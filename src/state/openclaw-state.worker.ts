import {
  readNativeHookRelayBridgeSnapshotFromDatabase,
  listNativeHookRelayBridgeSnapshotsInDatabase,
} from "../agents/harness/native-hook-relay-store.kernel.js";
import { executeNativeHookRelayMutation } from "../agents/harness/native-hook-relay-store.worker.js";
import { loadSubagentSessionListRunsFromSqlite } from "../agents/subagents/registry/subagent-registry.store.sqlite.js";
import { readClawInstallSchemaVersionRows } from "../claws/provenance-runtime-read.kernel.js";
import {
  patchConfigHealthEntryInDatabase,
  readConfigHealthSnapshotInDatabase,
} from "../config/io.health-state.kernel.js";
import { loadMutableCronStoreInWorker } from "../cron/store/load.worker.js";
import { executeCronStoreSaveCommand } from "../cron/store/save.worker.js";
import { readDeferredPluginMigrations } from "../infra/deferred-plugin-migrations.js";
import { countFailedDeliveryQueueEntriesInDatabase } from "../infra/delivery-queue-sqlite.kernel.js";
import { executeSessionDeliveryCommand } from "../infra/session-delivery-queue.worker.js";
import { createSqliteAuditRecordKernel } from "../infra/sqlite-audit-record.kernel.js";
import {
  readStableSqliteFileGeneration,
  sameSqliteFileGeneration,
} from "../infra/sqlite-file-generation.js";
import { deferSqlitePostCommitPublication } from "../infra/sqlite-post-commit.js";
import {
  assertTransactionUsable,
  runSqliteDeferredTransactionSync,
} from "../infra/sqlite-transaction.js";
import type { SqliteWorkerBackend } from "../infra/sqlite-worker-contract.js";
import { getSqliteWorkerStateContext } from "../infra/sqlite-worker-state-context.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { readRemoteModelCatalog } from "../model-catalog/remote-store.js";
import { isPluginStateWorkerCommand } from "../plugin-state/plugin-state-worker-contract.js";
import { executePluginStateCommand } from "../plugin-state/plugin-state.worker.js";
import {
  readPluginBindingApprovalsInDatabase,
  upsertPluginBindingApprovalInDatabase,
} from "../plugins/conversation-binding-state.kernel.js";
import { readPluginMetadataStateRowSync } from "../plugins/installed-plugin-index-row.js";
import {
  readHostedCatalogSnapshotInDatabase,
  writeHostedCatalogSnapshotInDatabase,
} from "../plugins/official-external-plugin-catalog-snapshot-store.kernel.js";
import { HostedCatalogSignedFeedMonotonicityError } from "../plugins/official-external-plugin-catalog-source.js";
import {
  ensureProjectRegistrySchema,
  listProjectRegistryInDatabase,
  removeProjectRegistryInDatabase,
  resolveRecordedProjectRootInDatabase,
} from "../projects/project-registry.kernel.js";
import { mapTaskFlowView } from "../tasks/task-domain-views.js";
import {
  runManagedTaskInFlowInDatabase,
  type ManagedTaskInFlowReceipt,
} from "../tasks/task-flow-managed-run-task.kernel.js";
import {
  assertControllerId,
  normalizeRestoredFlowRecord,
} from "../tasks/task-flow-registry.records.js";
import {
  bindTaskFlowRecord,
  listTaskFlowRecordsForOwnerReadInDatabase,
  readTaskFlowRecord,
  readTaskFlowRegistrySnapshot,
  listTaskFlowViewRecordsForOwnerInDatabase,
  readTaskFlowViewRecordInDatabase,
  updateTaskFlowRecordInDatabase,
  upsertTaskFlowRowInDatabase,
} from "../tasks/task-flow-registry.store.kernel.js";
import { isTerminalTaskFlow, type TaskFlowRecord } from "../tasks/task-flow-registry.types.js";
import { executeTaskInitialMutation } from "../tasks/task-initial.worker.js";
import { syncLiveTaskFlowInDatabase } from "../tasks/task-registry-live-flow.worker.js";
import {
  restoreTaskRegistryInDatabase,
  syncTaskMirroredFlowInDatabase,
} from "../tasks/task-registry-restore.worker.js";
import {
  findTaskRecordByRunIdForViewInDatabase,
  listTaskRecordsByOwnerKeyInDatabase,
  listTaskRecordsForFlowReadInDatabase,
  listTaskRecordsForOwnerReadInDatabase,
  readTaskViewRecordInDatabase,
  readTaskRegistryMutationSnapshotInDatabase,
  readTaskRegistrySnapshot,
  summarizeTaskRecordsForFlowInDatabase,
} from "../tasks/task-registry.store.kernel.js";
import { readTaskRegistryStatusSnapshot } from "../tasks/task-registry.store.status.js";
import { recordBackupRunInDatabase } from "./backup-run-records.kernel.js";
import {
  openClawStateDatabaseCache,
  retainOpenClawStateDatabase,
} from "./openclaw-state-db-cache.js";
import type { OpenClawStateDatabase } from "./openclaw-state-db-contract.js";
import { assertOpenClawStateDatabaseOwner } from "./openclaw-state-db-maintenance.js";
import {
  withOpenClawStateDatabaseReadOnly,
  withArtifactPreservingStateReads,
  withExistingOpenClawStateDatabaseArtifactPreservingReadOnly,
  withExistingOpenClawStateDatabaseReadOnly,
} from "./openclaw-state-db-readonly.js";
import { withSharedStateWriteCoordinator } from "./openclaw-state-db-write-coordination.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "./openclaw-state-db.js";
import { assertOpenClawStateLeaseWorkerOwnedInTransaction } from "./openclaw-state-lease-worker.js";
import type {
  OpenClawStateWorkerOperations,
  OpenClawStateWorkerInspectionOperations,
} from "./openclaw-state-worker-contract.js";
import { executeUserPreferenceCommand } from "./user-preferences.worker.js";

