export type ChatHistoryPagination =
  | { hasMore: false; totalMessages?: number; completeSnapshot?: true }
  | {
      hasMore: true;
      olderCursor?: string;
      // Cache trimming removes the page edge. Reopen the held source boundary,
      // rather than using a fresh tail's cursor and skipping discarded rows.
      needsBoundary?: true;
      nextOffset?: number;
      totalMessages?: number;
    };

/** A delta cursor is usable only with the transcript already adopted by this pane. */
export type ChatHistoryCursor = {
  cursor: string;
  snapshotKey: string;
  sessionId: string | null;
};

export function trimmedChatHistoryPagination(
  pagination: ChatHistoryPagination,
): ChatHistoryPagination {
  return {
    hasMore: true,
    needsBoundary: true,
    ...(pagination.totalMessages !== undefined ? { totalMessages: pagination.totalMessages } : {}),
  };
}
