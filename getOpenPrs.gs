/**
 * イベント処理
 * NOTE:更新のたびにやること
 * 以下のURLをデプロイ後のURL(webアプリ)に更新する
 * 1: Slash Commands > Request URL
 */
function doPost(e) {
  // SlackのAPI設定画面の「Basic information > App Credentials > Verification」に設定したトークンを、GASのプロパティファイルから取得。
  const VARIFICATION_TOKEN =
    PropertiesService.getScriptProperties().getProperty("VERIFICATION_TOKEN");
  // slash_commandを受け付けた場合の処理
  const COMMAND = "/your_target_slash_command_name";
  const CHANNEL_NAME = "your_target_channel_name";
  if (e.parameter.command === COMMAND) {
    if (e.parameter.token !== VARIFICATION_TOKEN) {
      writeLogsInSpreadSheet(`invalid request**** ${e.parameter.command}`);

      return ContentService.createTextOutput("不正なリクエストです。");
    }
    deleteTriggers();
    ScriptApp.newTrigger("callMain") //発火させたいメソッド名
      .timeBased() //時間主導型のトリガー
      .after(10) //ミリ秒で設定
      .create();

    return ContentService.createTextOutput(
      `PRリスト取得処理を非同期で実行中... \n　結果を #${CHANNEL_NAME} で確認してください。(約1分程度かかります)`
    );

    // 以下のように返却しようとすると、タイムアウトになってしまうことが多い（対象のレポジトリ数やPR数による）
    // return ContentService.createTextOutput(`${main(true)}`);
  }
}

//不要なトリガーを削除
function deleteTriggers() {
  let triggers = ScriptApp.getProjectTriggers();
  triggers.forEach((trigger) => ScriptApp.deleteTrigger(trigger));
}

//Slashコマンド以外から呼び出しされる想定
function callMain() {
  main(false);
}

function main(isSlashCommand) {
  //GithubのPersonal Access Tokenに設定したトークンを、GASのプロパティファイルから取得。これをヘッダのAuthorizationに渡す
  const PR_NOTIFICATION_TOKEN =
    PropertiesService.getScriptProperties().getProperty(
      "PR_NOTIFICATION_TOKEN"
    );
  const OWNER = "your_target_repos_owner_name";
  const targetRepos = ["your_target_repo_1", "your_target_repo_2"];
  const targetKeysToExtract = [
    "draft",
    "number",
    "title",
    "html_url",
    "user",
    "requested_reviewers",
  ];

  //メッセージ表示用の設定
  const targetKeysForDisplay = [
    "title",
    "html_url",
    "user",
    "requested_reviewers",
  ];
  const targetTextForDisplay = ["", "", "担当者 : ", "レビュワー : "];
  const textMapByKey = associateKeyWithText(
    targetKeysForDisplay,
    targetTextForDisplay
  );

  const results = {};
  targetRepos.forEach((repo) => {
    const response = fetchPrList(PR_NOTIFICATION_TOKEN, OWNER, repo);
    const extractDatas = editResponse(response, targetKeysToExtract);
    results[repo] = extractDatas;
  });

  //レビューの明細取得のAPI呼び出しはまとめて実行
  const reviewDetailUrLs = [];
  targetRepos.forEach((repo) => {
    results[repo].forEach((result) => {
      reviewDetailUrLs.push(
        createRequestObject(PR_NOTIFICATION_TOKEN, OWNER, repo, result.number)
      );
    });
  });
  const reviewDetails = UrlFetchApp.fetchAll(reviewDetailUrLs);

  targetRepos.forEach((repo) => {
    for (let i = 0; i < results[repo].length; i++) {
      editExtractDatas(reviewDetails[i], results[repo][i]);
    }
  });

  const message = createMessageText(
    results,
    targetKeysForDisplay,
    textMapByKey
  );

  if (isSlashCommand) {
    return message;
  }

  postToSlack(message);
}

