import type { Virtualizer } from "@tanstack/virtual-core";
import { maxTranscriptScrollOffset } from "./chat-transcript-geometry.ts";

/** Return the loaded message at or preceding the viewport midpoint. */
export function activeTranscriptMessageId(
  scrollElement: HTMLDivElement | null,
  virtualizer: Virtualizer<HTMLDivElement, HTMLElement>,
  messageIds: readonly string[],
  messageRowKeysById: ReadonlyMap<string, string>,
  rowIndexesByKey: ReadonlyMap<string, number>,
): string | null {
  if (!scrollElement || messageIds.length === 0) {
    return null;
  }
  const maxOffset = maxTranscriptScrollOffset(scrollElement);
  // At the end, the last section owns the position even if the midpoint
  // still falls in the preceding row.
  if (maxOffset !== null && Math.abs(maxOffset - scrollElement.scrollTop) <= 1) {
    return messageIds.findLast((messageId) => messageRowKeysById.has(messageId)) ?? null;
  }
  // Measurements include scrollMargin; use the complete model rather than
  // the rendered range, which may lag a jump or contain a focused outlier.
  const activeRow = virtualizer.getVirtualItemForOffset(
    scrollElement.scrollTop + scrollElement.clientHeight * 0.5,
  );
  if (!activeRow) {
    return null;
  }
  let precedingId: string | null = null;
  for (const messageId of messageIds) {
    const rowKey = messageRowKeysById.get(messageId);
    const rowIndex = rowKey ? rowIndexesByKey.get(rowKey) : undefined;
    if (rowIndex === undefined) {
      continue;
    }
    if (rowIndex > activeRow.index) {
      return precedingId ?? messageId;
    }
    precedingId = messageId;
  }
  return precedingId;
}
