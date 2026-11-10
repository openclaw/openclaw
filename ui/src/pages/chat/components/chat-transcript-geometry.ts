import type { Virtualizer } from "@tanstack/virtual-core";
import { captureChatSessionScrollPosition, type ChatSessionScrollPosition } from "../scroll.ts";
import type { TranscriptViewportMeasurement } from "./chat-transcript-scroll-events.ts";

export const POSITION_RAIL_MARKER_HEIGHT = 10;
const POSITION_RAIL_MARKER_OVERSCAN = 6;

export function positionRailWindowIndexes(
  count: number,
  markerIndexes: ReadonlyMap<string, number>,
  offset: number,
  height: number,
  ...retainedIds: readonly (string | null | undefined)[]
): number[] {
  const start = Math.max(
    0,
    Math.floor(offset / POSITION_RAIL_MARKER_HEIGHT) - POSITION_RAIL_MARKER_OVERSCAN,
  );
  const end = Math.min(
    count,
    Math.ceil((offset + height) / POSITION_RAIL_MARKER_HEIGHT) + POSITION_RAIL_MARKER_OVERSCAN,
  );
  const indexes = new Set<number>();
  for (let index = start; index < end; index++) {
    indexes.add(index);
  }
  // Roving Tab entry and an explored focus survive an independently scrolled rail.
  for (const id of retainedIds) {
    const index = id ? markerIndexes.get(id) : undefined;
    if (index !== undefined) {
      indexes.add(index);
    }
  }
  return [...indexes].toSorted((left, right) => left - right);
}

export type PositionRailReaderState = {
  viewport?: ChatSessionScrollPosition & { height: number };
  resizeTarget?: { offset: number; atEnd: boolean };
  followingResize: boolean;
  followActive: boolean;
};

export function resolvePositionRailReaderViewport(
  previous: PositionRailReaderState,
  measured: TranscriptViewportMeasurement,
  focused: boolean,
): { state: PositionRailReaderState; scheduleLayout: boolean } {
  const viewport = {
    height: measured.clientHeight,
    ...captureChatSessionScrollPosition(measured),
  };
  const state = { ...previous, viewport };
  let scheduleLayout = false;
  if (previous.viewport && viewport.height !== previous.viewport.height) {
    // Intersections can precede resize compensation. Preserve the reader's
    // rail offset while keeping any keyboard-focused marker in view.
    state.followingResize = true;
    state.followActive ||= focused;
    scheduleLayout ||= state.followActive;
    // A measured end supersedes startup's non-end estimate; smooth follow may still be pending.
    const atEnd = state.resizeTarget?.atEnd || previous.viewport.anchorToEnd;
    const maxOffset = Math.max(0, measured.scrollHeight - viewport.height);
    state.resizeTarget = {
      offset: atEnd ? maxOffset : Math.min(previous.viewport.scrollTop, maxOffset),
      atEnd,
    };
  }
  // Navigation and a resize can arrive in the same observer delivery.
  if (previous.viewport && viewport.scrollTop !== previous.viewport.scrollTop) {
    const target = state.resizeTarget?.offset;
    // Smooth resize compensation crosses intermediate offsets before its target.
    // The transcript input owner retires it when the reader takes over.
    const compensating =
      target !== undefined &&
      (Math.abs(viewport.scrollTop - target) <= 1 ||
        (viewport.scrollTop >= Math.min(previous.viewport.scrollTop, target) &&
          viewport.scrollTop <= Math.max(previous.viewport.scrollTop, target)));
    if (!compensating) {
      if (state.followingResize) {
        state.followActive = true;
        scheduleLayout = true;
      }
      state.followingResize = false;
      state.resizeTarget = undefined;
    }
  }
  return { state, scheduleLayout };
}

/** Row offsets start below the scroll padding plus the in-flow history header. */
export function resolveTranscriptScrollMargin(
  scrollElement: Element | null,
  headerHeight: number,
): number {
  const margin =
    scrollElement instanceof HTMLElement && typeof getComputedStyle === "function"
      ? Number.parseFloat(getComputedStyle(scrollElement).paddingTop)
      : 0;
  return (Number.isFinite(margin) ? margin : 0) + headerHeight;
}

