import type { Virtualizer, VirtualItem } from "@tanstack/virtual-core";
import { maxTranscriptScrollOffset } from "./chat-transcript-geometry.ts";
import type { TranscriptLayoutOwner } from "./chat-transcript-layout-owner.ts";
import type { ChatTranscriptRenderer } from "./chat-transcript-layout-solid.tsx";
import type { TranscriptOffsetState } from "./chat-transcript-offset-observer.ts";
import { focusedTranscriptRowKey } from "./chat-transcript-range.ts";

type TranscriptVirtualizer = Virtualizer<HTMLDivElement, HTMLElement>;
/** The owning virtualizer host's geometry and positioning facts. */
type ReaderAnchorHost = {
  readonly virtualizer: TranscriptVirtualizer;
  readonly layout: TranscriptLayoutOwner;
  readonly offsetState: TranscriptOffsetState;
  readonly renderer: Pick<ChatTranscriptRenderer, "columnElement" | "queueAfterCommit">;
  readonly initialRange: { readonly pending: boolean };
  readonly prependAnchor: { readonly messageKey: string | null };
  readonly headerHeight: number;
  readonly scrollElement: HTMLDivElement | null;
  readonly contentElement: HTMLDivElement | null;
};

/** The first content the reader sees, located inside its row. */
type ReaderContent = {
  readonly row: HTMLElement;
  readonly element: Element;
  readonly offset: number;
  readonly height: number;
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
 * WebKit can cancel native wheel, touch and momentum scrolling on a scrollTop write, so during
 * scrolling the correction moves the row column instead (a negative margin, mirrored in
 * scrollMargin). It folds into scrollTop at the start boundary or once scrolling settles.
 *
 * Content can also change size inside the row at the reader's top edge, such as a preview image
 * that loads above text the reader already sees. Like native scroll anchoring (disabled on the
 * transcript), the first content at or below that edge is recorded after each scroll and resize
 * delivery, and growth above it inside the row is compensated the same way.
 */
export class TranscriptReaderAnchor {
  focusedRowKey: string | null = null;
  readonly handleFocusIn = (event: FocusEvent): void => {
    this.focusedRowKey = focusedTranscriptRowKey(this.host.scrollElement, event.target);
  };
  readonly handleFocusOut = (event: FocusEvent): void => {
    this.focusedRowKey = focusedTranscriptRowKey(this.host.scrollElement, event.relatedTarget);
  };
  // Last laid-out row heights. A new row starts from its virtual size: the flow placed the rows
  // below it as though it had that size.
  private readonly heights = new WeakMap<Element, number>();
  // Corrections applied to native geometry before virtual-core measured the row.
  private readonly unlanded = new Map<string, number>();
  // Rows the reader was moved inside of, by corrected height. Landing that size moves no reader
  // the correction did not already move, though the moved reader now sees the old size as above.
  private readonly unlandedWithin = new Map<string, number>();
  private columnShift = 0;
  private landedShift = 0;
  private owedScroll = 0;
  private observer: ResizeObserver | null = null;
  // A positioning owner can measure and release its anchor before this frame's resize
  // delivery. Its restoration already accounts for that delivery's rows.
  private ownedSinceDelivery = false;
  private readerContent: ReaderContent | null = null;
  private animatedRow: HTMLElement | null = null;

  constructor(
    private readonly host: ReaderAnchorHost,
    private readonly onRowsMeasured: () => void,
  ) {}

  /** Native receipts and the active range must describe the same measurement batch. */
  readonly rowsMeasured = (indexes?: readonly number[]): boolean => {
    const { virtualizer } = this.host;
    const rows = virtualizer.getVirtualItems();
    const required = indexes?.map((index) => rows.find((row) => row.index === index)) ?? rows;
    return required.every((item) => {
      if (!item) {
        return false;
      }
      const row = virtualizer.elementsCache.get(item.key);
      if (row?.dataset.preparedRow === "true") {
        if (indexes === undefined) {
          return true;
        }
        if (row.dataset.preparingRow !== "true") {
          return false;
        }
      }
      const height = row && this.heights.get(row);
      return (
        row?.isConnected === true && height !== undefined && Math.abs(height - item.size) < 0.5
      );
    });
  };

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

  /** Native writes can stop a gesture; hold the correction in the column until it ends. */
  private holdsNativeOffset(): boolean {
    return (
      (this.host.virtualizer.isScrolling && this.host.offsetState.nativeInputActive) ||
      this.host.offsetState.touchActive
    );
  }

  private readonly resized = (entries: ResizeObserverEntry[]): void => {
    const element = this.host.scrollElement;
    // A hidden pane reports collapsed rows; they keep their last laid-out heights.
    if (!element?.clientHeight) {
      return;
    }
    const { virtualizer } = this.host;
    // A fast native jump can arrive before its scroll event. Retiring rows may
    // still deliver sizes, but their old window must not move the new reader.
    if (!this.host.initialRange.pending) {
      this.host.offsetState.syncNativeOffset?.(true);
    }
    const range = virtualizer.calculateRange();
    const overscan = virtualizer.options.overscan;
    const readerTop = element.getBoundingClientRect().top;
    const compensating = !this.positionOwned() && !this.ownedSinceDelivery;
    this.ownedSinceDelivery = false;
    // Earlier rows in this delivery push later ones; recover each row's pre-change top.
    const rows = entries
      .flatMap((entry) => {
        const row = entry.target;
        return row instanceof HTMLElement &&
          row.isConnected &&
          (row.dataset.preparedRow !== "true" || row.dataset.preparingRow === "true") &&
          element.contains(row)
          ? [{ entry, row, top: row.getBoundingClientRect().top }]
          : [];
      })
      .toSorted((left, right) => left.top - right.top);
    // Newly revealed rows can enter inside the viewport ahead of retained content.
    // Their first measurement preserves that content unless the reader reached native zero.
    const retainedIndex =
      compensating && element.scrollTop > 0
        ? virtualizer.getVirtualItems().find((item) => {
            const row = virtualizer.elementsCache.get(item.key);
            return (
              item.end > (virtualizer.scrollOffset ?? 0) &&
              row?.dataset.preparedRow !== "true" &&
              row !== undefined &&
              this.heights.has(row)
            );
          })?.index
        : undefined;
    let moved = 0;
    let correction = 0;
    let within = 0;
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
      if (row.dataset.preparedRow === "true") {
        continue;
      }
      const delta = height - previous;
      const previousTop = top - moved;
      moved += delta;
      const index = virtualizer.indexFromElement(row);
      const above =
        isAboveReader(previousTop, previous, first, readerTop) ||
        (first && retainedIndex !== undefined && index < retainedIndex);
      if (compensating && !above && Math.abs(delta) >= 0.5) {
        const shift = this.contentShift(row);
        if (shift) {
          within += shift;
          this.unlandedWithin.set(key, height);
        }
      }
      if (
        !compensating ||
        !range ||
        index < range.startIndex - overscan ||
        index > range.endIndex + overscan ||
        Math.abs(delta) < 0.5 ||
        !above
      ) {
        continue;
      }
      correction += delta;
      this.unlanded.set(key, (this.unlanded.get(key) ?? 0) + delta);
    }
    if (this.host.prependAnchor.messageKey !== null) {
      this.host.renderer.queueAfterCommit(this.onRowsMeasured);
    }
    if (correction) {
      // At native zero a negative correction already clamps; don't paint a temporary shift.
      if (this.holdsNativeOffset() && !(correction < 0 && element.scrollTop === 0)) {
        this.columnShift += correction;
        this.syncColumn();
      } else {
        // Keep the pre-shrink offset: committing a smaller extent can clamp it first.
        const offset = element.scrollTop;
        this.shiftVirtual(-correction);
        this.scrollBy(correction, offset);
      }
    }
    // The row's virtual start is unchanged, so only the reader moves within it. A held shift
    // moves the column instead, and scrollMargin follows the rows it moved.
    if (within) {
      if (this.holdsNativeOffset()) {
        this.columnShift += within;
        this.shiftVirtual(within);
        this.syncColumn();
      } else {
        this.scrollBy(within);
      }
    }
    this.captureReaderContent(true);
  };

  /** How far the recorded reader content moved inside a resized row. */
  private contentShift(row: HTMLElement): number {
    const content = this.readerContent;
    // At native zero the reader is at the start, where new content stays visible.
    if (
      content?.row !== row ||
      !row.contains(content.element) ||
      !this.host.scrollElement?.scrollTop
    ) {
      return 0;
    }
    const shift =
      content.element.getBoundingClientRect().top -
      row.getBoundingClientRect().top -
      content.offset;
    return Math.abs(shift) < 0.5 ? 0 : shift;
  }

  /**
   * Record the first content at or below the reader's top edge: the deepest first element of the
   * row crossing that edge which still reaches below it. Runs after every native scroll and resize
   * delivery, so the record describes the layout the next size change starts from. `refresh`
   * re-reads a record the reader is still inside, after its row's layout changed.
   */
  captureReaderContent(refresh = false): void {
    const element = this.host.scrollElement;
    if (!element?.clientHeight) {
      this.readerContent = null;
      return;
    }
    const readerTop = element.getBoundingClientRect().top;
    const previous = this.readerContent;
    if (!refresh && previous?.row.isConnected && previous.row.contains(previous.element)) {
      // Offsets inside a row change only when it resizes, so scrolling within the recorded
      // content keeps the record without walking the row again.
      const rect = previous.row.getBoundingClientRect();
      const edge = readerTop - rect.top;
      if (
        rect.bottom > readerTop &&
        edge >= previous.offset &&
        edge < previous.offset + previous.height
      ) {
        return;
      }
    }
    const { virtualizer } = this.host;
    let row: HTMLElement | undefined;
    for (const item of virtualizer.getVirtualItems()) {
      const candidate = virtualizer.elementsCache.get(item.key);
      if (
        candidate?.isConnected &&
        candidate.dataset.preparedRow !== "true" &&
        candidate.getBoundingClientRect().bottom > readerTop
      ) {
        row = candidate;
        break;
      }
    }
    // A scroll event can run after this frame's content change and before its resize delivery;
    // keep the record of the layout that change started from.
    const delivered = row && this.heights.get(row);
    if (
      row &&
      delivered !== undefined &&
      Math.abs(row.getBoundingClientRect().height - delivered) >= 0.5
    ) {
      return;
    }
    this.readerContent = null;
    if (!row) {
      return;
    }
    let content: Element = row;
    let child = row.firstElementChild;
    while (child) {
      const rect = child.getBoundingClientRect();
      if (rect.height > 0 && rect.bottom > readerTop) {
        content = child;
        child = child.firstElementChild;
      } else {
        child = child.nextElementSibling;
      }
    }
    if (content === row) {
      return;
    }
    const rect = content.getBoundingClientRect();
    this.readerContent = {
      row,
      element: content,
      offset: rect.top - row.getBoundingClientRect().top,
      height: rect.height,
    };
    // Entering bubbles animate a transform that rects include and row sizes don't. Record the
    // settled layout once the row's running animations end; a size change mid-animation stays
    // approximate. Activity shimmer never ends and moves nothing; a finished animation that
    // fills forwards is already settled.
    if (this.animatedRow === row) {
      return;
    }
    const animations = row
      .getAnimations({ subtree: true })
      .filter(
        (animation) =>
          animation.playState === "running" &&
          Number.isFinite(animation.effect?.getComputedTiming().endTime),
      );
    if (animations.length) {
      this.animatedRow = row;
      void Promise.allSettled(animations.map((animation) => animation.finished)).then(() => {
        if (this.animatedRow === row) {
          this.animatedRow = null;
          if (this.readerContent?.row === row) {
            this.captureReaderContent(true);
          }
        }
      });
    }
  }

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
    const corrected = this.unlandedWithin.get(key);
    this.unlandedWithin.delete(key);
    if (corrected !== undefined && Math.abs(item.size + delta - corrected) < 0.5) {
      return false;
    }
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
        // Prepend restores the measured bubble absolutely; relative compensation
        // can replay after its anchor retires during iOS's post-touch grace.
        return above && this.host.prependAnchor.messageKey === null;
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
    // A row unmounted before its measurement landed no longer extends the flow, and
    // measurement without scroll adjustment lands sizes without consulting landSize.
    const settled = (key: string): boolean => {
      const row = virtualizer.elementsCache.get(key);
      return (
        row?.isConnected !== true ||
        Math.abs((virtualizer.itemSizeCache.get(key) ?? -1) - (this.heights.get(row) ?? 0)) < 0.5
      );
    };
    for (const [key, applied] of this.unlanded) {
      if (settled(key)) {
        this.landedShift += applied;
        this.unlanded.delete(key);
      }
    }
    for (const key of this.unlandedWithin.keys()) {
      if (settled(key)) {
        this.unlandedWithin.delete(key);
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
    if (!shift) {
      return;
    }
    const element = this.host.scrollElement;
    const offset = element?.scrollTop ?? 0;
    // A held negative shift cannot be reached by native scrolling past zero.
    const reachesStart = shift < 0 && offset + shift <= 0;
    if (!force && this.holdsNativeOffset() && !reachesStart) {
      return;
    }
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
    this.readerContent = null;
    this.animatedRow = null;
    this.unlanded.clear();
    this.unlandedWithin.clear();
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

  private scrollBy(delta: number, offset?: number): void {
    const element = this.host.scrollElement;
    if (!element) {
      return;
    }
    const before = element.scrollTop;
    element.scrollTo({ top: (offset ?? before) + delta, behavior: "instant" });
    // Maintenance provenance keeps offset observers from reading the write as reader movement.
    this.host.offsetState.recordProgrammaticScroll?.(before, element.scrollTop, true);
    this.host.offsetState.syncNativeOffset?.(true);
  }
}
