import type { Range, Virtualizer } from "@tanstack/virtual-core";
import { cancelLayout, scheduleLayout } from "../../../lib/layout-frame.ts";

/** Prepare measured tail rows before resuming the ordinary overscan window. */
export class TranscriptInitialRange {
  pending = true;
  private tailRows: number;

  constructor(
    initialOffset: number | null,
    private readonly virtualizer: () => Virtualizer<HTMLDivElement, HTMLElement>,
    private readonly normalRange: (range: Range) => number[],
    private readonly invalidate: () => void,
  ) {
    this.tailRows = initialOffset === null ? 1 : 0;
  }

  extract(range: Range): number[] {
    if (!this.tailRows) {
      return this.normalRange(range);
    }
    const count = Math.min(range.count, this.tailRows);
    return Array.from({ length: count }, (_, index) => range.count - count + index);
  }

  private refresh(): void {
    const virtualizer = this.virtualizer();
    virtualizer.setOptions({
      ...virtualizer.options,
      // Range extraction is memoized by function identity, independently of row measurements.
      rangeExtractor: (range) => this.extract(range),
    });
  }

  extend(element: HTMLDivElement): boolean {
    const virtualizer = this.virtualizer();
    if (
      !(
        this.tailRows > 0 &&
        this.tailRows < virtualizer.options.count &&
        virtualizer.getVirtualItems().reduce((height, row) => height + row.size, 0) +
          (Number.parseFloat(getComputedStyle(element).paddingBottom) || 0) <
          element.clientHeight
      )
    ) {
      return false;
    }
    // One preceding row avoids preparing and discarding expensive Markdown on estimates.
    this.tailRows += 1;
    this.refresh();
    return true;
  }

  finish(afterPaint = false): void {
    this.pending = false;
    this.virtualizer().shouldAdjustScrollPositionOnItemSizeChange = undefined;
    if (!this.tailRows) {
      return;
    }
    const resumeOverscan = () => {
      this.tailRows = 0;
      this.refresh();
      this.invalidate();
    };
    cancelLayout(this);
    if (afterPaint) {
      // Paint the measured viewport before preparing the ordinary offscreen overscan.
      scheduleLayout(this, () => () => scheduleLayout(this, () => resumeOverscan));
    } else {
      resumeOverscan();
    }
  }

  disconnect(): void {
    cancelLayout(this);
    if (!this.pending && this.tailRows) {
      this.tailRows = 0;
      this.refresh();
    }
  }
}
