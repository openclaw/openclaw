import type { WorktreeTemplateWorkerOperations } from "../agents/worktrees/template-registry.worker.js";
import { isClawAddStateCommand } from "../claws/add-state-worker-contract.js";
import { isPostgresSqlConnection } from "../infra/sql-connection.js";
import { refreshSqlitePlannerStatistics } from "../infra/sqlite-planner-statistics.js";
import { assertNoActiveSqliteReaders } from "../infra/sqlite-reader-lifecycle.js";
import { SQLITE_WORKER_SOURCE_FENCE } from "../infra/sqlite-source-fence-contract.js";
import { assertTransactionUsable } from "../infra/sqlite-transaction.js";
import {
  SQLITE_WORKER_PREPARE_COMMAND,
  SQLITE_WORKER_OPERATION_CLEANUP,
  SQLITE_WORKER_PREPARE_ADMITTED,
} from "../infra/sqlite-worker-contract.js";
import { assertExistingDatabaseIdentity } from "../infra/sqlite-worker-identity.js";
import {
  deferSqliteWorkerCommitReceipt,
  requestSqliteWorkerOperationAdmission,
} from "../infra/sqlite-worker-operation-admission.js";
import {
  getSqliteWorkerStateContext,
  withSqliteWorkerExistingDatabase,
} from "../infra/sqlite-worker-state-context.js";
import {
  isPluginStateWorkerCommand,
  pluginStateWorkerOperations,
} from "../plugin-state/plugin-state-worker-contract.js";
import {
  openClawStateDatabaseCache,
  retainOpenClawStateDatabase,
} from "./openclaw-state-db-cache.js";
import type { OpenClawStateDatabase } from "./openclaw-state-db-contract.js";
import type { ExistingOpenClawStateWriter } from "./openclaw-state-db-existing-write.js";
import { ensureSecretStoreSchema } from "./openclaw-state-db-schema-additive.js";
import {
  openOpenClawStateDatabase,
  reconcileOpenClawStateSchemaPublication,
  runOpenClawStateWriteTransaction,
} from "./openclaw-state-db.js";
import {
  acquireOpenClawStateLeaseInWorker,
  executeOpenClawStateLeaseCommand,
} from "./openclaw-state-lease-worker.js";
import type {
  OpenClawStateWorkerBackend,
  OpenClawStateWorkerOperations,
} from "./openclaw-state-worker-contract.js";
import { stateWorkerRegistry } from "./openclaw-state-worker-registry.js";
import {
  createWorkerOperationRegistry,
  type WorkerWriteOperationContext,
} from "./worker-operation-registry.js";

// Restart handoff must stay cheap when shutdown has already retired every actor.
const commandRegistry = createWorkerOperationRegistry<
  WorktreeTemplateWorkerOperations &
    Pick<
      OpenClawStateWorkerOperations,
      | "worktrees.reserveCapacity"
      | "worktrees.recoverPending"
      | Extract<keyof OpenClawStateWorkerOperations, `restartLifecycle.${string}`>
    >,
  WorkerWriteOperationContext
