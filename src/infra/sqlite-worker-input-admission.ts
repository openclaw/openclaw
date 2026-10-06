import { createDeferredCore } from "../shared/deferred.js";
import type {
  SqliteWorkerInputPreparation,
  SqliteWorkerInputRetention,
} from "./sqlite-worker-broker.types.js";
import { SqliteWorkerError } from "./sqlite-worker-contract.js";

/** Retained inputs share the broker budget before they become queued jobs. */
export class SqliteWorkerInputAdmission {
  private bytes = 0;
  private inputPreparationGeneration = {};
  private readonly inputPreparations = new Set<Promise<void>>();
  private openTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly owner: {
      queuedBytes(): number;
      isClosing(): boolean;
      maxQueuedBytes: number;
      maxQueuedInputBytes: number;
      maxMessageBytes: number;
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

  open<T>(bytes: number, dispatch: () => Promise<T>): Promise<T> {
    if (
      bytes > this.owner.maxMessageBytes ||
      this.owner.queuedBytes() + this.bytes + bytes > this.owner.maxQueuedBytes
    ) {
      return Promise.reject(
        new SqliteWorkerError("SQLite worker open input capacity reached", "overloaded"),
      );
    }
    const previous = this.openTail;
    const settled = createDeferredCore();
    this.openTail = settled.promise;
    const release = this.retain(bytes);
    // Physical-file identity must be published before admitting another open alias.
    return previous.then(dispatch).finally(() => {
      release();
      settled.resolve();
    });
  }

  joinOpens(): Promise<void> {
    return this.openTail;
  }

  invalidatePreparations(): void {
    this.inputPreparationGeneration = {};
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
    const generation = this.inputPreparationGeneration;
    this.bytes += bytes;
    const settled = createDeferredCore();
    this.inputPreparations.add(settled.promise);
    let released = false;
    let handedOff = false;
    const release = () => {
      if (!released) {
        released = true;
        this.bytes -= bytes;
        this.inputPreparations.delete(settled.promise);
        settled.resolve();
      }
    };
    const assertCurrent = () => {
      if (
        !handedOff &&
        (released || this.owner.isClosing() || generation !== this.inputPreparationGeneration)
      ) {
        throw new SqliteWorkerError("SQLite worker input preparation is closed", "closed");
      }
    };
    return {
      assertCurrent,
      handoff: (dispatch) => {
        try {
          if (released) {
            throw new SqliteWorkerError("SQLite worker input preparation is closed", "closed");
          }
          assertCurrent();
        } catch (error) {
          release();
          throw error;
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
