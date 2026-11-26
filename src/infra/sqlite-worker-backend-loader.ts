import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { SQLITE_WORKER_SOURCE_FENCE } from "./sqlite-source-fence-contract.js";
import {
  SQLITE_WORKER_PREPARE_COMMAND,
  SQLITE_WORKER_PREPARE_ADMITTED,
  SQLITE_WORKER_OPERATION_CLEANUP,
  SQLITE_WORKER_CLOSE_RECEIPT,
  SQLITE_WORKER_WAL_CHECKPOINT,
  type SqliteWorkerPreparedBackend,
  type SqliteWorkerOperations,
} from "./sqlite-worker-contract.js";

// A module loader registration is isolate-wide, including in the shared worker host.
let sourceLoaderRegistered = false;

export async function loadSqliteWorkerBackendModule(
  moduleUrl: string,
  sourceLoaderUrl?: string,
): Promise<unknown> {
  if (!sourceLoaderRegistered && sourceLoaderUrl) {
    const loader: unknown = await import(sourceLoaderUrl);
    if (!isRecord(loader) || typeof loader.register !== "function") {
      throw new Error("SQLite source worker loader is unavailable");
    }
    loader.register();
    sourceLoaderRegistered = true;
  }
  return import(moduleUrl);
}

/** Backend construction crosses the same contract whether its module is source or compiled. */
export function assertSqliteWorkerBackend(
  backend: unknown,
): asserts backend is SqliteWorkerPreparedBackend<SqliteWorkerOperations> {
  if (
    !isRecord(backend) ||
    typeof backend.execute !== "function" ||
    typeof backend.close !== "function" ||
    (SQLITE_WORKER_PREPARE_COMMAND in backend &&
      backend[SQLITE_WORKER_PREPARE_COMMAND] !== undefined &&
      typeof backend[SQLITE_WORKER_PREPARE_COMMAND] !== "function") ||
    (SQLITE_WORKER_PREPARE_ADMITTED in backend &&
      backend[SQLITE_WORKER_PREPARE_ADMITTED] !== undefined &&
      (typeof backend[SQLITE_WORKER_PREPARE_ADMITTED] !== "function" ||
        typeof backend.assertSettled !== "function")) ||
    (SQLITE_WORKER_OPERATION_CLEANUP in backend &&
      backend[SQLITE_WORKER_OPERATION_CLEANUP] !== undefined &&
      (typeof backend[SQLITE_WORKER_OPERATION_CLEANUP] !== "function" ||
        typeof backend.assertSettled !== "function")) ||
    (SQLITE_WORKER_SOURCE_FENCE in backend &&
      backend[SQLITE_WORKER_SOURCE_FENCE] !== undefined &&
      (typeof backend[SQLITE_WORKER_SOURCE_FENCE] !== "function" ||
        typeof backend.assertSettled !== "function")) ||
    (SQLITE_WORKER_CLOSE_RECEIPT in backend &&
      backend[SQLITE_WORKER_CLOSE_RECEIPT] !== undefined &&
      typeof backend[SQLITE_WORKER_CLOSE_RECEIPT] !== "function") ||
    (SQLITE_WORKER_WAL_CHECKPOINT in backend &&
      backend[SQLITE_WORKER_WAL_CHECKPOINT] !== undefined &&
      (typeof backend[SQLITE_WORKER_WAL_CHECKPOINT] !== "function" ||
        typeof backend.assertSettled !== "function")) ||
    (backend.assertSettled !== undefined && typeof backend.assertSettled !== "function") ||
    (backend.prepare !== undefined && typeof backend.prepare !== "function")
  ) {
    throw new Error("SQLite worker module returned an invalid backend");
  }
}
