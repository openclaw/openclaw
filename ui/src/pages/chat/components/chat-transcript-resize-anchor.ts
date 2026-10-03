import type { VirtualItem, Virtualizer } from "@tanstack/virtual-core";

// Messages and their text blocks: the first of these at or below the viewport
// top is what the reader is looking at. Media is never an anchor, because it
// is the content that settles late; text around it must hold still instead.
const ANCHOR_BUBBLES = ".chat-bubble[data-message-id]";
const ANCHOR_BLOCKS = ":is(p, pre, li, h1, h2, h3, h4, h5, h6, table, blockquote)";
// Rows remember a bounded number of recently measured neighbours.
const ROW_OFFSET_LIMIT = 200;

// Offsets from the row top by message and block, so a regrouped or remounted
// row element still compares against what the reader saw.
type RowAnchorOffsets = Map<string, number>;
type RowAnchor = { id: string; element: Element };

export type TranscriptResizeAnchorHost = {
  /** Explicit commands and restores keep TanStack's own compensation policy. */
  hasScrollCommand(): boolean;
  /** Row whose disclosure the reader just toggled; it anchors on its own top. */
  interactionRow(): Element | null;
  /** A finger is on the transcript, so a momentum fling may follow. */
  touching(): boolean;
  /** Write a measured correction through the transcript's maintenance path. */
  writeOffset(offset: number, instance: Virtualizer<HTMLDivElement, HTMLElement>): void;
};

/** Same detection as TanStack, which defers its own corrections on iOS. */
function isIOSWebKit(): boolean {
  return (
    typeof navigator !== "undefined" &&
    (/iP(hone|od|ad)/.test(navigator.userAgent) ||
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 0))
  );
}

/**
 * iOS WebKit before Safari 27 stops momentum on every scrollTop write, so
 * TanStack defers corrections until the fling ends. Safari 27 keeps momentum
 * across writes (WebKit bug 187449) and ships `overflow-anchor` in the same
 * release, which is the feature we can detect.
 */
function transcriptWritesInterruptMomentum(): boolean {
  return (
    isIOSWebKit() && !(typeof CSS !== "undefined" && CSS.supports?.("overflow-anchor", "auto"))
  );
}

/**
 * Keep the message being read still when a row above it changes height.
 *
 * TanStack only compensates re-measured rows that sit entirely above the
 * viewport, and skips them while the reader scrolls up. That is exactly when
 * older history, late images, and code blocks settle above the reader. This
 * policy compensates every change above the first message the reader sees,
 * including the part of a row that spans the top edge, and nothing below it.
 */
export class TranscriptResizeAnchor {
  private readonly rowOffsets = new Map<string, RowAnchorOffsets>();
  private readonly deferToTanStack = transcriptWritesInterruptMomentum();
  private readonly ios = isIOSWebKit();
  // Offset the reader last saw painted, while native scrolling moves it.
  private paintedOffset: number | null = null;
  private paintedToken = 0;
  private scrollFrameOpen = false;
  // The toggled row keeps settling after its interaction anchor is released,
  // so it keeps the existing policy until the reader scrolls again.
  private toggledRow: Element | null = null;
  // Old iOS: corrections made during a fling move the rows on screen instead
  // of scrollTop, and fold into scrollTop once the fling rests.
  private heldShift = 0;
  private heldContent: HTMLElement | null = null;

  constructor(private readonly host: TranscriptResizeAnchorHost) {}