function fetchPrList(token, owner, repo) {
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/pulls?state=open`;
  const params = {
    method: "GET",
    headers: {
      Authorization: "Bearer " + token,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  };
  return UrlFetchApp.fetch(apiUrl, params);
}

function createRequestObject(token, owner, repo, pull_number) {
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/pulls/${pull_number}/reviews`;
  return {
    url: apiUrl,
    method: "GET",
    headers: {
      Authorization: "Bearer " + token,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  };
}

function associateKeyWithText(keyArray, textArray) {
  const associatedObj = {};
  if (keyArray.length !== textArray.length) {
    return associatedObj;
  }
  for (let i = 0; i < keyArray.length; i++) {
    associatedObj[keyArray[i]] = textArray[i];
  }
  return associatedObj;
}

/**
 * レスポンスの加工
 * - open状態のPRのURLの配列を返す
 */
function editResponse(response, targetKeys) {
  const responseData = JSON.parse(response.getContentText());
  // 次のいずれかのPRは除外："保留" ラベル/ドラフト
  const filteredData = responseData.filter((pr) => {
    return !pr.labels.some((label) => label.name === "保留") && !pr.draft;
  });

  const targetDataList = [];
  filteredData.forEach((data) => {
    const targetData = {};
    targetKeys.forEach((targetKey) => {
      if (data.hasOwnProperty(targetKey)) {
        if (targetKey === "requested_reviewers") {
          targetData[targetKey] = data[targetKey].map(
            (reviewer) => reviewer.login
          );
        } else if (targetKey === "user") {
          targetData[targetKey] = data[targetKey].login;
        } else {
          targetData[targetKey] = data[targetKey];
        }
      }
    });
    targetDataList.push(targetData);
  });

  // PRのnumberをキーとして昇順にソート
  targetDataList.sort((x, y) => {
    return x["number"] - y["number"];
  });

  return targetDataList;
}

function editExtractDatas(reviewDetails, result) {
  const responseReviewData = JSON.parse(reviewDetails.getContentText());
  responseReviewData.forEach((data) => {
    const foundUser = data.user.login;
    //PR作成者以外かつ、既に配列に入っていないユーザー名を追加
    //※reviewerにアサインされていないがコメントだけした人もここには入る
    if (
      foundUser !== result.user &&
      !isDuplicated(result.requested_reviewers, foundUser)
    ) {
      result.requested_reviewers.push(data.user.login);
    }
  });
}

function isDuplicated(targetArray, value) {
  return targetArray.indexOf(value) !== -1;
}

function createMessageText(targetDatasForEachRepo, targetKeys, textMapByKey) {
  let message = `<現在レビュー待ちのPR一覧>\n\n`;

  // レポジトリ毎にまとめてメッセージを記述
  for (const [repo, datas] of Object.entries(targetDatasForEachRepo)) {
    let hasAtLeastOne = false;
    message += `◾️ ${repo}  \n`;

    datas.forEach((data) => {
      targetKeys.forEach((targetKey) => {
        hasAtLeastOne = true;
        message += `- ${textMapByKey[targetKey]}${data[targetKey]} \n`;
      });
      message += `=============================================\n`;
    });
    if (!hasAtLeastOne) {
      message += "レビュー着手可能なPRはありません\n";
    }
    message += "\n";
  }

  return message;
}

function postToSlack(message) {
  const BOT_TOKEN =
    PropertiesService.getScriptProperties().getProperty("BOT_TOKEN");

  const channelId = "#your_target_channel_id";
  const slackApp = SlackApp.create(BOT_TOKEN);
  slackApp.postMessage(channelId, message);
  // writeLogsInSpreadSheet(message);
}

/**
 * 実行ログを記録する(デバッグ用。「スプレッドシートの指定したシート」に出力。)
 */
function writeLogsInSpreadSheet(text) {
  const SHEET_NAME = "Logs";
  const SPREADSHEET_ID =
    PropertiesService.getScriptProperties().getProperty("SPREADSHEET_ID");
  const sheet =
    SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(SHEET_NAME);
  let lastRow = sheet.getLastRow();
  sheet.getRange(lastRow + 1, 1).setValue(text);
}
