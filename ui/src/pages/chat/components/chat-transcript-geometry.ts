import { measureElement, type Virtualizer } from "@tanstack/virtual-core";
import type { ReactiveController, ReactiveControllerHost } from "lit";

function transcriptScrollMargin(element: Element | null): number {
  if (!(element instanceof HTMLElement) || typeof getComputedStyle !== "function") {
    return 0;
  }
  const margin = Number.parseFloat(getComputedStyle(element).paddingTop);
  return Number.isFinite(margin) ? margin : 0;
}

/** Row offsets start below the scroll padding plus the in-flow history header. */
export function resolveTranscriptScrollMargin(
  scrollElement: Element | null,
  headerHeight: number,
): number {
  return transcriptScrollMargin(scrollElement) + headerHeight;
}

export function syncScrollMargin(
  scrollElement: HTMLDivElement | null,
  virtualizer: Virtualizer<HTMLDivElement, HTMLElement>,
  headerHeight: number,
): void {
  const scrollMargin = resolveTranscriptScrollMargin(scrollElement, headerHeight);
  if (scrollMargin === virtualizer.options.scrollMargin) {
    return;
  }
  virtualizer.setOptions({
    ...virtualizer.options,
    scrollMargin,
  });
}

export function initialTranscriptRect(host: ReactiveControllerHost) {
  const width = host instanceof HTMLElement ? host.clientWidth : 0;
  const height = host instanceof HTMLElement ? host.clientHeight : 0;
  return {
    width: width || (typeof window === "undefined" ? 0 : window.innerWidth),
    height: height || (typeof window === "undefined" ? 0 : window.innerHeight),
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
  let changed = false;
  for (const row of scrollElement.querySelectorAll<HTMLElement>(".chat-virtual-row")) {
    const index = virtualizer.indexFromElement(row);
    // Rows are border-boxes; read their fractional layout height, not a scaled
    // client rect when a containing board or sidebar is transitioning.
    const height = Number.parseFloat(getComputedStyle(row).height);
    const key = virtualizer.options.getItemKey(index);
    const previousSize = virtualizer.itemSizeCache.get(key);
    virtualizer.resizeItem(index, Number.isFinite(height) ? height : row.offsetHeight);
    changed ||= virtualizer.itemSizeCache.get(key) !== previousSize;
  }
  return changed;
}

export function measureTranscriptRowRefs(
  elements: readonly HTMLElement[],
  virtualizer: Virtualizer<HTMLDivElement, HTMLElement>,
  canMeasureVisibleRows: boolean,
): void {
  const range = virtualizer.range;
  const candidates =
    canMeasureVisibleRows && !virtualizer.options.useCachedMeasurements && range
      ? elements.flatMap((element) => {
          const index = virtualizer.indexFromElement(element);
          return element.isConnected &&
            index >= range.startIndex &&
            index <= range.endIndex &&
            !virtualizer.itemSizeCache.has(virtualizer.options.getItemKey(index))
            ? [{ element, index }]
            : [];
        })
      : [];
  // Cached and overscan mounts must not force even a viewport layout read.
  if (candidates.length > 0 && virtualizer.scrollElement?.clientHeight) {
    const rows = candidates.map(({ element, index }) => ({
      element,
      index,
      visibility: element.style.getPropertyValue("content-visibility"),
      priority: element.style.getPropertyPriority("content-visibility"),
    }));
    const measurements: Array<{ index: number; size: number }> = [];
    try {
      // Resolve intrinsic placeholders before paint, with all writes before
      // all reads. resizeItem can write scrollTop, so defer it until afterward.
      for (const { element } of rows) {
        element.style.setProperty("content-visibility", "visible");
      }
      for (const { element, index } of rows) {
        measurements.push({
          index,
          size: virtualizer.options.measureElement(element, undefined, virtualizer),
        });
      }
    } finally {
      for (const { element, visibility, priority } of rows) {
        if (visibility) {
          element.style.setProperty("content-visibility", visibility, priority);
        } else {
          element.style.removeProperty("content-visibility");
        }
      }
    }
    for (const { index, size } of measurements) {
      virtualizer.resizeItem(index, size);
    }
  }
  for (const element of elements) {
    virtualizer.measureElement(element);
  }
}

export function measureTranscriptRow(
  element: HTMLElement,
  entry: ResizeObserverEntry | undefined,
  virtualizer: Virtualizer<HTMLDivElement, HTMLElement>,
): number {
  // Rounded row heights accumulate when skipped overscan uses those measurements.
  const size = entry?.borderBoxSize?.[0]?.blockSize ?? measureElement(element, entry, virtualizer);
  if (size === 0 && virtualizer.scrollElement?.clientHeight === 0) {
    // A hidden panel has no row geometry. Retain the last measurement instead
    // of replacing it with zero and moving the restored viewport.
    const index = virtualizer.indexFromElement(element);
    return (
      virtualizer.itemSizeCache.get(virtualizer.options.getItemKey(index)) ??
      virtualizer.options.estimateSize(index)
    );
  }
  return size;
}

export function maxTranscriptScrollOffset(element: HTMLElement | null): number | null {
  return element && element.clientHeight > 0
    ? Math.max(0, element.scrollHeight - element.clientHeight)
    : null;
}

export function reconcileInitialTranscriptOffset(
  element: HTMLDivElement | null,
  virtualizer: Virtualizer<HTMLDivElement, HTMLElement>,
): "pending" | "settled" | "corrected" {
  const maxOffset = maxTranscriptScrollOffset(element);
  const offset = virtualizer.scrollOffset;
  if (maxOffset === null || offset === null) {
    return "pending";
  }
  if (offset >= 0 && offset <= maxOffset) {
    return "settled";
  }
  if (maxOffset !== 0) {
    return "pending";
  }
  // An underfilled end anchor clamps to zero without a native scroll event.
  virtualizer.scrollOffset = 0;
  virtualizer.scrollToOffset(0);
  return "corrected";
}

export class PositionRailGutterController implements ReactiveController {
  private frame: number | null = null;
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
    let innerWidth: number | undefined;
    let regionHeight: number | undefined;
    this.resizeObserver = new ResizeObserver((entries) => {
      let changed = false;
      for (const entry of entries) {
        if (entry.target === inner) {
          const width = entry.borderBoxSize?.[0]?.inlineSize ?? entry.contentRect.width;
          changed ||= width !== innerWidth;
          innerWidth = width;
        } else if (entry.target === region) {
          const height = entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height;
          changed ||= height !== regionHeight;
          regionHeight = height;
        }
      }
      // Streaming changes the inner height, but only column width affects the gutter.
      if (changed) {
        this.scheduleSync();
      }
    });
    this.resizeObserver.observe(inner, { box: "border-box" });
    this.resizeObserver.observe(region, { box: "border-box" });
    this.scheduleSync();
  }

  private scheduleSync(): void {
    if (this.frame !== null) {
      return;
    }
    // Nested Lit children can still be replacing footer content. A synchronous
    // layout read here clamps scrolling against that intermediate viewport.
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      this.sync();
    });
  }

  hostDisconnected(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.viewport = null;
    this.innerElement = null;
    this.region = null;
    if (this.frame !== null) {
      cancelAnimationFrame(this.frame);
      this.frame = null;
    }
  }

  sync(): void {
    const viewport = this.host.scrollElement;
    const inner = this.inner();
    if (!viewport?.isConnected || inner?.parentElement !== viewport) {
      return;
    }
    const left = viewport.getBoundingClientRect().left + viewport.clientLeft;
    const gutter = inner.getBoundingClientRect().left - left;
    // Publish the resolved, unscaled column width: a saved percentage cannot be
    // reused inside a descendant table without changing its containing block.
    const columnWidth = inner.clientWidth;
    if (columnWidth > 0) {
      viewport.style.setProperty("--chat-transcript-column-width", `${columnWidth}px`);
    }
    // The conversation region stays fixed when its composer resizes the scrollport.
    const region = viewport.closest<HTMLElement>(".chat-main__conversation") ?? viewport;
    viewport.style.setProperty("--chat-position-rail-viewport-height", `${region.clientHeight}px`);
    // Reserve room for the compact left rail and breathing space, including
    // when a saved width fills the pane.
    viewport.toggleAttribute("data-position-rail-gutter", gutter >= 68);
  }
}
