import type { Virtualizer } from "@tanstack/virtual-core";
import { measureTranscriptRowRef } from "./chat-transcript-geometry.ts";

/** Stable row refs own connection fences and deferred observer pruning. */
export class TranscriptRowRefs {
  private readonly refs = new Map<string, (element?: Element) => void>();
  private pruneQueued = false;

  constructor(
    private readonly virtualizer: Virtualizer<HTMLDivElement, HTMLElement>,
    private readonly callbacks: {
      canMeasureVisibleRows: () => boolean;
      isCurrentRow: (element: HTMLElement, key: string) => boolean;
      onMount: (key: string) => void;
    },
  ) {}

  private measureMountedRow(element: HTMLElement): void {
    measureTranscriptRowRef(element, this.virtualizer, this.callbacks.canMeasureVisibleRows());
  }
  forKey(key: string): (element?: Element) => void {
    let callback = this.refs.get(key);
    if (!callback) {
      callback = (element?: Element) => {
        if (element instanceof HTMLElement) {
          this.callbacks.onMount(key);
          // Nested message refs finish their preview clamps in a microtask.
          // Measure in the same pre-paint checkpoint after those writes settle.
          queueMicrotask(() => {
            queueMicrotask(() => {
              if (
                element.isConnected &&
                element.dataset.virtualRowKey === key &&
                this.callbacks.isCurrentRow(element, key)
              ) {
                this.measureMountedRow(element);
              }
            });
          });
          return;
        }
        // Re-stamps (e.g. the chat<->dashboard face switch) re-invoke each
        // stable row ref as an (undefined, element) pair while the new subtree
        // is still detached. measureElement(null) prunes every disconnected
        // row, so calling it synchronously unobserves just-registered sibling
        // rows and freezes their heights at the old pane width (overlapping
        // bubbles). Defer until the commit lands so only removed rows prune.
        if (this.pruneQueued) {
          return;
        }
        this.pruneQueued = true;
        queueMicrotask(() => {
          this.pruneQueued = false;
          this.virtualizer.measureElement(null);
        });
      };
      this.refs.set(key, callback);
    }
    return callback;
  }

  retainKeys(keys: ReadonlyMap<string, number>): void {
    for (const key of this.refs.keys()) {
      if (!keys.has(key)) {
        this.refs.delete(key);
      }
    }
  }

  clear(): void {
    this.refs.clear();
  }
}
