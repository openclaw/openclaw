import type { Virtualizer } from "@tanstack/virtual-core";

/** Keyed Solid rows own their refs; batch observer changes after the DOM commit. */
export class TranscriptRowRefs {
  private readonly pendingRows = new Map<HTMLElement, string>();
  private updateQueued = false;
  private pruneQueued = false;

  constructor(
    private readonly virtualizer: Virtualizer<HTMLDivElement, HTMLElement>,
    private readonly callbacks: {
      isCurrentRow: (element: HTMLElement, key: string) => boolean;
      onMount: (key: string) => void;
    },
  ) {}

  get elements(): ReadonlySet<HTMLElement> {
    // A commit can measure connected rows before their queued observer registration.
    return new Set([...this.virtualizer.elementsCache.values(), ...this.pendingRows.keys()]);
  }

  private queueUpdate(): void {
    if (this.updateQueued) {
      return;
    }
    this.updateQueued = true;
    // Both Lit and Solid refs can run before connection. Pruning in the same
    // commit must wait too, or it can unobserve newly registered sibling rows.
    queueMicrotask(() => {
      this.updateQueued = false;
      for (const [row, rowKey] of this.pendingRows) {
        if (
          row.isConnected &&
          row.dataset.virtualRowKey === rowKey &&
          this.callbacks.isCurrentRow(row, rowKey)
        ) {
          this.virtualizer.measureElement(row);
        }
      }
      this.pendingRows.clear();
      if (this.pruneQueued) {
        this.pruneQueued = false;
        this.virtualizer.measureElement(null);
      }
    });
  }

  forKey(key: string): (element?: Element) => void {
    return (element?: Element) => {
      if (element instanceof HTMLElement) {
        this.callbacks.onMount(key);
        this.pendingRows.set(element, key);
      } else {
        this.pruneQueued = true;
      }
      this.queueUpdate();
    };
  }

  clear(): void {
    this.pendingRows.clear();
  }
}
