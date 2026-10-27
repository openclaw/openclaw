export type ChatHistoryPagination =
  | { hasMore: false; totalMessages?: number; completeSnapshot?: true }
  | { hasMore: true; nextOffset: number; totalMessages?: number };

/** A delta cursor is usable only with the transcript already adopted by this pane. */
export type ChatHistoryCursor = {
  cursor: string;
  snapshotKey: string;
  sessionId: string | null;
};
