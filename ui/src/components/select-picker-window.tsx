import type { JSX } from "@solidjs/web";
import {
  defaultRangeExtractor,
  elementScroll,
  observeElementOffset,
  observeElementRect,
  Virtualizer,
} from "@tanstack/virtual-core";
import { createMemo, createSignal, For, onSettled } from "solid-js";
import { createLayoutMeasurement } from "../lib/reactive/layout-measurement.ts";
import { createScrollPosition } from "../lib/reactive/scroll-state.ts";
import type { PickerOption } from "./select-picker-types.ts";

export type PickerWindowRow<Option> = {
  option: Option;
  index: number;
  count: number;
  start: number;
};

/** Mounted only for an open, caller-sized large picker. The menu owns selection;
 * virtual-core owns geometry, and the existing scroll primitive owns reveal. */
export default function PickerWindow<Option extends PickerOption>(props: {
  options: readonly Option[];
  active: string | null;
  viewport: () => HTMLDivElement;
  target: () => HTMLDivElement | undefined;
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
  const virtualizer = new Virtualizer<HTMLDivElement, HTMLDivElement>({
    count: 0,
    getScrollElement: props.viewport,
    estimateSize: () => 32,
    observeElementRect,
    observeElementOffset,
    scrollToFn: elementScroll,
    overscan: 5,
    useAnimationFrameWithResizeObserver: true,
    onChange: publish,
  });
  const [registeredActive, setRegisteredActive] = createSignal<HTMLDivElement>();
  const measureRow = (element: HTMLDivElement | null) => {
    virtualizer.measureElement(element);
    if (element && element === props.target()) {
      setRegisteredActive(element);
    }
  };
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
    },
    { targets: () => [props.viewport()], changeTiming: "sync" },
  );
  // The first spacer supplies a measurable viewport before the library has a range.
  const height = () =>
    window().source === props.options ? window().height : props.options.length * 32;
  const rows = () => (window().source === props.options ? window().rows : []);
  const activeTarget = createMemo(() => {
    const registered = registeredActive();
    const active = props.active;
    return props.target() ?? (registered?.dataset.value === active ? registered : undefined);
  });
  // Row registration admits reveal after DOM commit without waiting for a WebKit frame.
  createScrollPosition(
    () => {
      const staticTarget = activeTarget();
      return {
        reveal: staticTarget
          ? {
              identity: [props.options, props.active, staticTarget],
              target: () => (props.pointerHighlight() ? undefined : staticTarget),
            }
          : undefined,
      };
    },
    { region: props.viewport },
  );
  return (
    <div class="picker-select__window" style={{ height: `${height()}px` }}>
      <For each={rows()} keyed={(row) => row.option.value}>
        {(row) => props.renderRow(row, measureRow)}
      </For>
    </div>
  );
}
