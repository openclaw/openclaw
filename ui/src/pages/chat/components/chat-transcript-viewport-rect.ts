import type { Rect, Virtualizer } from "@tanstack/virtual-core";
import {
  resolveTranscriptScrollMargin,
  syncScrollMargin,
  type createPositionRailGutter,
} from "./chat-transcript-geometry.ts";
import { type TranscriptLayoutOwner, unscaledBorderBox } from "./chat-transcript-layout-owner.ts";

type ViewportRectOwner = {
  getScrollElement(): HTMLDivElement | null;
  getHeaderHeight(): number;
  positionRail: Pick<ReturnType<typeof createPositionRailGutter>, "read" | "sync">;
  commitComposerResize(): void;
  measureConnectedRows(): boolean;
  queueRowMeasure(): void;
  onViewportResize(): void;
  layout: TranscriptLayoutOwner;
  invalidate(): void;
};

function sameDimension(previous: number | null | undefined, next: number): boolean {
  return previous != null && Math.abs(previous - next) < 0.5;
}

/** Delivers each viewport geometry once, including pane and sidebar pre-measurement. */
export class TranscriptViewportRect {
  private observedWidth: number | null = null;
  private observedHeight: number | null = null;
  private syncRect: (() => void) | null = null;

  constructor(private readonly owner: ViewportRectOwner) {}

  commit(widthChanged: boolean): void {
    this.owner.positionRail.sync();
    if (!widthChanged) {
      return;
    }
    const rect = this.owner.getScrollElement()?.getBoundingClientRect();
    if (!rect?.width || !rect.height) {
      return;
    }
    // The observer must not repeat this committed width's row scan.
    this.observedWidth = Math.round(rect.width);
    this.owner.measureConnectedRows();
  }

  sync(): void {
    this.syncRect?.();
  }

  readonly observe = (
    instance: Virtualizer<HTMLDivElement, HTMLElement>,
    callback: (rect: Rect) => void,
  ): (() => void) => {
    let delivered = false;
    const deliverRect = (rect: Rect) => {
      // Hidden tabs and detached faces retain their last measurable geometry.
      if (instance.scrollElement !== this.owner.getScrollElement() || !rect.width || !rect.height) {
        return;
      }
      const scrollMargin = resolveTranscriptScrollMargin(
        instance.scrollElement,
        this.owner.getHeaderHeight(),
      );
      // Sidebar commits can measure rows before the virtualizer gets its rect.
      if (
        delivered &&
        scrollMargin === instance.options.scrollMargin &&
        sameDimension(this.observedWidth, rect.width) &&
        sameDimension(this.observedHeight, rect.height) &&
        sameDimension(instance.scrollRect?.width, rect.width) &&
        sameDimension(instance.scrollRect?.height, rect.height)
      ) {
        return;
      }
      delivered = true;
      const railGeometry = this.owner.positionRail.read();
      this.owner.commitComposerResize();
      const widthChanged =
        this.observedWidth !== null && !sameDimension(this.observedWidth, rect.width);
      const heightChanged =
        this.observedHeight !== null && !sameDimension(this.observedHeight, rect.height);
      this.observedWidth = rect.width;
      this.observedHeight = rect.height;
      // The host supplies only the header height already compensated by its render.
      syncScrollMargin(instance, scrollMargin);
      callback(rect);
      if (railGeometry) {
        this.owner.layout.restoreRows(
          instance,
          railGeometry.columnWidth,
          rect.width,
          railGeometry.gutter,
        );
      }
      if (widthChanged) {
        // Preserve offscreen estimates; connected resizeItem measurements own scroll compensation.
        this.owner.measureConnectedRows();
        this.owner.queueRowMeasure();
      }
      this.owner.positionRail.sync(railGeometry);
      if (widthChanged || heightChanged) {
        this.owner.onViewportResize();
        this.owner.invalidate();
      }
    };
    const syncRect = () => {
      const element = instance.scrollElement;
      if (element?.getClientRects().length) {
        const rect = unscaledBorderBox(element);
        // Match virtual-core's observer normalization, including exact half-pixels.
        deliverRect({ width: Math.round(rect.width), height: Math.round(rect.height) });
      }
    };
    this.syncRect = syncRect;
    syncRect();
    const element = instance.scrollElement;
    const ResizeObserver = instance.targetWindow?.ResizeObserver;
    // Composer compensation must see the viewport before deferred row measurements.
    const observer =
      element && ResizeObserver
        ? new ResizeObserver(([entry]) => {
            const box = entry?.borderBoxSize?.[0];
            if (box) {
              deliverRect({ width: Math.round(box.inlineSize), height: Math.round(box.blockSize) });
            } else {
              syncRect();
            }
          })
        : null;
    if (element) {
      observer?.observe(element, { box: "border-box" });
    }
    return () => {
      observer?.disconnect();
      if (this.syncRect === syncRect) {
        this.syncRect = null;
      }
    };
  };
}
