import { deferSqlitePostCommitPublication } from "../infra/sqlite-post-commit.js";
import { runSqliteDeferredTransactionSync } from "../infra/sqlite-transaction.js";
import type { SqliteWorkerCommand } from "../infra/sqlite-worker-contract.js";
import {
  deferSqliteWorkerCommitReceipt,
  requestSqliteWorkerOperationAdmission,
} from "../infra/sqlite-worker-operation-admission.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type {
  OpenClawStateDatabase,
  OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db-contract.js";
import {
  withArtifactPreservingStateReads,
  withExistingOpenClawStateDatabaseReadOnly,
} from "../state/openclaw-state-db-readonly.js";
import { withSharedStateWriteCoordinator } from "../state/openclaw-state-db-write-coordination.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { mapTaskFlowView } from "./task-domain-views.js";
import { maintainTaskFlowInDatabase } from "./task-flow-maintenance.worker.js";
import {
  runManagedTaskInFlowInDatabase,
  type ManagedTaskInFlowReceipt,
} from "./task-flow-managed-run-task.kernel.js";
import { assertControllerId, normalizeRestoredFlowRecord } from "./task-flow-registry.records.js";
import {
  bindTaskFlowExecutionInDatabase,
  bindTaskFlowRecord,
  listTaskFlowRecordsForOwnerReadInDatabase,
  readTaskFlowRecord,
  readTaskFlowRegistrySnapshot,
  listTaskFlowViewRecordsForOwnerInDatabase,
  readTaskFlowViewRecordInDatabase,
  updateSelectedTaskFlowRecordInDatabase,
  upsertTaskFlowRowInDatabase,
} from "./task-flow-registry.store.kernel.js";
import { isTerminalTaskFlow, type TaskFlowRecord } from "./task-flow-registry.types.js";
import { executeTaskInitialMutation } from "./task-initial.worker.js";
import { captureTaskCreationEventTarget } from "./task-registry-agent-event-target.js";
import { observeTaskAgentEventInDatabase } from "./task-registry-agent-event.worker.js";
import { syncLiveTaskFlowInDatabase } from "./task-registry-live-flow.worker.js";
import {
  restoreTaskRegistryInDatabase,
  syncTaskMirroredFlowInDatabase,
} from "./task-registry-restore.worker.js";
import {
  bindTaskRunExecutionInDatabase,
  findTaskRecordByRunIdForViewInDatabase,
  listTaskRecordsForFlowReadInDatabase,
  listTaskRecordsForOwnerReadInDatabase,
  listTaskRecordsByOwnerKeyInDatabase,
  readTaskViewRecordInDatabase,
  readTaskRecord,
  summarizeTaskRecordsForFlowInDatabase,
} from "./task-registry.store.kernel.js";
import { readTaskRegistryStatusSnapshot } from "./task-registry.store.status.js";
import type { TaskRegistryWorkerOperations } from "./task-registry.worker-contract.js";

const log = createSubsystemLogger("state/worker");
type ManagedFlowWriteResult =
  | TaskRegistryWorkerOperations["flows.createManaged"]["output"]
  | TaskRegistryWorkerOperations["flows.updateManaged"]["output"];

