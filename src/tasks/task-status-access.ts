// Filters task status visibility by requester, owner, and flow scope.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { reconcileInspectableTasks, reconcileTaskLookupToken } from "./task-registry.reconcile.js";
import type { TaskRecord } from "./task-registry.types.js";

function taskMatchesRelatedSessionKey(task: TaskRecord, sessionKey: string): boolean {
  const normalized = normalizeOptionalString(sessionKey);
  if (!normalized) {
    return false;
  }
  return [task.requesterSessionKey, task.ownerKey, task.childSessionKey].some(
    (candidate) => normalizeOptionalString(candidate) === normalized,
  );
}

/** Returns only the session lookup fields needed by task status commands. */
export function getTaskSessionLookupByIdForStatus(
  taskId: string,
):
  | Pick<TaskRecord, "requesterSessionKey" | "ownerKey" | "runId" | "agentId" | "requesterAgentId">
  | undefined {
  const task = reconcileInspectableTasks().find((entry) => entry.taskId === taskId);
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
  return reconcileInspectableTasks().filter((task) =>
    taskMatchesRelatedSessionKey(task, sessionKey),
  );
}

export function listTasksForOwnerOrRequesterSessionKeyForStatus(sessionKey: string): TaskRecord[] {
  return reconcileInspectableTasks().filter(
    (task) => task.requesterSessionKey === sessionKey || task.ownerKey === sessionKey,
  );
}

export function listTasksForAgentIdForStatus(agentId: string): TaskRecord[] {
  return reconcileInspectableTasks().filter((task) => task.agentId?.trim() === agentId.trim());
}

export function findTaskByRunIdForStatus(runId: string): TaskRecord | undefined {
  const task = reconcileTaskLookupToken(runId);
  return task?.runId === runId ? task : undefined;
}
