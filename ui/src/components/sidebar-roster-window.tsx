import {
  defaultRangeExtractor,
  elementScroll,
  observeElementOffset,
  observeElementRect,
  Virtualizer,
  type VirtualItem,
} from "@tanstack/virtual-core";
import { createMemo, createSignal, onSettled, useContext } from "solid-js";
import { createLayoutMeasurement } from "../lib/reactive/layout-measurement.ts";
import { SidebarScrollContext } from "./sidebar-context-controller.ts";

/** Roster headers have a fixed 44px track and a 2px gap. The shared sidebar
 * scroll owner retains the offset; the roster only limits mounted row content. */
export function createSidebarRosterWindow<T extends { id: string }>(
  cards: () => readonly T[],
  activeId: () => string | undefined,
) {
  const scroll = useContext(SidebarScrollContext);
  let list: HTMLDivElement;
  const [focusedId, setFocusedId] = createSignal<string>();
  const [itemsInView, setItemsInView] = createSignal<VirtualItem[]>([]);
  // Standalone renderer consumers without the shared sidebar have no viewport.
  if (!scroll) {
    return {
      bind: (element: HTMLDivElement) => (list = element),
      cards,
      height: () => undefined,
      position: (_id: string) => undefined,
      focus: (_id: string) => {},
    };
  }
  const viewport = () => scroll.element();
  const publish = () => setItemsInView(virtualizer.getVirtualItems());
  const virtualizer = new Virtualizer<HTMLElement, HTMLDivElement>({
    count: 0,
    getScrollElement: () => viewport() ?? null,
    estimateSize: () => 46,
    observeElementRect,
    observeElementOffset,
    scrollToFn: elementScroll,
    overscan: 2,
    onChange: publish,
  });
  onSettled(() => {
    const { _didMount: mountVirtualizer } = virtualizer;
    return mountVirtualizer();
  });
  createLayoutMeasurement(
    () => ({ cards: cards(), active: activeId(), focused: focusedId() }),
    (next) => {
      const scroller = viewport();
      if (!next || !scroller) {
        return;
      }
      const focusedIndex = next.cards.findIndex((card) => card.id === next.focused);
      const pinned = next.cards.flatMap((card, index) =>
        card.id === next.active || (focusedIndex >= 0 && Math.abs(index - focusedIndex) <= 1)
          ? [index]
          : [],
      );
      virtualizer.setOptions({
        ...virtualizer.options,
        count: next.cards.length,
        getItemKey: (index) => next.cards[index]!.id,
        scrollMargin:
          list.getBoundingClientRect().top -
          scroller.getBoundingClientRect().top +
          scroller.scrollTop,
        rangeExtractor: (range) =>
          [...new Set([...defaultRangeExtractor(range), ...pinned])].toSorted((a, b) => a - b),
      });
      const { _willUpdate: updateVirtualizer } = virtualizer;
      updateVirtualizer();
      publish();
    },
    {
      targets: () => [
        list,
        ...(viewport() ? [viewport()!] : []),
        ...(scroll.content() ? [scroll.content()!] : []),
      ],
      changeTiming: "sync",
    },
  );
  const items = createMemo(() => new Map(itemsInView().map((item) => [item.key, item])));
  return {
    bind: (element: HTMLDivElement) => (list = element),
    cards: () => cards().filter((card) => items().has(card.id)),
    // Reserve the complete fixed-height list before mount, including when the
    // parent restores its scroll position during the first reactive settle.
    height: () => `${cards().length * 46}px`,
    position: (id: string) => {
      const item = items().get(id);
      return item ? `${item.start - virtualizer.options.scrollMargin}px` : undefined;
    },
    focus: setFocusedId,
  };
}
