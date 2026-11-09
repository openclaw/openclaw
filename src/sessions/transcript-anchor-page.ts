import type { TranscriptReadWindow } from "./transcript-read-window.js";

export type TranscriptRecentReadLimits = {
  maxMessages: number;
  maxLines: number;
  maxBytes: number;
};

export type TranscriptAnchorPageOptions = {
  messageId: string;
  /** Reopen the interval before a closing reset anchor, excluding that reset marker. */
  closedResetInterval?: boolean;
  /** Includes the anchor unless closedResetInterval excludes its closing reset; directional reads never backfill. */
  maxMessages: number;
  /** Optional response bound enforced before a worker returns the page. */
  maxBytes?: number;
  direction?: "older" | "newer";
  expectedReadWindow?: TranscriptReadWindow;
};

/** Internal Gateway continuation; not part of TranscriptAnchorPageOptions or the RPC. */
export type TranscriptAnchorReadOptions = TranscriptAnchorPageOptions & {
  directionalPage?: true;
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
  {
    maxMessages,
    direction,
    directionalPage,
  }: Pick<TranscriptAnchorReadOptions, "maxMessages" | "direction" | "directionalPage">,
) {
  const pageSize = Math.max(1, Math.floor(Number.isFinite(maxMessages) ? maxMessages : 1));
  if (direction) {
    if (directionalPage) {
      const endExclusive =
        direction === "older"
          ? anchorPosition
          : Math.min(totalMessages, anchorPosition + 1 + pageSize);
      return {
        readStart:
          direction === "older"
            ? Math.max(0, endExclusive - pageSize)
            : Math.min(totalMessages, anchorPosition + 1),
        endExclusive,
        hasOverreadContext: false,
        offset: totalMessages - endExclusive,
      };
    }
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

/** Admit a contiguous range around the anchor before loading any payloads. */
export function boundHistoryAnchorPageRange(
  range: ReturnType<typeof resolveHistoryAnchorPageRange>,
  anchorPosition: number,
  maxBytes: number,
  byteSize: (position: number, remainingBytes: number) => number,
  rejectOversized = false,
) {
  let start = Math.max(range.readStart, Math.min(anchorPosition, range.endExclusive - 1));
  let endExclusive = start;
  let bytes = 2;
  const include = (position: number) => {
    const separator = start === endExclusive ? 0 : 1;
    const size = byteSize(position, maxBytes - bytes - separator) + separator;
    if (bytes + size > maxBytes) {
      if (rejectOversized && start === endExclusive) {
        throw new Error(`Transcript history message exceeds the ${maxBytes}-byte page limit`);
      }
      return false;
    }
    bytes += size;
    return true;
  };
  if (start < range.endExclusive) {
    if (!include(start)) {
      return { start, endExclusive };
    }
    endExclusive++;
  }
  while (start > range.readStart && include(start - 1)) {
    start--;
  }
  while (endExclusive < range.endExclusive && include(endExclusive)) {
    endExclusive++;
  }
  return { start, endExclusive };
}
