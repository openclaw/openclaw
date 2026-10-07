import type { WorktreeTemplateWorkerOperations } from "../agents/worktrees/template-registry.worker.js";
import {
  loadDeviceIdentityIfPresent,
  loadOrCreateDeviceIdentity,
} from "../infra/device-identity.js";
import { refreshSqlitePlannerStatistics } from "../infra/sqlite-planner-statistics.js";
import { assertNoActiveSqliteReaders } from "../infra/sqlite-reader-lifecycle.js";
import { assertTransactionUsable } from "../infra/sqlite-transaction.js";
import { SQLITE_WORKER_PREPARE_COMMAND } from "../infra/sqlite-worker-contract.js";
import { assertExistingDatabaseIdentity } from "../infra/sqlite-worker-identity.js";
import { requestSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import {
  getSqliteWorkerStateContext,
  withSqliteWorkerExistingDatabase,
} from "../infra/sqlite-worker-state-context.js";
import {
  isPluginStateWorkerCommand,
  pluginStateWorkerOperations,
} from "../plugin-state/plugin-state-worker-contract.js";
import { readPluginMetadataStateRowSync } from "../plugins/installed-plugin-index-row.js";
import {
  openClawStateDatabaseCache,
  retainOpenClawStateDatabase,
} from "./openclaw-state-db-cache.js";
import type { OpenClawStateDatabase } from "./openclaw-state-db-contract.js";
import type { ExistingOpenClawStateWriter } from "./openclaw-state-db-existing-write.js";
import { assertOpenClawStateDatabaseOwner } from "./openclaw-state-db-maintenance.js";
import { ensureSecretStoreSchema } from "./openclaw-state-db-schema-additive.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "./openclaw-state-db.js";
import {
  acquireOpenClawStateLeaseInWorker,
  executeOpenClawStateLeaseCommand,
} from "./openclaw-state-lease-worker.js";
import type {
  OpenClawStateWorkerBackend,
  OpenClawStateWorkerOpenPreparation,
  OpenClawStateWorkerOperations,
} from "./openclaw-state-worker-contract.js";
import { createWorkerOperationRegistry } from "./worker-operation-registry.js";

// PR provisioning retains allocation and template owners without the application runtime.
const provisionRegistry = createWorkerOperationRegistry<
  WorktreeTemplateWorkerOperations &
    Pick<OpenClawStateWorkerOperations, "worktrees.reserveCapacity" | "worktrees.recoverPending">
>({
  worktrees: async () => {
    const [templates, reserveCapacity, recoverPending] = await Promise.all([
      import("../agents/worktrees/template-registry.worker.js").then(
        (loaded) => loaded.worktreeTemplateOperations,
      ),
      import("../agents/worktrees/capacity.worker.js").then(
        (loaded) => loaded.reserveWorktreeCapacityInWorker,
      ),
      import("../agents/worktrees/registry-run-end.worker.js").then(
        (loaded) => loaded.recoverPendingWorktreesInWorker,
      ),
    ]);
    return {
      ...templates,
      "worktrees.reserveCapacity": reserveCapacity,
      "worktrees.recoverPending": recoverPending,
    };
  },
});

let agentCleanup: typeof import("./openclaw-agent-execution-cleanup.worker.js") | undefined;
let pluginState: typeof import("../plugin-state/plugin-state.worker.js") | undefined;
let capture: typeof import("../proxy-capture/store.worker.js") | undefined;
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
  context: { databasePath: string; existingIdentity: string },
): OpenClawStateWorkerBackend {
  const identity = context.existingIdentity;
  assertExistingDatabaseIdentity(context.databasePath, identity);
  const backend = createSharedStateWorkerBackend(context, undefined, identity);
  return {
    ...backend,
    execute(command) {
      return withSqliteWorkerExistingDatabase(context.databasePath, identity, () =>
        backend.execute(command),
      );
    },
  };
}

