import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { readTranscriptDisplayPosition } from "../../../../src/chat/transcript-display-position.ts";

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

export function sameChatHistoryPagination(
  left: ChatHistoryPagination,
  right: ChatHistoryPagination,
): boolean {
  if (left.hasMore !== right.hasMore || left.totalMessages !== right.totalMessages) {
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
