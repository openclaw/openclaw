import type { Virtualizer } from "@tanstack/virtual-core";

/** Keyed Solid rows own their refs; batch observer changes after the DOM commit. */
export class TranscriptRowRefs {
  private readonly mountedRows = new Map<HTMLElement, string>();
  private updateQueued = false;
  private pruneQueued = false;

  constructor(
    private readonly virtualizer: Virtualizer<HTMLDivElement, HTMLElement>,
    private readonly callbacks: {
      isCurrentRow: (element: HTMLElement, key: string) => boolean;
      beforeMeasure: () => void;
      onMount: (key: string) => void;
    },
  ) {}

  get elements(): ReadonlySet<HTMLElement> {
    return new Set(this.mountedRows.keys());
  }

  observeConnected(): void {
    let prepared = false;
    for (const [row, key] of this.mountedRows) {
      if (
        row.isConnected &&
        row.dataset.virtualRowKey === key &&
        this.callbacks.isCurrentRow(row, key) &&
        this.virtualizer.elementsCache.get(key) !== row
      ) {
        if (!prepared) {
          this.callbacks.beforeMeasure();
          prepared = true;
        }
        // Detached observer receipts retire the cache, not the retained Solid ref.
        this.virtualizer.measureElement(row);
      }
    }
  }

  forKey(key: string): (element?: Element) => void {
    let mounted: HTMLElement | undefined;
    return (element?: Element) => {
      if (mounted) {
        this.mountedRows.delete(mounted);
      }
      mounted = element instanceof HTMLElement ? element : undefined;
      if (element instanceof HTMLElement) {
        this.callbacks.onMount(key);
        this.mountedRows.set(element, key);
      } else {
        this.pruneQueued = true;
      }
      if (this.updateQueued) {
        return;
      }
      this.updateQueued = true;
      // Both Lit and Solid refs can run before connection. Pruning in the same
      // commit must wait too, or it can unobserve newly registered sibling rows.
      queueMicrotask(() => {
        this.updateQueued = false;
        this.observeConnected();
        if (this.pruneQueued) {
          this.pruneQueued = false;
          this.virtualizer.measureElement(null);
        }
      });
    };
  }

  clear(): void {
    this.mountedRows.clear();
  }
}
