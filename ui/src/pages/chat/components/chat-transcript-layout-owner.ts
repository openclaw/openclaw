import { nothing } from "lit";
import { Directive, directive, type ElementPart } from "lit/directive.js";
import {
  publishTranscriptScroll,
  readTranscriptViewport,
} from "./chat-transcript-scroll-events.ts";

/** The native scroll range changes only at these viewport and content writes. */
export class TranscriptLayoutOwner {
  private viewport: HTMLDivElement | null = null;
  private observers: ResizeObserver[] = [];
  private readonly rangeHeights = new WeakMap<HTMLElement, number>();

  constructor(private readonly onClamp: (before: number, after: number) => void) {}

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
    };
    // Padding and viewport size can change independently; neither box covers both.
    this.observers = (["content-box", "border-box"] as const).map((box) => {
      const observer = new ResizeObserver(resize);
      observer.observe(slot, { box });
      return observer;
    });
  }

  commitRange(element: HTMLElement, height: number): void {
    const previous = this.rangeHeights.get(element);
    if (previous === height) {
      return;
    }
    const shrinking =
      element.parentElement === this.viewport && previous !== undefined && height < previous;
    const before = shrinking ? this.viewport?.scrollTop : undefined;
    this.rangeHeights.set(element, height);
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
    // Publish the native clamp before another measurement can move the anchor.
    const measuredViewport = readTranscriptViewport(viewport);
    const after = measuredViewport.scrollTop;
    if (before !== after) {
      this.onClamp(before, after);
    }
    publishTranscriptScroll(viewport, {
      type: "resize",
      viewport: measuredViewport,
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
  render(_owner: TranscriptLayoutOwner, _height: number) {
    return nothing;
  }

  override update(part: ElementPart, [owner, height]: [TranscriptLayoutOwner, number]) {
    if (part.element instanceof HTMLElement) {
      owner.commitRange(part.element, height);
    }
    return nothing;
  }
}

export const transcriptRangeSize = directive(TranscriptRangeSize);
