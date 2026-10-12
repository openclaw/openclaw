import { measureElement, type Virtualizer } from "@tanstack/virtual-core";
import type { ReactiveController, ReactiveControllerHost } from "lit";
import { captureChatSessionScrollPosition, type ChatSessionScrollPosition } from "../scroll.ts";
import type { TranscriptViewportMeasurement } from "./chat-transcript-scroll-events.ts";

export const POSITION_RAIL_MARKER_HEIGHT = 12;
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

export function measureConnectedTranscriptRows(
  scrollElement: HTMLDivElement | null,
  virtualizer: Virtualizer<HTMLDivElement, HTMLElement>,
): boolean {
  const rect = scrollElement?.getBoundingClientRect();
  if (
    !scrollElement ||
    virtualizer.scrollElement !== scrollElement ||
    !rect?.width ||
    !rect.height
  ) {
    return false;
  }
  // Width changes and retired smooth commands can have undelivered sizes.
  // Ordinary row refs stay on TanStack's observer path; never clear its cache.
  const measurements: Array<{ index: number; height: number }> = [];
  for (const row of scrollElement.querySelectorAll<HTMLElement>(".chat-virtual-row")) {
    const index = virtualizer.indexFromElement(row);
    // Rows are border-boxes; read their fractional layout height, not a scaled
    // client rect when a containing board or sidebar is transitioning.
    const height = Number.parseFloat(getComputedStyle(row).height);
    measurements.push({ index, height: Number.isFinite(height) ? height : row.offsetHeight });
  }
  let changed = false;
  for (const { index, height } of measurements) {
    const key = virtualizer.options.getItemKey(index);
    const previousSize = virtualizer.itemSizeCache.get(key);
    virtualizer.resizeItem(index, height);
    changed ||= virtualizer.itemSizeCache.get(key) !== previousSize;
  }
  return changed;
}

export function measureTranscriptRow(
  element: HTMLElement,
  entry: ResizeObserverEntry | undefined,
  virtualizer: Virtualizer<HTMLDivElement, HTMLElement>,
): number {
  if (entry || !virtualizer.targetWindow?.ResizeObserver) {
    // Rounded row heights accumulate when skipped overscan uses those measurements.
    const size =
      entry?.borderBoxSize?.[0]?.blockSize ?? measureElement(element, entry, virtualizer);
    if (size !== 0 || virtualizer.scrollElement?.clientHeight !== 0) {
      return size;
    }
  }
  // Lit registration waits for the observer's first layout; hidden panels retain
  // their last measurement instead of replacing it with zero and moving the viewport.
  const index = virtualizer.indexFromElement(element);
  return (
    virtualizer.itemSizeCache.get(virtualizer.options.getItemKey(index)) ??
    virtualizer.options.estimateSize(index)
  );
}

export function maxTranscriptScrollOffset(element: HTMLElement | null): number | null {
  return element && element.clientHeight > 0
    ? Math.max(0, element.scrollHeight - element.clientHeight)
    : null;
}

export class PositionRailGutterController implements ReactiveController {
  private resizeObserver: ResizeObserver | null = null;
  private viewport: HTMLDivElement | null = null;
  private innerElement: HTMLDivElement | null = null;
  private region: HTMLElement | null = null;

  constructor(
    private readonly host: ReactiveControllerHost & {
      readonly scrollElement: HTMLDivElement | null;
    },
    private readonly inner: () => HTMLDivElement | null,
  ) {
    host.addController(this);
  }

  hostUpdated(): void {
    const viewport = this.host.scrollElement;
    const inner = this.inner();
    const region = viewport?.closest<HTMLElement>(".chat-main__conversation") ?? viewport;
    if (viewport === this.viewport && inner === this.innerElement && region === this.region) {
      return;
    }
    this.hostDisconnected();
    if (!viewport?.isConnected || inner?.parentElement !== viewport || !region) {
      return;
    }
    this.viewport = viewport;
    this.innerElement = inner;
    this.region = region;
    const column = inner.querySelector<HTMLElement>(":scope > .chat-virtual-sizer") ?? inner;
    let innerWidth: number | undefined;
    let regionHeight: number | undefined;
    this.resizeObserver = new ResizeObserver((entries) => {
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
        this.sync();
      }
    });
    // The virtual column has no flow height. Observing the owned range instead
    // feeds row measurements back into shallower ResizeObserver delivery.
    this.resizeObserver.observe(column, { box: "border-box" });
    this.resizeObserver.observe(region, { box: "border-box" });
  }

  hostDisconnected(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.viewport = null;
    this.innerElement = null;
    this.region = null;
  }

  read() {
    const viewport = this.host.scrollElement;
    const inner = this.inner();
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
  }

  sync(geometry = this.read()): void {
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
  }
}