function createSharedStateWorkerBackend(
  context: { databasePath: string },
  initialDatabase?: OpenClawStateDatabase,
  existingIdentity?: string,
): OpenClawStateWorkerBackend {
  let nativeDatabase = initialDatabase;
  let updateRunWriter: ExistingOpenClawStateWriter | undefined;
  let borrow = nativeDatabase ? retainOpenClawStateDatabase(nativeDatabase) : undefined;
  let closed = false;
  let secretSchemaAdmitted = false;
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
      if (
        commandType.startsWith("worktrees.templates.") ||
        commandType === "worktrees.reserveCapacity" ||
        commandType === "worktrees.recoverPending"
      ) {
        return provisionRegistry.prepare(commandType);
      }
      if (commandType.startsWith("capture.")) {
        if (capture) {
          return undefined;
        }
        return import("../proxy-capture/store.worker.js").then((loaded) => {
          capture = loaded;
        });
      }
      if (commandType === "agentDatabases.releaseExitedLease") {
        if (agentCleanup) {
          return undefined;
        }
        return import("./openclaw-agent-execution-cleanup.worker.js").then((loaded) => {
          agentCleanup = loaded;
        });
      }
      if (Object.hasOwn(pluginStateWorkerOperations, commandType)) {
        if (pluginState) {
          return undefined;
        }
        return import("../plugin-state/plugin-state.worker.js").then((loaded) => {
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
      return import("./openclaw-state-worker-runtime.js").then((loaded) => {
        runtime = loaded;
        return runtime.prepareSharedStateCommand(commandType);
      });
    },
    execute(command) {
      if (closed) {
        throw new Error("Shared-state worker is closed");
      }
      if (provisionRegistry.has(command)) {
        return provisionRegistry.execute(command, {
          open,
          stateOptions: () => ({
            path: context.databasePath,
            env: getSqliteWorkerStateContext().environment,
          }),
        });
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
        if (command.input.schemaPolicy === "existing" && existingIdentity) {
          // Existing-schema leases open a separate native connection outside open().
          assertExistingDatabaseIdentity(context.databasePath, existingIdentity);
        }
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
        const database = open();
        const admit = (stage: "transaction" | "commit") => {
          requestSqliteWorkerOperationAdmission({ stage, facts: undefined });
        };
        return (
          database.walMaintenance.maintainPeriodic?.(command.input, admit, () =>
            runOpenClawStateWriteTransaction(
              ({ db }) => {
                admit("transaction");
                refreshSqlitePlannerStatistics(db);
                admit("commit");
              },
              { database },
              { busyTimeoutMs: 0, operationLabel: "state.planner-statistics" },
            ),
          ) ?? { reclaimedPages: 0 }
        );
      }
      if (command.type === "database.inspectIdle") {
        // Idle maintenance must never materialize a connection for an artifact-preserving reader.
        if (
          !nativeDatabase?.db.isOpen ||
          openClawStateDatabaseCache.getCachedOpenClawStateDatabase(nativeDatabase.path) !==
            nativeDatabase
        ) {
          if (!nativeDatabase && updateRunWriter) {
            updateRunWriter.assertSettled();
            return "healthy";
          }
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
      const currentRuntime = runtime;
      if (!currentRuntime) {
        throw new Error("Shared-state worker command runtime is not prepared");
      }
      if (command.type === "secrets.write" && !secretSchemaAdmitted) {
        runOpenClawStateWriteTransaction(
          ({ db }) => ensureSecretStoreSchema(db),
          { database: open() },
          {
            operationLabel: "secrets.store.admit",
          },
        );
        secretSchemaAdmitted = true;
      }
      return currentRuntime.executeSharedStateCommand(
        command,
        context,
        open,
        () =>
          (updateRunWriter ??= currentRuntime.openUpdateRunWriter({
            path: context.databasePath,
            env: getSqliteWorkerStateContext().environment,
          })),
      );
    },
    assertSettled() {
      updateRunWriter?.assertSettled();
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
    async close() {
      closed = true;
      try {
        updateRunWriter?.close();
      } finally {
        await borrow?.releaseAsync();
      }
    },
  };
}
