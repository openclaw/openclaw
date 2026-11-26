import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { readTranscriptDisplayPosition } from "../../../../src/chat/transcript-display-position.ts";
import { nativeHistoryMessageSourceIdentity } from "../../lib/chat/history-message-identity.ts";

export function nativeHistoryMessagePosition(message: unknown) {
  return readTranscriptDisplayPosition(
    asNullableRecord(asNullableRecord(message)?.["__openclaw"])?.transcriptPosition,
  );
}

/** A trimmed snapshot must retain a physical suffix that its older cursor can refill. */
export function chatHistoryTrimOrder(messages: readonly unknown[]): Uint32Array | undefined {
  const positions = messages.map(nativeHistoryMessagePosition);
  let order: Uint32Array | undefined;
  for (let start = 0; start < positions.length;) {
    const first = positions[start];
    let end = start + 1;
    if (first) {
      let previous = first;
      let relocated = Boolean(first.activity);
      let inverted = false;
      while (end < positions.length) {
        const next = positions[end];
        // Unpositioned rows and distinct transcript generations are ordering barriers.
        if (!next || next.source !== first.source) {
          break;
        }
        inverted ||= next.rawSeq < previous.rawSeq;
        relocated ||= Boolean(next.activity);
        previous = next;
        end++;
      }
      if (relocated && inverted) {
        order ??= Uint32Array.from({ length: messages.length }, (_, index) => index);
        const physical = order
          .subarray(start, end)
          .toSorted((a, b) => positions[a]!.rawSeq - positions[b]!.rawSeq);
        order.set(physical, start);
      }
    }
    start = end;
  }
  return order;
}

/** Mounted geometry custody contains source names only, never transcript bodies. */
export type ChatTranscriptReaderSnapshot = {
  anchor: string | null;
  visibleSources: readonly string[];
};

export type ChatHistorySegment = {
  sources: readonly string[];
  olderCursor?: string;
  newerCursor?: string;
  hasOlder: boolean;
  hasNewer: boolean;
  // Only intact, bounded wire admission can certify otherwise unreopenable cuts.
  boundedPacket?: true;
};

type ResidentHistoryCoverage = {
  // Only the admitted indivisible source is exempt; reader custody is separate.
  intrinsicSource?: string;
  newerCursor?: string;
  hasNewer?: true;
  needsNewerBoundary?: true;
  segments?: readonly ChatHistorySegment[];
};

export type ChatHistoryPagination = ResidentHistoryCoverage &
  (
    | { hasMore: false; totalMessages?: number; completeSnapshot?: true }
    | {
        hasMore: true;
        olderCursor?: string;
        // Cache trimming removes the page edge. Reopen the held source boundary,
        // rather than using a fresh tail's cursor and skipping discarded rows.
        needsBoundary?: true;
        nextOffset?: number;
        totalMessages?: number;
      }
  );

/** A delta cursor is usable only with the transcript already adopted by this pane. */
export type ChatHistoryCursor = {
  cursor: string;
  snapshotKey: string;
  sessionId: string | null;
};

export function trimmedChatHistoryPagination(
  pagination: ChatHistoryPagination,
  messages: readonly unknown[],
  start = 0,
): ChatHistoryPagination {
  return {
    hasMore: true,
    ...(pagination.intrinsicSource &&
    messages.some(
      (message, index) =>
        index >= start &&
        nativeHistoryMessageSourceIdentity(message) === pagination.intrinsicSource,
    )
      ? { intrinsicSource: pagination.intrinsicSource }
      : {}),
    needsBoundary: true,
    ...(pagination.hasNewer ? { hasNewer: true as const, needsNewerBoundary: true as const } : {}),
    ...(pagination.totalMessages !== undefined ? { totalMessages: pagination.totalMessages } : {}),
  };
}

export function sameChatHistoryPagination(
  left: ChatHistoryPagination,
  right: ChatHistoryPagination,
): boolean {
  if (
    left.hasMore !== right.hasMore ||
    left.totalMessages !== right.totalMessages ||
    left.intrinsicSource !== right.intrinsicSource ||
    left.hasNewer !== right.hasNewer ||
    left.newerCursor !== right.newerCursor ||
    left.needsNewerBoundary !== right.needsNewerBoundary ||
    JSON.stringify(left.segments) !== JSON.stringify(right.segments)
  ) {
    return false;
  }
  if (left.hasMore && right.hasMore) {
    return (
      left.nextOffset === right.nextOffset &&
      left.olderCursor === right.olderCursor &&
      left.needsBoundary === right.needsBoundary
    );
  }
  return !left.hasMore && !right.hasMore && left.completeSnapshot === right.completeSnapshot;
}

/** Traversal changes navigation, not the original held packet's body certificate. */
export function advanceChatHistoryNavigation(
  previous: ChatHistoryPagination,
  next: ChatHistoryPagination,
  direction: "older" | "newer",
): ChatHistoryPagination {
  if (direction === "older") {
    const navigation = { ...previous };
    // Older traversal retires a prior complete-snapshot claim.
    if (navigation.hasMore) {
      delete navigation.olderCursor;
      delete navigation.needsBoundary;
      delete navigation.nextOffset;
    } else {
      delete navigation.completeSnapshot;
    }
    return {
      ...navigation,
      ...(next.hasMore
        ? {
            hasMore: true as const,
            olderCursor: next.olderCursor,
            needsBoundary: next.needsBoundary,
            nextOffset: next.nextOffset,
          }
        : { hasMore: false as const }),
      totalMessages: next.totalMessages ?? previous.totalMessages,
    };
  }
  return {
    ...previous,
    totalMessages: next.totalMessages ?? previous.totalMessages,
    hasNewer: next.hasNewer,
    newerCursor: next.hasNewer ? next.newerCursor : undefined,
    needsNewerBoundary: next.hasNewer ? next.needsNewerBoundary : undefined,
  };
}
