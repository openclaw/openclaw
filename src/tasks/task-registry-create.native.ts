import crypto from "node:crypto";
import { findExistingTaskForCreate } from "./task-registry-create-helpers.js";
import { runTaskCreateOperation } from "./task-registry-create.operation.js";
import { maybeDeliverTaskTerminalUpdate } from "./task-registry-delivery.js";
import {
  assertParentFlowLinkAllowed,
  ensureLinkedTaskFlowRegistryReady,
} from "./task-registry-flow-link.js";
import { publishTaskRecordUpdate } from "./task-registry-mutation.js";
import {
  cloneTaskRecord,
  cloneTaskRecordForObserver,
  type CreateTaskRecordParams,
} from "./task-registry-records.js";
import {
  bumpTaskRegistryRevision,
  emitTaskRegistryObserverEvent,
  ensureTaskRegistryReady,
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

class TaskCreatePersistenceRejected extends Error {}

/** The deprecated synchronous adapter retains its process insertion-order selection. */
export function createTaskRecord(params: CreateTaskRecordParams): TaskRecord | null {
  return withTaskRegistryMutation(
    () => {
      ensureTaskRegistryReady();
      try {
        const created = runTaskCreateOperation(
          { params, taskId: crypto.randomUUID(), now: Date.now() },
          {
            readSelection(identity) {
              assertParentFlowLinkAllowed({ ...identity, parentFlowId: params.parentFlowId });
              const existing = findExistingTaskForCreate({ ...params, ...identity });
              if (existing) {
                ensureLinkedTaskFlowRegistryReady(existing);
              }
              return {
                existing,
                deliveryState: existing ? taskDeliveryStates.get(existing.taskId) : undefined,
              };
            },
            write: (operation) => operation(),
            upsertDelivery(deliveryState) {
              if (!tryPersistTaskDeliveryStateUpsert(deliveryState)) {
                throw new TaskCreatePersistenceRejected();
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
                throw new TaskCreatePersistenceRejected();
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
        if (error instanceof TaskCreatePersistenceRejected) {
          return null;
        }
        throw error;
      }
    },
    () => null,
  );
}
