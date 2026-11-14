import type { Range, Virtualizer } from "@tanstack/virtual-core";

/** Commit row keys with the header change in one setOptions; the scroll margin is relative. */
export function commitTranscriptRows(
  virtualizer: Virtualizer<HTMLDivElement, HTMLElement>,
  keys: readonly string[],
  headerDelta: number,
  rangeExtractor: (range: Range) => number[],
): void {
  virtualizer.setOptions({
    ...virtualizer.options,
    count: keys.length,
    getItemKey: (index) => keys[index]!,
    rangeExtractor,
    scrollMargin: virtualizer.options.scrollMargin + headerDelta,
  });
}

/** Compensate a header change when unchanged row keys do not trigger a prepend anchor. */
export function reconcileTranscriptHeaderMargin(
  virtualizer: Virtualizer<HTMLDivElement, HTMLElement>,
  headerHeight: number,
  appliedHeaderHeight: number,
): number {
  if (headerHeight === appliedHeaderHeight) {
    return appliedHeaderHeight;
  }
  const delta = headerHeight - appliedHeaderHeight;
  virtualizer.setOptions({
    ...virtualizer.options,
    scrollMargin: virtualizer.options.scrollMargin + delta,
  });
  const offset = virtualizer.scrollOffset;
  const next = offset === null ? null : Math.max(0, offset + delta);
  if (next !== null && next !== offset) {
    virtualizer.scrollOffset = next;
    virtualizer.scrollToOffset(next);
  }
  return headerHeight;
}
