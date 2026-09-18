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

function measureConnectedTranscriptRows(
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
  const rows = scrollElement.querySelectorAll<HTMLElement>(".chat-virtual-row");
  for (const row of rows) {
    virtualizer.resizeItem(virtualizer.indexFromElement(row), row.offsetHeight);
  }
  return rows.length > 0;
}

export function measureTranscriptRow(
  element: HTMLElement,
  entry: ResizeObserverEntry | undefined,
  virtualizer: Virtualizer<HTMLDivElement, HTMLElement>,
): number {
  const size = measureElement(element, entry, virtualizer);
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

export class TranscriptGeometryController implements ReactiveController {
  private frame: number | null = null;
  private rowMeasureFrame: number | null = null;

  constructor(
    private readonly host: ReactiveControllerHost & {
      readonly scrollElement: HTMLDivElement | null;
    },
    private readonly inner: () => HTMLDivElement | null,
    private readonly getVirtualizer: () => Virtualizer<HTMLDivElement, HTMLElement>,
    private readonly beforeMeasure: () => void,
  ) {
    host.addController(this);
  }

  hostUpdated(): void {
    if (this.frame !== null) {
      return;
    }
    // Nested Lit children can still be replacing footer content. A synchronous
    // layout read here clamps scrolling against that intermediate viewport.
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      this.syncPositionRail();
    });
  }

  hostDisconnected(): void {
    if (this.rowMeasureFrame !== null) {
      cancelAnimationFrame(this.rowMeasureFrame);
      this.rowMeasureFrame = null;
    }
    if (this.frame !== null) {
      cancelAnimationFrame(this.frame);
      this.frame = null;
    }
  }

  measureRows(): boolean {
    // Native input can land after takeover but before its offset observer.
    // Refresh the offset and direction before compensating deferred row growth.
    this.beforeMeasure();
    return measureConnectedTranscriptRows(this.host.scrollElement, this.getVirtualizer());
  }

  queueRowMeasure(): void {
    if (this.rowMeasureFrame !== null) {
      return;
    }
    const element = this.host.scrollElement;
    this.rowMeasureFrame = requestAnimationFrame(() => {
      this.rowMeasureFrame = null;
      if (element === this.host.scrollElement) {
        this.measureRows();
      }
    });
  }

  syncPositionRail(): void {
    const viewport = this.host.scrollElement;
    const inner = this.inner();
    if (!viewport?.isConnected || inner?.parentElement !== viewport) {
      return;
    }
    const left = viewport.getBoundingClientRect().left + viewport.clientLeft;
    const gutter = inner.getBoundingClientRect().left - left;
    // The conversation region stays fixed when its composer resizes the scrollport.
    const region = viewport.closest<HTMLElement>(".chat-main__conversation") ?? viewport;
    viewport.style.setProperty("--chat-position-rail-viewport-height", `${region.clientHeight}px`);
    // Reserve room for the compact left rail and breathing space, including
    // when a saved width fills the pane.
    viewport.toggleAttribute("data-position-rail-gutter", gutter >= 68);
  }
}
