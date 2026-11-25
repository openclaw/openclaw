import {
  captureOlderHistoryClaim,
  chatHistoryBoundarySelector,
  chatHistoryOlderSelector,
} from "./chat-history-request.ts";
import { acceptsHistoryResult } from "./chat-history-state.ts";
import type { ChatState } from "./chat-state-contract.ts";

export type ChatInputHistoryReader = NonNullable<ReturnType<typeof createChatInputHistoryReader>>;

export function createChatInputHistoryReader(state: ChatState) {
  const client = state.client;
  const selector = chatHistoryOlderSelector(state);
  if (!client || !state.connected || !selector) {
    return undefined;
  }
  const sessionId = state.currentSessionId;
  const claim = captureOlderHistoryClaim(state, client);
  const pagination = state.chatHistoryPagination;
  const cursor: { selector: ReturnType<typeof chatHistoryOlderSelector>; boundaryId?: string } = {
    selector,
    boundaryId: "messageId" in selector ? selector.messageId : undefined,
  };
  return {
    state,
    claim,
    sessionId,
    cursor,
    isCurrent: () =>
      acceptsHistoryResult(state, claim) &&
      state.currentSessionId === sessionId &&
      state.chatHistoryPagination === pagination &&
      (!cursor.boundaryId || chatHistoryBoundarySelector(state)?.messageId === cursor.boundaryId),
  };
}
