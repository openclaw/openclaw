import type { Virtualizer } from "@tanstack/virtual-core";
import { measureTranscriptRowRefs } from "./chat-transcript-geometry.ts";

/** Stable row refs own connection fences and deferred observer pruning. */
export class TranscriptRowRefs {
  private readonly refs = new Map<string, (element?: Element) => void>();
  private pruneQueued = false;
  private pendingRows = new Map<HTMLElement, string>();
  private measureQueued = false;

  constructor(
    private readonly virtualizer: Virtualizer<HTMLDivElement, HTMLElement>,
    private readonly callbacks: {
      canMeasureVisibleRows: () => boolean;
      isCurrentRow: (element: HTMLElement, key: string) => boolean;
      onMount: (key: string) => void;
    },
  ) {}

  private queueMountedRow(element: HTMLElement, key: string): void {
    this.pendingRows.set(element, key);
    if (this.measureQueued) {
      return;
    }
    this.measureQueued = true;
    // Nested message refs finish their preview clamps in a microtask. Capture
    // this batch at the first checkpoint so later mounts get their own wait.
    queueMicrotask(() => {
      const pendingRows = this.pendingRows;
      this.pendingRows = new Map();
      this.measureQueued = false;
      queueMicrotask(() => {
        const elements = [...pendingRows].flatMap(([row, rowKey]) =>
          row.isConnected &&
          row.dataset.virtualRowKey === rowKey &&
          this.callbacks.isCurrentRow(row, rowKey)
            ? [row]
            : [],
        );
        measureTranscriptRowRefs(
          elements,
          this.virtualizer,
          this.callbacks.canMeasureVisibleRows(),
        );
      });
    });
  }
  forKey(key: string): (element?: Element) => void {
    let callback = this.refs.get(key);
    if (!callback) {
      callback = (element?: Element) => {
        if (element instanceof HTMLElement) {
          this.callbacks.onMount(key);
          this.queueMountedRow(element, key);
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
    this.pendingRows.clear();
  }
}
