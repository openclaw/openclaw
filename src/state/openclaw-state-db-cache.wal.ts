import path from "node:path";
import { performance } from "node:perf_hooks";
import { isMainThread } from "node:worker_threads";
import { isAbortError } from "../infra/abort-signal.js";
import { runWithSqliteCoordinator, SqliteCoordinatorError } from "../infra/sqlite-coordinator.js";
import type { SqliteWalHealth } from "../infra/sqlite-wal-checkpoint.js";
import { registerSqliteWalWriteAdmission } from "../infra/sqlite-wal-write-admission.js";
import {
  assertExistingDatabaseIdentity,
  type DatabasePathIdentity,
} from "../infra/sqlite-worker-identity.js";
import { acquireStateDatabaseCoordinatorWithWait } from "../infra/state-database-coordinator-acquisition.js";
import { captureStateDatabaseCoordinatorRuntime } from "../infra/state-database-coordinator.js";
import {
  isStateDatabaseReadAdmissionInvalidatedError,
  StateDatabaseReadAdmissionInvalidatedError,
} from "./openclaw-state-db-async-lifecycle.js";
import type { StateDatabaseLifecycle } from "./openclaw-state-db-cache.types.js";
import {
  STATE_WAL_COORDINATOR_WAIT_MS,
  type OpenClawStateDatabase,
} from "./openclaw-state-db-contract.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";

/** Bind periodic maintenance and its observations to the cache's exact native owner. */
export function createStateDatabaseWalOwner(
  { cachedDatabases, asyncResources }: StateDatabaseLifecycle,
  retainForIdle: (database: OpenClawStateDatabase) => () => void,
) {
  return {
    register(this: void, database: OpenClawStateDatabase, identity: DatabasePathIdentity): void {
      if (!isMainThread) {
        return;
      }
      const runtime = captureStateDatabaseCoordinatorRuntime();
      const controller = new AbortController();
      let pending: Promise<void> | undefined;
      let coordinator:
        | Awaited<ReturnType<typeof acquireStateDatabaseCoordinatorWithWait>>
        | undefined;
      const releaseCoordinator = () => {
        try {
          coordinator?.release();
        } finally {
          if (coordinator?.closed) {
            coordinator = undefined;
          }
        }
      };
      const cancel = () => {
        controller.abort();
        if (!pending && !coordinator) {
          unregister();
        }
      };
      const unregister = asyncResources.register({
        async close(selected) {
          if (selected && selected.key !== identity.key) {
            return;
          }
          cancel();
          // The WAL scheduler reports operation errors; close joins before retrying cleanup.
          await pending?.catch(() => {});
          // A completed checkpoint is never replayed to retry native lease cleanup.
          releaseCoordinator();
          unregister();
        },
      });
      const run = async (operation: () => void) => {
        let releaseIdle: (() => void) | undefined;
        let operationStarted = false;
        try {
          if (coordinator) {
            throw new SqliteCoordinatorError("Shared-state WAL coordinator cleanup is pending");
          }
          const admission = asyncResources.capture(database.path);
          releaseIdle = retainForIdle(database);
          const assertCurrent = () => {
            controller.signal.throwIfAborted();
            admission.assertCurrent();
            if (cachedDatabases.get(database.path) !== database || !database.db.isOpen) {
              throw new StateDatabaseReadAdmissionInvalidatedError(
                "Shared-state WAL maintenance owner changed",
              );
            }
          };
          coordinator = await acquireStateDatabaseCoordinatorWithWait({
            operation: "wal-maintenance",
            databasePath: database.path,
            runtime,
            deadlineMs: performance.now() + STATE_WAL_COORDINATOR_WAIT_MS,
            maxPollIntervalMs: 25,
            signal: controller.signal,
            assertCurrent,
          });
          runWithSqliteCoordinator(coordinator, "shared-state periodic WAL maintenance", () => {
            assertCurrent();
            assertExistingDatabaseIdentity(database.path, identity.key);
            operationStarted = true;
            operation();
          });
        } catch (error) {
          if (
            !operationStarted &&
            (isStateDatabaseReadAdmissionInvalidatedError(error) ||
              (controller.signal.aborted && isAbortError(error)))
          ) {
            return;
          }
          throw error;
        } finally {
          if (coordinator?.closed) {
            coordinator = undefined;
          }
          releaseIdle?.();
        }
      };
      registerSqliteWalWriteAdmission(
        database.db,
        (operation) => {
          if (controller.signal.aborted) {
            return Promise.resolve();
          }
          const active = run(operation);
          pending = active;
          return active.finally(() => {
            if (pending === active) {
              pending = undefined;
            }
            if (controller.signal.aborted && !coordinator) {
              unregister();
            }
          });
        },
        cancel,
      );
    },
    /** Report the last observation without opening or querying SQLite. */
    readHealth(this: void): SqliteWalHealth | undefined {
      const database = cachedDatabases.get(path.resolve(resolveOpenClawStateSqlitePath()));
      return database?.db.isOpen ? database.walMaintenance.health : undefined;
    },
  };
}
