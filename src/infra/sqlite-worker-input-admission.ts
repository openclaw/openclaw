import { createDeferredCore } from "../shared/deferred.js";
import { runQueuedStoreWrite, type StoreWriterQueue } from "../shared/store-writer-queue.js";
import {
  runWithSqliteDatabaseAdmissionTurn,
  type PreparedSqliteReadAdmission,
} from "./sqlite-database-admission-turn.js";
import type {
  Job,
  PreparedSqliteWorkerOpen,
  SqliteWorkerInputPreparation,
  SqliteWorkerInputRetention,
} from "./sqlite-worker-broker.types.js";
import {
  SQLITE_WORKER_MAX_MESSAGE_BYTES,
  SqliteWorkerError,
  type SqliteWorkerRequest,
} from "./sqlite-worker-contract.js";
import { createSqliteWorkerTransferOwner } from "./sqlite-worker-transfer.js";
import { ownedWorkerBytes } from "./worker-transfer-bytes.js";

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

  async open<T>(
    bytes: number,
    databasePath: string,
    dispatch: () => Promise<T>,
    signal?: AbortSignal,
    reuse?: () => Promise<T | undefined>,
    carrierClass?: PreparedSqliteWorkerOpen["carrierClass"],
    prepare?: () => Promise<PreparedSqliteReadAdmission>,
  ): Promise<T> {
    if (
      this.opens.size >= this.owner.maxPendingOpens ||
      bytes > this.owner.maxMessageBytes ||
      this.owner.queuedBytes() + this.bytes + bytes > this.owner.maxQueuedBytes
    ) {
      throw new SqliteWorkerError("SQLite worker open input capacity reached", "overloaded");
    }
    const settled = createDeferredCore();
    this.opens.add(settled.promise);
    const release = this.retain(bytes);
    // Wait for a cold database's admission turn before the open FIFO. The turn owner
    // opens its own worker inside that turn, so a FIFO holder waiting on the same
    // turn would block that open and deadlock both.
    const enqueue = () =>
      runWithSqliteDatabaseAdmissionTurn(
        [databasePath],
        () =>
          // Serialize aliases within each owner class without holding unrelated stores behind agent scans.
          runQueuedStoreWrite({
            queues: this.openQueue,
            storePath: carrierClass ?? "generic",
            label: "SQLite worker open",
            fn: dispatch,
            signal,
          }),
        [],
        signal,
        prepare,
      );
    // Unknown actors register discovery/enqueue in invocation order before yielding. A published
    // actor can attach independently, retaining the same input budget and drainage.
    try {
      // Discovery failures still release this original input custody.
      return await (reuse
        ? Promise.resolve()
            .then(reuse)
            .then((store) => (store === undefined ? enqueue() : store))
        : enqueue());
    } finally {
      this.opens.delete(settled.promise);
      release();
      settled.resolve();
    }
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

export function prepareSqliteWorkerRequest(job: Job): SqliteWorkerRequest {
  if (
    job.request.type !== "execute" ||
    job.request.input.byteLength <= SQLITE_WORKER_MAX_MESSAGE_BYTES
  ) {
    // Bun's serializer can return shared storage; dispatch must own transferable bytes.
    if ("input" in job.request) {
      job.request.input = ownedWorkerBytes(job.request.input);
    }
    if (job.request.type === "open" && job.request.preparation) {
      job.request.preparation = ownedWorkerBytes(job.request.preparation);
    }
    return job.request;
  }
  const { input, ...request } = job.request;
  const producer = createSqliteWorkerTransferOwner();
  const transfer = producer.start([{ kind: "command", serialized: input }].values(), {
    kinds: ["command"],
  });
  job.inputTransfer = { id: transfer.id, producer };
  job.request.input = new Uint8Array();
  return { ...request, type: "execute-start", transfer };
}
