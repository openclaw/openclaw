import { getDingTalkAccessToken } from "./auth.js";
import { loadDingTalkAxios } from "./deps.js";

const axios = loadDingTalkAxios();

const DINGTALK_API = "https://api.dingtalk.com";
const DEFAULT_TEMPLATE_ID = "382e4302-551d-4880-bf29-a30acfab2e71.schema";

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

export type AICardTarget =
  | { type: "user"; userId: string }
  | { type: "group"; openConversationId: string };

export type AICardInstance = {
  cardInstanceId: string;
  accessToken: string;
  inputingStarted: boolean;
};

// flowStatus 值与 Python SDK AICardStatus 一致（cardParamMap 的值必须是字符串）
const AICardStatus = {
  PROCESSING: "1",
  INPUTING: "2",
  FINISHED: "3",
  EXECUTING: "4",
  FAILED: "5",
} as const;

function buildDeliverBody(cardInstanceId: string, target: AICardTarget, robotCode: string) {
  const base = { outTrackId: cardInstanceId, userIdType: 1 };

  if (target.type === "group") {
    return {
      ...base,
      openSpaceId: `dtv1.card//IM_GROUP.${target.openConversationId}`,
      imGroupOpenDeliverModel: { robotCode },
    };
  }

  return {
    ...base,
    openSpaceId: `dtv1.card//IM_ROBOT.${target.userId}`,
    imRobotOpenDeliverModel: { spaceType: "IM_ROBOT" },
  };
}

