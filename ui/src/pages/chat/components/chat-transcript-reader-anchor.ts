import type { Virtualizer, VirtualItem } from "@tanstack/virtual-core";
import { isIosBrowserPlatform } from "../../../lib/browser-platform.ts";
import { maxTranscriptScrollOffset } from "./chat-transcript-geometry.ts";
import type { TranscriptLayoutOwner } from "./chat-transcript-layout-owner.ts";
import type { TranscriptOffsetState } from "./chat-transcript-offset-observer.ts";

type TranscriptVirtualizer = Virtualizer<HTMLDivElement, HTMLElement>;
/** The owning virtualizer host's geometry and positioning facts. */
type ReaderAnchorHost = {
  readonly virtualizer: TranscriptVirtualizer;
  readonly layout: TranscriptLayoutOwner;
  readonly offsetState: TranscriptOffsetState;
  readonly renderer: { readonly columnElement: HTMLElement | undefined };
  readonly initialRange: { readonly pending: boolean };
  readonly prependAnchor: { readonly messageKey: string | null };
  readonly headerHeight: number;
  readonly scrollElement: HTMLDivElement | null;
  readonly contentElement: HTMLDivElement | null;
};

/** A row first measured while crossing the top edge was laid out above the reader. */
function isAboveReader(top: number, height: number, first: boolean, readerTop: number): boolean {
  return top + height <= readerTop + 0.5 || (first && top < readerTop);
}

/**
 * Keeps the rows a reader sees still when rows above them change size.
 *
 * Rows lay out in normal flow below the first mounted row, so any size change above the
 * viewport moves every visible row in the frame the browser lays it out. Virtual-core applies
 * row measurements a frame later (native resize delivery must not commit the range), which
 * painted each correction as a jump. This owner compensates during resize delivery with native
 * geometry only, then reconciles virtual sizes when virtual-core lands them.
 *
 * iOS WebKit cancels touch and momentum scrolling on a scrollTop write, so while it scrolls
 * the correction moves the row column instead (a negative margin, mirrored in scrollMargin)
 * and folds into scrollTop once scrolling settles. Accepted edge: a reader who reaches the top
 * during that gesture sees the column's first rows clipped until the gesture settles.
 */
export class TranscriptReaderAnchor {
  // Last laid-out row heights. A new row starts from its virtual size: the flow placed the rows
  // below it as though it had that size.
  private readonly heights = new WeakMap<Element, number>();
  // Corrections applied to native geometry before virtual-core measured the row.
  private readonly unlanded = new Map<string, number>();
  private columnShift = 0;
  private landedShift = 0;
  private owedScroll = 0;
  private observer: ResizeObserver | null = null;
  // A positioning owner can measure and release its anchor before this frame's resize
  // delivery. Its restoration already accounts for that delivery's rows.
  private ownedSinceDelivery = false;

  constructor(private readonly host: ReaderAnchorHost) {}

  /** Restoration, scroll commands, prepend and disclosure anchors place the reader themselves. */
  private positionOwned(): boolean {
    const { offsetState } = this.host;
    return (
      this.host.initialRange.pending ||
      offsetState.hasPendingCommand ||
      offsetState.pendingInteractionAnchor !== null ||
      this.host.prependAnchor.messageKey !== null
    );
  }

  observe(row: HTMLElement): void {
    this.observer ??= new ResizeObserver(this.resized);
    this.observer.observe(row, { box: "border-box" });
  }

  unobserve(row: HTMLElement): void {
    this.observer?.unobserve(row);
  }

  /** Native writes would stop an iOS gesture; hold the correction in the column until it ends. */
  private holdsNativeOffset(): boolean {
    return (
      isIosBrowserPlatform() &&
      (this.host.virtualizer.isScrolling || this.host.offsetState.touchActive)
    );
  }

  private readonly resized = (entries: ResizeObserverEntry[]): void => {
    const element = this.host.scrollElement;
    // A hidden pane reports collapsed rows; they keep their last laid-out heights.
    if (!element?.clientHeight) {
      return;
    }
    const readerTop = element.getBoundingClientRect().top;
    const { virtualizer } = this.host;
    const compensating = !this.positionOwned() && !this.ownedSinceDelivery;
    this.ownedSinceDelivery = false;
    // Earlier rows in this delivery push later ones; recover each row's pre-change top.
    const rows = entries
      .flatMap((entry) => {
        const row = entry.target;
        return row instanceof HTMLElement && row.isConnected && element.contains(row)
          ? [{ entry, row, top: row.getBoundingClientRect().top }]
          : [];
      })
      .toSorted((left, right) => left.top - right.top);
    let moved = 0;
    let correction = 0;
    for (const { entry, row, top } of rows) {
      const key = row.dataset.virtualRowKey;
      const box = entry.borderBoxSize?.[0];
      const height = box?.blockSize ?? row.offsetHeight;
      // A hidden row reports no width; it keeps its last laid-out height.
      if (!key || (box ? !box.inlineSize : !row.offsetWidth)) {
        continue;
      }
      const first = !this.heights.has(row);
      const previous =
        this.heights.get(row) ??
        virtualizer.itemSizeCache.get(key) ??
        virtualizer.options.estimateSize(virtualizer.indexFromElement(row));
      this.heights.set(row, height);
      const delta = height - previous;
      const previousTop = top - moved;
      moved += delta;
      if (
        !compensating ||
        Math.abs(delta) < 0.5 ||
        !isAboveReader(previousTop, previous, first, readerTop)
      ) {
        continue;
      }
      correction += delta;
      this.unlanded.set(key, (this.unlanded.get(key) ?? 0) + delta);
    }
    if (!correction) {
      return;
    }
    if (this.holdsNativeOffset()) {
      this.columnShift += correction;
      this.syncColumn();
    } else {
      // Grow the native range before the write so the end cannot clamp it.
      this.shiftVirtual(-correction);
      this.scrollBy(correction);
    }
  };

