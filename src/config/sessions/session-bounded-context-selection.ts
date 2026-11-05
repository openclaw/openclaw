import {
  DEFAULT_VISIBLE_MESSAGE_MAX_BYTES,
  DEFAULT_VISIBLE_MESSAGE_MAX_MESSAGES,
  MAX_VISIBLE_MESSAGE_MAX_BYTES,
  MAX_VISIBLE_MESSAGE_MAX_MESSAGES,
  normalizeVisibleMessageLimit,
} from "./session-accessor.sqlite-visible-cursor.js";
import type { SessionTranscriptContextSelection } from "./session-history-read.types.js";

export function normalizeBoundedContextLimits(selection: SessionTranscriptContextSelection) {
  // Compaction keeps its complete semantic window independently of replay limits.
  return "compaction" in selection
    ? undefined
    : {
        maxBytes: normalizeVisibleMessageLimit(
          selection.maxBytes,
          DEFAULT_VISIBLE_MESSAGE_MAX_BYTES,
          MAX_VISIBLE_MESSAGE_MAX_BYTES,
          "maxBytes",
        ),
        maxEvents: normalizeVisibleMessageLimit(
          selection.maxEvents,
          DEFAULT_VISIBLE_MESSAGE_MAX_MESSAGES,
          MAX_VISIBLE_MESSAGE_MAX_MESSAGES,
          "maxEvents",
        ),
      };
}

/** The newest contiguous eligible rows must fit together with the canonical header. */
export function selectBoundedContextRows<T extends { serialized_bytes: number }>(
  rows: Iterable<T>,
  headerBytes: number,
  limits?: { maxBytes: number; maxEvents: number },
): { selectedRows: T[]; serializedBytes: number; truncated: boolean } {
  if (limits && headerBytes > limits.maxBytes) {
    throw new RangeError("Session transcript header exceeds the active-context byte limit");
  }
  const selectedRows: T[] = [];
  let serializedBytes = headerBytes;
  let truncated = false;
  for (const row of rows) {
    if (
      limits &&
      (selectedRows.length >= limits.maxEvents ||
        serializedBytes + row.serialized_bytes > limits.maxBytes)
    ) {
      truncated = true;
      break;
    }
    selectedRows.push(row);
    serializedBytes += row.serialized_bytes;
  }
  return { selectedRows, serializedBytes, truncated };
}
