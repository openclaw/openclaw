import { classifyToolUseResultPairing } from "../../../packages/agent-core/src/harness/session/tool-result-pairing.js";
import type { AgentMessage } from "../../../packages/agent-core/src/types.js";
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

/** Shared cut policy; cold readers measure payloads lazily from newest to oldest. */
export function selectBoundedContextStart(
  messages: readonly AgentMessage[],
  maxBytes: number,
  tokenBudget: number | undefined,
  measure: (index: number) => { bytes: number; tokens: number },
): number {
  let bytes = 2;
  let tokens = 0;
  let cut = messages.length;
  let exceedsByteBudget = false;
  for (let index = messages.length - 1; index >= 0; index--) {
    const size = measure(index);
    bytes += size.bytes + 1;
    tokens += size.tokens;
    if (bytes > maxBytes) {
      exceedsByteBudget = true;
      break;
    }
    if (tokenBudget !== undefined && tokens > tokenBudget) {
      continue;
    }
    if (index === 0 || messages[index]!.role === "user") {
      cut = index;
    }
  }
  // Ordinary token pressure still belongs to semantic compaction.
  if (!exceedsByteBudget) {
    return 0;
  }
  // Pairing uses the complete navigation, including calls outside the measured suffix.
  for (const frame of classifyToolUseResultPairing(messages)) {
    if (frame.startIndex >= cut) {
      break;
    }
    for (const occurrence of frame.occurrences) {
      if (occurrence.sourceResultIndex !== undefined && occurrence.sourceResultIndex >= cut) {
        cut = occurrence.sourceResultIndex + 1;
        while (cut < messages.length && messages[cut]?.role !== "user") {
          cut++;
        }
      }
    }
  }
  return cut;
}
