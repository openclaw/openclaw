import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeDeliveryContext } from "../utils/delivery-context.shared.js";
import { isTaskFlowCancellationPending } from "./task-cancellation-state.js";
import { isTerminalTaskFlow } from "./task-flow-registry.types.js";
import {
  getTaskFlowById,
  updateFlowRecordByIdExpectedRevision,
} from "./task-flow-runtime-internal.js";
import { clearTaskActivity, flushTaskActivity } from "./task-registry-activity.js";
import { ensureLinkedTaskFlowRegistryReady } from "./task-registry-flow-link.js";
import { listTasksForFlowId } from "./task-registry-query.js";
import {
  cloneTaskDeliveryState,
  cloneTaskRecord,
  cloneTaskRecordForObserver,
  applyTaskRecordPatch,
  isEquivalentTaskRecord,
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
import {
  addOwnerKeyIndex,
  deleteOwnerKeyIndex,
  addParentFlowIdIndex,
  deleteParentFlowIdIndex,
  addRelatedSessionKeyIndex,
  deleteRelatedSessionKeyIndex,
  rebuildRunIdIndex,
} from "./task-registry.process-state.js";
import { tryPersistTaskDeliveryStateUpsert, tryPersistTaskUpsert } from "./task-registry.store.js";
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
  if (
    !flow ||
    flow.syncMode !== "managed" ||
    flow.cancelRequestedAt == null ||
    isTerminalTaskFlow(flow)
  ) {
    return;
  }
  if (listTasksForFlowId(flowId).some(isTaskFlowCancellationPending)) {
    return;
  }
  const endedAt = task.endedAt ?? task.lastEventAt ?? Date.now();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = updateFlowRecordByIdExpectedRevision({
      flowId,
      expectedRevision: flow.revision,
      patch: {
        status: "cancelled",
        blockedTaskId: null,
        blockedSummary: null,
        waitJson: null,
        endedAt,
        updatedAt: endedAt,
      },
    });
    if (result.applied || result.reason === "not_found") {
      return;
    }
    flow = result.current;
    if (
      !flow ||
      flow.syncMode !== "managed" ||
      flow.cancelRequestedAt == null ||
      isTerminalTaskFlow(flow)
    ) {
      return;
    }
    if (listTasksForFlowId(flowId).some(isTaskFlowCancellationPending)) {
      return;
    }
  }
}

export function updateTask(taskId: string, patch: Partial<TaskRecord>): TaskRecord | null {
  return withTaskRegistryMutation(
    () => {
      const current = tasks.get(taskId);
      if (!current) {
        return null;
      }
      const next = applyTaskRecordPatch(current, patch);
      const becomesTerminal =
        !isTerminalTaskStatus(current.status) && isTerminalTaskStatus(next.status);
      const sessionIndexChanged =
        normalizeOptionalString(current.requesterSessionKey) !==
          normalizeOptionalString(next.requesterSessionKey) ||
        normalizeOptionalString(current.ownerKey) !== normalizeOptionalString(next.ownerKey) ||
        normalizeOptionalString(current.childSessionKey) !==
          normalizeOptionalString(next.childSessionKey);
      const parentFlowIndexChanged = current.parentFlowId?.trim() !== next.parentFlowId?.trim();
      ensureLinkedTaskFlowRegistryReady(current);
      ensureLinkedTaskFlowRegistryReady(next);
      if (!isTerminalTaskStatus(current.status) || !isEquivalentTaskRecord(current, next)) {
        if (becomesTerminal) {
          flushTaskActivity(taskId);
        }
        // Persist before mutating memory. If the store rejects the write, keep the
        // in-memory mirror at the durable value and report that no mutation applied.
        if (!tryPersistTaskUpsert(next, "update")) {
          return null;
        }
        tasks.set(taskId, next);
        bumpTaskRegistryRevision();
        if (becomesTerminal) {
          clearTaskActivity(taskId);
        }
        if (patch.runId && patch.runId !== current.runId) {
          rebuildRunIdIndex();
        }
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
      emitTaskRegistryObserverEvent(() => ({
        kind: "upserted",
        task: cloneTaskRecordForObserver(next),
        previous: cloneTaskRecordForObserver(current),
      }));
      return cloneTaskRecord(next);
    },
    () => null,
  );
}

export function upsertTaskDeliveryState(state: TaskDeliveryState): TaskDeliveryState {
  return withTaskRegistryMutation(
    () => {
      const current = taskDeliveryStates.get(state.taskId);
      const next: TaskDeliveryState = {
        taskId: state.taskId,
        ...(state.requesterOrigin
          ? { requesterOrigin: normalizeDeliveryContext(state.requesterOrigin) }
          : {}),
        ...(state.lastNotifiedEventAt != null
          ? { lastNotifiedEventAt: state.lastNotifiedEventAt }
          : {}),
      };
      if (!next.requesterOrigin && typeof next.lastNotifiedEventAt !== "number" && !current) {
        return cloneTaskDeliveryState({ taskId: state.taskId });
      }
      if (!tryPersistTaskDeliveryStateUpsert(next)) {
        return current
          ? cloneTaskDeliveryState(current)
          : cloneTaskDeliveryState({ taskId: state.taskId });
      }
      taskDeliveryStates.set(state.taskId, next);
      bumpTaskRegistryRevision();
      return cloneTaskDeliveryState(next);
    },
    () => cloneTaskDeliveryState(taskDeliveryStates.get(state.taskId) ?? { taskId: state.taskId }),
  );
}

export function getTaskDeliveryState(taskId: string): TaskDeliveryState | undefined {
  const state = taskDeliveryStates.get(taskId);
  return state ? cloneTaskDeliveryState(state) : undefined;
}
