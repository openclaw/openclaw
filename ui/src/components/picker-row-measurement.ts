import { measureElement, type Virtualizer } from "@tanstack/virtual-core";

export function measurePickerRow(
  element: HTMLDivElement,
  entry: ResizeObserverEntry | undefined,
  virtualizer: Virtualizer<HTMLDivElement, HTMLDivElement>,
): number {
  if (entry) {
    return measureElement(element, entry, virtualizer);
  }
  // Registration uses owned geometry; the observer supplies the first real size.
  // Reading each new row synchronously forces repeated layout in WebKit.
  const index = virtualizer.indexFromElement(element);
  return (
    virtualizer.itemSizeCache.get(virtualizer.options.getItemKey(index)) ??
    virtualizer.options.estimateSize(index)
  );
}