  /** Virtual-core's adjustment predicate: reconcile a landed size with native corrections. */
  readonly landSize = (
    item: VirtualItem,
    delta: number,
    instance: TranscriptVirtualizer,
  ): boolean => {
    const owned = this.positionOwned();
    this.ownedSinceDelivery ||= owned;
    // An estimated initial end is not a native scroll target.
    if (this.host.initialRange.pending) {
      return false;
    }
    const key = String(item.key);
    const applied = this.unlanded.get(key);
    this.unlanded.delete(key);
    const readerTop = instance.scrollOffset ?? 0;
    const above = isAboveReader(
      item.start,
      item.size,
      !instance.itemSizeCache.has(item.key),
      readerTop,
    );
    if (applied === undefined) {
      if (!above || owned || !this.holdsNativeOffset()) {
        // Virtual-core grows the native range and writes (or retries) the correction itself;
        // positioning owners restore their own anchors afterwards.
        return above;
      }
      this.columnShift += delta;
      this.landedShift += delta;
      return false;
    }
    const owed = delta - applied;
    this.landedShift += applied;
    if (this.holdsNativeOffset()) {
      this.columnShift += owed;
      this.landedShift += owed;
    } else {
      this.owedScroll += owed;
    }
    return false;
  };

  /** Apply corrections collected while virtual-core landed a measurement batch. */
  flush(): void {
    const { virtualizer } = this.host;
    for (const [key, applied] of this.unlanded) {
      const row = virtualizer.elementsCache.get(key);
      // A row unmounted before its measurement landed no longer extends the flow, and
      // measurement without scroll adjustment lands sizes without consulting landSize.
      if (
        row?.isConnected !== true ||
        Math.abs((virtualizer.itemSizeCache.get(key) ?? -1) - (this.heights.get(row) ?? 0)) < 0.5
      ) {
        this.landedShift += applied;
        this.unlanded.delete(key);
      }
    }
    const shift = this.landedShift;
    const owed = this.owedScroll;
    this.landedShift = 0;
    this.owedScroll = 0;
    if (shift) {
      this.shiftVirtual(shift);
    }
    this.syncColumn();
    if (Math.abs(owed) >= 0.5) {
      this.commitRange();
      this.scrollBy(owed);
    }
    // Virtual-core notifies when its scrolling state ends.
    this.settle();
  }

  /** Fold a held column shift into scrollTop once native scrolling can be written again. */
  settle(force = false): void {
    const shift = this.columnShift;
    if (!shift || (!force && this.holdsNativeOffset())) {
      return;
    }
    const element = this.host.scrollElement;
    const offset = element?.scrollTop ?? 0;
    // A write during elastic overscroll snaps back and drops the correction; retry in range.
    if (!force && element && (offset < 0 || offset > (maxTranscriptScrollOffset(element) ?? 0))) {
      return;
    }
    this.columnShift = 0;
    this.shiftVirtual(-shift);
    this.syncColumn();
    this.scrollBy(shift);
  }

  /** A moved pane keeps its mounted rows observed; only pending corrections are retired. */
  reset(): void {
    this.settle(true);
    this.unlanded.clear();
    this.landedShift = 0;
    this.owedScroll = 0;
  }

  /**
   * Move every virtual row by `delta` without moving the DOM: the native range ends where the
   * flowed rows end, and scrollMargin keeps virtual offsets on their laid-out positions.
   */
  private shiftVirtual(delta: number): void {
    const { virtualizer, layout } = this.host;
    layout.rowShift += delta;
    virtualizer.setOptions({
      ...virtualizer.options,
      scrollMargin: virtualizer.options.scrollMargin - delta,
    });
    this.commitRange();
  }

  /** The native range must reach a correction's target before it is written. */
  private commitRange(): void {
    const content = this.host.contentElement;
    if (content) {
      this.host.layout.commitRange(
        content,
        this.host.virtualizer.getTotalSize() + this.host.headerHeight,
      );
    }
  }

  private syncColumn(): void {
    const column = this.host.renderer.columnElement;
    const margin = this.columnShift ? `${-this.columnShift}px` : "";
    if (column && column.style.marginTop !== margin) {
      column.style.marginTop = margin;
    }
  }

  private scrollBy(delta: number): void {
    const element = this.host.scrollElement;
    if (!element) {
      return;
    }
    const before = element.scrollTop;
    element.scrollTo({ top: before + delta, behavior: "instant" });
    // Maintenance provenance keeps offset observers from reading the write as reader movement.
    this.host.offsetState.recordProgrammaticScroll?.(before, element.scrollTop, true);
  }
}
