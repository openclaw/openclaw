import type { AICardTarget } from "./ai-card.js";
import { createAICardForTarget, finishAICard } from "./ai-card.js";
import { getDingTalkAccessToken, getDingTalkOapiToken } from "./auth.js";
import { loadDingTalkAxios } from "./deps.js";
import {
  processAudioMarkers,
  processFileMarkers,
  processLocalImages,
  processVideoMarkers,
} from "./media.js";

const axios = loadDingTalkAxios();

export type DingTalkMsgType = "text" | "markdown" | "link" | "actionCard" | "image";

export type DingTalkSendResult = {
  ok: boolean;
  processQueryKey?: string;
  cardInstanceId?: string;
  error?: string;
  usedAICard?: boolean;
};

type Logger = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
};

type ErrorResponse = {
  status?: number;
  data?: unknown;
};

function getErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

function getErrorResponse(err: unknown): ErrorResponse | undefined {
  if (typeof err !== "object" || err === null || !("response" in err)) {
    return undefined;
  }
  const response = (err as { response?: unknown }).response;
  if (typeof response !== "object" || response === null) {
    return undefined;
  }
  const statusValue = (response as { status?: unknown }).status;
  const data = (response as { data?: unknown }).data;
  return {
    status: typeof statusValue === "number" ? statusValue : undefined,
    data,
  };
}

function getResponseMessage(data: unknown): string | undefined {
  if (typeof data !== "object" || data === null) {
    return undefined;
  }
  const message = (data as { message?: unknown }).message;
  return typeof message === "string" ? message : undefined;
}

type ProactiveSendOptions = {
  msgType?: DingTalkMsgType;
  title?: string;
  log?: Logger;
  useAICard?: boolean;
  fallbackToNormal?: boolean;
};