const log = createSubsystemLogger("state/worker");
type ManagedFlowWriteResult =
  | OpenClawStateWorkerOperations["flows.createManaged"]["output"]
  | OpenClawStateWorkerOperations["flows.updateManaged"]["output"];

export function createSqliteWorkerBackend(
  _input: undefined,
  context: { databasePath: string },
): SqliteWorkerBackend<OpenClawStateWorkerOperations & OpenClawStateWorkerInspectionOperations> {
  const database = openOpenClawStateDatabase({
    path: context.databasePath,
    env: getSqliteWorkerStateContext().environment,
  });
  return createSharedStateWorkerBackend(context, database);
}

export function openExistingSqliteWorkerBackend(
  _input: undefined,
  context: { databasePath: string },
): SqliteWorkerBackend<OpenClawStateWorkerOperations & OpenClawStateWorkerInspectionOperations> {
  return createSharedStateWorkerBackend(context);
}

function createSharedStateWorkerBackend(
  context: { databasePath: string },
  initialDatabase?: OpenClawStateDatabase,
): SqliteWorkerBackend<OpenClawStateWorkerOperations & OpenClawStateWorkerInspectionOperations> {
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
  const listFlows = (db: ReturnType<typeof open>["db"], ownerKey: string) =>
    listTaskFlowRecordsForOwnerReadInDatabase(db, ownerKey).map(normalizeRestoredFlowRecord);
  const ownedFlow = (flow: ReturnType<typeof readTaskFlowRecord>, ownerKey: string) =>
    flow?.ownerKey.trim() === ownerKey ? normalizeRestoredFlowRecord(flow) : undefined;
  return {
    execute(command) {
      if (closed) {
        throw new Error("Shared-state worker is closed");
      }
      if (command.type === "subagents.sessionList") {
        return withExistingOpenClawStateDatabaseReadOnly(
          (database) => loadSubagentSessionListRunsFromSqlite(undefined, database),
          { path: context.databasePath, env: getSqliteWorkerStateContext().environment },
        );
      }
      if (command.type === "nativeHookRelay.read") {
        return withOpenClawStateDatabaseReadOnly(
          (database) =>
            readNativeHookRelayBridgeSnapshotFromDatabase({
              database,
              relayId: command.input.relayId,
            })?.record,
          { path: context.databasePath, env: getSqliteWorkerStateContext().environment },
        );
      }
      if (command.type === "tasks.statusSummary") {
        const read = () =>
          withExistingOpenClawStateDatabaseReadOnly(
            (database) => readTaskRegistryStatusSnapshot(database, command.input.now),
            { path: context.databasePath, env: getSqliteWorkerStateContext().environment },
          );
        return command.input.preserveSourceArtifacts
          ? withArtifactPreservingStateReads(read)
          : read();
      }
      if (command.type === "modelCatalog.remote.read") {
        const read = () =>
          readRemoteModelCatalog({
            path: context.databasePath,
            env: getSqliteWorkerStateContext().environment,
          });
        return command.input.artifactPreservingReadOnly
          ? withArtifactPreservingStateReads(read)
          : read();
      }
      if (command.type === "plugins.conversationBindingApprovals.read") {
        return readPluginBindingApprovalsInDatabase(open().db);
      }
      if (command.type === "plugins.conversationBindingApprovals.upsert") {
        const database = open();
        return runOpenClawStateWriteTransaction(
          ({ db }) => upsertPluginBindingApprovalInDatabase(db, command.input),
          { database, path: context.databasePath, env: getSqliteWorkerStateContext().environment },
        );
      }
      if (command.type === "plugins.metadata.read") {
        return readPluginMetadataStateRowSync(
          command.input.selector,
          { path: context.databasePath, env: getSqliteWorkerStateContext().environment },
          command.input.artifactPreservingReadOnly,
        );
      }
      if (command.type === "plugins.deferredMigrations.read") {
        return readDeferredPluginMigrations({
          path: context.databasePath,
          env: getSqliteWorkerStateContext().environment,
        });
      }
      if (command.type === "claws.install-schema-versions") {
        return withExistingOpenClawStateDatabaseArtifactPreservingReadOnly(
          ({ db, path: pathname }) => {
            assertOpenClawStateDatabaseOwner(db, { pathname });
            return readClawInstallSchemaVersionRows(db);
          },
          { path: context.databasePath, env: getSqliteWorkerStateContext().environment },
        );
      }
      if (command.type === "database.generationMatches") {
        // Unavailable inspection retains the known failure; only a stable mismatch expires it.
        return sameSqliteFileGeneration(
          command.input.generation,
          readStableSqliteFileGeneration(context.databasePath),
        );
      }
      if (command.type === "userPreferences.read" || command.type === "userPreferences.write") {
        return executeUserPreferenceCommand(command, {
          database: open(),
          path: context.databasePath,
          env: getSqliteWorkerStateContext().environment,
        });
      }
      if (
        command.type === "tasks.createRecord" ||
        command.type === "tasks.settleUnstarted" ||
        command.type === "flows.createForTask" ||
        command.type === "tasks.linkInitialFlow" ||
        command.type === "flows.deleteUnlinkedForTask" ||
        command.type === "flows.finalizeTaskCancellation"
      ) {
        return executeTaskInitialMutation(open(), command);
      }
      if (command.type === "flows.runTask") {
        let committed: ManagedTaskInFlowReceipt | undefined;
        try {
          const database = open();
          return withSharedStateWriteCoordinator(
            { databasePath: database.path, existing: database.db, operationLabel: "flows.runTask" },
            () =>
              runManagedTaskInFlowInDatabase(
                database.db,
                command.input,
                (operation) =>
                  runOpenClawStateWriteTransaction(operation, {
                    database,
                    path: context.databasePath,
                    env: getSqliteWorkerStateContext().environment,
                  }),
                (result) => {
                  committed = result;
                },
              ),
          );
        } catch (error) {
          if (committed) {
            log.warn("Managed child task operation completed before cleanup failed", {
              flowId: command.input.params.flowId,
              error,
            });
            return committed;
          }
          throw error;
        }
      }
      if (command.type === "flows.createManaged" || command.type === "flows.updateManaged") {
        let observed: TaskFlowRecord | undefined;
        let committed: ManagedFlowWriteResult | undefined;
        try {
          const database = open();
          return runOpenClawStateWriteTransaction(
            ({ db: writer }) => {
              let result: ManagedFlowWriteResult;
              if (command.type === "flows.createManaged") {
                const flow = command.input.flow;
                if (flow.syncMode !== "managed") {
                  throw new Error("Worker creation requires a managed flow");
                }
                assertControllerId(flow.controllerId);
                upsertTaskFlowRowInDatabase(writer, bindTaskFlowRecord(flow));
                result = flow;
              } else {
                observed = ownedFlow(
                  readTaskFlowRecord(writer, command.input.flowId),
                  command.input.ownerKey,
                );
                result = !observed
                  ? { applied: false, reason: "not_found" }
                  : observed.syncMode !== "managed" || !observed.controllerId
                    ? { applied: false, reason: "not_managed", current: observed }
                    : updateTaskFlowRecordInDatabase(writer, command.input);
              }
              deferSqlitePostCommitPublication(writer, () => {
                committed = result;
              });
              return result;
            },
            {
              path: context.databasePath,
              database,
              env: getSqliteWorkerStateContext().environment,
            },
          );
        } catch (error) {
          if (committed) {
            log.warn("Managed task-flow write committed before cleanup failed", {
              flowId:
                command.type === "flows.createManaged"
                  ? command.input.flow.flowId
                  : command.input.flowId,
              error,
            });
            return committed;
          }
          if (command.type === "flows.createManaged") {
            throw error;
          }
          log.warn("Failed to persist managed task-flow update", {
            flowId: command.input.flowId,
            error,
          });
          return {
            applied: false,
            reason: "persist_failed",
            ...(observed ? { current: observed } : {}),
          };
        }
      }
      if (isPluginStateWorkerCommand(command)) {
        return executePluginStateCommand(
          command,
          {
            path: context.databasePath,
            env: getSqliteWorkerStateContext().environment,
          },
          open,
          nativeDatabase?.db.isOpen === true,
        );
      }
      if (command.type === "config.health.read") {
        const read = command.input.artifactPreserving
          ? withExistingOpenClawStateDatabaseArtifactPreservingReadOnly
          : withExistingOpenClawStateDatabaseReadOnly;
        return (
          read(({ db }) => readConfigHealthSnapshotInDatabase(db), {
            path: context.databasePath,
            env: getSqliteWorkerStateContext().environment,
          }) ?? { state: {}, basis: {} }
        );
      }
      const database = open();
      if (command.type === "plugins.catalogSnapshot.read") {
        return readHostedCatalogSnapshotInDatabase(database.db, command.input.url);
      }
      if (command.type === "nativeHookRelay.listSnapshots") {
        return listNativeHookRelayBridgeSnapshotsInDatabase(database);
      }
      if (
        command.type === "nativeHookRelay.write" ||
        command.type === "nativeHookRelay.renew" ||
        command.type === "nativeHookRelay.deleteOwned" ||
        command.type === "nativeHookRelay.prune"
      ) {
        return executeNativeHookRelayMutation(command, {
          database,
          path: context.databasePath,
          env: getSqliteWorkerStateContext().environment,
        });
      }
      if (command.type === "cron.loadMutable") {
        return loadMutableCronStoreInWorker(database, command.input.storeKey);
      }
      if (command.type === "cron.save" || command.type === "cron.saveChanges") {
        return executeCronStoreSaveCommand(command, database);
      }
      if (command.type === "tasks.restore") {
        return restoreTaskRegistryInDatabase(database);
      }
      if (command.type === "flows.syncMirroredTask") {
        return syncTaskMirroredFlowInDatabase(database, command.input);
      }
      if (command.type === "flows.syncLiveMirroredTask") {
        return syncLiveTaskFlowInDatabase(database, command.input);
      }
      if (command.type === "deliveryQueue.countFailed") {
        return countFailedDeliveryQueueEntriesInDatabase(database);
      }
      if (
        command.type === "sessionDelivery.enqueue" ||
        command.type === "sessionDelivery.enqueueClaimed" ||
        command.type === "sessionDelivery.releaseClaim" ||
        command.type === "sessionDelivery.defer" ||
        command.type === "sessionDelivery.advanceAgentRun" ||
        command.type === "sessionDelivery.mergePreparedMedia" ||
        command.type === "sessionDelivery.markAttemptStarted" ||
        command.type === "sessionDelivery.markSettlement" ||
        command.type === "sessionDelivery.complete" ||
        command.type === "sessionDelivery.fail" ||
        command.type === "sessionDelivery.load" ||
        command.type === "sessionDelivery.list" ||
        command.type === "sessionDelivery.moveToFailed"
      ) {
        return executeSessionDeliveryCommand(command, database);
      }
      const writeOptions = {
        database,
        path: context.databasePath,
        env: getSqliteWorkerStateContext().environment,
      };
      if (command.type === "plugins.catalogSnapshot.write") {
        try {
          runOpenClawStateWriteTransaction(
            ({ db }) =>
              writeHostedCatalogSnapshotInDatabase(db, command.input.snapshot, command.input.now),
            writeOptions,
          );
          return { ok: true };
        } catch (error) {
          if (error instanceof HostedCatalogSignedFeedMonotonicityError) {
            return { ok: false, message: error.message };
          }
          throw error;
        }
      }
      if (command.type === "backup.recordOutcome") {
        return runOpenClawStateWriteTransaction(
          ({ db }) => recordBackupRunInDatabase(db, command.input),
          writeOptions,
        );
      }
      if (command.type === "projects.findRoot") {
        ensureProjectRegistrySchema(writeOptions);
        return resolveRecordedProjectRootInDatabase(database.db, command.input.repoRoot);
      }
      if (command.type === "projects.list") {
        ensureProjectRegistrySchema(writeOptions);
        return listProjectRegistryInDatabase(database.db);
      }
      if (command.type === "projects.remove") {
        return runOpenClawStateWriteTransaction(
          ({ db }) => {
            const { project, lease } = command.input;
            if (lease.scope !== "projects.checkout" || lease.key !== project.repoRoot) {
              throw new Error("Project registry mutation requires its checkout lifecycle lease");
            }
            assertOpenClawStateLeaseWorkerOwnedInTransaction(db, lease);
            return removeProjectRegistryInDatabase(db, project);
          },
          writeOptions,
          { operationLabel: "projects.registry.remove" },
        );
      }
      if (command.type === "config.health.patch") {
        const { configPath, patch, expected, updatedAtMs } = command.input;
        return runOpenClawStateWriteTransaction(({ db }) => {
          return patchConfigHealthEntryInDatabase(db, configPath, patch, expected, updatedAtMs);
        }, writeOptions);
      }
      if (command.type === "diagnostic.register") {
        const { scope, maxEntries, record } = command.input;
        return runOpenClawStateWriteTransaction(({ db }) => {
          createSqliteAuditRecordKernel(db, { scope, maxEntries }).register(record);
        }, writeOptions);
      }
      const { db } = database;
      return runSqliteDeferredTransactionSync(db, () => {
        switch (command.type) {
          case "flows.snapshot":
            return readTaskFlowRegistrySnapshot(db);
          case "tasks.mutationSnapshot":
            return command.input === undefined
              ? readTaskRegistrySnapshot(database)
              : readTaskRegistryMutationSnapshotInDatabase(db, command.input);
          case "tasks.get":
            return readTaskViewRecordInDatabase(db, command.input.taskId);
          case "tasks.list":
            return command.input.mode === "full-record"
              ? listTaskRecordsByOwnerKeyInDatabase(db, command.input.ownerKey)
              : listTaskRecordsForOwnerReadInDatabase(db, command.input.ownerKey);
          case "tasks.resolve": {
            const { ownerKey, token } = command.input;
            return {
              direct: readTaskViewRecordInDatabase(db, token),
              byRun: findTaskRecordByRunIdForViewInDatabase(db, token),
              related: listTaskRecordsForOwnerReadInDatabase(db, ownerKey, token),
            };
          }
          case "flows.list":
            return listFlows(db, command.input.ownerKey);
          case "flows.views":
            return listTaskFlowViewRecordsForOwnerInDatabase(db, command.input.ownerKey)
              .map(normalizeRestoredFlowRecord)
              .map(mapTaskFlowView);
          case "flows.summary": {
            const { ownerKey, flowId } = command.input;
            const flow = ownedFlow(readTaskFlowViewRecordInDatabase(db, flowId), ownerKey);
            return flow ? summarizeTaskRecordsForFlowInDatabase(db, flow.flowId) : undefined;
          }
          case "flows.current": {
            const flow = readTaskFlowRecord(db, command.input.flowId);
            return flow ? normalizeRestoredFlowRecord(flow) : undefined;
          }
          case "flows.read":
          case "flows.detail": {
            const { ownerKey, lookup, token } = command.input;
            const direct = token === undefined ? undefined : readTaskFlowRecord(db, token);
            let flow = ownedFlow(direct, ownerKey);
            if (
              !flow &&
              (lookup === "latest" || (lookup === "resolve" && token?.trim() === ownerKey))
            ) {
              const flows = listFlows(db, ownerKey);
              flow =
                lookup === "resolve"
                  ? (flows.find((candidate) => !isTerminalTaskFlow(candidate)) ?? flows[0])
                  : flows[0];
            }
            if (!flow) {
              return undefined;
            }
            return command.type === "flows.detail"
              ? { flow, tasks: listTaskRecordsForFlowReadInDatabase(db, flow.flowId) }
              : flow;
          }
          default:
            throw new Error("Unknown shared-state SQLite command");
        }
      });
    },
    assertSettled() {
      if (nativeDatabase) {
        assertTransactionUsable(nativeDatabase.db);
        if (nativeDatabase.db.isOpen && nativeDatabase.db.isTransaction) {
          throw new Error("Shared-state worker retained an unsettled transaction");
        }
      }
    },
    close() {
      closed = true;
      borrow?.release();
    },
  };
}