export function executeTaskRegistryCommand(
  command: SqliteWorkerCommand<TaskRegistryWorkerOperations>,
  options: OpenClawStateDatabaseOptions & { path: string },
  open: () => OpenClawStateDatabase,
): TaskRegistryWorkerOperations[keyof TaskRegistryWorkerOperations]["output"] {
  if (command.type === "flows.maintain") {
    return maintainTaskFlowInDatabase(open(), command.input);
  }
  if (command.type === "tasks.bindExecution" || command.type === "flows.bindExecution") {
    const database = open();
    return runOpenClawStateWriteTransaction(
      ({ db }) => {
        requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
        const result =
          command.type === "tasks.bindExecution"
            ? bindTaskRunExecutionInDatabase(db, command.input.taskId, command.input.binding)
            : bindTaskFlowExecutionInDatabase(db, command.input.flowId, command.input.binding);
        requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined });
        return result;
      },
      { ...options, database },
      {
        operationLabel:
          command.type === "tasks.bindExecution"
            ? "task.run.execution-binding"
            : "task.flow.execution-binding",
      },
    );
  }
  if (command.type === "tasks.observeAgentEvent") {
    return observeTaskAgentEventInDatabase(open(), command.input);
  }
  if (
    command.type === "tasks.applyRetention" ||
    command.type === "tasks.maintainCron" ||
    command.type === "tasks.bindRunOwner" ||
    command.type === "tasks.transitionRunRow" ||
    command.type === "tasks.updateNotificationDelivery" ||
    command.type === "tasks.acknowledgeStateChange" ||
    command.type === "tasks.createRecord" ||
    command.type === "tasks.finalizeActive" ||
    command.type === "tasks.settleUnstarted" ||
    command.type === "flows.createForTask" ||
    command.type === "tasks.linkInitialFlow" ||
    command.type === "flows.deleteUnlinkedForTask" ||
    command.type === "flows.finalizeTaskCancellation"
  ) {
    return executeTaskInitialMutation(open(), command);
  }
  const listFlows = (db: OpenClawStateDatabase["db"], ownerKey: string) =>
    listTaskFlowRecordsForOwnerReadInDatabase(db, ownerKey).map(normalizeRestoredFlowRecord);
  const ownedFlow = (flow: ReturnType<typeof readTaskFlowRecord>, ownerKey: string) =>
    flow?.ownerKey.trim() === ownerKey ? normalizeRestoredFlowRecord(flow) : undefined;
  if (command.type === "tasks.statusSummary") {
    const read = () =>
      withExistingOpenClawStateDatabaseReadOnly(
        (database) => readTaskRegistryStatusSnapshot(database, command.input.now),
        options,
      );
    return command.input.preserveSourceArtifacts ? withArtifactPreservingStateReads(read) : read();
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
            (operation) => runOpenClawStateWriteTransaction(operation, { ...options, database }),
            (result) => {
              committed = result;
            },
            {
              assertCurrent: () =>
                requestSqliteWorkerOperationAdmission({
                  stage: "transaction",
                  facts: {
                    kind: "task-registry-mutation",
                    operation: command.type,
                    taskId: command.input.taskId,
                  },
                }),
              retainTaskCommit(taskId) {
                const task = readTaskRecord(database.db, taskId);
                if (task?.runId) {
                  deferSqliteWorkerCommitReceipt(
                    database.db,
                    captureTaskCreationEventTarget(task, command.type, command.input.taskId),
                  );
                }
              },
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
                : updateSelectedTaskFlowRecordInDatabase(writer, observed, command.input);
          }
          deferSqlitePostCommitPublication(writer, () => {
            committed = result;
          });
          return result;
        },
        { ...options, database },
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
  const database = open();
  if (command.type === "tasks.restore") {
    return restoreTaskRegistryInDatabase(database);
  }
  if (command.type === "flows.syncMirroredTask") {
    return syncTaskMirroredFlowInDatabase(database, command.input);
  }
  if (command.type === "flows.syncLiveMirroredTask") {
    return syncLiveTaskFlowInDatabase(database, command.input);
  }
  const { db } = database;
  return runSqliteDeferredTransactionSync(db, () => {
    switch (command.type) {
      case "flows.snapshot":
        return readTaskFlowRegistrySnapshot(db);
      case "tasks.get":
        return readTaskViewRecordInDatabase(db, command.input.taskId);
      case "tasks.findByRunId":
        return findTaskRecordByRunIdForViewInDatabase(db, command.input.runId);
      case "tasks.list":
        return listTaskRecordsForOwnerReadInDatabase(db, command.input.ownerKey);
      case "tasks.ownerRecords":
        return listTaskRecordsByOwnerKeyInDatabase(db, command.input.ownerKey);
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
}