export async function createAICardForTarget(
  config: { clientId: string; clientSecret: string; aiCardTemplateId?: string },
  target: AICardTarget,
  log?: Logger,
): Promise<AICardInstance | null> {
  const targetDesc =
    target.type === "group" ? `群聊 ${target.openConversationId}` : `用户 ${target.userId}`;

  try {
    const token = await getDingTalkAccessToken(config);
    const cardInstanceId = `card_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

    log?.info?.(`[DingTalk][AICard] 开始创建卡片: ${targetDesc}, outTrackId=${cardInstanceId}`);

    // 1. 创建卡片实例
    const createBody = {
      cardTemplateId: config.aiCardTemplateId || DEFAULT_TEMPLATE_ID,
      outTrackId: cardInstanceId,
      cardData: { cardParamMap: {} },
      callbackType: "STREAM",
      imGroupOpenSpaceModel: { supportForward: true },
      imRobotOpenSpaceModel: { supportForward: true },
    };

    log?.info?.(`[DingTalk][AICard] POST /v1.0/card/instances`);
    const createResp = await axios.post(`${DINGTALK_API}/v1.0/card/instances`, createBody, {
      headers: { "x-acs-dingtalk-access-token": token, "Content-Type": "application/json" },
    });
    log?.info?.(`[DingTalk][AICard] 创建卡片响应: status=${createResp.status}`);

    // 2. 投放卡片
    const deliverBody = buildDeliverBody(cardInstanceId, target, config.clientId);

    log?.info?.(
      `[DingTalk][AICard] POST /v1.0/card/instances/deliver body=${JSON.stringify(deliverBody)}`,
    );
    const deliverResp = await axios.post(
      `${DINGTALK_API}/v1.0/card/instances/deliver`,
      deliverBody,
      {
        headers: { "x-acs-dingtalk-access-token": token, "Content-Type": "application/json" },
      },
    );
    log?.info?.(`[DingTalk][AICard] 投放卡片响应: status=${deliverResp.status}`);

    return { cardInstanceId, accessToken: token, inputingStarted: false };
  } catch (err: unknown) {
    const errMessage = getErrorMessage(err);
    const response = getErrorResponse(err);
    log?.error?.(`[DingTalk][AICard] 创建卡片失败 (${targetDesc}): ${errMessage}`);
    if (response) {
      log?.error?.(
        `[DingTalk][AICard] 错误响应: status=${response.status} data=${JSON.stringify(response.data)}`,
      );
    }
    return null;
  }
}

export async function streamAICard(
  card: AICardInstance,
  content: string,
  finished: boolean = false,
  log?: Logger,
): Promise<void> {
  // 首次 streaming 前，先切换到 INPUTING 状态（与 Python SDK get_card_data(INPUTING) 一致）
  if (!card.inputingStarted) {
    const statusBody = {
      outTrackId: card.cardInstanceId,
      cardData: {
        cardParamMap: {
          flowStatus: AICardStatus.INPUTING,
          msgContent: "",
          staticMsgContent: "",
          sys_full_json_obj: JSON.stringify({
            order: ["msgContent"], // 只声明实际使用的字段，避免部分客户端显示空占位
          }),
        },
      },
    };
    log?.info?.(
      `[DingTalk][AICard] PUT /v1.0/card/instances (INPUTING) outTrackId=${card.cardInstanceId}`,
    );
    try {
      const statusResp = await axios.put(`${DINGTALK_API}/v1.0/card/instances`, statusBody, {
        headers: {
          "x-acs-dingtalk-access-token": card.accessToken,
          "Content-Type": "application/json",
        },
      });
      log?.info?.(
        `[DingTalk][AICard] INPUTING 响应: status=${statusResp.status} data=${JSON.stringify(statusResp.data)}`,
      );
    } catch (err: unknown) {
      const errMessage = getErrorMessage(err);
      const response = getErrorResponse(err);
      log?.error?.(
        `[DingTalk][AICard] INPUTING 切换失败: ${errMessage}, resp=${JSON.stringify(response?.data)}`,
      );
      throw err;
    }
    card.inputingStarted = true;
  }

  // 调用 streaming API 更新内容
  const body = {
    outTrackId: card.cardInstanceId,
    guid: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    key: "msgContent",
    content,
    isFull: true, // 全量替换
    isFinalize: finished,
    isError: false,
  };

  log?.info?.(
    `[DingTalk][AICard] PUT /v1.0/card/streaming contentLen=${content.length} isFinalize=${finished} guid=${body.guid}`,
  );
  try {
    const streamResp = await axios.put(`${DINGTALK_API}/v1.0/card/streaming`, body, {
      headers: {
        "x-acs-dingtalk-access-token": card.accessToken,
        "Content-Type": "application/json",
      },
    });
    log?.info?.(`[DingTalk][AICard] streaming 响应: status=${streamResp.status}`);
  } catch (err: unknown) {
    const errMessage = getErrorMessage(err);
    const response = getErrorResponse(err);
    log?.error?.(
      `[DingTalk][AICard] streaming 更新失败: ${errMessage}, resp=${JSON.stringify(response?.data)}`,
    );
    throw err;
  }
}

// 完成 AI Card：先 streaming isFinalize 关闭流式通道，再 put_card_data 更新 FINISHED 状态
export async function finishAICard(
  card: AICardInstance,
  content: string,
  log?: Logger,
): Promise<void> {
  log?.info?.(`[DingTalk][AICard] 开始 finish，最终内容长度=${content.length}`);

  // 1. 先用最终内容关闭流式通道（isFinalize=true），确保卡片显示替换后的内容
  await streamAICard(card, content, true, log);

  // 2. 更新卡片状态为 FINISHED
  const body = {
    outTrackId: card.cardInstanceId,
    cardData: {
      cardParamMap: {
        flowStatus: AICardStatus.FINISHED,
        msgContent: content,
        staticMsgContent: "",
        sys_full_json_obj: JSON.stringify({
          order: ["msgContent"], // 只声明实际使用的字段，避免部分客户端显示空占位
        }),
      },
    },
  };

  log?.info?.(
    `[DingTalk][AICard] PUT /v1.0/card/instances (FINISHED) outTrackId=${card.cardInstanceId}`,
  );
  try {
    const finishResp = await axios.put(`${DINGTALK_API}/v1.0/card/instances`, body, {
      headers: {
        "x-acs-dingtalk-access-token": card.accessToken,
        "Content-Type": "application/json",
      },
    });
    log?.info?.(
      `[DingTalk][AICard] FINISHED 响应: status=${finishResp.status} data=${JSON.stringify(finishResp.data)}`,
    );
  } catch (err: unknown) {
    const errMessage = getErrorMessage(err);
    const response = getErrorResponse(err);
    log?.error?.(
      `[DingTalk][AICard] FINISHED 更新失败: ${errMessage}, resp=${JSON.stringify(response?.data)}`,
    );
  }
}

export class DingTalkStreamingSession {
  private readonly config: { clientId: string; clientSecret: string; aiCardTemplateId?: string };
  private readonly _target: AICardTarget;
  private card: AICardInstance | null = null;

  constructor(
    config: { clientId: string; clientSecret: string; aiCardTemplateId?: string },
    params: { isGroup: boolean; senderId: string; chatId: string },
  ) {
    this.config = config;
    this._target = params.isGroup
      ? { type: "group", openConversationId: params.chatId }
      : { type: "user", userId: params.senderId };
  }

  get target(): AICardTarget {
    return this._target;
  }

  isActive(): boolean {
    return Boolean(this.card);
  }

  async start(log?: Logger): Promise<void> {
    if (this.card) {
      return;
    }
    const card = await createAICardForTarget(this.config, this._target, log);
    if (!card) {
      throw new Error("Failed to create DingTalk AI Card");
    }
    this.card = card;
  }

  async update(content: string, log?: Logger): Promise<void> {
    if (!this.card) {
      return;
    }
    await streamAICard(this.card, content, false, log);
  }

  async close(content: string, log?: Logger): Promise<void> {
    if (!this.card) {
      return;
    }
    await finishAICard(this.card, content, log);
    this.card = null;
  }
}
