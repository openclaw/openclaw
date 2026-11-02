import type { Range, Virtualizer } from "@tanstack/virtual-core";

export class TranscriptInitialRange {
  pending = true;
  private tailRows: number;
  private viewportOnly = false;
  private preparingOverscan = false;
  private cachedWindow = false;

  get measuring(): boolean {
    return this.pending || this.preparingOverscan;
  }

  get reading(): boolean {
    return !this.pending && !this.viewportOnly;
  }

  constructor(
    initialOffset: number | null,
    private readonly virtualizer: () => Virtualizer<HTMLDivElement, HTMLElement>,
    private readonly normalRange: (range: Range) => number[],
    private readonly invalidate: () => void,
    private readonly cachedRowSize: (index: number) => number,
  ) {
    this.tailRows = initialOffset === null ? 1 : 0;
  }

  extract(range: Range): number[] {
    const height = this.pending ? this.viewportRowHeight(this.virtualizer().scrollElement) : 0;
    if (height > 0) {
      let startIndex = range.startIndex;
      if (this.tailRows) {
        const virtualizer = this.virtualizer();
        startIndex = range.count - 1;
        let covered = this.cachedRowSize(startIndex);
        while (startIndex > 0 && covered > 0 && covered < height) {
          const size = this.cachedRowSize(--startIndex);
          if (!size) {
            break;
          }
          covered += size + virtualizer.options.gap;
        }
      }
      const cachedRange = {
        ...range,
        startIndex,
        endIndex: this.tailRows ? range.count - 1 : range.endIndex,
      };
      let indexes = this.normalRange(cachedRange);
      const cachedWindow = indexes.every((index) => this.cachedRowSize(index) > 0);
      if (!cachedWindow && this.tailRows) {
        indexes = this.normalRange({ ...cachedRange, overscan: 0 });
      }
      if (indexes.length && indexes.every((index) => this.cachedRowSize(index) > 0)) {
        // Exact-width footprints cover the viewport and overscan; no measurement ladder is needed.
        if (this.tailRows) {
          this.tailRows = range.count - indexes[0]!;
        }
        this.cachedWindow = cachedWindow;
        return indexes;
      }
    }
    if (!this.tailRows) {
      return this.normalRange(this.viewportOnly ? { ...range, overscan: 0 } : range);
    }
    const count = Math.min(range.count, this.tailRows);
    return Array.from({ length: count }, (_, index) => range.count - count + index);
  }

  private viewportRowHeight(element: HTMLDivElement | null): number {
    // Bottom padding fills the same part of the viewport for cached and measured rows.
    return element
      ? element.clientHeight - (Number.parseFloat(getComputedStyle(element).paddingBottom) || 0)
      : 0;
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
        virtualizer.getVirtualItems().reduce((height, row) => height + row.size, 0) <
          this.viewportRowHeight(element)
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
      this.finish(!this.cachedWindow);
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
