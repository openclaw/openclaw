import type { JSX } from "@solidjs/web";
import {
  defaultRangeExtractor,
  elementScroll,
  observeElementOffset,
  observeElementRect,
  Virtualizer,
  type VirtualItem,
} from "@tanstack/virtual-core";
import { createMemo, createSignal, For, onSettled, type Accessor } from "solid-js";
import { cancelLayout, scheduleLayout } from "../../lib/layout-frame.ts";
import type { PluginDiscoveryEntry } from "../../lib/plugins/index.ts";
import { observeDocumentRootAttributes } from "../../lib/reactive/document-root-attributes.ts";
import { createLayoutMeasurement } from "../../lib/reactive/layout-measurement.ts";
import { observeResize } from "../../lib/reactive/observers.ts";

/** Keep one keyed card list while row tracks limit layout to the visible catalog. */
export function PluginCatalogGrid(props: {
  items: readonly PluginDiscoveryEntry[];
  results?: boolean;
  children: (
    plugin: Accessor<PluginDiscoveryEntry>,
    contentRef: (element: HTMLDivElement) => void,
  ) => JSX.Element;
}) {
  let grid!: HTMLDivElement;
  let scroller: HTMLElement | null = null;
  let columns = 4;
  let gap = 12;
  let blockInset = 0;
  let sizingRows = false;
  const rowSizeKey = {};
  let keyInput: { items: readonly PluginDiscoveryEntry[]; columns: number } | undefined;
  let pinnedRows: number[] = [];
  let syncScrollOffset: (() => void) | undefined;
  let measuredFocus: Element | null | undefined;
  const mounted = new Map<string, { element: HTMLDivElement; height: number }>();
  const [focused, setFocused] = createSignal<string>();
  const [view, setView] = createSignal<{
    rows: VirtualItem[];
    height: number;
    columns: number;
    gap: number;
    available: boolean;
  }>({ rows: [], height: 0, columns, gap, available: true });
  const windowed = createMemo(() => props.items.length > 60 && view().available);
  const indexes = createMemo(
    () => new Map<VirtualItem["key"], number>(props.items.map((item, index) => [item.id, index])),
  );
  const publish = () => {
    if (sizingRows) {
      return;
    }
    const rows = virtualizer.getVirtualItems();
    const height = virtualizer.getTotalSize();
    setView((previous) =>
      previous.height === height &&
      previous.columns === columns &&
      previous.gap === gap &&
      previous.available === Boolean(scroller) &&
      previous.rows.length === rows.length &&
      previous.rows.every((row, index) => {
        const next = rows[index]!;
        return row.index === next.index && row.start === next.start && row.size === next.size;
      })
        ? previous
        : { rows, height, columns, gap, available: Boolean(scroller) },
    );
  };
  const virtualizer = new Virtualizer<HTMLElement, HTMLDivElement>({
    count: 0,
    enabled: false,
    getScrollElement: () => scroller,
    initialOffset: () => scroller?.scrollTop ?? 0,
    estimateSize: () => 124,
    observeElementRect,
    observeElementOffset: (instance, publishOffset) => {
      const element = instance.scrollElement!;
      const release = observeElementOffset(instance, publishOffset);
      syncScrollOffset = () => {
        const offset = element.scrollTop;
        if (offset !== instance.scrollOffset) {
          publishOffset(offset, true);
        }
      };
      return () => {
        syncScrollOffset = undefined;
        release?.();
      };
    },
    scrollToFn: elementScroll,
    overscan: 1,
    onChange: publish,
  });
  const syncFocusedOffset = () => {
    const activeElement = document.activeElement;
    // Native focus supersedes a pending clamped correction before _willUpdate can replay it.
    if (activeElement !== measuredFocus) {
      measuredFocus = activeElement;
      syncScrollOffset?.();
    }
  };
  const pinFocusedRows = (
    itemIndexes: Map<VirtualItem["key"], number>,
    columnCount: number,
    count: number,
    focusedId: string | undefined,
  ) => {
    // Endpoints admit native Tab from either direction; neighboring tracks
    // let focus keep advancing without measuring the grid again.
    const pinned = new Set([0, count - 1]);
    const focusedIndex = itemIndexes.get(focusedId ?? "");
    if (focusedIndex !== undefined) {
      const row = Math.floor(focusedIndex / columnCount);
      for (const index of [row - 1, row, row + 1]) {
        if (index >= 0 && index < count) {
          pinned.add(index);
        }
      }
    }
    const next = [...pinned];
    if (
      pinnedRows.length === next.length &&
      pinnedRows.every((row, index) => row === next[index])
    ) {
      return;
    }
    pinnedRows = next;
    virtualizer.setOptions({
      ...virtualizer.options,
      rangeExtractor: (range) =>
        [...new Set([...defaultRangeExtractor(range), ...next])].toSorted((a, b) => a - b),
    });
  };
  const rowHeights = (
    itemIndexes: Map<VirtualItem["key"], number>,
    columnCount: number,
    inset: number,
  ) => {
    const heights = new Map<number, number>();
    for (const [id, content] of mounted) {
      const index = itemIndexes.get(id);
      if (index !== undefined && content.height > 0) {
        const row = Math.floor(index / columnCount);
        heights.set(row, Math.max(heights.get(row) ?? 0, content.height + inset));
      }
    }
    return heights;
  };
  const resizeRows = (heights: Map<number, number>) => {
    sizingRows = true;
    try {
      for (const [index, height] of heights) {
        const offset = virtualizer.scrollOffset;
        virtualizer.resizeItem(index, height);
        // A compensated scroll changes where the next row sits relative to the fold.
        if (virtualizer.scrollOffset !== offset) {
          virtualizer.getTotalSize();
        }
      }
    } finally {
      sizingRows = false;
    }
    publish();
  };
  onSettled(() => {
    const { _didMount: mountVirtualizer } = virtualizer;
    const release = mountVirtualizer();
    // A settling template can still belong to an inert document before adoption.
    const stopStyles = observeDocumentRootAttributes(
      document,
      ["class", "style", "data-theme", "data-theme-id", "data-theme-mode"],
      measure,
    );
    return () => {
      cancelLayout(rowSizeKey);
      stopStyles();
      release();
    };
  });
  const measure = createLayoutMeasurement(
    () => ({ items: props.items, indexes: indexes(), windowed: windowed() }),
    (next) => {
      if (!next) {
        return undefined;
      }
      if (!next.windowed) {
        return () => {
          cancelLayout(rowSizeKey);
          virtualizer.setOptions({ ...virtualizer.options, enabled: false });
          const { _willUpdate: updateVirtualizer } = virtualizer;
          updateVirtualizer();
        };
      }
      const viewport = grid.closest<HTMLElement>(".content");
      const style = getComputedStyle(grid);
      const nextColumns = style.gridTemplateColumns.split(" ").length;
      const nextGap = Number.parseFloat(style.rowGap) || 0;
      const margin = viewport
        ? grid.getBoundingClientRect().top -
          viewport.getBoundingClientRect().top +
          viewport.scrollTop
        : 0;
      // Intrinsic content can shrink even while its card stretches to the row height.
      const firstContent = mounted.values().next().value?.element;
      const cardStyle = firstContent ? getComputedStyle(firstContent.parentElement!) : null;
      const inset = cardStyle
        ? [
            cardStyle.paddingTop,
            cardStyle.paddingBottom,
            cardStyle.borderTopWidth,
            cardStyle.borderBottomWidth,
          ].reduce((sum, value) => sum + Number.parseFloat(value), 0)
        : 0;
      const heights = rowHeights(next.indexes, nextColumns, inset);
      const count = Math.ceil(next.items.length / nextColumns);
      return () => {
        scroller = viewport;
        // Callback identity invalidates the virtualizer's measurement/range memos.
        const getItemKey =
          keyInput?.items === next.items && keyInput.columns === nextColumns
            ? virtualizer.options.getItemKey
            : (index: number) => next.items[index * nextColumns]!.id;
        keyInput = { items: next.items, columns: nextColumns };
        for (const key of virtualizer.itemSizeCache.keys()) {
          if (!next.indexes.has(key)) {
            virtualizer.itemSizeCache.delete(key);
          }
        }
        if (columns !== nextColumns) {
          virtualizer.measure();
        }
        columns = nextColumns;
        gap = nextGap;
        blockInset = inset;
        virtualizer.setOptions({
          ...virtualizer.options,
          count,
          getItemKey,
          enabled: next.windowed && Boolean(viewport),
          gap,
          scrollMargin: margin,
        });
        pinFocusedRows(next.indexes, nextColumns, count, focused());
        syncFocusedOffset();
        const { _willUpdate: updateVirtualizer } = virtualizer;
        updateVirtualizer();
        resizeRows(heights);
      };
    },
    {
      // A preceding publisher group can move this grid without resizing it.
      targets: (next) =>
        next?.windowed
          ? [
              grid,
              grid.closest(".plugin-catalog-results__body") ?? grid,
              ...(scroller ? [scroller] : []),
            ]
          : [],
      // An empty target list releases measurements when the catalog shrinks.
      measureWithoutTarget: true,
      fonts: true,
    },
  );
  const rows = createMemo(() => new Map(view().rows.map((row) => [row.index, row])));
  const visible = createMemo(() => {
    if (!windowed()) {
      return props.items;
    }
    const columnCount = view().columns;
    const rowCount = Math.ceil(props.items.length / columnCount);
    const visibleRows = new Set(view().rows.map((row) => row.index));
    // Bootstrap a bounded window before the first layout measurement.
    if (visibleRows.size === 0) {
      for (let row = 0; row < Math.min(4, rowCount); row++) {
        visibleRows.add(row);
      }
      visibleRows.add(rowCount - 1);
    }
    // Data can move a focused card before the next measured frame. Keep its
    // native focus and adjacent Tab destinations alive at their new positions.
    const focusedIndex = indexes().get(focused() ?? "");
    if (focusedIndex !== undefined) {
      const focusedRow = Math.floor(focusedIndex / columnCount);
      for (const row of [focusedRow - 1, focusedRow, focusedRow + 1]) {
        if (row >= 0 && row < rowCount) {
          visibleRows.add(row);
        }
      }
    }
    return [...visibleRows]
      .toSorted((a, b) => a - b)
      .flatMap((row) => props.items.slice(row * columnCount, (row + 1) * columnCount));
  });
  function Card(card: { plugin: Accessor<PluginDiscoveryEntry> }) {
    let content!: HTMLDivElement;
    onSettled(() => {
      const id = card.plugin().id;
      const geometry = { element: content, height: 0 };
      mounted.set(id, geometry);
      // Resize delivery already measured the natural content. Re-reading every
      // mounted card during scroll forces redundant geometry work.
      const release = observeResize([content], ([entry]) => {
        const height = entry!.borderBoxSize[0]?.blockSize ?? entry!.contentRect.height;
        if (height !== geometry.height) {
          geometry.height = height;
          if (!windowed()) {
            return;
          }
          // Consume delivered sizes once per frame, using the latest full-layout
          // columns and inset without measuring the grid again.
          scheduleLayout(rowSizeKey, () => () => {
            syncFocusedOffset();
            resizeRows(rowHeights(indexes(), columns, blockInset));
          });
        }
      });
      return () => {
        release();
        mounted.delete(id);
      };
    });
    const index = () => indexes().get(card.plugin().id)!;
    const position = (): JSX.CSSProperties | undefined => {
      if (!windowed()) {
        return undefined;
      }
      const row = Math.floor(index() / view().columns);
      const column = index() % view().columns;
      const track = rows().get(row);
      return {
        position: "absolute",
        top: `${(track?.start ?? row * (124 + view().gap)) - virtualizer.options.scrollMargin}px`,
        "inset-inline-start": `calc(${column} * (100% + ${view().gap}px) / ${view().columns})`,
        width: `calc((100% - ${(view().columns - 1) * view().gap}px) / ${view().columns})`,
        height: `${track?.size ?? 124}px`,
      };
    };
    return (
      <div
        class="plugin-catalog-window-item"
        role="listitem"
        aria-posinset={index() + 1}
        aria-setsize={props.items.length}
        style={position()}
        onFocusIn={() => {
          const id = card.plugin().id;
          setFocused(id);
          if (windowed()) {
            pinFocusedRows(indexes(), columns, virtualizer.options.count, id);
            syncFocusedOffset();
            publish();
          }
        }}
      >
        {props.children(card.plugin, (node) => (content = node))}
      </div>
    );
  }
  return (
    <div
      ref={(element) => (grid = element)}
      class={["plugin-catalog-grid", { "plugin-catalog-grid--results": props.results }]}
      role="list"
      style={
        windowed()
          ? {
              position: "relative",
              height: `${view().height || Math.ceil(props.items.length / 4) * 136}px`,
              contain: "layout",
            }
          : undefined
      }
    >
      <For each={visible()} keyed={(plugin) => plugin.id}>
        {(plugin) => <Card plugin={plugin} />}
      </For>
    </div>
  );
}
