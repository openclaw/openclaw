import type { VirtualItem, Virtualizer } from "@tanstack/virtual-core";
import { nothing } from "lit";
import { Directive, directive, type ElementPart } from "lit/directive.js";
import { publishTranscriptScroll } from "./chat-transcript-scroll-events.ts";

/** The native scroll range changes only at these viewport and content writes. */
export class TranscriptLayoutOwner {
  private viewport: HTMLDivElement | null = null;
  private observers: ResizeObserver[] = [];
  private readonly ranges = new WeakMap<
    HTMLElement,
    {
      height: number;
      rows: readonly VirtualItem[];
      scrollMargin: number;
    }
  >();

  constructor(
    private readonly onClamp: (before: number, after: number) => void,
    private readonly onViewportCommitted: () => void,
  ) {}

  get viewportResizePending(): boolean {
    const viewport = this.viewport;
    const slot = viewport?.parentElement;
    const height = slot?.clientHeight;
    if (!viewport || !slot || !height) {
      return false;
    }
    const style = getComputedStyle(slot);
    return (
      height !== viewport.clientHeight ||
      style.paddingTop !== viewport.style.paddingTop ||
      style.paddingBottom !== viewport.style.paddingBottom
    );
  }

  connect(viewport: HTMLDivElement | null): void {
    if (viewport === this.viewport) {
      return;
    }
    this.disconnect();
    this.viewport = viewport;
    const slot = viewport?.parentElement;
    if (!viewport || !slot) {
      return;
    }
    const resize = (entries: ResizeObserverEntry[]) => {
      const entry = entries.find((candidate) => candidate.target === slot);
      const size = entry?.borderBoxSize[0];
      if (
        this.viewport !== viewport ||
        !viewport.isConnected ||
        !size?.inlineSize ||
        !size.blockSize
      ) {
        return;
      }
      const { paddingTop, paddingBottom } = getComputedStyle(slot);
      const width = `${size.inlineSize}px`;
      const height = `${size.blockSize}px`;
      if (
        viewport.style.width === width &&
        viewport.style.height === height &&
        viewport.style.paddingTop === paddingTop &&
        viewport.style.paddingBottom === paddingBottom
      ) {
        return;
      }
      const before = viewport.style.height === "" ? null : viewport.scrollTop;
      viewport.style.width = width;
      viewport.style.height = height;
      viewport.style.paddingTop = paddingTop;
      viewport.style.paddingBottom = paddingBottom;
      if (before !== null) {
        this.publishResize(before);
      }
      // Initial styles can clear the positioning fence without changing box
      // dimensions, so the viewport size observer may have nothing to report.
      this.onViewportCommitted();
    };
    // Padding and viewport size can change independently; neither box covers both.
    this.observers = (["content-box", "border-box"] as const).map((box) => {
      const observer = new ResizeObserver(resize);
      observer.observe(slot, { box });
      return observer;
    });
  }

  hasCommittedMeasurements(
    element: HTMLElement | null,
    virtualizer: Virtualizer<HTMLDivElement, HTMLElement>,
    headerHeight: number,
  ): boolean {
    const committed = element ? this.ranges.get(element) : undefined;
    const height = virtualizer.getTotalSize() + headerHeight;
    const rows = virtualizer.getVirtualItems();
    return (
      committed !== undefined &&
      committed.height === height &&
      committed.scrollMargin === virtualizer.options.scrollMargin &&
      committed.rows.length === rows.length &&
      committed.rows.every((row, index) => {
        const current = rows[index];
        return current?.key === row.key && current.start === row.start && current.size === row.size;
      })
    );
  }

  commitRange(
    element: HTMLElement,
    height: number,
    rows: readonly VirtualItem[],
    scrollMargin: number,
  ): void {
    const previous = this.ranges.get(element)?.height;
    // These are the exact range/row facts used by the same Lit commit, not a
    // reconstruction from CSS serialization or another measurement cache.
    this.ranges.set(element, { height, rows, scrollMargin });
    if (previous === height) {
      return;
    }
    const shrinking =
      element.parentElement === this.viewport && previous !== undefined && height < previous;
    const before = shrinking ? this.viewport?.scrollTop : undefined;
    element.style.height = `${height}px`;
    if (before !== undefined) {
      this.publishResize(before);
    }
  }

  private publishResize(before: number): void {
    const viewport = this.viewport;
    if (!viewport) {
      return;
    }
    const after = viewport.scrollTop;
    if (before !== after) {
      this.onClamp(before, after);
    }
    publishTranscriptScroll(viewport, {
      type: "resize",
      ...(before !== after ? { scrollCorrection: { before, after } } : {}),
    });
  }

  disconnect(): void {
    for (const observer of this.observers) {
      observer.disconnect();
    }
    this.observers = [];
    this.viewport = null;
  }
}

class TranscriptRangeSize extends Directive {
  render(
    _owner: TranscriptLayoutOwner,
    _height: number,
    _rows: readonly VirtualItem[],
    _scrollMargin: number,
  ) {
    return nothing;
  }

  override update(
    part: ElementPart,
    [owner, height, rows, scrollMargin]: [
      TranscriptLayoutOwner,
      number,
      readonly VirtualItem[],
      number,
    ],
  ) {
    if (part.element instanceof HTMLElement) {
      owner.commitRange(part.element, height, rows, scrollMargin);
    }
    return nothing;
  }
}

export const transcriptRangeSize = directive(TranscriptRangeSize);
