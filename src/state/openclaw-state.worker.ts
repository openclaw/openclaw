import {
  loadDeviceIdentityIfPresent,
  loadOrCreateDeviceIdentity,
} from "../infra/device-identity.js";
import { assertNoActiveSqliteReaders } from "../infra/sqlite-reader-lifecycle.js";
import { assertTransactionUsable } from "../infra/sqlite-transaction.js";
import { SQLITE_WORKER_PREPARE_COMMAND } from "../infra/sqlite-worker-contract.js";
import { requestSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import { getSqliteWorkerStateContext } from "../infra/sqlite-worker-state-context.js";
import {
  isPluginStateWorkerCommand,
  pluginStateWorkerOperations,
} from "../plugin-state/plugin-state-worker-contract.js";
import { readPluginMetadataStateRowSync } from "../plugins/installed-plugin-index-row.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import {
  openClawStateDatabaseCache,
  retainOpenClawStateDatabase,
} from "./openclaw-state-db-cache.js";
import type { OpenClawStateDatabase } from "./openclaw-state-db-contract.js";
import { assertOpenClawStateDatabaseOwner } from "./openclaw-state-db-maintenance.js";
import { openOpenClawStateDatabase } from "./openclaw-state-db.js";
import {
  acquireOpenClawStateLeaseInWorker,
  executeOpenClawStateLeaseCommand,
} from "./openclaw-state-lease-worker.js";
import type {
  OpenClawStateWorkerBackend,
  OpenClawStateWorkerOpenPreparation,
} from "./openclaw-state-worker-contract.js";

const loadAgentCleanup = createLazyRuntimeModule(
  () => import("./openclaw-agent-execution-cleanup.worker.js"),
);
let agentCleanup: typeof import("./openclaw-agent-execution-cleanup.worker.js") | undefined;

const loadPluginState = createLazyRuntimeModule(
  () => import("../plugin-state/plugin-state.worker.js"),
);
let pluginState: typeof import("../plugin-state/plugin-state.worker.js") | undefined;

const loadCapture = createLazyRuntimeModule(() => import("../proxy-capture/store.worker.js"));
let capture: typeof import("../proxy-capture/store.worker.js") | undefined;

const loadRuntime = createLazyRuntimeModule(() => import("./openclaw-state-worker-runtime.js"));
let runtime: typeof import("./openclaw-state-worker-runtime.js") | undefined;

function stateDatabaseInitializationEnvironment(): NodeJS.ProcessEnv {
  const context = getSqliteWorkerStateContext();
  return context.initializationEnvironment ?? context.environment;
}

export function createSqliteWorkerBackend(
  _input: undefined,
  context: { databasePath: string; preparation?: OpenClawStateWorkerOpenPreparation },
): OpenClawStateWorkerBackend {
  if (context.preparation?.type === "deviceIdentity") {
    loadOrCreateDeviceIdentity({
      path: context.databasePath,
      env: stateDatabaseInitializationEnvironment(),
      identityKey: context.preparation.identityKey,
    });
  }
  const database = openOpenClawStateDatabase({
    path: context.databasePath,
    env: stateDatabaseInitializationEnvironment(),
    initializationAgentPaths: getSqliteWorkerStateContext().initializationAgentPaths,
  });
  return createSharedStateWorkerBackend(context, database);
}

export function openExistingSqliteWorkerBackend(
  _input: undefined,
  context: { databasePath: string },
): OpenClawStateWorkerBackend {
  return createSharedStateWorkerBackend(context);
}

