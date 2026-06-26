// Filters task status visibility by requester, owner, and flow scope.
import {
  findTaskByRunId,
  getTaskById,
  listFreshTasksForOwnerKey,
  listTaskRecords,
  listTasksForAgentId,
  listTasksForRelatedSessionKey,
  listTasksForSessionKey,
} from "./task-registry.js";
import type { TaskRecord, TaskStatus } from "./task-registry.types.js";

/** Returns only the session lookup fields needed by task status commands. */
export function getTaskSessionLookupByIdForStatus(
  taskId: string,
):
  | Pick<TaskRecord, "requesterSessionKey" | "ownerKey" | "runId" | "agentId" | "requesterAgentId">
  | undefined {
  const task = getTaskById(taskId);
  return task
    ? {
        requesterSessionKey: task.requesterSessionKey,
        ownerKey: task.ownerKey,
        ...(task.runId ? { runId: task.runId } : {}),
        ...(task.agentId ? { agentId: task.agentId } : {}),
        ...(task.requesterAgentId ? { requesterAgentId: task.requesterAgentId } : {}),
      }
    : undefined;
}

export function listTasksForSessionKeyForStatus(sessionKey: string): TaskRecord[] {
  return listTasksForSessionKey(sessionKey);
}

export function listTasksForOwnerOrRequesterSessionKeyForStatus(sessionKey: string): TaskRecord[] {
  return listTaskRecords().filter(
    (task) => task.requesterSessionKey === sessionKey || task.ownerKey === sessionKey,
  );
}

export function isActiveTaskStatusForStatus(status: TaskStatus): boolean {
  return status === "queued" || status === "running";
}

export function listTasksForSessionReconciliationForStatus(sessionKey: string): TaskRecord[] {
  const byId = new Map<string, TaskRecord>();
  for (const task of [
    ...listFreshTasksForOwnerKey(sessionKey),
    ...listTasksForSessionKey(sessionKey),
    ...listTasksForRelatedSessionKey(sessionKey),
  ]) {
    byId.set(task.taskId, task);
  }
  return [...byId.values()];
}

export function listTasksForAgentIdForStatus(agentId: string): TaskRecord[] {
  return listTasksForAgentId(agentId);
}

export function findTaskByRunIdForStatus(runId: string): TaskRecord | undefined {
  return findTaskByRunId(runId);
}
