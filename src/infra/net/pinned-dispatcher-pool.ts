import { AsyncLocalStorage } from "node:async_hooks";
import type { Dispatcher } from "undici";
import { closeDispatcher } from "./ssrf.js";

// Gateway startup imports this module before admitting requests. Pool timers and
// cleanup must keep that context instead of retaining the last request's stores.
const runInDispatcherPoolContext = AsyncLocalStorage.snapshot();

export type PinnedDispatcherLease = {
  dispatcher: Dispatcher;
  reused: boolean;
  release: () => Promise<void>;
};

type PinnedDispatcherPoolEntry = {
  key: string;
  dispatcher: Dispatcher;
  activeLeases: number;
  idleTimer?: ReturnType<typeof setTimeout>;
  closePromise?: Promise<void>;
};

type PinnedDispatcherPoolOptions = {
  maxEntries: number;
  idleTtlMs: number;
};

/**
 * Bounded cache of reusable DNS-pinned dispatchers.
 *
 * Callers must perform fresh DNS and SSRF validation before every acquisition
 * and include the resulting origin, address set, and connection policy in the key.
 */
export class PinnedDispatcherPool {
  private readonly entries = new Map<string, PinnedDispatcherPoolEntry>();
  private readonly maxEntries: number;
  private readonly idleTtlMs: number;
  private closed = false;

  constructor(options: PinnedDispatcherPoolOptions) {
    this.maxEntries = options.maxEntries;
    this.idleTtlMs = options.idleTtlMs;
  }

  acquire(params: {
    key: string;
    createDispatcher: () => Dispatcher;
  }): PinnedDispatcherLease | undefined {
    if (this.closed) {
      return undefined;
    }

    const existing = this.entries.get(params.key);
    if (existing) {
      clearTimeout(existing.idleTimer);
      existing.idleTimer = undefined;
      existing.activeLeases += 1;
      // Map insertion order is the cache's LRU order.
      this.entries.delete(existing.key);
      this.entries.set(existing.key, existing);
      return this.createLease(existing, true);
    }

    if (this.entries.size >= this.maxEntries) {
      const idleEntry = [...this.entries.values()].find((entry) => entry.activeLeases === 0);
      if (idleEntry) {
        this.retireEntry(idleEntry);
      }
    }
    if (this.entries.size >= this.maxEntries) {
      // Never evict a live stream merely to satisfy the reusable-cache cap.
      return undefined;
    }

    const entry: PinnedDispatcherPoolEntry = {
      key: params.key,
      dispatcher: params.createDispatcher(),
      activeLeases: 1,
    };
    this.entries.set(entry.key, entry);
    return this.createLease(entry, false);
  }

  async closeAll(): Promise<void> {
    this.closed = true;
    const entries = [...this.entries.values()];
    this.entries.clear();
    await Promise.all(
      entries.map((entry) => {
        clearTimeout(entry.idleTimer);
        entry.idleTimer = undefined;
        // Explicit lifecycle shutdown is bounded by closeDispatcher and must not
        // wait indefinitely for an abandoned response-body finalizer.
        return this.startClose(entry);
      }),
    );
  }

  private createLease(entry: PinnedDispatcherPoolEntry, reused: boolean): PinnedDispatcherLease {
    let released = false;
    return {
      dispatcher: entry.dispatcher,
      reused,
      release: async () => {
        if (released) {
          return;
        }
        released = true;
        entry.activeLeases -= 1;
        if (entry.activeLeases > 0) {
          return;
        }
        if (this.closed || this.entries.get(entry.key) !== entry) {
          await this.startClose(entry);
          return;
        }
        entry.idleTimer = runInDispatcherPoolContext(() =>
          setTimeout(() => this.retireEntry(entry), this.idleTtlMs),
        );
        entry.idleTimer.unref?.();
      },
    };
  }

  private retireEntry(entry: PinnedDispatcherPoolEntry): void {
    if (this.entries.get(entry.key) === entry) {
      this.entries.delete(entry.key);
    }
    clearTimeout(entry.idleTimer);
    entry.idleTimer = undefined;
    if (entry.activeLeases === 0) {
      void this.startClose(entry);
    }
  }

  private startClose(entry: PinnedDispatcherPoolEntry): Promise<void> {
    entry.closePromise ??= runInDispatcherPoolContext(() => closeDispatcher(entry.dispatcher));
    return entry.closePromise;
  }
}