>({
  restartLifecycle: () =>
    import("../infra/restart-lifecycle.worker.js").then(
      (loaded) => loaded.restartLifecycleOperations,
    ),
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
let clawAddState: typeof import("../claws/add-state.worker.js") | undefined;
let pluginState: typeof import("../plugin-state/plugin-state.worker.js") | undefined;
let capture: typeof import("../proxy-capture/store.worker.js") | undefined;
let cron: typeof import("../cron/store/dispatch.worker.js") | undefined;
let updater: typeof import("../infra/update-run-dispatch.worker.js") | undefined;
let publicationSource: typeof import("./github-publication-source.worker.js") | undefined;

function stateDatabaseInitializationEnvironment(): NodeJS.ProcessEnv {
  const context = getSqliteWorkerStateContext();
  return context.initializationEnvironment ?? context.environment;
}

export function createSqliteWorkerBackend(
  _input: undefined,
  context: { databasePath: string },
): OpenClawStateWorkerBackend {
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
  let publicationSourceReader:
    | ReturnType<NonNullable<typeof publicationSource>["createGitHubPublicationSourceWorker"]>
    | undefined;
  const retainCachedDatabase = () => {
    // Existing-only operations can acquire their first writable handle through a native owner.
    if (!nativeDatabase) {
      const database = openClawStateDatabaseCache.getCachedOpenClawStateDatabase(
        context.databasePath,
      );
      if (database) {
        borrow = retainOpenClawStateDatabase(database);
        nativeDatabase = database;
      }
    }
  };
  const retainedDatabase = (): OpenClawStateDatabase => {
    if (!nativeDatabase) {
      const opened = openOpenClawStateDatabase({
        path: context.databasePath,
        env: stateDatabaseInitializationEnvironment(),
        initializationAgentPaths: getSqliteWorkerStateContext().initializationAgentPaths,
      });
      borrow = retainOpenClawStateDatabase(opened);
      nativeDatabase = opened;
    }
    // The cache lookup also enforces current schema and terminal-failure admission.
    if (
      !nativeDatabase.db.isOpen ||
      openClawStateDatabaseCache.getCachedOpenClawStateDatabase(nativeDatabase.path) !==
        nativeDatabase
    ) {
      throw new Error("Shared-state worker lost its retained native database");
    }
    return nativeDatabase;
  };
  const open = (): OpenClawStateDatabase =>
    openOpenClawStateDatabase({
      database: retainedDatabase(),
      path: context.databasePath,
      env: getSqliteWorkerStateContext().environment,
    });
  // The transaction owner validates schema and write authority after BEGIN.
  const write = <T>(
    operation: (database: OpenClawStateDatabase) => T,
    transactionOptions?: Parameters<WorkerWriteOperationContext["write"]>[1],
    database = retainedDatabase(),
    env: NodeJS.ProcessEnv = getSqliteWorkerStateContext().environment,
  ): T =>
    runOpenClawStateWriteTransaction(
      operation,
      {
        database,
        path: context.databasePath,
        env,
      },
      transactionOptions,
    );
  const writeAdmitted: WorkerWriteOperationContext["writeAdmitted"] = (
    operation,
    transactionOptions = {},
  ) => {
    const { receipt, transactionEnvironment, ...options } = transactionOptions;
    const openedDatabase = open();
    return write(
      (database) => {
        requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
        const result = operation(database);
        requestSqliteWorkerOperationAdmission({
          stage: "commit",
          facts: receipt === "result" ? result : undefined,
        });
        if (receipt === "result") {
          deferSqliteWorkerCommitReceipt(database.db, result);
        }
        return result;
      },
      options,
      openedDatabase,
      transactionEnvironment === "process" ? process.env : undefined,
    );
  };
  const operationContext: WorkerWriteOperationContext = {
    open,
    write,
    writeAdmitted,
    stateOptions: () => ({
      path: context.databasePath,
      env: getSqliteWorkerStateContext().environment,
    }),
  };
  return {
    [SQLITE_WORKER_PREPARE_ADMITTED](command) {
      const source =
        command.type === "githubPublication.sourceFacts" ||
        command.type === "githubPublications.shared" ||
        command.type === "githubPublications.insert" ||
        command.type === "githubPublications.personal" ||
        command.type === "githubPublications.repository"
          ? command.input.source
          : undefined;
      if (source) {
        if (!publicationSource) {
          throw new Error("GitHub publication source runtime is not prepared.");
        }
        publicationSourceReader ??= publicationSource.createGitHubPublicationSourceWorker();
        publicationSourceReader.prepare(source, open().db);
      }
    },
    [SQLITE_WORKER_SOURCE_FENCE](command) {
      if (
        command.type === "githubPublications.shared" ||
        command.type === "githubPublications.insert" ||
        command.type === "githubPublications.personal" ||
        command.type === "githubPublications.repository"
      ) {
        if (command.input.source) {
          if (!publicationSourceReader) {
            throw new Error("GitHub publication source is unavailable.");
          }
          return publicationSourceReader.fence(command.input.source);
        }
      }
      return undefined;
    },
    [SQLITE_WORKER_OPERATION_CLEANUP]() {
      publicationSourceReader?.close();
    },
    prepare(command) {
      if (command.type === "pluginState.executeOperation") {
        if (pluginState) {
          return pluginState.preparePluginStateOperation(command.input);
        }
        return import("../plugin-state/plugin-state.worker.js").then((loaded) => {
          pluginState = loaded;
          return pluginState.preparePluginStateOperation(command.input);
        });
      }
      return undefined;
    },
    [SQLITE_WORKER_PREPARE_COMMAND](commandType) {
      if (commandType.startsWith("cron.")) {
        if (cron) {
          return cron.prepareCronStateWorkerCommand(commandType);
        }
        return import("../cron/store/dispatch.worker.js").then((loaded) => {
          cron = loaded;
          return cron.prepareCronStateWorkerCommand(commandType);
        });
      }
      if (commandType.startsWith("updateRuns.")) {
        if (updater) {
          return undefined;
        }
        return import("../infra/update-run-dispatch.worker.js").then((loaded) => {
          updater = loaded;
        });
      }
      if (isClawAddStateCommand({ type: commandType })) {
        if (clawAddState) {
          return undefined;
        }
        return import("../claws/add-state.worker.js").then((loaded) => {
          clawAddState = loaded;
        });
      }
      if (
        commandType === "githubPublication.sourceFacts" ||
        commandType.startsWith("githubPublications.")
      ) {
        const sourcePreparation = publicationSource
          ? undefined
          : import("./github-publication-source.worker.js").then((loaded) => {
              publicationSource = loaded;
            });
        const commandPreparation =
          commandType === "githubPublication.sourceFacts"
            ? undefined
            : stateWorkerRegistry.prepare(commandType);
        // A Promise marks newly loaded modules for the transport's compile-cache flush.
        return sourcePreparation || commandPreparation
          ? Promise.all([sourcePreparation, commandPreparation]).then(() => undefined)
          : undefined;
      }
      if (
        commandType.startsWith("restartLifecycle.") ||
        commandType.startsWith("worktrees.templates.") ||
        commandType === "worktrees.reserveCapacity" ||
        commandType === "worktrees.recoverPending"
      ) {
        return commandRegistry.prepare(commandType);
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
        commandType === "database.walMaintenance" ||
        commandType === "database.publishSchema" ||
        commandType === "stateLease.acquire" ||
        commandType === "stateLease.verify" ||
        commandType === "stateLease.renew" ||
        commandType === "stateLease.release"
      ) {
        return undefined;
      }
      return stateWorkerRegistry.prepare(commandType);
    },
    execute(command) {
      if (closed) {
        throw new Error("Shared-state worker is closed");
      }
      if (isClawAddStateCommand(command)) {
        if (!clawAddState) {
          throw new Error("Claw Add state runtime is not prepared");
        }
        return clawAddState.executeClawAddStateCommand(command, operationContext);
      }
      if (command.type === "githubPublication.sourceFacts") {
        if (!publicationSourceReader) {
          throw new Error("GitHub publication source is unavailable.");
        }
        return publicationSourceReader.read(command.input.source);
      }
      if (commandRegistry.has(command)) {
        return commandRegistry.execute(command, operationContext);
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
      if (command.type === "database.publishSchema") {
        try {
          return reconcileOpenClawStateSchemaPublication({
            path: context.databasePath,
            env: getSqliteWorkerStateContext().environment,
          });
        } finally {
          retainCachedDatabase();
        }
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
                if (!isPostgresSqlConnection(db)) {
                  refreshSqlitePlannerStatistics(db);
                }
                admit("commit");
              },
              { database },
              { busyTimeoutMs: 0, operationLabel: "state.planner-statistics" },
            ),
          ) ?? { reclaimedPages: 0 }
        );
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
          retainedDatabase,
          nativeDatabase?.db.isOpen === true,
        );
      }
      if (cron?.isCronStateWorkerCommand(command)) {
        return cron.executeCronStateCommand(command, open());
      }
      const currentUpdater = updater;
      if (currentUpdater?.isUpdateRunWorkerCommand(command)) {
        return currentUpdater.executeUpdateRunCommand(
          command,
          operationContext.stateOptions(),
          () =>
            (updateRunWriter ??= currentUpdater.openUpdateRunWriter(
              operationContext.stateOptions(),
            )),
        );
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
      if (stateWorkerRegistry.has(command)) {
        return stateWorkerRegistry.execute(command, operationContext);
      }
      throw new Error(`Shared-state worker command is not prepared: ${command.type}`);
    },
    assertSettled() {
      updateRunWriter?.assertSettled();
      if (nativeDatabase) {
        assertTransactionUsable(nativeDatabase.db);
        if (!nativeDatabase.db.isOpen && isPostgresSqlConnection(nativeDatabase.db)) {
          throw new Error("Shared-state worker retained a closed PostgreSQL connection");
        }
        if (nativeDatabase.db.isOpen && nativeDatabase.db.isTransaction) {
          throw new Error("Shared-state worker retained an unsettled transaction");
        }
        if (nativeDatabase.db.isOpen && !isPostgresSqlConnection(nativeDatabase.db)) {
          assertNoActiveSqliteReaders(nativeDatabase.db, "Shared-state worker");
        }
      }
    },
    async close() {
      closed = true;
      try {
        publicationSourceReader?.close();
        updateRunWriter?.close();
      } finally {
        await borrow?.releaseAsync();
      }
    },
  };
}
