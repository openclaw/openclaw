import { resetChatHistoryProjection } from "./chat-history-state.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { resolveChatSnapshotKey } from "./session-message-cache.ts";
import { subscribeSnapshotInvalidation } from "./session-snapshot-invalidation-events.ts";

export function subscribeChatPaneSnapshotInvalidation(
  getState: () => ChatPageHost | undefined,
  onInvalidate?: () => void,
): () => void {
  return subscribeSnapshotInvalidation(({ sessionKey, scopePrefix, reason }) => {
    // Cache eviction must preserve the active transcript and its completed load.
    const state = getState();
    if (
      reason === "cache-eviction" ||
      !state ||
      (scopePrefix &&
        !resolveChatSnapshotKey(state, { sessionKey: state.sessionKey }).startsWith(scopePrefix)) ||
      (sessionKey && resolveChatSnapshotKey(state, { sessionKey: state.sessionKey }) !== sessionKey)
    ) {
      return;
    }
    onInvalidate?.();
    resetChatHistoryProjection(state);
  });
}
