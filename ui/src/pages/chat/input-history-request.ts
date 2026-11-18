import { t } from "../../i18n/index.ts";
import {
  nativeHistoryMessageSourceIdentity,
  oldestNativeHistoryMessage,
} from "../../lib/chat/history-message-identity.ts";
import {
  isUiSelectedGlobalSessionKey,
  resolveUiSelectedSessionAgentId,
} from "../../lib/sessions/session-key.ts";
import { captureChatConnectionOwner } from "./chat-connection-owner.ts";
import { chatHistoryOlderSelector, requestOlderChatHistoryPage } from "./chat-history-request.ts";
import { formatChatHistoryLoadError } from "./chat-history-retry.ts";
import { resolveChatHistoryPagination } from "./chat-history-snapshot.ts";
import { requiresChatHistoryReload } from "./chat-history.ts";
import type { ChatState } from "./chat-state-contract.ts";
import type { ChatInputHistoryReader } from "./input-history.ts";

export function createChatInputHistoryReader(state: ChatState): ChatInputHistoryReader | undefined {
  const client = state.client;
  let selector = chatHistoryOlderSelector(state);
  if (!client || !state.connected || !selector) {
    return undefined;
  }

  const sessionKey = state.sessionKey;
  const sessionId = state.currentSessionId;
  const sessions = state.sessions;
  const selectedAgent = isUiSelectedGlobalSessionKey(state, sessionKey)
    ? resolveUiSelectedSessionAgentId(state)
    : undefined;
  const ownsConnection = captureChatConnectionOwner(state);
  const capturedBoundary =
    "messageId" in selector
      ? nativeHistoryMessageSourceIdentity(oldestNativeHistoryMessage(state.chatMessages))
      : undefined;
  const isCurrent = () =>
    ownsConnection() &&
    state.sessionKey === sessionKey &&
    state.currentSessionId === sessionId &&
    state.sessions === sessions &&
    (isUiSelectedGlobalSessionKey(state, state.sessionKey)
      ? resolveUiSelectedSessionAgentId(state)
      : undefined) === selectedAgent;

  return async () => {
    if (!selector || !isCurrent()) {
      return undefined;
    }

    const requested = selector;
    try {
      const result = await requestOlderChatHistoryPage(
        client,
        sessionKey,
        selectedAgent,
        requested,
        isCurrent,
      );
      if (!isCurrent()) {
        return undefined;
      }
      if (
        requiresChatHistoryReload(
          result,
          sessionId?.trim() ?? "",
          "messageId" in requested ? capturedBoundary : undefined,
        )
      ) {
        throw new Error(t("chat.thread.earlierInterrupted"));
      }

      const nextPagination = resolveChatHistoryPagination(result);
      if (nextPagination.hasMore) {
        const nextCursor = nextPagination.olderCursor;
        if (!nextCursor?.trim() || ("cursor" in requested && nextCursor === requested.cursor)) {
          throw new Error(t("chat.thread.earlierInterrupted"));
        }
        selector = { cursor: nextCursor };
      } else {
        selector = null;
      }

      return {
        // Boundary probes return the already loaded anchor, not older recall inputs.
        messages: "messageId" in requested ? [] : result.messages,
        hasMore: selector !== null,
      };
    } catch (error) {
      if (isCurrent()) {
        state.chatError = formatChatHistoryLoadError(error);
      }
      throw error;
    }
  };
}
