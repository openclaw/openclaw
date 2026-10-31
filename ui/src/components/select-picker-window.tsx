import type { JSX } from "@solidjs/web";
import {
  defaultRangeExtractor,
  elementScroll,
  observeElementOffset,
  observeElementRect,
  Virtualizer,
} from "@tanstack/virtual-core";
import { createSignal, For, onSettled } from "solid-js";
import { createLayoutMeasurement } from "../lib/reactive/layout-measurement.ts";
import { measureObservedRow, revealVirtualRow } from "../lib/virtual-row-geometry.ts";
import type { PickerOption } from "./select-picker-types.ts";

export type PickerWindowRow<Option> = {
  option: Option;
  index: number;
  count: number;
  start: number;
};

/** Mounted only for an open, caller-sized large picker. The menu owns selection;
 * virtual-core owns row geometry and reveal. */
export default function PickerWindow<Option extends PickerOption>(props: {
  options: readonly Option[];
  active: string | null;
  viewport: () => HTMLDivElement;
  pointerHighlight: () => boolean;
  renderRow: (
    row: () => PickerWindowRow<Option>,
    measure: (element: HTMLDivElement | null) => void,
  ) => JSX.Element;
}) {
  let current: readonly Option[] = [];
  const [window, setWindow] = createSignal<{
    source: readonly Option[];
    rows: PickerWindowRow<Option>[];
    height: number;
  }>({ source: [], rows: [], height: 0 });
  const publish = () =>
    setWindow({
      source: current,
      rows: virtualizer.getVirtualItems().map((item) => ({
        option: current[item.index]!,
        index: item.index,
        count: current.length,
        start: item.start,
      })),
      height: virtualizer.getTotalSize(),
    });
  const reveal = (index: number) => {
    if (!props.pointerHighlight()) {
      revealVirtualRow(virtualizer, index);
    }
  };
  const virtualizer = new Virtualizer<HTMLDivElement, HTMLDivElement>({
    count: 0,
    getScrollElement: props.viewport,
    estimateSize: () => 32,
    measureElement: (element, entry, instance) => {
      const size = measureObservedRow(element, entry, instance);
      if (entry && element.dataset.value === props.active) {
        // A wrapped active row can outgrow its estimate after the initial reveal.
        onSettled(() => reveal(instance.indexFromElement(element)));
      }
      return size;
    },
    observeElementRect,
    observeElementOffset,
    scrollToFn: elementScroll,
    overscan: 5,
    useAnimationFrameWithResizeObserver: true,
    onChange: publish,
  });
  onSettled(() => {
    const { _didMount: mount } = virtualizer;
    return mount();
  });
  createLayoutMeasurement(
    () => ({ rows: props.options, active: props.active }),
    (next) => {
      if (!next) {
        return;
      }
      current = next.rows;
      const activeIndex = current.findIndex((option) => option.value === next.active);
      virtualizer.setOptions({
        ...virtualizer.options,
        count: current.length,
        getItemKey: (index) => current[index]!.value,
        rangeExtractor: (range) =>
          [
            ...new Set([
              ...defaultRangeExtractor(range),
              ...(activeIndex < 0 ? [] : [activeIndex]),
            ]),
          ].toSorted((a, b) => a - b),
      });
      const { _willUpdate: update } = virtualizer;
      update();
      publish();
      // Commit the spacer and rows before scrolling against their geometry.
      if (activeIndex >= 0) {
        onSettled(() => reveal(activeIndex));
      }
    },
    { targets: () => [props.viewport()], changeTiming: "sync" },
  );
  // The first spacer supplies a measurable viewport before the library has a range.
  const height = () =>
    window().source === props.options ? window().height : props.options.length * 32;
  const rows = () => (window().source === props.options ? window().rows : []);
  return (
    <div class="picker-select__window" style={{ height: `${height()}px` }}>
      <For each={rows()} keyed={(row) => row.option.value}>
        {(row) => props.renderRow(row, virtualizer.measureElement)}
      </For>
    </div>
  );
}