export function syncScrollMargin(
  virtualizer: Virtualizer<HTMLDivElement, HTMLElement>,
  scrollMargin: number,
): void {
  if (scrollMargin === virtualizer.options.scrollMargin) {
    return;
  }
  virtualizer.setOptions({
    ...virtualizer.options,
    scrollMargin,
  });
}

export function initialTranscriptRect() {
  return {
    width: typeof window === "undefined" ? 0 : window.innerWidth,
    height: typeof window === "undefined" ? 0 : window.innerHeight,
  };
}

export function isTranscriptRangeCommitted(
  inner: HTMLElement | null,
  virtualizer: Virtualizer<HTMLDivElement, HTMLElement>,
): boolean {
  return virtualizer.getVirtualItems().every((row) => {
    const node = virtualizer.elementsCache.get(row.key);
    return (
      node !== undefined &&
      inner?.contains(node) === true &&
      // This records the committed size without feeding it back into the row's styles.
      (node.dataset.streamingRow === "true" ||
        Math.abs(Number.parseFloat(node.dataset.rowSize ?? "") - row.size) < 1)
    );
  });
}

export function readTranscriptRowHeight(element: HTMLElement): number {
  // Rows are border-boxes; CSS layout height stays fractional and unscaled
  // inside board/sidebar transitions.
  const height = Number.parseFloat(getComputedStyle(element).height);
  return Number.isFinite(height) ? height : element.offsetHeight;
}

export function readConnectedTranscriptRows(
  scrollElement: HTMLDivElement | null,
  virtualizer: Virtualizer<HTMLDivElement, HTMLElement>,
  rowElements: Iterable<HTMLElement>,
  onMeasured?: (row: HTMLElement, height: number) => void,
): (() => boolean) | null {
  const rect = scrollElement?.getBoundingClientRect();
  if (
    !scrollElement ||
    virtualizer.scrollElement !== scrollElement ||
    !rect?.width ||
    !rect.height
  ) {
    return null;
  }
  // Width changes and retired smooth commands can have undelivered sizes.
  // Ordinary row refs stay on TanStack's observer path; never clear its cache.
  const measurements: Array<{ row: HTMLElement; index: number; height: number }> = [];
  // Refs can arrive out of order during prepends; preserve DOM-order corrections.
  const rows = [...rowElements]
    .filter((row) => scrollElement.contains(row) && row.dataset.preparedRow !== "true")
    .toSorted(
      (left, right) => virtualizer.indexFromElement(left) - virtualizer.indexFromElement(right),
    );
  for (const row of rows) {
    const index = virtualizer.indexFromElement(row);
    measurements.push({ row, index, height: readTranscriptRowHeight(row) });
  }
  return () => {
    // A positioning owner accounts for these native facts before virtual writes can
    // notify or retire it. Persisted virtual footprints are not native measurements.
    for (const { row, height } of measurements) {
      onMeasured?.(row, height);
    }
    let changed = false;
    for (const { index, height } of measurements) {
      const key = virtualizer.options.getItemKey(index);
      const previousSize = virtualizer.itemSizeCache.get(key);
      virtualizer.resizeItem(index, height);
      changed ||= virtualizer.itemSizeCache.get(key) !== previousSize;
    }
    return changed;
  };
}

export function measureTranscriptRow(
  element: HTMLElement,
  entry: ResizeObserverEntry | undefined,
  virtualizer: Virtualizer<HTMLDivElement, HTMLElement>,
): number {
  const parked =
    element.dataset.preparedRow === "true" && !element.hasAttribute("data-preparing-row");
  if (!parked && (entry || !virtualizer.targetWindow?.ResizeObserver)) {
    // TanStack defers observer entries; they can predate a foreground read.
    // Treat delivery as invalidation so old sizes cannot roll that read back.
    const size = readTranscriptRowHeight(element);
    if (
      size !== 0 ||
      (element.getBoundingClientRect().width !== 0 &&
        virtualizer.scrollElement?.clientHeight !== 0 &&
        element.offsetHeight === 0)
    ) {
      return size;
    }
  }
  // Parked rows have no visible extent. Retain their geometry until preparation or
  // presentation resumes, also while a whole pane is hidden or awaiting layout.
  const index = virtualizer.indexFromElement(element);
  return (
    virtualizer.itemSizeCache.get(virtualizer.options.getItemKey(index)) ??
    virtualizer.options.estimateSize(index)
  );
}

