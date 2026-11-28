import { toStringifiedError } from "@openclaw/normalization-core/error-coercion";
import { DEFAULT_WORKER_PENDING_TASKS, WorkerTaskError } from "@openclaw/worker-runtime";
import { KeyedAsyncQueue } from "../../plugin-sdk/keyed-async-queue.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";

// Serialize lifecycle archive Workers so this path cannot multiply
// whole-buffer usage across several Worker heaps at once.
const sqliteTranscriptArchiveWorkerQueue = resolveGlobalSingleton(
  Symbol.for("openclaw.sqliteTranscriptArchiveWorkerQueue"),
  () => ({ queue: new KeyedAsyncQueue(), pending: 0 }),
);
const SQLITE_TRANSCRIPT_ARCHIVE_WORKER_QUEUE_KEY = "lifecycle-archive";

export function runExclusiveSqliteTranscriptArchiveWorker<T>(
  run: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) {
    return Promise.reject(toStringifiedError(signal.reason));
  }
  if (sqliteTranscriptArchiveWorkerQueue.pending >= DEFAULT_WORKER_PENDING_TASKS) {
    return Promise.reject(
      new WorkerTaskError(
        "Session archiving is busy. Wait for pending archive operations to finish, then retry.",
        "overloaded",
      ),
    );
  }
  sqliteTranscriptArchiveWorkerQueue.pending++;
  const hooks = {
    onSettle: () => {
      sqliteTranscriptArchiveWorkerQueue.pending--;
    },
  };
  if (!signal) {
    return sqliteTranscriptArchiveWorkerQueue.queue.enqueue(
      SQLITE_TRANSCRIPT_ARCHIVE_WORKER_QUEUE_KEY,
      run,
      hooks,
    );
  }
  return new Promise<T>((resolve, reject) => {
    let pending: (() => Promise<T>) | undefined = run;
    const cancel = () => {
      // Drop execution before releasing the caller's claim; its FIFO slot remains inert.
      pending = undefined;
      reject(toStringifiedError(signal.reason));
    };
    signal.addEventListener("abort", cancel, { once: true });
    void sqliteTranscriptArchiveWorkerQueue.queue
      .enqueue(
        SQLITE_TRANSCRIPT_ARCHIVE_WORKER_QUEUE_KEY,
        () => {
          signal.removeEventListener("abort", cancel);
          const admitted = pending;
          pending = undefined;
          if (!admitted) {
            throw toStringifiedError(signal.reason);
          }
          // Once admitted, even a revoked request must join its physical settlement.
          return admitted();
        },
        hooks,
      )
      .then(resolve, reject);
  });
}

/** Includes admitted, queued, and cancelled operations until physical FIFO settlement. */
export function hasPendingSqliteArchiveWork(): boolean {
  return sqliteTranscriptArchiveWorkerQueue.pending !== 0;
}
