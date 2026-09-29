import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { ChatWorkContext } from "../../../../packages/gateway-protocol/src/chat-work-context.js";
import type {
  ChatSendIntent,
  QueueMode,
} from "../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import { GatewayRequestError } from "../../api/gateway.ts";
import { t } from "../../i18n/index.ts";
import type { ChatAttachment, HumanMention } from "../../lib/chat/chat-types.ts";
import {
  isUiGlobalSessionKey,
  normalizeAgentId,
  resolveUiSelectedSessionAgentId,
} from "../../lib/sessions/session-key.ts";
import { assertUploadsEnabled } from "../../lib/uploads.ts";
import { buildChatApiAttachments } from "./attachment-api.ts";
import { isInitialChatHistoryUnavailable } from "./chat-history-state.ts";
import { chatProviderReviewRow } from "./chat-provider-review.ts";
import { normalizeChatSendAck, type ChatSendAck } from "./chat-send-ack.ts";
import { resolveImageAttachmentRequestTimeoutMs } from "./chat-send-timeout.ts";
import type { ChatState } from "./chat-state-contract.ts";

export async function requestChatSend(
  state: ChatState,
  params: {
    message: string;
    workContext?: ChatWorkContext;
    mentions?: readonly HumanMention[];
    attachments?: ChatAttachment[];
    runId: string;
    sessionKey?: string;
    agentId?: string;
    queueMode?: QueueMode;
    intent?: ChatSendIntent;
    sessionId?: string;
    replyToId?: string;
    expectedLeafEntryId?: string | null;
  },
): Promise<ChatSendAck> {
  if (params.attachments?.length) {
    assertUploadsEnabled(state.uploadConfig);
  }
  const routing = resolveChatSendRouting(state, params);
  if (chatProviderReviewRow(state, routing.sessionKey, routing.selectedAgentId)?.providerReview) {
    throw new Error(t("chat.providerReview.pausedBody"));
  }
  const sessionId = params.sessionId ?? (params.intent ? undefined : routing.sessionId);
  const controlUiReconnectResume = Boolean(
    !params.intent && sessionId && state.reconnectResumeSessionId === sessionId,
  );
  const attachments = buildChatApiAttachments(params.attachments);
  const hasImageAttachment =
    attachments?.some((attachment) => attachment.type === "image") === true;
  const imageRequestTimeoutMs = hasImageAttachment
    ? resolveImageAttachmentRequestTimeoutMs(state.chatAttachmentRequestTimeoutMs)
    : undefined;
  const requestParams = {
    sessionKey: routing.sessionKey,
    ...(isUiGlobalSessionKey(routing.sessionKey) && routing.selectedAgentId
      ? { agentId: routing.selectedAgentId }
      : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(controlUiReconnectResume ? { __controlUiReconnectResume: true } : {}),
    message: params.message,
    ...(params.workContext ? { workContext: params.workContext } : {}),
    ...(params.mentions?.length ? { mentions: params.mentions } : {}),
    ...(params.intent ? { intent: params.intent } : {}),
    deliver: false,
    ...(params.replyToId ? { replyToId: params.replyToId } : {}),
    ...(params.queueMode ? { queueMode: params.queueMode } : {}),
    ...(params.expectedLeafEntryId !== undefined
      ? { expectedLeafEntryId: params.expectedLeafEntryId }
      : {}),
    idempotencyKey: params.runId,
    attachments,
    // The local transport deadline and the server-side agent-run budget must
    // agree; otherwise the UI can wait five minutes while Gateway still cuts
    // image analysis off at its shorter default.
    ...(imageRequestTimeoutMs !== undefined ? { timeoutMs: imageRequestTimeoutMs } : {}),
  };
  const payload = hasImageAttachment
    ? await state.client!.request("chat.send", requestParams, {
        timeoutMs: imageRequestTimeoutMs,
      })
    : await state.client!.request("chat.send", requestParams);
  if (controlUiReconnectResume) {
    state.reconnectResumeSessionId = null;
  }
  return normalizeChatSendAck(payload, params.runId);
}

export function resolveDisplayedLeafEntryId(state: ChatState): string | null | undefined {
  if (state.chatLoading || isInitialChatHistoryUnavailable(state)) {
    return undefined;
  }
  if (state.chatDisplayedLeafEntryId === null) {
    return null;
  }
  const leafEntryId = state.chatDisplayedLeafEntryId?.trim();
  return leafEntryId || undefined;
}

const ACTIVE_LEAF_CHANGED_ERROR_REASON = "active-leaf-changed";

export function isActiveLeafChangedError(err: unknown): err is GatewayRequestError {
  return (
    err instanceof GatewayRequestError &&
    asOptionalRecord(err.details)?.reason === ACTIVE_LEAF_CHANGED_ERROR_REASON
  );
}

function resolveChatSendRouting(
  state: ChatState,
  params: {
    sessionKey?: string;
    agentId?: string;
  },
): { selectedAgentId?: string; sessionId?: string; sessionKey: string } {
  const sessionKey = params.sessionKey ?? state.sessionKey;
  const selectedAgentId = params.agentId
    ? normalizeAgentId(params.agentId)
    : resolveUiSelectedSessionAgentId(state);
  const currentSessionId = state.currentSessionId;
  const canReuseCurrentSessionId =
    sessionKey === state.sessionKey &&
    (!isUiGlobalSessionKey(sessionKey) ||
      (selectedAgentId !== undefined &&
        selectedAgentId === resolveUiSelectedSessionAgentId(state)));
  const sessionId =
    canReuseCurrentSessionId && typeof currentSessionId === "string" && currentSessionId.trim()
      ? currentSessionId.trim()
      : undefined;
  return {
    sessionKey,
    ...(selectedAgentId ? { selectedAgentId } : {}),
    ...(sessionId ? { sessionId } : {}),
  };
}
