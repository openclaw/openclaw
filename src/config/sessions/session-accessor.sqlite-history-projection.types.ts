export type VisibleHistoryBoundary = {
  displayPosition: number;
  eventId: string;
  eventSeq: number;
  messagePosition: number;
  serializedBytes: number;
};

export type VisibleHistoryProjection = {
  boundaries: VisibleHistoryBoundary[];
  boundariesById: Map<string, VisibleHistoryBoundary>;
  boundariesBySeq: Map<number, VisibleHistoryBoundary>;
  displaySource?: string;
  latestResetRawSeq: number | null;
  total: number;
};
