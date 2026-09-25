import type { TranscriptReadWindow } from "./transcript-read-window.js";

export type TranscriptRecentReadLimits = {
  maxMessages: number;
  maxLines: number;
  maxBytes: number;
};

export type TranscriptAnchorPageOptions = {
  messageId: string;
  /** Includes the anchor; directional reads never backfill from the opposite side. */
  maxMessages: number;
  direction?: "older" | "newer";
  expectedReadWindow?: TranscriptReadWindow;
};

export function resolveTranscriptPageEnd(
  totalMessages: number,
  options: { beforeSeq?: number; offset?: number },
): number {
  const boundary =
    options.beforeSeq === undefined || !Number.isFinite(options.beforeSeq)
      ? totalMessages
      : Math.min(totalMessages, Math.max(0, Math.floor(options.beforeSeq) - 1));
  const offset = options.offset ?? 0;
  return Math.max(0, boundary - Math.max(0, Math.floor(Number.isFinite(offset) ? offset : 0)));
}

export function resolveHistoryAnchorPageRange(
  totalMessages: number,
  anchorPosition: number,
  { maxMessages, direction }: Pick<TranscriptAnchorPageOptions, "maxMessages" | "direction">,
) {
  const pageSize = Math.max(1, Math.floor(Number.isFinite(maxMessages) ? maxMessages : 1));
  if (direction) {
    const endExclusive =
      direction === "older"
        ? anchorPosition + 1
        : Math.min(totalMessages, anchorPosition + pageSize);
    const readStart = direction === "older" ? Math.max(0, endExclusive - pageSize) : anchorPosition;
    return {
      readStart,
      endExclusive,
      hasOverreadContext: false,
      offset: totalMessages - endExclusive,
    };
  }
  const newerMessages = Math.floor(pageSize / 2);
  const olderMessages = pageSize - newerMessages - 1;
  const latestStart = Math.max(0, totalMessages - pageSize);
  const start = Math.min(Math.max(0, anchorPosition - olderMessages), latestStart);
  const endExclusive = Math.min(totalMessages, start + pageSize);
  const readStart = Math.max(0, start - 1);
  return {
    readStart,
    endExclusive,
    hasOverreadContext: readStart < start,
    offset: totalMessages - endExclusive,
  };
}
