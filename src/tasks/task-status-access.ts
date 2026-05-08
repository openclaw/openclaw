import {
  getTaskById,
  getTaskRegistrySnapshot,
  listTasksForAgentId,
  listTasksForSessionKey,
} from "./task-registry.js";
import type { TaskDeliveryState, TaskRecord } from "./task-registry.types.js";

export function getTaskSessionLookupByIdForStatus(
  taskId: string,
): Pick<TaskRecord, "requesterSessionKey" | "runId"> | undefined {
  const task = getTaskById(taskId);
  return task
    ? {
        requesterSessionKey: task.requesterSessionKey,
        ...(task.runId ? { runId: task.runId } : {}),
      }
    : undefined;
}

export function listTasksForSessionKeyForStatus(sessionKey: string): TaskRecord[] {
  return listTasksForSessionKey(sessionKey);
}

export function listTasksForAgentIdForStatus(agentId: string): TaskRecord[] {
  return listTasksForAgentId(agentId);
}

export function getTaskRequesterOriginForStatus(
  taskId: string,
): TaskDeliveryState["requesterOrigin"] | undefined {
  return getTaskRegistrySnapshot().deliveryStates.find((state) => state.taskId === taskId)
    ?.requesterOrigin;
}
