import { createDeferredCore } from "../shared/deferred.js";

/** Internal pull-wait ownership used by the node-host long poll. */
export class MeetingNodeAudioPullWaiters {
  readonly #waiters = new Set<() => void>();

  get size(): number {
    return this.#waiters.size;
  }

  async wait(timeoutMs: number): Promise<void> {
    const { promise: ready, resolve: wake } = createDeferredCore();
    this.#waiters.add(wake);
    const timer = setTimeout(wake, timeoutMs);
    try {
      await ready;
    } finally {
      // A stalled bridge can be polled indefinitely. Timeout must release its
      // resolver instead of retaining one waiter per empty pull.
      this.#waiters.delete(wake);
      clearTimeout(timer);
    }
  }

  wake(): void {
    const waiters = [...this.#waiters];
    this.#waiters.clear();
    for (const waiter of waiters) {
      waiter();
    }
  }
}
