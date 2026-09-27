import crypto from "node:crypto";
import { getTaskMirroredFlowIds } from "./task-flow-runtime-internal.js";
import { selectExistingTaskForCreate } from "./task-registry-create-rules.js";
import { runTaskCreateOperation } from "./task-registry-create.operation.js";
import { maybeDeliverTaskTerminalUpdate } from "./task-registry-delivery.js";
import {
  assertParentFlowLinkAllowed,
  ensureLinkedTaskFlowRegistryReady,
} from "./task-registry-flow-link.js";
import { publishTaskRecordUpdate } from "./task-registry-mutation.js";
import {
  captureTaskPersistenceReceipt,
  cloneTaskRecord,
  cloneTaskRecordForObserver,
  matchesTaskPersistenceReceipt,
  type CreateTaskRecordParams,
} from "./task-registry-records.js";
import {
  bumpTaskRegistryRevision,
  emitTaskRegistryObserverEvent,
  ensureTaskRegistryReady,
  getTasksByRunId,
  syncFlowFromTaskAfterTaskMutation,
  taskDeliveryStates,
  tasks,
  withTaskRegistryMutation,
} from "./task-registry-state.js";
import {
  addOwnerKeyIndex,
  addParentFlowIdIndex,
  addRelatedSessionKeyIndex,
  addRunIdIndex,
  recordTaskRegistryProjectionWrite,
} from "./task-registry.process-state.js";
import { tryPersistTaskDeliveryStateUpsert, tryPersistTaskUpsert } from "./task-registry.store.js";
import { isTerminalTaskStatus, type TaskRecord } from "./task-registry.types.js";

class TaskCreateRejected extends Error {}

/** The deprecated synchronous adapter retains its process insertion-order selection. */
export function createTaskRecord(input: CreateTaskRecordParams): TaskRecord | null {
  return withTaskRegistryMutation(
    () => {
      ensureTaskRegistryReady();
      try {
        const created = runTaskCreateOperation(
          { params: input, taskId: crypto.randomUUID(), now: Date.now() },
          {
            readSelection(identity, params) {
              assertParentFlowLinkAllowed({ ...identity, parentFlowId: params.parentFlowId });
              let mirroredFlowIds: ReadonlySet<string> | undefined;
              const selectCurrent = () => {
                const candidates = params.runId?.trim() ? getTasksByRunId(params.runId) : [];
                return selectExistingTaskForCreate({
                  ...params,
                  ...identity,
                  candidates,
                  isTaskMirroredFlow: (flowId) => {
                    mirroredFlowIds ??= getTaskMirroredFlowIds(
                      candidates.flatMap((task) =>
                        task.parentFlowId ? [task.parentFlowId.trim()] : [],
                      ),
                    );
                    return mirroredFlowIds.has(flowId);
                  },
                });
              };
              const selected = selectCurrent();
              let existing = selected;
              if (selected) {
                const receipt = captureTaskPersistenceReceipt(selected);
                ensureLinkedTaskFlowRegistryReady(selected);
                // Mirrored-flow lookup and readiness can publish task replacements.
                existing = selectCurrent();
                if (!existing || !matchesTaskPersistenceReceipt(existing, receipt)) {
                  throw new TaskCreateRejected();
                }
              }
              return {
                existing,
                deliveryState: existing ? taskDeliveryStates.get(existing.taskId) : undefined,
              };
            },
            write: (operation) => operation(),
            upsertDelivery(deliveryState) {
              if (!tryPersistTaskDeliveryStateUpsert(deliveryState)) {
                throw new TaskCreateRejected();
              }
            },
            upsertTask(task, deliveryState) {
              if (
                !tryPersistTaskUpsert(
                  task,
                  tasks.has(task.taskId) ? "update" : "create",
                  deliveryState,
                )
              ) {
                throw new TaskCreateRejected();
              }
            },
            deferCommit: (publish) => publish(),
            onCommitted(commit) {
              if (commit.kind === "delivery") {
                taskDeliveryStates.set(commit.task.taskId, commit.deliveryState);
                recordTaskRegistryProjectionWrite("delivery", commit.task.taskId);
                bumpTaskRegistryRevision();
                return;
              }
              const { result } = commit;
              if (result.mutation === "reused") {
                return;
              }
              if (result.mutation === "updated") {
                publishTaskRecordUpdate(result.previous, result.task, result.persisted);
                return;
              }
              const record = result.task;
              const taskId = record.taskId;
              tasks.set(taskId, record);
              recordTaskRegistryProjectionWrite("task", taskId);
              bumpTaskRegistryRevision();
              if (result.deliveryState) {
                taskDeliveryStates.set(taskId, result.deliveryState);
              }
              addRunIdIndex(taskId, record.runId);
              addOwnerKeyIndex(taskId, record);
              addParentFlowIdIndex(taskId, record);
              addRelatedSessionKeyIndex(taskId, record);
              syncFlowFromTaskAfterTaskMutation(record, "create");
              emitTaskRegistryObserverEvent(() => ({
                kind: "upserted",
                task: cloneTaskRecordForObserver(record),
              }));
              if (isTerminalTaskStatus(record.status)) {
                void maybeDeliverTaskTerminalUpdate(taskId);
              }
            },
          },
        );
        return cloneTaskRecord(created.task);
      } catch (error) {
        if (error instanceof TaskCreateRejected) {
          return null;
        }
        throw error;
      }
    },
    () => null,
  );
}
