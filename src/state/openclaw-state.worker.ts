import { readMcpOAuthStoreInDatabase } from "../agents/mcp-oauth-store.kernel.js";
import { readClawInstallSchemaVersionRows } from "../claws/provenance-runtime-read.kernel.js";
import {
  patchConfigHealthEntryInDatabase,
  readConfigHealthSnapshotInDatabase,
} from "../config/io.health-state.kernel.js";
import { loadMutableCronStoreInWorker } from "../cron/store/load.worker.js";
import {
  acquireFleetCellOperationInDatabase,
  assertFleetCellOperationInDatabase,
  deleteFleetCellInDatabase,
  heartbeatFleetCellOperationInDatabase,
  releaseFleetCellOperationInDatabase,
  reserveFleetCellInDatabase,
  updateFleetCellImageInDatabase,
} from "../fleet/registry.kernel.js";
import { executeSessionDeliveryCommand } from "../infra/session-delivery-queue.worker.js";
import { createSqliteAuditRecordKernel } from "../infra/sqlite-audit-record.kernel.js";
import {
  readStableSqliteFileGeneration,
  sameSqliteFileGeneration,
} from "../infra/sqlite-file-generation.js";
import { deferSqlitePostCommitPublication } from "../infra/sqlite-post-commit.js";
import { runSqliteDeferredTransactionSync } from "../infra/sqlite-transaction.js";
import type { SqliteWorkerBackend } from "../infra/sqlite-worker-contract.js";
import { getSqliteWorkerStateContext } from "../infra/sqlite-worker-state-context.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { isPluginStateWorkerCommand } from "../plugin-state/plugin-state-worker-contract.js";
import { executePluginStateCommand } from "../plugin-state/plugin-state.worker.js";
import { readPluginMetadataStateRowSync } from "../plugins/installed-plugin-index-row.js";
import {
  ensureProjectRegistrySchema,
  resolveRecordedProjectRootInDatabase,
} from "../projects/project-registry.kernel.js";
import { mapTaskFlowView } from "../tasks/task-domain-views.js";
import { runManagedTaskInFlowInDatabase } from "../tasks/task-flow-managed-run-task.kernel.js";
import type { RunTaskInFlowResult } from "../tasks/task-flow-managed-run-task.types.js";
import {
  assertControllerId,
  normalizeRestoredFlowRecord,
} from "../tasks/task-flow-registry.records.js";
import {
  bindTaskFlowRecord,
  listTaskFlowRecordsForOwnerReadInDatabase,
  readTaskFlowRecord,
  listTaskFlowViewRecordsForOwnerInDatabase,
  readTaskFlowViewRecordInDatabase,
  updateTaskFlowRecordInDatabase,
  upsertTaskFlowRowInDatabase,
} from "../tasks/task-flow-registry.store.kernel.js";
import { isTerminalTaskFlow, type TaskFlowRecord } from "../tasks/task-flow-registry.types.js";
import {
  findTaskRecordByRunIdForViewInDatabase,
  listTaskRecordsForFlowReadInDatabase,
  listTaskRecordsForOwnerReadInDatabase,
  readTaskViewRecordInDatabase,
  readTaskRegistryMutationSnapshotInDatabase,
  summarizeTaskRecordsForFlowInDatabase,
} from "../tasks/task-registry.store.kernel.js";
import { readTaskRegistryStatusSnapshot } from "../tasks/task-registry.store.status.js";
import { recordBackupRunInDatabase } from "./backup-run-records.kernel.js";
import { executeOnboardingRecommendationCommand } from "./onboarding-recommendations.kernel.js";
import {
  openClawStateDatabaseCache,
  retainOpenClawStateDatabase,
} from "./openclaw-state-db-cache.js";
import type { OpenClawStateDatabase } from "./openclaw-state-db-contract.js";
import { assertOpenClawStateDatabaseOwner } from "./openclaw-state-db-maintenance.js";
import {
  withArtifactPreservingStateReads,
  withExistingOpenClawStateDatabaseArtifactPreservingReadOnly,
  withExistingOpenClawStateDatabaseReadOnly,
} from "./openclaw-state-db-readonly.js";
import { withSharedStateWriteCoordinator } from "./openclaw-state-db-write-coordination.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "./openclaw-state-db.js";
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
      if (command.type === "mcpOAuth.read") {
        return readMcpOAuthStoreInDatabase(open().db, command.input);
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
      if (command.type === "plugins.metadata.read") {
        return readPluginMetadataStateRowSync(
          command.input.selector,
          { path: context.databasePath, env: getSqliteWorkerStateContext().environment },
          command.input.artifactPreservingReadOnly,
        );
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
      if (
        command.type === "onboardingRecommendations.writeOffer" ||
        command.type === "onboardingRecommendations.acknowledge" ||
        command.type === "onboardingRecommendations.updatePending" ||
        command.type === "onboardingRecommendations.clearPending" ||
        command.type === "onboardingRecommendations.clear"
      ) {
        return executeOnboardingRecommendationCommand(command, {
          database: open(),
          path: context.databasePath,
          env: getSqliteWorkerStateContext().environment,
        });
      }
      if (command.type === "userPreferences.read" || command.type === "userPreferences.write") {
        return executeUserPreferenceCommand(command, {
          database: open(),
          path: context.databasePath,
          env: getSqliteWorkerStateContext().environment,
        });
      }
      if (command.type === "flows.runTask") {
        let committed: RunTaskInFlowResult | undefined;
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
      if (command.type === "cron.loadMutable") {
        return loadMutableCronStoreInWorker(database, command.input.storeKey);
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
      if (
        command.type === "fleet.cell.reserve" ||
        command.type === "fleet.cell.updateImage" ||
        command.type === "fleet.cell.delete" ||
        command.type === "fleet.operation.acquire" ||
        command.type === "fleet.operation.heartbeat" ||
        command.type === "fleet.operation.release"
      ) {
        return runOpenClawStateWriteTransaction(({ db }) => {
          switch (command.type) {
            case "fleet.cell.reserve":
              assertFleetCellOperationInDatabase(
                db,
                command.input.tenantId,
                command.input.operationOwner,
              );
              return reserveFleetCellInDatabase(db, command.input);
            case "fleet.cell.updateImage":
              assertFleetCellOperationInDatabase(
                db,
                command.input.tenantId,
                command.input.operationOwner,
              );
              return updateFleetCellImageInDatabase(
                db,
                command.input.tenantId,
                command.input.image,
              );
            case "fleet.cell.delete":
              assertFleetCellOperationInDatabase(
                db,
                command.input.tenantId,
                command.input.operationOwner,
              );
              return deleteFleetCellInDatabase(db, command.input.tenantId);
            case "fleet.operation.acquire":
              return acquireFleetCellOperationInDatabase(db, command.input);
            case "fleet.operation.heartbeat":
              return heartbeatFleetCellOperationInDatabase(db, command.input);
            case "fleet.operation.release":
              return releaseFleetCellOperationInDatabase(db, command.input);
          }
        }, writeOptions);
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
          case "tasks.mutationSnapshot":
            return readTaskRegistryMutationSnapshotInDatabase(db, command.input);
          case "tasks.get":
            return readTaskViewRecordInDatabase(db, command.input.taskId);
          case "tasks.list":
            return listTaskRecordsForOwnerReadInDatabase(db, command.input.ownerKey);
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
    close() {
      closed = true;
      borrow?.release();
    },
  };
}
