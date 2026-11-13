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

/**
 * Content the reader sees in the row crossing the top edge, in anchoring order: content starting
 * at or below the edge, then content the edge cuts through. The first still in the row anchors.
 * `from`/`until` bound the edge positions (row offsets) for which this order still holds.
 */
type ReaderContent = {
  readonly row: HTMLElement;
  readonly from: number;
  readonly until: number;
  readonly candidates: readonly { readonly element: Element; readonly offset: number }[];
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
 * or diagram that renders above text the reader already sees. Like native scroll anchoring
 * (disabled on the transcript), the content at that edge is recorded after each scroll and
 * resize delivery, and growth above it inside the row is compensated the same way.
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
  // Rows laid out in the flow at the last resize delivery: the content the reader has seen. A
  // prepared row is measured outside the flow, so joining it reveals new content too.
  private readonly laidOut = new WeakSet<Element>();
  // Corrections applied to native geometry before virtual-core measured the row.
  private readonly unlanded = new Map<string, number>();
  // Unlanded corrections made inside the reader's row. Its growth below the reader moves no
  // reader, so landing it owes no further scroll.
  private readonly unlandedWithin = new Set<string>();
  private columnShift = 0;
  private landedShift = 0;
  private owedScroll = 0;
  private observer: ResizeObserver | null = null;
  // A positioning owner can measure and release its anchor before this frame's resize
  // delivery. Its restoration already accounts for that delivery's rows.
  private ownedSinceDelivery = false;
  private readerContent: ReaderContent | null = null;
  // A landed size before the flow moved its start, and scrollTop with it, this batch.
  private flowMoved = false;
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
              this.laidOut.has(row)
            );
          })?.index
        : undefined;
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
      if (row.dataset.preparedRow === "true") {
        continue;
      }
      const delta = height - previous;
      const previousTop = top - moved;
      moved += delta;
      const index = virtualizer.indexFromElement(row);
      if (
        !compensating ||
        !range ||
        index < range.startIndex - overscan ||
        index > range.endIndex + overscan ||
        Math.abs(delta) < 0.5
      ) {
        continue;
      }
      // A row above the reader moves it by its whole change; the reader's own row by the part
      // above the content the reader sees.
      const above =
        isAboveReader(previousTop, previous, first, readerTop) ||
        (first && retainedIndex !== undefined && index < retainedIndex);
      const applied = above ? delta : this.contentShift(row);
      if (!applied) {
        continue;
      }
      if (!above) {
        this.unlandedWithin.add(key);
      }
      correction += applied;
      this.unlanded.set(key, (this.unlanded.get(key) ?? 0) + applied);
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
    for (const item of virtualizer.getVirtualItems()) {
      const row = virtualizer.elementsCache.get(item.key);
      if (row?.dataset.preparedRow === "true") {
        this.laidOut.delete(row);
      } else if (row && this.heights.has(row)) {
        this.laidOut.add(row);
      }
    }
    this.captureReaderContent(true);
  };

  /** The recorded content the reader sees, while it is still in its row. */
  readonly readerElement = (): Element | null => {
    const content = this.readerContent;
    return (
      content?.candidates.find(({ element }) => content.row.contains(element))?.element ?? null
    );
  };

  /** How far the recorded reader content moved inside a resized row. */
  private contentShift(row: HTMLElement): number {
    const content = this.readerContent;
    // At native zero the reader is at the start, where new content stays visible.
    if (content?.row !== row || !this.host.scrollElement?.scrollTop) {
      return 0;
    }
    const anchor = content.candidates.find(({ element }) => row.contains(element));
    if (!anchor) {
      return 0;
    }
    const shift =
      anchor.element.getBoundingClientRect().top - row.getBoundingClientRect().top - anchor.offset;
    return Math.abs(shift) < 0.5 ? 0 : shift;
  }

  /**
   * Record the content the reader sees in the row crossing the top edge. Runs after every native
   * scroll and resize delivery, so the record describes the layout the next size change starts
   * from. `refresh` re-reads a record the reader is still inside, after its row's layout changed.
   */
  captureReaderContent(refresh = false): void {
    const element = this.host.scrollElement;
    if (!element?.clientHeight) {
      this.readerContent = null;
      return;
    }
    const readerTop = element.getBoundingClientRect().top;
    const previous = this.readerContent;
    if (!refresh && previous?.row.isConnected) {
      // Offsets inside a row change only when it resizes, so scrolling within the recorded
      // range keeps the record without walking the row again.
      const rect = previous.row.getBoundingClientRect();
      const edge = readerTop - rect.top;
      if (rect.bottom > readerTop && edge >= previous.from && edge <= previous.until) {
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
    // keep the record of the layout that change started from. After a delivery, a further
    // change already laid out leaves no layout to record.
    const delivered = row && this.heights.get(row);
    const pending =
      row !== undefined &&
      delivered !== undefined &&
      Math.abs(row.getBoundingClientRect().height - delivered) >= 0.5;
    if (pending && !refresh) {
      return;
    }
    this.readerContent = null;
    if (!row || pending) {
      return;
    }
    // Like native scroll anchoring, walk into the content the edge cuts until reaching the first
    // content that starts at or below it; that anchors whole, so content growing inside what the
    // reader fully sees moves what follows. The cut content can be what changes (a diagram's
    // toolbar while its image grows below it), so it anchors only as a last resort.
    const rowTop = row.getBoundingClientRect().top;
    const edge = readerTop - rowTop;
    const below: { element: Element; offset: number }[] = [];
    const cut: { element: Element; offset: number }[] = [];
    let until = row.getBoundingClientRect().height;
    let walked: Element = row;
    let child = row.firstElementChild;
    while (child) {
      const rect = child.getBoundingClientRect();
      if (rect.height > 0 && rect.bottom > readerTop) {
        const offset = rect.top - rowTop;
        walked = child;
        if (offset >= edge - 0.5) {
          below.push({ element: child, offset });
          until = Math.min(until, offset);
          break;
        }
        cut.unshift({ element: child, offset });
        until = Math.min(until, rect.bottom - rowTop);
        child = child.firstElementChild;
      } else {
        child = child.nextElementSibling;
      }
    }
    // A rendered replacement (a diagram for its source block) detaches what it replaces; the
    // content after it still marks the reader's place.
    for (let node: Element | null = walked; node && node !== row; node = node.parentElement) {
      let next = node.nextElementSibling;
      while (next && !next.getBoundingClientRect().height) {
        next = next.nextElementSibling;
      }
      const offset = next ? next.getBoundingClientRect().top - rowTop : -Infinity;
      if (next && offset >= edge - 0.5) {
        below.push({ element: next, offset });
      }
    }
    if (!below.length && !cut.length) {
      return;
    }
    this.readerContent = { row, from: edge, until, candidates: [...below, ...cut] };
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
    const within = this.unlandedWithin.delete(key);
    const applied = this.unlanded.get(key);
    this.unlanded.delete(key);
    // Rows in the flow moved the content after them when they were laid out; only one above
    // the reader still owes that movement. Rows outside it change the flow's start (rows before
    // it) or a gap holding their estimated slot, and so move what follows. Placement owners
    // position by virtual geometry, as does a pane with no laid-out rows.
    const element = instance.elementsCache.get(item.key);
    const laidOut = (row: VirtualItem) => {
      const candidate = instance.elementsCache.get(row.key);
      return candidate?.isConnected === true && candidate.dataset.preparedRow !== "true";
    };
    const flowStart = instance.getVirtualItems().find(laidOut);
    let above: boolean;
    let moves = false;
    if (owned || !flowStart) {
      above = isAboveReader(
        item.start,
        item.size,
        !instance.itemSizeCache.has(item.key),
        instance.scrollOffset ?? 0,
      );
    } else if (element?.isConnected === true && element.dataset.preparedRow !== "true") {
      // Virtual offsets can lag the flow after held corrections; a row laid out below the
      // reader's edge moved nothing the reader sees.
      const readerTop = this.host.scrollElement?.getBoundingClientRect().top ?? 0;
      above =
        element.getBoundingClientRect().top <= readerTop + 0.5 &&
        isAboveReader(
          item.start,
          item.size,
          !instance.itemSizeCache.has(item.key),
          instance.scrollOffset ?? 0,
        );
    } else {
      const next = instance.getVirtualItems().find((row) => row.index > item.index && laidOut(row));
      const readerTop = this.host.scrollElement?.getBoundingClientRect().top ?? 0;
      above =
        item.index < flowStart.index ||
        (next !== undefined &&
          (instance.elementsCache.get(next.key)?.getBoundingClientRect().top ?? 0) <=
            readerTop + 0.5);
      moves = above;
      this.flowMoved ||= above;
    }
    const held = this.holdsNativeOffset();
    if (applied === undefined) {
      if (moves && !owned && !held && this.host.prependAnchor.messageKey === null) {
        // The flow moves in this frame; virtual-core would defer its write while iOS scrolls.
        this.owedScroll += delta;
        return false;
      }
      if (!above || owned || !held) {
        // Prepend restores the measured bubble absolutely; relative compensation
        // can replay after its anchor retires during iOS's post-touch grace.
        return above && this.host.prependAnchor.messageKey === null;
      }
      this.columnShift += delta;
      this.landedShift += delta;
      return false;
    }
    const owed = within ? 0 : delta - applied;
    this.landedShift += applied;
    if (held) {
      this.columnShift += owed;
      this.landedShift += owed;
    } else {
      this.owedScroll += owed;
    }
    return false;
  };

  /**
   * Apply corrections collected while virtual-core landed a measurement batch. Returns whether a
   * landed size moved the flow's start: its scroll adjustment is already written, so the flow
   * must be redrawn in the same frame.
   */
  flush(): boolean {
    const flowMoved = this.flowMoved;
    this.flowMoved = false;
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
    return flowMoved;
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