export async function sendDingTalkWebhookText(
  config: { clientId: string; clientSecret: string },
  sessionWebhook: string,
  text: string,
  opts: { atUserId?: string | null; title?: string; useMarkdown?: boolean } = {},
): Promise<unknown> {
  const token = await getDingTalkAccessToken(config);
  let payloadText = text;
  const hasMarkdown = /^[#*>-]|[*_`#[\]]/.test(text) || text.includes("\n");
  const useMarkdown = opts.useMarkdown !== false && (opts.useMarkdown || hasMarkdown);

  if (useMarkdown) {
    const title =
      opts.title ||
      text
        .split("\n")[0]
        ?.replace(/^[#*\s\->]+/, "")
        .slice(0, 20) ||
      "OpenClaw";
    if (opts.atUserId) {
      payloadText = `${payloadText} @${opts.atUserId}`;
    }
    const body: Record<string, unknown> = {
      msgtype: "markdown",
      markdown: { title, text: payloadText },
    };
    if (opts.atUserId) {
      body.at = { atUserIds: [opts.atUserId], isAtAll: false };
    }
    const resp = await axios.post(sessionWebhook, body, {
      headers: {
        "x-acs-dingtalk-access-token": token,
        "Content-Type": "application/json",
      },
    });
    return resp.data;
  }

  const body: Record<string, unknown> = { msgtype: "text", text: { content: payloadText } };
  if (opts.atUserId) {
    body.at = { atUserIds: [opts.atUserId], isAtAll: false };
  }
  const resp = await axios.post(sessionWebhook, body, {
    headers: {
      "x-acs-dingtalk-access-token": token,
      "Content-Type": "application/json",
    },
  });
  return resp.data;
}

async function sendAICardInternal(
  config: { clientId: string; clientSecret: string; aiCardTemplateId?: string },
  target: AICardTarget,
  content: string,
  log?: Logger,
): Promise<DingTalkSendResult> {
  const targetDesc =
    target.type === "group" ? `群聊 ${target.openConversationId}` : `用户 ${target.userId}`;

  try {
    // 0. 获取 oapiToken 用于后处理
    const oapiToken = await getDingTalkOapiToken(config);

    // 1. 后处理01：上传本地图片到钉钉，替换路径为 media_id
    let processedContent = content;
    if (oapiToken) {
      log?.info?.(`[DingTalk][AICard][Proactive] 开始图片后处理`);
      processedContent = await processLocalImages(content, oapiToken, log);
    } else {
      log?.warn?.(`[DingTalk][AICard][Proactive] 无法获取 oapiToken，跳过媒体后处理`);
    }

    // 2. 后处理02：提取视频标记并发送视频消息
    log?.info?.(`[DingTalk][Video][Proactive] 开始视频后处理`);
    processedContent = await processVideoMarkers(
      processedContent,
      "",
      config,
      oapiToken,
      log,
      true,
      target,
    );

    // 3. 后处理03：提取音频标记并发送音频消息（使用主动消息 API）
    log?.info?.(`[DingTalk][Audio][Proactive] 开始音频后处理`);
    processedContent = await processAudioMarkers(
      processedContent,
      "",
      config,
      oapiToken,
      log,
      true,
      target,
    );

    // 4. 后处理04：提取文件标记并发送独立文件消息（使用主动消息 API）
    log?.info?.(`[DingTalk][File][Proactive] 开始文件后处理`);
    processedContent = await processFileMarkers(
      processedContent,
      "",
      config,
      oapiToken,
      log,
      true,
      target,
    );

    // 5. 检查处理后的内容是否为空（纯文件/视频/音频消息场景）
    const trimmedContent = processedContent.trim();
    if (!trimmedContent) {
      log?.info?.(`[DingTalk][AICard][Proactive] 处理后内容为空，跳过创建 AI Card`);
      return { ok: true, usedAICard: false };
    }

    // 6. 创建卡片
    const card = await createAICardForTarget(config, target, log);
    if (!card) {
      return { ok: false, error: "Failed to create AI Card", usedAICard: false };
    }

    // 7. 使用 finishAICard 设置内容
    await finishAICard(card, processedContent, log);

    log?.info?.(
      `[DingTalk][AICard][Proactive] AI Card 发送成功: ${targetDesc}, cardInstanceId=${card.cardInstanceId}`,
    );
    return { ok: true, cardInstanceId: card.cardInstanceId, usedAICard: true };
  } catch (err: unknown) {
    const errMessage = getErrorMessage(err);
    const response = getErrorResponse(err);
    log?.error?.(`[DingTalk][AICard][Proactive] AI Card 发送失败 (${targetDesc}): ${errMessage}`);
    if (response) {
      log?.error?.(
        `[DingTalk][AICard][Proactive] 错误响应: status=${response.status} data=${JSON.stringify(response.data)}`,
      );
    }
    return {
      ok: false,
      error: getResponseMessage(response?.data) || errMessage,
      usedAICard: false,
    };
  }
}

async function sendAICardToUser(
  config: { clientId: string; clientSecret: string; aiCardTemplateId?: string },
  userId: string,
  content: string,
  log?: Logger,
): Promise<DingTalkSendResult> {
  return sendAICardInternal(config, { type: "user", userId }, content, log);
}

async function sendAICardToGroup(
  config: { clientId: string; clientSecret: string; aiCardTemplateId?: string },
  openConversationId: string,
  content: string,
  log?: Logger,
): Promise<DingTalkSendResult> {
  return sendAICardInternal(config, { type: "group", openConversationId }, content, log);
}

function buildMsgPayload(
  msgType: DingTalkMsgType,
  content: string,
  title?: string,
): { msgKey: string; msgParam: Record<string, unknown> } | { error: string } {
  switch (msgType) {
    case "markdown":
      return {
        msgKey: "sampleMarkdown",
        msgParam: {
          title:
            title ||
            content
              .split("\n")[0]
              .replace(/^[#*\s\->]+/, "")
              .slice(0, 20) ||
            "Message",
          text: content,
        },
      };
    case "link":
      try {
        return {
          msgKey: "sampleLink",
          msgParam: typeof content === "string" ? JSON.parse(content) : content,
        };
      } catch {
        return { error: "Invalid link message format, expected JSON" };
      }
    case "actionCard":
      try {
        return {
          msgKey: "sampleActionCard",
          msgParam: typeof content === "string" ? JSON.parse(content) : content,
        };
      } catch {
        return { error: "Invalid actionCard message format, expected JSON" };
      }
    case "image":
      return {
        msgKey: "sampleImageMsg",
        msgParam: { photoURL: content },
      };
    case "text":
    default:
      return {
        msgKey: "sampleText",
        msgParam: { content },
      };
  }
}

async function sendNormalToUser(
  config: { clientId: string; clientSecret: string },
  userIds: string | string[],
  content: string,
  options: { msgType?: DingTalkMsgType; title?: string; log?: Logger } = {},
): Promise<DingTalkSendResult> {
  const { msgType = "text", title, log } = options;
  const userIdArray = Array.isArray(userIds) ? userIds : [userIds];

  const payload = buildMsgPayload(msgType, content, title);
  if ("error" in payload) {
    return { ok: false, error: payload.error, usedAICard: false };
  }

  try {
    const token = await getDingTalkAccessToken(config);
    const body = {
      robotCode: config.clientId,
      userIds: userIdArray,
      msgKey: payload.msgKey,
      msgParam: JSON.stringify(payload.msgParam),
    };

    log?.info?.(
      `[DingTalk][Normal] 发送单聊消息: userIds=${userIdArray.join(",")}, msgType=${msgType}`,
    );

    const resp = await axios.post(
      "https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend",
      body,
      {
        headers: { "x-acs-dingtalk-access-token": token, "Content-Type": "application/json" },
        timeout: 10_000,
      },
    );

    if (resp.data?.processQueryKey) {
      log?.info?.(`[DingTalk][Normal] 发送成功: processQueryKey=${resp.data.processQueryKey}`);
      return { ok: true, processQueryKey: resp.data.processQueryKey, usedAICard: false };
    }

    log?.warn?.(`[DingTalk][Normal] 发送响应异常: ${JSON.stringify(resp.data)}`);
    return { ok: false, error: resp.data?.message || "Unknown error", usedAICard: false };
  } catch (err: unknown) {
    const errMsg = getResponseMessage(getErrorResponse(err)?.data) || getErrorMessage(err);
    log?.error?.(`[DingTalk][Normal] 发送失败: ${errMsg}`);
    return { ok: false, error: errMsg, usedAICard: false };
  }
}

async function sendNormalToGroup(
  config: { clientId: string; clientSecret: string },
  openConversationId: string,
  content: string,
  options: { msgType?: DingTalkMsgType; title?: string; log?: Logger } = {},
): Promise<DingTalkSendResult> {
  const { msgType = "text", title, log } = options;

  const payload = buildMsgPayload(msgType, content, title);
  if ("error" in payload) {
    return { ok: false, error: payload.error, usedAICard: false };
  }

  try {
    const token = await getDingTalkAccessToken(config);
    const body = {
      robotCode: config.clientId,
      openConversationId,
      msgKey: payload.msgKey,
      msgParam: JSON.stringify(payload.msgParam),
    };

    log?.info?.(
      `[DingTalk][Normal] 发送群聊消息: openConversationId=${openConversationId}, msgType=${msgType}`,
    );

    const resp = await axios.post("https://api.dingtalk.com/v1.0/robot/groupMessages/send", body, {
      headers: { "x-acs-dingtalk-access-token": token, "Content-Type": "application/json" },
      timeout: 10_000,
    });

    if (resp.data?.processQueryKey) {
      log?.info?.(`[DingTalk][Normal] 发送成功: processQueryKey=${resp.data.processQueryKey}`);
      return { ok: true, processQueryKey: resp.data.processQueryKey, usedAICard: false };
    }

    log?.warn?.(`[DingTalk][Normal] 发送响应异常: ${JSON.stringify(resp.data)}`);
    return { ok: false, error: resp.data?.message || "Unknown error", usedAICard: false };
  } catch (err: unknown) {
    const errMsg = getResponseMessage(getErrorResponse(err)?.data) || getErrorMessage(err);
    log?.error?.(`[DingTalk][Normal] 发送失败: ${errMsg}`);
    return { ok: false, error: errMsg, usedAICard: false };
  }
}

async function sendToUser(
  config: { clientId: string; clientSecret: string; aiCardTemplateId?: string },
  userIds: string | string[],
  content: string,
  options: ProactiveSendOptions = {},
): Promise<DingTalkSendResult> {
  const { log, useAICard = true, fallbackToNormal = true } = options;

  if (!config.clientId || !config.clientSecret) {
    return { ok: false, error: "Missing clientId or clientSecret", usedAICard: false };
  }

  const userIdArray = Array.isArray(userIds) ? userIds : [userIds];
  if (userIdArray.length === 0) {
    return { ok: false, error: "userIds cannot be empty", usedAICard: false };
  }

  // AI Card 只支持单个用户
  if (useAICard && userIdArray.length === 1) {
    log?.info?.(`[DingTalk][SendToUser] 尝试使用 AI Card 发送: userId=${userIdArray[0]}`);
    const cardResult = await sendAICardToUser(config, userIdArray[0], content, log);

    if (cardResult.ok) {
      return cardResult;
    }

    log?.warn?.(`[DingTalk][SendToUser] AI Card 发送失败: ${cardResult.error}`);

    if (!fallbackToNormal) {
      log?.error?.(`[DingTalk][SendToUser] 不降级到普通消息，返回错误`);
      return cardResult;
    }

    log?.info?.(`[DingTalk][SendToUser] 降级到普通消息发送`);
  } else if (useAICard && userIdArray.length > 1) {
    log?.info?.(`[DingTalk][SendToUser] 多用户发送不支持 AI Card，使用普通消息`);
  }

  return sendNormalToUser(config, userIdArray, content, options);
}

async function sendToGroup(
  config: { clientId: string; clientSecret: string; aiCardTemplateId?: string },
  openConversationId: string,
  content: string,
  options: ProactiveSendOptions = {},
): Promise<DingTalkSendResult> {
  const { log, useAICard = true, fallbackToNormal = true } = options;

  if (!config.clientId || !config.clientSecret) {
    return { ok: false, error: "Missing clientId or clientSecret", usedAICard: false };
  }

  if (!openConversationId) {
    return { ok: false, error: "openConversationId cannot be empty", usedAICard: false };
  }

  if (useAICard) {
    log?.info?.(
      `[DingTalk][SendToGroup] 尝试使用 AI Card 发送: openConversationId=${openConversationId}`,
    );
    const cardResult = await sendAICardToGroup(config, openConversationId, content, log);

    if (cardResult.ok) {
      return cardResult;
    }

    log?.warn?.(`[DingTalk][SendToGroup] AI Card 发送失败: ${cardResult.error}`);

    if (!fallbackToNormal) {
      log?.error?.(`[DingTalk][SendToGroup] 不降级到普通消息，返回错误`);
      return cardResult;
    }

    log?.info?.(`[DingTalk][SendToGroup] 降级到普通消息发送`);
  }

  return sendNormalToGroup(config, openConversationId, content, options);
}

async function sendProactive(
  config: { clientId: string; clientSecret: string; aiCardTemplateId?: string },
  target: { userId?: string; userIds?: string[]; openConversationId?: string },
  content: string,
  options: ProactiveSendOptions = {},
): Promise<DingTalkSendResult> {
  if (!options.msgType) {
    const hasMarkdown = /^[#*>-]|[*_`#[\]]/.test(content) || content.includes("\n");
    if (hasMarkdown) {
      options.msgType = "markdown";
    }
  }

  if (target.userId || target.userIds) {
    const userIds = target.userIds || [target.userId!];
    return sendToUser(config, userIds, content, options);
  }

  if (target.openConversationId) {
    return sendToGroup(config, target.openConversationId, content, options);
  }

  return {
    ok: false,
    error: "Must specify userId, userIds, or openConversationId",
    usedAICard: false,
  };
}

export async function sendDingTalkProactiveText(
  config: { clientId: string; clientSecret: string; aiCardTemplateId?: string },
  target: AICardTarget,
  text: string,
  opts?: { msgType?: DingTalkMsgType; title?: string; log?: Logger },
): Promise<DingTalkSendResult> {
  const result = await sendProactive(
    config,
    target.type === "group"
      ? { openConversationId: target.openConversationId }
      : { userId: target.userId },
    text,
    { msgType: opts?.msgType, title: opts?.title, log: opts?.log },
  );
  if (!result.ok) {
    throw new Error(result.error || "DingTalk proactive send failed");
  }
  return result;
}

export async function sendDingTalkProactiveFile(
  config: { clientId: string; clientSecret: string },
  target: AICardTarget,
  payload: { mediaId: string; fileName: string; fileType: string },
  log?: Logger,
): Promise<void> {
  const token = await getDingTalkAccessToken(config);
  const msgParam = {
    mediaId: payload.mediaId,
    fileName: payload.fileName,
    fileType: payload.fileType,
  };
  const body: Record<string, unknown> = {
    robotCode: config.clientId,
    msgKey: "sampleFile",
    msgParam: JSON.stringify(msgParam),
  };
  let endpoint: string;
  if (target.type === "group") {
    body.openConversationId = target.openConversationId;
    endpoint = "https://api.dingtalk.com/v1.0/robot/groupMessages/send";
  } else {
    body.userIds = [target.userId];
    endpoint = "https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend";
  }
  log?.info?.(`[DingTalk][File][Proactive] 发送文件消息: ${payload.fileName}`);
  await axios.post(endpoint, body, {
    headers: { "x-acs-dingtalk-access-token": token, "Content-Type": "application/json" },
    timeout: 10_000,
  });
}

export async function sendDingTalkProactiveAudio(
  config: { clientId: string; clientSecret: string },
  target: AICardTarget,
  payload: { mediaId: string; durationMs?: number },
  log?: Logger,
): Promise<void> {
  const token = await getDingTalkAccessToken(config);
  const msgParam = {
    mediaId: payload.mediaId,
    duration: String(payload.durationMs ?? 60000),
  };
  const body: Record<string, unknown> = {
    robotCode: config.clientId,
    msgKey: "sampleAudio",
    msgParam: JSON.stringify(msgParam),
  };
  let endpoint: string;
  if (target.type === "group") {
    body.openConversationId = target.openConversationId;
    endpoint = "https://api.dingtalk.com/v1.0/robot/groupMessages/send";
  } else {
    body.userIds = [target.userId];
    endpoint = "https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend";
  }
  log?.info?.(`[DingTalk][Audio][Proactive] 发送音频消息`);
  await axios.post(endpoint, body, {
    headers: { "x-acs-dingtalk-access-token": token, "Content-Type": "application/json" },
    timeout: 10_000,
  });
}

export async function sendDingTalkProactiveVideo(
  config: { clientId: string; clientSecret: string },
  target: AICardTarget,
  payload: {
    videoMediaId: string;
    picMediaId: string;
    duration: number;
    width: number;
    height: number;
  },
  log?: Logger,
): Promise<void> {
  const token = await getDingTalkAccessToken(config);
  const msgParam = {
    duration: String(payload.duration),
    videoMediaId: payload.videoMediaId,
    videoType: "mp4",
    picMediaId: payload.picMediaId,
  };
  const body: Record<string, unknown> = {
    robotCode: config.clientId,
    msgKey: "sampleVideo",
    msgParam: JSON.stringify(msgParam),
  };
  let endpoint: string;
  if (target.type === "group") {
    body.openConversationId = target.openConversationId;
    endpoint = "https://api.dingtalk.com/v1.0/robot/groupMessages/send";
  } else {
    body.userIds = [target.userId];
    endpoint = "https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend";
  }
  log?.info?.(`[DingTalk][Video][Proactive] 发送视频消息`);
  await axios.post(endpoint, body, {
    headers: { "x-acs-dingtalk-access-token": token, "Content-Type": "application/json" },
    timeout: 10_000,
  });
}