  /**
   * Native scrolling lands before this frame's resize observations. Choose the
   * anchor from what the reader saw, not from where this frame will paint.
   */
  noteReaderScroll(from: number): void {
    this.toggledRow = null;
    // The first scroll of a frame starts where the previous frame painted.
    if (!this.scrollFrameOpen) {
      this.scrollFrameOpen = true;
      this.paintedOffset = from;
      requestAnimationFrame(() => {
        this.scrollFrameOpen = false;
      });
    }
    const token = ++this.paintedToken;
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (this.paintedToken === token) {
          this.paintedOffset = null;
        }
      }),
    );
  }

  /** Take over TanStack's compensation for rows that resize. */
  attach(instance: Virtualizer<HTMLDivElement, HTMLElement>): void {
    instance.shouldAdjustScrollPositionOnItemSizeChange = this.shouldAdjust;
  }

  /** Record where each message sits inside a row seen for the first time. */
  observeRow(element: HTMLElement): void {
    const key = element.dataset.virtualRowKey;
    if (key !== undefined && !this.rowOffsets.has(key)) {
      this.recordRow(element);
    }
  }

  readonly shouldAdjust = (
    item: VirtualItem,
    delta: number,
    instance: Virtualizer<HTMLDivElement, HTMLElement>,
  ): boolean => {
    const offset = (instance.scrollOffset ?? 0) + instance.scrollAdjustments;
    const firstMeasure = !instance.itemSizeCache.has(item.key);
    const element = instance.elementsCache.get(item.key);
    this.toggledRow = this.host.interactionRow() ?? this.toggledRow;
    if (this.host.hasScrollCommand() || (element !== undefined && element === this.toggledRow)) {
      this.recordRow(element);
      return firstMeasure
        ? item.start < offset
        : item.end <= offset && instance.scrollDirection !== "backward";
    }
    let amount = 0;
    if (firstMeasure ? item.start < offset : item.end <= offset) {
      amount = delta;
    } else if (!firstMeasure && item.start < offset) {
      amount = this.shiftAboveReader(item, delta, offset, element, instance);
    }
    this.recordRow(element);
    if (Math.abs(amount) < 0.5) {
      return false;
    }
    // Old iOS: a scrollTop write would stop the fling, and TanStack's own
    // deferral applies everything in one jump when it rests. Hold it on screen.
    if (this.deferToTanStack) {
      if (instance.isScrolling || this.host.touching()) {
        this.hold(amount, instance);
      } else {
        this.write(amount, instance);
      }
      return false;
    }
    if (Math.abs(amount - delta) < 0.5 && !this.ios) {
      return true;
    }
    this.write(amount, instance);
    return false;
  };

  /** The reader's offset in row coordinates, including a shift held on screen. */
  readerOffset(scrollTop: number): number {
    return scrollTop + this.heldShift;
  }

  /**
   * Fold a held shift into scrollTop once the fling has rested, in one write
   * so the reader sees nothing move. Above the first row it cannot be
   * written yet, so it stays on screen until older history or the reader
   * makes room.
   */
  settle(instance: Virtualizer<HTMLDivElement, HTMLElement>): void {
    const scrollElement = instance.scrollElement;
    if (
      this.heldShift !== 0 &&
      scrollElement &&
      !instance.isScrolling &&
      !this.host.touching() &&
      this.readerOffset(scrollElement.scrollTop) >= 0
    ) {
      this.write(0, instance);
    }
  }

  /** Drop a held shift; the caller writes a target in row coordinates. */
  clearHeld(): void {
    this.heldShift = 0;
    this.heldContent?.style.removeProperty("translate");
    this.heldContent = null;
  }

  private hold(amount: number, instance: Virtualizer<HTMLDivElement, HTMLElement>): void {
    const scrollElement = instance.scrollElement;
    const content = scrollElement?.querySelector<HTMLElement>(":scope > .chat-thread-inner");
    if (!scrollElement || !content) {
      return;
    }
    if (this.heldContent !== content) {
      this.clearHeld();
      this.heldContent = content;
    }
    this.heldShift += amount;
    content.style.translate = `0 ${-this.heldShift}px`;
    // Later rows in this batch and the range see where the reader is.
    instance.scrollOffset = this.readerOffset(scrollElement.scrollTop);
  }

  private write(amount: number, instance: Virtualizer<HTMLDivElement, HTMLElement>): void {
    const scrollElement = instance.scrollElement;
    if (scrollElement) {
      this.host.writeOffset(this.readerOffset(scrollElement.scrollTop) + amount, instance);
    }
  }

  /** Shift of the first content the reader saw at or below the viewport top in a spanning row. */
  private shiftAboveReader(
    item: VirtualItem,
    delta: number,
    offset: number,
    element: HTMLElement | undefined,
    instance: Virtualizer<HTMLDivElement, HTMLElement>,
  ): number {
    const key = element?.dataset.virtualRowKey;
    const previous = key === undefined ? undefined : this.rowOffsets.get(key);
    const scrollElement = instance.scrollElement;
    if (!element || !previous || !scrollElement) {
      return 0;
    }
    // Row-relative line the reader saw at the viewport top. Rows may already
    // be repositioned for this frame, so live viewport positions can show
    // content the reader never saw.
    const nativeScroll =
      this.paintedOffset === null ? 0 : scrollElement.scrollTop - this.paintedOffset;
    const readerLine = offset - nativeScroll - item.start;
    const rowTop = element.getBoundingClientRect().top;
    for (const { id, element: candidate } of readRowAnchors(element)) {
      const before = previous.get(id);
      // Content already cut by the top edge is scrolling away, not being read.
      if (before !== undefined && before >= readerLine - 1) {
        return candidate.getBoundingClientRect().top - rowTop - before;
      }
    }
    // Nothing in this row starts inside the viewport, so the reader is looking
    // at a later row. Only the last row grows at the reader, like a stream.
    return item.index < instance.options.count - 1 ? delta : 0;
  }

  private recordRow(element: HTMLElement | undefined): void {
    const key = element?.dataset.virtualRowKey;
    if (!element?.isConnected || key === undefined) {
      return;
    }
    const rowTop = element.getBoundingClientRect().top;
    const offsets: RowAnchorOffsets = new Map();
    for (const { id, element: candidate } of readRowAnchors(element)) {
      offsets.set(id, candidate.getBoundingClientRect().top - rowTop);
    }
    this.rowOffsets.delete(key);
    this.rowOffsets.set(key, offsets);
    if (this.rowOffsets.size > ROW_OFFSET_LIMIT) {
      this.rowOffsets.delete(this.rowOffsets.keys().next().value!);
    }
  }
}

/** Anchor candidates in document order, named by message and block position. */
function readRowAnchors(element: HTMLElement): RowAnchor[] {
  const anchors: RowAnchor[] = [];
  for (const bubble of element.querySelectorAll<HTMLElement>(ANCHOR_BUBBLES)) {
    const id = bubble.dataset.messageId!;
    anchors.push({ id, element: bubble });
    bubble.querySelectorAll(ANCHOR_BLOCKS).forEach((block, index) => {
      anchors.push({ id: `${id}/${index}`, element: block });
    });
  }
  return anchors;
}
