export type HermesArbiterTopic =
  | "dev-command"
  | "dev-iox"
  | "content-draft"
  | "content-publish"
  | "invest-command"
  | "invest-query"
  | "doctor-report"
  | "alert-ops";

export type HermesArbiterBotName =
  | "HermesA8_bot"
  | "AHC_A8_bot"
  | "AlphaMate_Alpha_No_1"
  | "AlphaMate_Alpha_No_2";

export type HermesArbiterActionType =
  | "message"
  | "shell"
  | "command"
  | "telegram_send"
  | "status"
  | "publish";

export type HermesArbiterAction = {
  type: HermesArbiterActionType;
  payload: string;
  target_chat_id?: string;
  extra?: Record<string, unknown>;
};

export type HermesArbiterMetadata = {
  arbiter_topic: HermesArbiterTopic;
  arbiter_bot_name: HermesArbiterBotName;
  arbiter_trace_id?: string;
  arbiter_action?: HermesArbiterAction;
};

export function makeHermesArbiterTraceId(origin = "openclaw"): string {
  return `${origin}:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`;
}

export function buildHermesArbiterMetadata(params: {
  topic: HermesArbiterTopic;
  botName: HermesArbiterBotName;
  text: string;
  traceId?: string;
  actionType?: HermesArbiterActionType;
  targetChatId?: string;
  extra?: Record<string, unknown>;
}): HermesArbiterMetadata {
  return {
    arbiter_topic: params.topic,
    arbiter_bot_name: params.botName,
    arbiter_trace_id: params.traceId ?? makeHermesArbiterTraceId(),
    arbiter_action: {
      type: params.actionType ?? "message",
      payload: params.text,
      ...(params.targetChatId ? { target_chat_id: params.targetChatId } : {}),
      ...(params.extra ? { extra: params.extra } : {}),
    },
  };
}
