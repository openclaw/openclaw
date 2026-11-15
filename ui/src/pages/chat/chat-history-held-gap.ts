import {
  nativeHistoryMessageSourceId,
  prependUniqueNativeMessages,
} from "../../lib/chat/history-message-identity.ts";
import type { ChatHistoryPagination } from "./chat-history-pagination.ts";
import {
  CHAT_HISTORY_OLDER_PAGE_LIMIT,
  requestOlderChatHistoryPage,
} from "./chat-history-request.ts";
import {
  type ChatHistoryResult,
  historySessionId,
  resolveChatHistoryPagination,
  nativeHistoryMessagePosition,
  oldestPositionedHistoryMessage,
} from "./chat-history-snapshot.ts";
import type { ChatState } from "./chat-state-contract.ts";

/**
 * Older cursor for the rows between the pane's held oldest edge
 * and a bounded tail that no longer reaches it. The older page and the tail are
 * both server rows, so filling the gap never trusts held live rows. Gaps larger
 * than one older page keep the lazy boundary.
 */
function heldHistoryGapCursor(options: {
  result: ChatHistoryResult;
  previousMessages: unknown[];
  previousPagination: ChatHistoryPagination;
  previousSessionId: string | null;
}): string | null {
  const next = resolveChatHistoryPagination(options.result);
  if (
    !next.hasMore ||
    !next.olderCursor ||
    next.nextOffset === undefined ||
    next.totalMessages === undefined ||
    options.result.windowReset === true ||
    options.previousMessages.length === 0 ||
    !options.previousSessionId ||
    options.previousSessionId !== historySessionId(options.result)
  ) {
    return null;
  }
  const previous = options.previousPagination;
  const edge = oldestPositionedHistoryMessage(options.result.messages ?? []);
  const firstId = nativeHistoryMessageSourceId(edge?.message ?? options.result.messages?.[0]);
  if (
    previous.hasMore &&
    firstId &&
    options.previousMessages.some((message) => {
      const position = nativeHistoryMessagePosition(message);
      return (
        nativeHistoryMessageSourceId(message) === firstId &&
        (!edge ||
          (position?.source === edge.position.source && position.rawSeq === edge.position.rawSeq))
      );
    })
  ) {
    return null;
  }
  const omittedPrefix = previous.hasMore
    ? previous.totalMessages !== undefined && previous.nextOffset !== undefined
      ? previous.totalMessages - previous.nextOffset
      : undefined
    : 0;
  const gap =
    omittedPrefix === undefined ? undefined : next.totalMessages - next.nextOffset - omittedPrefix;
  // Raw counts bound one authoritative read, never certify the held ancestry.
  return gap !== undefined && gap >= 0 && gap <= CHAT_HISTORY_OLDER_PAGE_LIMIT
    ? next.olderCursor
    : null;
}

/**
 * Compaction and Stop can reset a delta cursor to a bounded tail.
 * Read the gap to the oldest edge this pane already shows before publishing,
 * so held rows never become earlier history. A failed read keeps the tail and
 * its retryable boundary.
 */
export async function fillHeldHistoryGap<Tail extends ChatHistoryResult>(
  state: ChatState,
  client: NonNullable<ChatState["client"]>,
  sessionKey: string,
  requestAgentId: string | undefined,
  tail: Tail,
  isCurrent: () => boolean,
  signal: AbortSignal,
): Promise<Tail> {
  const cursor = heldHistoryGapCursor({
    result: tail,
    previousMessages: state.chatMessages,
    previousPagination: state.chatHistoryPagination,
    previousSessionId: state.currentSessionId ?? null,
  });
  const older = cursor
    ? await requestOlderChatHistoryPage(
        client,
        sessionKey,
        requestAgentId,
        { cursor },
        isCurrent,
        signal,
      ).catch(() => undefined)
    : undefined;
  if (!older || older.windowReset || historySessionId(older) !== historySessionId(tail)) {
    return tail;
  }
  return {
    ...tail,
    messages: prependUniqueNativeMessages(older.messages ?? [], tail.messages ?? []),
    hasMore: older.hasMore,
    olderCursor: older.olderCursor,
    nextOffset: older.nextOffset,
  };
}
