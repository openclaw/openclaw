import assert from "node:assert/strict";
import { getEnvironmentData } from "node:worker_threads";
import {
  createSqliteWorkerBackend as createBackend,
  openExistingSqliteWorkerBackend as openBackend,
} from "../../state/openclaw-state.worker.js";
import { isPostgresSqlConnection } from "../sql-connection.js";
import { isSqliteLockError } from "../sqlite-error-diagnostics.js";
import { SQLITE_WORKER_SOURCE_FENCE } from "../sqlite-source-fence-contract.js";
import { SQLITE_WORKER_OPERATION_CLEANUP } from "../sqlite-worker-contract.js";

const PUBLICATION_RETRY_BARRIER = "openclaw.test.publicationSourceRetry";

/** Observe real failed acquisition and empty cleanup; never supply authority or a SQL result. */
function observeRetries(backend: ReturnType<typeof createBackend>) {
  const shared: unknown = getEnvironmentData(PUBLICATION_RETRY_BARRIER);
  assert(shared instanceof SharedArrayBuffer);
  const barrier = new Int32Array(shared);
  const restore: Array<() => void> = [];
  return {
    ...backend,
    [SQLITE_WORKER_SOURCE_FENCE](
      command: Parameters<NonNullable<(typeof backend)[typeof SQLITE_WORKER_SOURCE_FENCE]>>[0],
    ) {
      const fence = backend[SQLITE_WORKER_SOURCE_FENCE]?.(command);
      if (!fence || Atomics.compareExchange(barrier, 0, 1, 0) !== 1) {
        return fence;
      }
      const databases = [
        ...new Set([fence.destination, ...fence.sources].map(({ database }) => database)),
      ];
      let busy = false;
      const afterRelease = () => {
        if (!busy || databases.some((database) => database.isTransaction)) {
          return;
        }
        busy = false;
        Atomics.store(barrier, 1, 1);
        Atomics.notify(barrier, 1);
        // The host only changes in-memory policy while this worker owns no transaction.
        while (Atomics.load(barrier, 2) === 0) {
          Atomics.wait(barrier, 2, 0);
        }
      };
      for (const database of databases) {
        const exec = database.exec;
        database.exec = (sql) => {
          try {
            exec.call(database, sql);
          } catch (error) {
            if (sql === "BEGIN IMMEDIATE" && isSqliteLockError(error)) {
              busy = true;
              afterRelease();
            }
            throw error;
          }
          if (sql === "ROLLBACK") {
            afterRelease();
          }
        };
        restore.push(() => {
          database.exec = exec;
        });
        if (isPostgresSqlConnection(database)) {
          const prepare = database.prepare.bind(database);
          database.prepare = (sql) => {
            const statement = prepare(sql);
            if (sql === "SELECT pg_try_advisory_xact_lock(?) AS acquired") {
              const get = statement.get.bind(statement);
              statement.get = (...parameters) => {
                const result = get(...parameters);
                if (result?.acquired === 0) {
                  busy = true;
                }
                return result;
              };
            }
            return statement;
          };
          restore.push(() => {
            database.prepare = prepare;
          });
        }
      }
      return fence;
    },
    [SQLITE_WORKER_OPERATION_CLEANUP](
      command: Parameters<NonNullable<(typeof backend)[typeof SQLITE_WORKER_OPERATION_CLEANUP]>>[0],
    ) {
      for (const undo of restore.splice(0)) {
        undo();
      }
      backend[SQLITE_WORKER_OPERATION_CLEANUP]?.(command);
    },
  };
}

export function createSqliteWorkerBackend(...args: Parameters<typeof createBackend>) {
  return observeRetries(createBackend(...args));
}

export function openExistingSqliteWorkerBackend(...args: Parameters<typeof openBackend>) {
  return observeRetries(openBackend(...args));
}
