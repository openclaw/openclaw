import { t } from "../../i18n/index.ts";
import {
  nativeHistoryMessageSourceIdentity,
  oldestNativeHistoryMessage,
} from "../../lib/chat/history-message-identity.ts";
import {
  captureOlderHistoryClaim,
  chatHistoryBoundarySelector,
  chatHistoryOlderSelector,
  requestOlderChatHistoryPage,
} from "./chat-history-request.ts";
import { formatChatHistoryLoadError } from "./chat-history-retry.ts";
import { resolveChatHistoryPagination } from "./chat-history-snapshot.ts";
import { acceptsHistoryResult } from "./chat-history-state.ts";
import { requiresChatHistoryReload } from "./chat-history.ts";
import type { ChatState } from "./chat-state-contract.ts";
import type { ChatInputHistoryReader } from "./input-history.ts";

// The error surface outlives a traversal; a successful retry must not clear another error.
const recallErrors = new WeakMap<ChatState, string>();

export function createChatInputHistoryReader(state: ChatState): ChatInputHistoryReader | undefined {
  const client = state.client;
  let selector = chatHistoryOlderSelector(state);
  if (!client || !state.connected || !selector) {
    return undefined;
  }

  const sessionId = state.currentSessionId;
  const claim = captureOlderHistoryClaim(state, client);
  const pagination = state.chatHistoryPagination;
  let boundaryId = "messageId" in selector ? selector.messageId : undefined;
  const isCurrent = () =>
    acceptsHistoryResult(state, claim) &&
    state.currentSessionId === sessionId &&
    state.chatHistoryPagination === pagination &&
    (!boundaryId || chatHistoryBoundarySelector(state)?.messageId === boundaryId);
  return {
    isCurrent,
    async read(signal, ownsAction) {
      const requested = selector;
      const ownsRead = () => ownsAction() && isCurrent();
      if (!requested || !ownsRead()) {
        return undefined;
      }
      const boundary =
        "messageId" in requested
          ? nativeHistoryMessageSourceIdentity(oldestNativeHistoryMessage(state.chatMessages))
          : undefined;
      try {
        const result = await requestOlderChatHistoryPage(
          client,
          claim.sessionKey,
          claim.agentId,
          requested,
          ownsRead,
          signal,
        );
        if (!ownsRead()) {
          return undefined;
        }
        const next = resolveChatHistoryPagination(result);
        if (
          requiresChatHistoryReload(result, sessionId?.trim() ?? "", boundary) ||
          (next.hasMore &&
            (!next.olderCursor || ("cursor" in requested && requested.cursor === next.olderCursor)))
        ) {
          // Never retry a rejected private cursor. A later Up can reopen the held
          // source anchor without reloading or publishing a transcript window.
          selector = "cursor" in requested ? chatHistoryBoundarySelector(state) : null;
          boundaryId = selector?.messageId;
          throw new Error(t("chat.thread.earlierInterrupted"));
        }
        selector = next.hasMore && next.olderCursor ? { cursor: next.olderCursor } : null;
        const readError = recallErrors.get(state);
        if (readError && state.chatError === readError) {
          state.chatError = null;
        }
        recallErrors.delete(state);
        return {
          messages: "messageId" in requested ? [] : result.messages,
          hasMore: selector !== null,
        };
      } catch (error) {
        if (ownsRead()) {
          const readError = formatChatHistoryLoadError(error);
          recallErrors.set(state, readError);
          state.chatError = readError;
        }
        return undefined;
      }
    },
  };
}