function createSharedStateWorkerBackend(
  context: { databasePath: string },
  initialDatabase?: OpenClawStateDatabase,
): OpenClawStateWorkerBackend {
  let nativeDatabase = initialDatabase;
  let borrow = nativeDatabase ? retainOpenClawStateDatabase(nativeDatabase) : undefined;
  let closed = false;
  const open = (): OpenClawStateDatabase => {
    if (!nativeDatabase) {
      const opened = openOpenClawStateDatabase({
        path: context.databasePath,
        env: stateDatabaseInitializationEnvironment(),
        initializationAgentPaths: getSqliteWorkerStateContext().initializationAgentPaths,
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
      if (commandType.startsWith("capture.")) {
        if (capture) {
          return undefined;
        }
        return loadCapture().then((loaded) => {
          capture = loaded;
        });
      }
      if (commandType === "agentDatabases.releaseExitedLease") {
        if (agentCleanup) {
          return undefined;
        }
        return loadAgentCleanup().then((loaded) => {
          agentCleanup = loaded;
        });
      }
      if (Object.hasOwn(pluginStateWorkerOperations, commandType)) {
        if (pluginState) {
          return undefined;
        }
        return loadPluginState().then((loaded) => {
          pluginState = loaded;
        });
      }
      if (
        commandType === "plugins.metadata.read" ||
        commandType === "database.inspectIdle" ||
        commandType === "database.walMaintenance" ||
        commandType === "stateLease.acquire" ||
        commandType === "deviceIdentity.read" ||
        commandType === "deviceIdentity.load" ||
        commandType === "stateLease.verify" ||
        commandType === "stateLease.renew" ||
        commandType === "stateLease.release"
      ) {
        return undefined;
      }
      if (runtime) {
        return runtime.prepareSharedStateCommand(commandType);
      }
      return loadRuntime().then((loaded) => {
        runtime = loaded;
        return runtime.prepareSharedStateCommand(commandType);
      });
    },
    execute(command) {
      if (closed) {
        throw new Error("Shared-state worker is closed");
      }
      if (
        command.type === "capture.upsertSession" ||
        command.type === "capture.endSession" ||
        command.type === "capture.persistPayload" ||
        command.type === "capture.recordEvent" ||
        command.type === "capture.recordEventWithPayload" ||
        command.type === "capture.listSessions" ||
        command.type === "capture.getSessionEvents" ||
        command.type === "capture.summarizeSessionCoverage" ||
        command.type === "capture.readBlob" ||
        command.type === "capture.queryPreset" ||
        command.type === "capture.deleteSessions" ||
        command.type === "capture.purgeAll"
      ) {
        if (!capture) {
          throw new Error("Capture worker command runtime is not prepared");
        }
        return capture.executeCaptureCommand(command, open());
      }
      if (command.type === "deviceIdentity.read") {
        return loadDeviceIdentityIfPresent({
          path: context.databasePath,
          identityKey: command.input.identityKey,
          env: getSqliteWorkerStateContext().environment,
        });
      }
      if (command.type === "deviceIdentity.load") {
        try {
          return loadOrCreateDeviceIdentity({
            path: context.databasePath,
            identityKey: command.input.identityKey,
            env: stateDatabaseInitializationEnvironment(),
          });
        } finally {
          // An existing-only actor may acquire its first writable handle through this owner.
          const database = openClawStateDatabaseCache.getCachedOpenClawStateDatabase(
            context.databasePath,
          );
          if (!nativeDatabase && database) {
            borrow = retainOpenClawStateDatabase(database);
            nativeDatabase = database;
          }
        }
      }
      if (command.type === "agentDatabases.releaseExitedLease") {
        if (!agentCleanup) {
          throw new Error("Agent database cleanup runtime is not prepared");
        }
        return agentCleanup.executeAgentDatabaseCleanupCommand(
          command,
          open(),
          getSqliteWorkerStateContext().environment,
        );
      }
      if (command.type === "stateLease.acquire") {
        return acquireOpenClawStateLeaseInWorker(command.input, context.databasePath, open);
      }
      if (
        command.type === "stateLease.verify" ||
        command.type === "stateLease.renew" ||
        command.type === "stateLease.release"
      ) {
        return executeOpenClawStateLeaseCommand(command, open());
      }
      if (command.type === "plugins.metadata.read") {
        return readPluginMetadataStateRowSync(
          command.input.selector,
          { path: context.databasePath, env: getSqliteWorkerStateContext().environment },
          command.input.artifactPreservingReadOnly,
        );
      }
      if (command.type === "database.walMaintenance") {
        return (
          open().walMaintenance.maintainPeriodic?.(command.input, (stage) => {
            requestSqliteWorkerOperationAdmission({ stage, facts: undefined });
          }) ?? { reclaimedPages: 0 }
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
      if (isPluginStateWorkerCommand(command)) {
        if (!pluginState) {
          throw new Error("Plugin-state worker command runtime is not prepared");
        }
        return pluginState.executePluginStateCommand(
          command,
          {
            path: context.databasePath,
            env: getSqliteWorkerStateContext().environment,
          },
          open,
          nativeDatabase?.db.isOpen === true,
        );
      }
      if (!runtime) {
        throw new Error("Shared-state worker command runtime is not prepared");
      }
      return runtime.executeSharedStateCommand(command, context, open);
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
