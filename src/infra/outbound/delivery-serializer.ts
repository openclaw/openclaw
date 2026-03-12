/**
 * Per-channel+recipient delivery mutex.
 *
 * Ensures concurrent deliveries to the same target (channel:accountId:recipient)
 * are serialized in FIFO order, while different targets remain fully concurrent.
 * In-memory only — this is for runtime ordering, not persistence.
 */

export class DeliverySerializer {
  private queues = new Map<string, Promise<void>>();

  /** Queue `fn` behind any pending delivery for the same key. */
  async serialize<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(key) ?? Promise.resolve();

    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const resultPromise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });

    // Chain after previous delivery settles (success or failure).
    // The tail always resolves so one failure doesn't stall the queue.
    const tail: Promise<void> = prev.then(
      () =>
        fn().then(
          (v) => {
            resolve(v);
          },
          (e) => {
            reject(e);
          },
        ),
      () =>
        fn().then(
          (v) => {
            resolve(v);
          },
          (e) => {
            reject(e);
          },
        ),
    );

    this.queues.set(key, tail);

    try {
      return await resultPromise;
    } finally {
      // Auto-cleanup: if our tail is still the latest, the queue is drained.
      if (this.queues.get(key) === tail) {
        this.queues.delete(key);
      }
    }
  }

  /** Number of active keys (for testing / diagnostics). */
  get size(): number {
    return this.queues.size;
  }
}

/** Singleton used by the outbound delivery path. */
export const deliverySerializer = new DeliverySerializer();
