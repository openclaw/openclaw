import { measureElement, type Virtualizer } from "@tanstack/virtual-core";

/** Let the row observer supply layout; mounting each row must not flush it. */
export function measureObservedRow<Scroll extends Element | Window, Row extends Element>(
  element: Row,
  entry: ResizeObserverEntry | undefined,
  virtualizer: Virtualizer<Scroll, Row>,
): number {
  if (entry) {
    return measureElement(element, entry, virtualizer);
  }
  const index = virtualizer.indexFromElement(element);
  return (
    virtualizer.itemSizeCache.get(virtualizer.options.getItemKey(index)) ??
    virtualizer.options.estimateSize(index)
  );
}

/** Vertical picker rows already in view need no native scroll or reconciliation. */
export function revealVirtualRow<Scroll extends Element, Row extends Element>(
  virtualizer: Virtualizer<Scroll, Row>,
  index: number,
): void {
  const row = virtualizer.measurementsCache[index];
  const top = virtualizer.scrollOffset ?? 0;
  const height = virtualizer.scrollRect?.height ?? 0;
  if (row && row.start >= top && row.end <= top + height) {
    virtualizer.cancelScroll();
    return;
  }
  virtualizer.scrollToIndex(index, { align: "auto" });
}
