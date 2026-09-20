import { assertNoActiveSqliteReaders } from "../infra/sqlite-reader-lifecycle.js";
import { assertTransactionUsable } from "../infra/sqlite-transaction.js";
import {
  SQLITE_WORKER_PREPARE_COMMAND,
  type SqliteWorkerPreparedBackend,
} from "../infra/sqlite-worker-contract.js";
import { getSqliteWorkerStateContext } from "../infra/sqlite-worker-state-context.js";
import { readPluginMetadataStateRowSync } from "../plugins/installed-plugin-index-row.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import {
  openClawStateDatabaseCache,
  retainOpenClawStateDatabase,
} from "./openclaw-state-db-cache.js";
import type { OpenClawStateDatabase } from "./openclaw-state-db-contract.js";
import { assertOpenClawStateDatabaseOwner } from "./openclaw-state-db-maintenance.js";
import { openOpenClawStateDatabase } from "./openclaw-state-db.js";
import type {
  OpenClawStateWorkerOperations,
  OpenClawStateWorkerInspectionOperations,
} from "./openclaw-state-worker-contract.js";

const loadRuntime = createLazyRuntimeModule(() => import("./openclaw-state-worker-runtime.js"));
let runtime: typeof import("./openclaw-state-worker-runtime.js") | undefined;

export function createSqliteWorkerBackend(
  _input: undefined,
  context: { databasePath: string },
): SqliteWorkerPreparedBackend<
  OpenClawStateWorkerOperations & OpenClawStateWorkerInspectionOperations
> {
  const database = openOpenClawStateDatabase({
    path: context.databasePath,
    env: getSqliteWorkerStateContext().environment,
  });
  return createSharedStateWorkerBackend(context, database);
}

export function openExistingSqliteWorkerBackend(
  _input: undefined,
  context: { databasePath: string },
): SqliteWorkerPreparedBackend<
  OpenClawStateWorkerOperations & OpenClawStateWorkerInspectionOperations
> {
  return createSharedStateWorkerBackend(context);
}

function createSharedStateWorkerBackend(
  context: { databasePath: string },
  initialDatabase?: OpenClawStateDatabase,
): SqliteWorkerPreparedBackend<
  OpenClawStateWorkerOperations & OpenClawStateWorkerInspectionOperations
> {
  let nativeDatabase = initialDatabase;
  let borrow = nativeDatabase ? retainOpenClawStateDatabase(nativeDatabase) : undefined;
  let closed = false;
  const open = (): OpenClawStateDatabase => {
    if (!nativeDatabase) {
      const opened = openOpenClawStateDatabase({
        path: context.databasePath,
        env: getSqliteWorkerStateContext().environment,
      });
      borrow = retainOpenClawStateDatabase(opened);
      nativeDatabase = opened;
    }
    if (
      !nativeDatabase.db.isOpen ||
      openClawStateDatabaseCache.getCachedOpenClawStateDatabase(nativeDatabase.path) !==
        nativeDatabase
    ) {
      throw new Error("Shared-state worker lost its retained native database");
    }
    return openOpenClawStateDatabase({
      database: nativeDatabase,
      path: context.databasePath,
      env: getSqliteWorkerStateContext().environment,
    });
  };
  return {
    [SQLITE_WORKER_PREPARE_COMMAND](commandType) {
      if (
        commandType === "plugins.metadata.read" ||
        commandType === "database.inspectIdle" ||
        runtime
      ) {
        return undefined;
      }
      return loadRuntime().then((loaded) => {
        runtime = loaded;
      });
    },
    execute(command) {
      if (closed) {
        throw new Error("Shared-state worker is closed");
      }
      if (command.type === "plugins.metadata.read") {
        return readPluginMetadataStateRowSync(
          command.input.selector,
          { path: context.databasePath, env: getSqliteWorkerStateContext().environment },
          command.input.artifactPreservingReadOnly,
        );
      }
      if (command.type === "database.inspectIdle") {
        // Idle maintenance must never materialize a connection for an artifact-preserving reader.
        if (
          !nativeDatabase?.db.isOpen ||
          openClawStateDatabaseCache.getCachedOpenClawStateDatabase(nativeDatabase.path) !==
            nativeDatabase
        ) {
          return "retire";
        }
        assertOpenClawStateDatabaseOwner(nativeDatabase.db, { pathname: nativeDatabase.path });
        return nativeDatabase.walMaintenance.inspectIdle?.() ?? "retire";
      }
      if (!runtime) {
        throw new Error("Shared-state worker command runtime is not prepared");
      }
      return runtime.executeSharedStateCommand(
        command,
        context,
        open,
        nativeDatabase?.db.isOpen === true,
      );
    },
    assertSettled() {
      if (nativeDatabase) {
        assertTransactionUsable(nativeDatabase.db);
        if (nativeDatabase.db.isOpen && nativeDatabase.db.isTransaction) {
          throw new Error("Shared-state worker retained an unsettled transaction");
        }
        if (nativeDatabase.db.isOpen) {
          assertNoActiveSqliteReaders(nativeDatabase.db, "Shared-state worker");
        }
      }
    },
    close() {
      closed = true;
      borrow?.release();
    },
  };
}
