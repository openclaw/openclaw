import type { Range, Virtualizer } from "@tanstack/virtual-core";

/** Prepare the measured tail; admit offscreen overscan when the reader navigates. */
export class TranscriptInitialRange {
  pending = true;
  private tailRows: number;
  private viewportOnly = false;
  private preparingOverscan = false;

  get measuring(): boolean {
    return this.pending || this.preparingOverscan;
  }

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
      return this.normalRange(this.viewportOnly ? { ...range, overscan: 0 } : range);
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

  restore(height: number, minimum: (index: number) => number): void {
    if (!this.pending) {
      return;
    }
    const virtualizer = this.virtualizer();
    for (let index = 0; index < virtualizer.options.count; index++) {
      const size = minimum(index);
      if (size) {
        virtualizer.resizeItem(index, size);
      }
    }
    if (!this.tailRows) {
      return;
    }
    let covered = 0,
      count = 0;
    for (let index = virtualizer.options.count - 1; index >= 0 && covered < height; index--) {
      const size = virtualizer.itemSizeCache.get(virtualizer.options.getItemKey(index));
      if (size === undefined) {
        return;
      }
      covered += size;
      count++;
    }
    this.tailRows = Math.max(1, count);
    this.refresh();
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

  finish(viewportOnly = false): void {
    this.pending = false;
    this.virtualizer().shouldAdjustScrollPositionOnItemSizeChange = undefined;
    if (!this.tailRows && !this.viewportOnly) {
      return;
    }
    this.preparingOverscan = this.viewportOnly && !viewportOnly;
    // The measured viewport stays adaptive; offscreen rows wait for reader navigation.
    this.tailRows = 0;
    this.viewportOnly = viewportOnly;
    this.refresh();
    this.invalidate();
  }

  complete(): void {
    if (this.pending) {
      this.finish(true);
    } else {
      this.preparingOverscan = false;
    }
  }

  disconnect(): void {
    this.preparingOverscan = false;
    if (!this.pending && (this.tailRows || this.viewportOnly)) {
      this.tailRows = 0;
      this.viewportOnly = false;
      this.refresh();
    }
  }
}
