import { defaultRangeExtractor, type Range, Virtualizer } from "@tanstack/virtual-core";
import { findMcpAppUnmountTargets } from "../../../components/mcp-app-unmount.ts";
import type { TranscriptRow } from "./chat-transcript-layout.ts";
import {
  CHAT_TRANSCRIPT_ESTIMATED_ROW_PX,
  CHAT_TRANSCRIPT_OVERSCAN,
} from "./chat-transcript-session.ts";

export function extractTranscriptRange(
  range: Range,
  rowIndexesByKey: ReadonlyMap<string, number>,
  retainedRowKeys: readonly (string | null)[],
): number[] {
  // Keep both overscan neighbors in the first measurement pass. Truncating
  // completed rows can require another cold render before the same paint.
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
  nextRows: readonly TranscriptRow[],
  focusedRowKey: string | null,
): Set<string> {
  const nextIndexes = new Map(nextRows.map((row, index) => [row.key, index]));
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
    count: nextRows.length,
    getItemKey: (index) => nextRows[index]!.key,
    estimateSize: (index) => nextRows[index]?.estimatedSize ?? CHAT_TRANSCRIPT_ESTIMATED_ROW_PX,
    overscan: CHAT_TRANSCRIPT_OVERSCAN,
  });
  return new Set(preview.getVirtualIndexes().map((index) => nextRows[index]!.key));
}

export function leavingTranscriptMcpAppRows(
  root: ParentNode | null,
  readRenderedKeys: () => ReadonlySet<string>,
): HTMLElement[] {
  const appRows = new Set(
    (root ? findMcpAppUnmountTargets([root]) : []).flatMap(
      (app) => app.closest<HTMLElement>(".chat-virtual-row") ?? [],
    ),
  );
  if (appRows.size === 0) {
    return [];
  }
  const renderedKeys = readRenderedKeys();
  return [...appRows].filter((row) => !renderedKeys.has(row.dataset.virtualRowKey ?? ""));
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
