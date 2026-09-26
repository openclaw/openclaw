import path from "node:path";
import { isMainThread } from "node:worker_threads";
import { isAbortError } from "../infra/abort-signal.js";
import type { SqliteWalHealth } from "../infra/sqlite-wal-checkpoint.js";
import {
  registerSqliteWalWorkerMaintenance,
  type SqliteWalPeriodicRequest,
  type SqliteWalPeriodicResult,
} from "../infra/sqlite-wal-write-admission.js";
import {
  assertExistingDatabaseIdentity,
  type DatabasePathIdentity,
} from "../infra/sqlite-worker-identity.js";
import { createSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import {
  getOpenClawDatabaseMaintenanceResourceScope,
  isStateDatabaseReadAdmissionInvalidatedError,
  StateDatabaseReadAdmissionInvalidatedError,
  type OpenClawStateDatabaseReadAdmission,
} from "./openclaw-state-db-async-lifecycle.js";
import type { StateDatabaseLifecycle } from "./openclaw-state-db-cache.types.js";
import type { OpenClawStateDatabase } from "./openclaw-state-db-contract.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";
import { captureOpenClawStateWorkerContextWithAdmission } from "./openclaw-state-worker-context.capture.js";

/** Bind periodic maintenance and its observations to the cache's exact native owner. */
export function createStateDatabaseWalOwner(
  { cachedDatabases, asyncResources }: StateDatabaseLifecycle,
  retainForIdle: (database: OpenClawStateDatabase) => () => void,
) {
  return {
    register(
      this: void,
      database: OpenClawStateDatabase,
      identity: DatabasePathIdentity,
      admission: OpenClawStateDatabaseReadAdmission,
      env: NodeJS.ProcessEnv,
    ): void {
      if (!isMainThread) {
        return;
      }
      const capturedContext = captureOpenClawStateWorkerContextWithAdmission(
        { path: database.path, env },
        () => admission,
      );
      const controller = new AbortController();
      let pending: Promise<SqliteWalPeriodicResult | undefined> | undefined;
      const cancel = () => {
        controller.abort();
        if (!pending) {
          unregister();
          return undefined;
        }
        return pending.then(
          () => undefined,
          () => undefined,
        );
      };
      const resource = {
        async close(selected?: DatabasePathIdentity) {
          if (selected && selected.key !== identity.key) {
            return;
          }
          void cancel();
          // The broker retains native cleanup; this owner joins accepted work before retirement.
          await pending?.catch(() => {});
          unregister();
        },
      };
      const unregister = asyncResources.register(resource);
      const run = async (request: SqliteWalPeriodicRequest) => {
        const maintenanceScope = getOpenClawDatabaseMaintenanceResourceScope(database.db);
        const context = { ...capturedContext, maintenanceScope };
        const assertCurrent = () => {
          controller.signal.throwIfAborted();
          context.admission.assertCurrent();
          maintenanceScope?.assertAdmission();
          if (
            getOpenClawDatabaseMaintenanceResourceScope(database.db) !== maintenanceScope ||
            cachedDatabases.get(database.path) !== database ||
            !database.db.isOpen
          ) {
            throw new StateDatabaseReadAdmissionInvalidatedError(
              "Shared-state WAL maintenance owner changed",
            );
          }
          assertExistingDatabaseIdentity(database.path, identity.key, identity.birthtime);
        };
        let releaseIdle: (() => void) | undefined;
        let operationStarted = false;
        try {
          assertCurrent();
          releaseIdle = retainForIdle(database);
          const { runOpenClawStateWorkerOperation } =
            await import("./openclaw-state-worker-store.js");
          assertCurrent();
          const result = await runOpenClawStateWorkerOperation(
            context,
            (worker) =>
              worker.execute(
                { type: "database.walMaintenance", input: request },
                { signal: controller.signal },
              ),
            {
              existingOnly: true,
              assertCurrent,
              createAdmission: () => ({
                nativeLocations: [database.path, identity.canonicalPath],
                admission: createSqliteWorkerOperationAdmission((_request, grant) => {
                  assertCurrent();
                  if (!grant()) {
                    throw new StateDatabaseReadAdmissionInvalidatedError(
                      "Shared-state WAL maintenance authority expired",
                    );
                  }
                  operationStarted = true;
                }),
              }),
            },
          );
          assertCurrent();
          return result;
        } catch (error) {
          if (
            !operationStarted &&
            (isStateDatabaseReadAdmissionInvalidatedError(error) ||
              (controller.signal.aborted && isAbortError(error)))
          ) {
            return undefined;
          }
          throw error;
        } finally {
          releaseIdle?.();
        }
      };
      registerSqliteWalWorkerMaintenance(
        database.db,
        (operation) => {
          if (controller.signal.aborted) {
            return Promise.resolve(undefined);
          }
          const active = run(operation);
          pending = active;
          return active.finally(() => {
            if (pending === active) {
              pending = undefined;
            }
            if (controller.signal.aborted) {
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
