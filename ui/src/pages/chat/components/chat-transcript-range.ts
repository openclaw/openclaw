import { defaultRangeExtractor, type Range, Virtualizer } from "@tanstack/virtual-core";

export function extractTranscriptRange(
  range: Range,
  rowIndexesByKey: ReadonlyMap<string, number>,
  retainedRowKeys: readonly (string | null)[],
): number[] {
  const indexes = defaultRangeExtractor(range);
  for (const key of retainedRowKeys) {
    const index = key === null ? undefined : rowIndexesByKey.get(key);
    if (index !== undefined && index >= 0 && index < range.count && !indexes.includes(index)) {
      indexes.push(index);
    }
  }
  return indexes.toSorted((left, right) => left - right);
}

export function previewTranscriptRowKeys(
  virtualizer: Virtualizer<HTMLDivElement, HTMLElement>,
  nextKeys: readonly string[],
  focusedRowKey: string | null,
): Set<string> {
  const nextIndexes = new Map(nextKeys.map((key, index) => [key, index]));
  const preview = new Virtualizer<HTMLDivElement, HTMLElement>({
    ...virtualizer.options,
    initialMeasurementsCache: virtualizer.takeSnapshot(),
    initialOffset: virtualizer.scrollOffset ?? virtualizer.options.initialOffset,
    initialRect: virtualizer.scrollRect ?? virtualizer.options.initialRect,
    onChange: () => undefined,
    rangeExtractor: (range) => extractTranscriptRange(range, nextIndexes, [focusedRowKey]),
  });
  preview.scrollElement = virtualizer.scrollElement;
  // Isolate the fork's key-anchor transition so teardown selection cannot
  // advance the model owned by connected DOM.
  preview.setOptions({
    ...preview.options,
    count: nextKeys.length,
    getItemKey: (index) => nextKeys[index] ?? `missing:${index}`,
  });
  return new Set(preview.getVirtualIndexes().flatMap((index) => nextKeys[index] ?? []));
}

export function focusedTranscriptRowKey(
  scrollElement: HTMLElement | null,
  target: EventTarget | null,
): string | null {
  if (!(target instanceof Element) || !scrollElement?.contains(target)) {
    return null;
  }
  const row = target.closest<HTMLElement>(".chat-virtual-row[data-virtual-row-key]");
  return row && scrollElement.contains(row) ? row.dataset.virtualRowKey || null : null;
}
