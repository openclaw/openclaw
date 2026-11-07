import type { JSX } from "@solidjs/web";
import {
  defaultRangeExtractor,
  elementScroll,
  measureElement,
  observeElementOffset,
  observeElementRect,
  Virtualizer,
  type VirtualItem,
} from "@tanstack/virtual-core";
import { createMemo, createProjection, createSignal, onSettled, Show } from "solid-js";
import { createLayoutMeasurement } from "../../../lib/reactive/layout-measurement.ts";

export type ModelPickerRowRenderer = (key: string, render: () => JSX.Element) => JSX.Element;

/** One scroll owner for grouped models, search results, targets, and accounts. */
export function createModelPickerWindow(
  rows: () => readonly string[],
  highlighted: () => string | undefined,
  shortcuts: () => readonly string[],
  allowNaturalLayout: () => boolean,
) {
  let viewport: HTMLDivElement;
  const naturalRows = createMemo(() =>
    allowNaturalLayout() && rows().length <= 24 ? new Set(rows()) : undefined,
  );
  const [window, setWindow] = createSignal<{ items: VirtualItem[]; height: number }>({
    items: [],
    height: 0,
  });
  const itemKey = createMemo(() => {
    const source = rows();
    return (index: number) => source[index]!;
  });
  const publish = () =>
    setWindow({ items: virtualizer.getVirtualItems(), height: virtualizer.getTotalSize() });
  const virtualizer = new Virtualizer<HTMLDivElement, HTMLDivElement>({
    count: 0,
    getScrollElement: () => viewport,
    // Composer choices have a 40px floor plus 2px row spacing.
    estimateSize: () => 42,
    observeElementRect,
    observeElementOffset,
    scrollToFn: elementScroll,
    overscan: 5,
    // Row measurement changes the list height; apply it outside resize delivery.
    useAnimationFrameWithResizeObserver: true,
    onChange: publish,
  });
  onSettled(() => {
    // Virtual-core exposes its adapter lifecycle as bound arrow functions.
    const { _didMount: mountVirtualizer } = virtualizer;
    return mountVirtualizer();
  });
  createLayoutMeasurement(
    () => ({
      rows: rows(),
      natural: naturalRows() !== undefined,
      highlighted: highlighted(),
      shortcuts: shortcuts(),
      itemKey: itemKey(),
    }),
    (next) => {
      if (!next) {
        return;
      }
      const pinned = new Set([...next.shortcuts, next.highlighted]);
      const pinnedIndexes = next.rows.flatMap((key, index) => (pinned.has(key) ? [index] : []));
      const naturalIndexes = next.natural ? next.rows.map((_, index) => index) : undefined;
      virtualizer.setOptions({
        ...virtualizer.options,
        count: next.rows.length,
        getItemKey: next.itemKey,
        // Natural rows size themselves before paint; ResizeObserver records their
        // sizes for a later transition to a long, positioned list.
        measureElement: next.natural
          ? (element, entry, instance) => (entry ? measureElement(element, entry, instance) : 42)
          : measureElement,
        // Keep the active descendant and digit shortcuts addressable offscreen.
        rangeExtractor: (range) =>
          naturalIndexes ??
          [...new Set([...defaultRangeExtractor(range), ...pinnedIndexes])].toSorted(
            (a, b) => a - b,
          ),
      });
      const { _willUpdate: updateVirtualizer } = virtualizer;
      updateVirtualizer();
      publish();
    },
    { targets: () => [viewport], changeTiming: "sync" },
  );
  const items = createProjection<Record<string, VirtualItem | undefined>>(() =>
    Object.fromEntries(window().items.map((item) => [item.key, item])),
  );
  const keys = createMemo(
    () => (naturalRows() ? rows() : window().items.map((item) => String(item.key))),
    {
      equals: (before, after) =>
        before.length === after.length && before.every((key, index) => key === after[index]),
    },
  );
  function Row(props: { rowKey: string; render: () => JSX.Element }) {
    let element: HTMLDivElement;
    onSettled(() => {
      virtualizer.measureElement(element);
      return () => virtualizer.measureElement(null);
    });
    return (
      <div
        ref={(node) => (element = node)}
        class={[
          "chat-controls__model-virtual-row",
          { "chat-controls__model-virtual-row--natural": Boolean(naturalRows()) },
        ]}
        data-index={naturalRows() ? rows().indexOf(props.rowKey) : items[props.rowKey]?.index}
        style={{
          transform: naturalRows() ? undefined : `translateY(${items[props.rowKey]?.start ?? 0}px)`,
        }}
      >
        {props.render()}
      </div>
    );
  }
  const renderRow: ModelPickerRowRenderer = (key, render) => (
    <Show when={naturalRows()?.has(key) ?? items[key]}>
      <Row rowKey={key} render={render} />
    </Show>
  );
  return {
    bind: (element: HTMLDivElement) => (viewport = element),
    height: () => (naturalRows() ? undefined : `${window().height}px`),
    keys,
    has: (key: string) => naturalRows()?.has(key) ?? Boolean(items[key]),
    renderRow,
    reveal(key: string) {
      const index = rows().indexOf(key);
      if (index >= 0) {
        const row = virtualizer.measurementsCache[index];
        const top = virtualizer.scrollOffset ?? 0;
        const height = virtualizer.scrollRect?.height ?? 0;
        // Leave any pending reveal to settle; an in-view key needs no new scroll.
        if (row && row.start >= top && row.end <= top + height) {
          return;
        }
        virtualizer.scrollToIndex(index, { align: "auto" });
        publish();
      }
    },
  };
}
