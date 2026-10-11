import type { AgentMessage } from "../../agents/runtime/index.js";
import type { SessionManager } from "../../agents/sessions/session-manager.js";
import type { ASSISTANT_DISPLAY_CONTENT_FIELD } from "../../shared/assistant-display-content.js";
import { applyAssistantDeliveryDirectives } from "./transcript-assistant-delivery.js";

export type SessionTranscriptAssistantMessage = Parameters<SessionManager["appendMessage"]>[0] & {
  role: "assistant";
  [ASSISTANT_DISPLAY_CONTENT_FIELD]?: Array<Record<string, unknown>>;
};

export type AssistantBeforeMessageWrite = (params: {
  message: AgentMessage;
  agentId?: string;
  sessionKey?: string;
}) => AgentMessage | null;

export function applyBeforeMessageWriteToAssistant(params: {
  message: Parameters<SessionManager["appendMessage"]>[0];
  beforeMessageWrite?: AssistantBeforeMessageWrite;
  explicitIdempotencyKey?: string;
  agentId?: string;
  sessionKey: string;
}): Parameters<SessionManager["appendMessage"]>[0] | undefined {
  const nextMessage = params.beforeMessageWrite
    ? params.beforeMessageWrite({
        message: params.message as AgentMessage,
        ...(params.agentId ? { agentId: params.agentId } : {}),
        sessionKey: params.sessionKey,
      })
    : params.message;
  if (nextMessage?.role !== "assistant") {
    return undefined;
  }
  return Object.assign(
    applyAssistantDeliveryDirectives(nextMessage),
    params.explicitIdempotencyKey ? { idempotencyKey: params.explicitIdempotencyKey } : {},
  ) as Parameters<SessionManager["appendMessage"]>[0];
}
