import { createDeferredCore } from "../shared/deferred.js";
import { runQueuedStoreWrite, type StoreWriterQueue } from "../shared/store-writer-queue.js";
import type {
  SqliteWorkerInputPreparation,
  SqliteWorkerInputRetention,
} from "./sqlite-worker-broker.types.js";
import { SqliteWorkerError } from "./sqlite-worker-contract.js";

/** Retained inputs share the broker budget before they become queued jobs. */
export class SqliteWorkerInputAdmission {
  private bytes = 0;
  private readonly opens = new Set<Promise<void>>();
  private readonly inputPreparations = new Set<Promise<void>>();
  private readonly openQueue = new Map<string, StoreWriterQueue>();

  constructor(
    private readonly owner: {
      queuedBytes(): number;
      isClosing(): boolean;
      maxQueuedBytes: number;
      maxQueuedInputBytes: number;
      maxMessageBytes: number;
      maxPendingOpens: number;
    },
  ) {}

  get retainedBytes(): number {
    return this.bytes;
  }

  retain(bytes: number): () => void {
    this.bytes += bytes;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.bytes -= bytes;
      }
    };
  }

  open<T>(
    bytes: number,
    dispatch: () => Promise<T>,
    signal?: AbortSignal,
    reuse?: () => Promise<T | undefined>,
    sharedState = false,
  ): Promise<T> {
    if (
      this.opens.size >= this.owner.maxPendingOpens ||
      bytes > this.owner.maxMessageBytes ||
      this.owner.queuedBytes() + this.bytes + bytes > this.owner.maxQueuedBytes
    ) {
      return Promise.reject(
        new SqliteWorkerError("SQLite worker open input capacity reached", "overloaded"),
      );
    }
    const settled = createDeferredCore();
    this.opens.add(settled.promise);
    const release = this.retain(bytes);
    // Serialize aliases within each owner class without holding shared state behind agent scans.
    const enqueue = () =>
      runQueuedStoreWrite({
        queues: this.openQueue,
        storePath: sharedState ? "sqlite-shared-state-open" : "sqlite-open",
        label: "SQLite worker open",
        fn: dispatch,
        signal,
      });
    // Unknown actors enter the FIFO synchronously. A published actor can attach
    // independently, but still retains its input budget and participates in drainage.
    return (
      reuse
        ? Promise.resolve()
            .then(reuse)
            .then((store) => (store === undefined ? enqueue() : store))
        : enqueue()
    ).finally(() => {
      this.opens.delete(settled.promise);
      release();
      settled.resolve();
    });
  }

  async joinOpens(): Promise<void> {
    while (this.opens.size > 0) {
      await Promise.allSettled(this.opens);
    }
  }

  async joinPreparations(): Promise<void> {
    await Promise.allSettled(this.inputPreparations);
  }

  reserveInputPreparation(
    inputBytes: number,
    retention: SqliteWorkerInputRetention = "stream",
  ): SqliteWorkerInputPreparation {
    if (!Number.isSafeInteger(inputBytes) || inputBytes < 0) {
      throw new RangeError("SQLite worker input bytes must be a non-negative safe integer");
    }
    if (this.owner.isClosing()) {
      throw new SqliteWorkerError("SQLite worker host is closing", "closed");
    }
    const bytes =
      retention === "stream" && inputBytes > this.owner.maxQueuedInputBytes
        ? this.owner.maxMessageBytes
        : inputBytes;
    if (this.owner.queuedBytes() + this.bytes + bytes > this.owner.maxQueuedBytes) {
      throw new SqliteWorkerError("SQLite worker input preparation capacity reached", "overloaded");
    }
    this.bytes += bytes;
    const settled = createDeferredCore();
    this.inputPreparations.add(settled.promise);
    let handedOff = false;
    const release = () => {
      if (this.inputPreparations.delete(settled.promise)) {
        this.bytes -= bytes;
        settled.resolve();
      }
    };
    const assertCurrent = () => {
      if (!handedOff && (!this.inputPreparations.has(settled.promise) || this.owner.isClosing())) {
        throw new SqliteWorkerError("SQLite worker input preparation is closed", "closed");
      }
    };
    return {
      assertCurrent,
      handoff: (dispatch) => {
        if (!this.inputPreparations.has(settled.promise) || this.owner.isClosing()) {
          release();
          throw new SqliteWorkerError("SQLite worker input preparation is closed", "closed");
        }
        // Enqueue takes custody in this same synchronous turn, including its oversized checks.
        handedOff = true;
        release();
        return dispatch();
      },
      release,
    };
  }
}
