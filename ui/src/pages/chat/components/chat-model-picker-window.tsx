import type { JSX } from "@solidjs/web";
import {
  defaultRangeExtractor,
  elementScroll,
  observeElementOffset,
  observeElementRect,
  Virtualizer,
  type VirtualItem,
} from "@tanstack/virtual-core";
import { createMemo, createSignal, onSettled, Show } from "solid-js";
import { createLayoutMeasurement } from "../../../lib/reactive/layout-measurement.ts";

export type ModelPickerRowRenderer = (key: string, render: () => JSX.Element) => JSX.Element;

/** One scroll owner for grouped models, search results, targets, and accounts. */
export function createModelPickerWindow(
  rows: () => readonly string[],
  highlighted: () => string | undefined,
  shortcuts: () => readonly string[],
) {
  let viewport: HTMLDivElement;
  const [window, setWindow] = createSignal<{ items: VirtualItem[]; height: number }>({
    items: [],
    height: 0,
  });
  const publish = () =>
    setWindow({ items: virtualizer.getVirtualItems(), height: virtualizer.getTotalSize() });
  const virtualizer = new Virtualizer<HTMLDivElement, HTMLDivElement>({
    count: 0,
    getScrollElement: () => viewport,
    estimateSize: () => 32,
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
    () => ({ rows: rows(), highlighted: highlighted(), shortcuts: shortcuts() }),
    (next) => {
      if (!next) {
        return;
      }
      const pinned = new Set([...next.shortcuts, next.highlighted]);
      const pinnedIndexes = next.rows.flatMap((key, index) => (pinned.has(key) ? [index] : []));
      virtualizer.setOptions({
        ...virtualizer.options,
        count: next.rows.length,
        getItemKey: (index) => next.rows[index]!,
        // Keep the active descendant and digit shortcuts addressable offscreen.
        rangeExtractor: (range) =>
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
  const items = createMemo(() => new Map(window().items.map((item) => [item.key, item])));
  function Row(props: { rowKey: string; render: () => JSX.Element }) {
    let element: HTMLDivElement;
    onSettled(() => {
      virtualizer.measureElement(element);
      return () => virtualizer.measureElement(null);
    });
    return (
      <div
        ref={(node) => (element = node)}
        class="chat-controls__model-virtual-row"
        data-index={items().get(props.rowKey)?.index}
        style={{ transform: `translateY(${items().get(props.rowKey)?.start ?? 0}px)` }}
      >
        {props.render()}
      </div>
    );
  }
  const renderRow: ModelPickerRowRenderer = (key, render) => (
    <Show when={items().has(key)}>
      <Row rowKey={key} render={render} />
    </Show>
  );
  return {
    bind: (element: HTMLDivElement) => (viewport = element),
    height: () => window().height,
    has: (key: string) => items().has(key),
    renderRow,
    reveal(key: string) {
      const index = rows().indexOf(key);
      if (index >= 0) {
        virtualizer.scrollToIndex(index, { align: "auto" });
        publish();
      }
    },
  };
}
