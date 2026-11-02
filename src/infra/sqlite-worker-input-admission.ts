import { createDeferredCore } from "../shared/deferred.js";
import { runQueuedStoreWrite, type StoreWriterQueue } from "../shared/store-writer-queue.js";
import { runWithSqliteDatabaseAdmissionTurn } from "./sqlite-database-admission-turn.js";
import type {
  SqliteWorkerInputPreparation,
  SqliteWorkerInputRetention,
} from "./sqlite-worker-broker.types.js";
import { SqliteWorkerError } from "./sqlite-worker-contract.js";

/** Retained inputs share the broker budget before they become queued jobs. */
export class SqliteWorkerInputAdmission {
  private bytes = 0;
  private readonly inputPreparations = new Set<Promise<void>>();
  private readonly openQueue = new Map<string, StoreWriterQueue>();
  private readonly opens = new Set<Promise<unknown>>();

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

  open<T>(
    bytes: number,
    databasePath: string,
    dispatch: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (
      bytes > this.owner.maxMessageBytes ||
      this.owner.queuedBytes() + this.bytes + bytes > this.owner.maxQueuedBytes
    ) {
      return Promise.reject(
        new SqliteWorkerError("SQLite worker open input capacity reached", "overloaded"),
      );
    }
    const release = this.retain(bytes);
    // Wait for a cold database's admission turn before the shared open FIFO. The
    // turn owner opens its own worker inside that turn, so a FIFO holder waiting
    // on the same turn would block that open and deadlock both.
    const opened = runWithSqliteDatabaseAdmissionTurn(
      [databasePath],
      () =>
        // Physical-file identity must be published before admitting another open alias.
        runQueuedStoreWrite({
          queues: this.openQueue,
          storePath: "sqlite-open",
          label: "SQLite worker open",
          fn: dispatch,
          signal,
        }),
      [],
      signal,
    ).finally(release);
    this.opens.add(opened);
    const settled = () => this.opens.delete(opened);
    void opened.then(settled, settled);
    return opened;
  }

  /** Joins every accepted open, including those still waiting for their turn. */
  async joinOpens(): Promise<void> {
    while (this.opens.size) {
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
        try {
          if (!this.inputPreparations.has(settled.promise)) {
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