export function maxTranscriptScrollOffset(element: HTMLElement | null): number | null {
  if (!element) {
    return null;
  }
  const clientHeight = element.clientHeight;
  return clientHeight > 0 ? Math.max(0, element.scrollHeight - clientHeight) : null;
}

export function createPositionRailGutter(
  scrollElement: () => HTMLDivElement | null,
  innerElement: () => HTMLDivElement | null,
  columnElement: () => HTMLDivElement | undefined,
) {
  let resizeObserver: ResizeObserver | null = null;
  let observedViewport: HTMLDivElement | null = null;
  let observedInner: HTMLDivElement | null = null;
  let observedRegion: HTMLElement | null = null;

  const disconnect = () => {
    resizeObserver?.disconnect();
    resizeObserver = null;
    observedViewport = null;
    observedInner = null;
    observedRegion = null;
  };

  const update = () => {
    const viewport = scrollElement();
    const inner = innerElement();
    const region = viewport?.closest<HTMLElement>(".chat-main__conversation") ?? viewport;
    if (viewport === observedViewport && inner === observedInner && region === observedRegion) {
      return;
    }
    disconnect();
    const column = columnElement();
    if (!viewport?.isConnected || inner?.parentElement !== viewport || !region || !column) {
      return;
    }
    observedViewport = viewport;
    observedInner = inner;
    observedRegion = region;
    let innerWidth: number | undefined;
    let regionHeight: number | undefined;
    resizeObserver = new ResizeObserver((entries) => {
      let changed = false;
      for (const entry of entries) {
        if (entry.target === column) {
          const width = entry.borderBoxSize?.[0]?.inlineSize ?? entry.contentRect.width;
          changed ||= width !== innerWidth;
          innerWidth = width;
        } else if (entry.target === region) {
          const height = entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height;
          changed ||= height !== regionHeight;
          regionHeight = height;
        }
      }
      if (changed) {
        sync();
      }
    });
    // The virtual column has no flow height. Observing the owned range instead
    // feeds row measurements back into shallower ResizeObserver delivery.
    resizeObserver.observe(column, { box: "border-box" });
    resizeObserver.observe(region, { box: "border-box" });
  };

  const read = () => {
    const viewport = scrollElement();
    const inner = innerElement();
    if (!viewport?.isConnected || inner?.parentElement !== viewport) {
      return null;
    }
    const left = viewport.getBoundingClientRect().left + viewport.clientLeft;
    const gutter = inner.getBoundingClientRect().left - left;
    // Publish the resolved, unscaled column width: a saved percentage cannot be
    // reused inside a descendant table without changing its containing block.
    const columnWidth = inner.clientWidth;
    const region = viewport.closest<HTMLElement>(".chat-main__conversation") ?? viewport;
    return { viewport, gutter, columnWidth, regionHeight: region.clientHeight };
  };

  const sync = (geometry = read()) => {
    if (!geometry) {
      return;
    }
    const { viewport, gutter, columnWidth, regionHeight } = geometry;
    if (columnWidth > 0) {
      viewport.style.setProperty("--chat-transcript-column-width", `${columnWidth}px`);
    }
    // The conversation region stays fixed when its composer resizes the scrollport.
    viewport.style.setProperty("--chat-position-rail-viewport-height", `${regionHeight}px`);
    // Reserve room for the compact left rail and breathing space, including
    // when a saved width fills the pane.
    viewport.toggleAttribute("data-position-rail-gutter", gutter >= 68);
  };

  return { update, disconnect, read, sync };
}
