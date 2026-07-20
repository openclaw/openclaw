export type ChatHistoryPagination =
  | { hasMore: false; totalMessages?: number; completeSnapshot?: true }
  | {
      hasMore: true;
      nextCursor: string;
      nextOffset?: number;
      totalMessages?: number;
    }
  | {
      hasMore: true;
      nextCursor?: undefined;
      nextOffset: number;
      totalMessages?: number;
    };
