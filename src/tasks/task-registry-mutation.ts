import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  getTaskFlowById,
  updateFlowRecordByIdExpectedRevision,
} from "./task-flow-runtime-internal.js";
import { buildManagedFlowCancellationPatch } from "./task-initial-flow.rules.js";
import { clearTaskActivity, flushTaskActivity } from "./task-registry-activity.js";
import { ensureLinkedTaskFlowRegistryReady } from "./task-registry-flow-link.js";
import { listTasksForFlowId } from "./task-registry-query.js";
import {
  cloneTaskDeliveryState,
  cloneTaskRecord,
  cloneTaskRecordForObserver,
} from "./task-registry-records.js";
import {
  withTaskRegistryMutation,
  syncFlowFromTaskAfterTaskMutation,
  bumpTaskRegistryRevision,
  emitTaskRegistryObserverEvent,
  taskRegistryLog,
  taskDeliveryStates,
  tasks,
} from "./task-registry-state.js";
import { prepareTaskRecordUpdate } from "./task-registry-transition.operation.js";
import {
  addOwnerKeyIndex,
  deleteOwnerKeyIndex,
  addParentFlowIdIndex,
  deleteParentFlowIdIndex,
  addRelatedSessionKeyIndex,
  deleteRelatedSessionKeyIndex,
  updateRunIdIndex,
  recordTaskRegistryProjectionWrite,
} from "./task-registry.process-state.js";
import { tryPersistTaskUpsert } from "./task-registry.store.js";
import {
  isTerminalTaskStatus,
  type TaskDeliveryState,
  type TaskRecord,
} from "./task-registry.types.js";

function syncManagedFlowCancellationFromTask(task: TaskRecord): void {
  const flowId = task.parentFlowId?.trim();
  if (!flowId) {
    return;
  }
  let flow = getTaskFlowById(flowId);
  const now = Date.now();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const patch = buildManagedFlowCancellationPatch(
      task,
      flow,
      () => listTasksForFlowId(flowId),
      now,
    );
    if (!flow || !patch) {
      return;
    }
    const result = updateFlowRecordByIdExpectedRevision({
      flowId,
      expectedRevision: flow.revision,
      patch,
    });
    if (result.applied || result.reason === "not_found") {
      return;
    }
    flow = result.current;
  }
}

export function updateTask(taskId: string, patch: Partial<TaskRecord>): TaskRecord | null {
  return updateTaskWithPublication(taskId, patch)?.task ?? null;
}

type TaskRecordPublication = {
  task: TaskRecord;
  isCurrent: () => boolean;
};

export function updateTaskWithPublication(
  taskId: string,
  patch: Partial<TaskRecord>,
  deferObserver?: (publish: () => void) => void,
): TaskRecordPublication | null {
  return withTaskRegistryMutation(
    () => {
      const current = tasks.get(taskId);
      if (!current) {
        return null;
      }
      const { task: next, becomesTerminal, persisted } = prepareTaskRecordUpdate(current, patch);
      ensureLinkedTaskFlowRegistryReady(current);
      ensureLinkedTaskFlowRegistryReady(next);
      if (persisted) {
        if (becomesTerminal) {
          flushTaskActivity(taskId);
        }
        // Persist before mutating memory. If the store rejects the write, keep the
        // in-memory mirror at the durable value and report that no mutation applied.
        if (!tryPersistTaskUpsert(next, "update")) {
          return null;
        }
      }
      return publishTaskRecordUpdate(current, next, persisted, deferObserver);
    },
    () => null,
  );
}

/** Reuse the update publication owner after a shared create/reuse kernel commits. */
export function publishTaskRecordUpdate(
  current: TaskRecord,
  next: TaskRecord,
  persisted: boolean,
  deferObserver?: (publish: () => void) => void,
): TaskRecordPublication {
  const taskId = next.taskId;
  // Flow synchronization and observers can replace this row before the call returns.
  const published = persisted ? next : current;
  const becomesTerminal =
    !isTerminalTaskStatus(current.status) && isTerminalTaskStatus(next.status);
  const sessionIndexChanged =
    normalizeOptionalString(current.requesterSessionKey) !==
      normalizeOptionalString(next.requesterSessionKey) ||
    normalizeOptionalString(current.ownerKey) !== normalizeOptionalString(next.ownerKey) ||
    normalizeOptionalString(current.childSessionKey) !==
      normalizeOptionalString(next.childSessionKey);
  const parentFlowIndexChanged = current.parentFlowId?.trim() !== next.parentFlowId?.trim();
  if (persisted) {
    const indexedCurrent = tasks.get(taskId);
    tasks.set(taskId, next);
    recordTaskRegistryProjectionWrite("task", taskId);
    bumpTaskRegistryRevision();
    if (becomesTerminal) {
      clearTaskActivity(taskId);
    }
    updateRunIdIndex(indexedCurrent, next);
    if (sessionIndexChanged) {
      deleteOwnerKeyIndex(taskId, current);
      addOwnerKeyIndex(taskId, next);
      deleteRelatedSessionKeyIndex(taskId, current);
      addRelatedSessionKeyIndex(taskId, next);
    }
    if (parentFlowIndexChanged) {
      deleteParentFlowIdIndex(taskId, current);
      addParentFlowIdIndex(taskId, next);
    }
  }
  // Storage no-ops still repair linked flows and retry failed observer publications.
  syncFlowFromTaskAfterTaskMutation(next, "update");
  try {
    syncManagedFlowCancellationFromTask(next);
  } catch (error) {
    taskRegistryLog.warn("Failed to finalize managed flow cancellation from task update", {
      taskId,
      flowId: next.parentFlowId,
      error,
    });
  }
  const publish = () =>
    emitTaskRegistryObserverEvent(() => ({
      kind: "upserted",
      task: cloneTaskRecordForObserver(next),
      previous: cloneTaskRecordForObserver(current),
    }));
  if (deferObserver) {
    deferObserver(publish);
  } else {
    publish();
  }
  return { task: cloneTaskRecord(next), isCurrent: () => tasks.get(taskId) === published };
}

export function getTaskDeliveryState(taskId: string): TaskDeliveryState | undefined {
  const state = taskDeliveryStates.get(taskId);
  return state ? cloneTaskDeliveryState(state) : undefined;
}
