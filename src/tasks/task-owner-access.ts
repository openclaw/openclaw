import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  findTaskByRunId,
  getTaskById,
  listTasksForRelatedSessionKey,
  markTaskTerminalById as markTaskTerminalRecordById,
  resolveTaskForLookupToken,
  updateTaskNotifyPolicyById,
} from "./task-registry.js";
import type { TaskNotifyPolicy, TaskRecord } from "./task-registry.types.js";
import { buildTaskStatusSnapshot } from "./task-status.js";

function canOwnerAccessTask(task: TaskRecord, callerOwnerKey: string): boolean {
  // Runtime task APIs expose only session-scoped work owned by the caller;
  // system tasks stay internal even when child/run ids are known.
  return (
    task.scopeKind === "session" &&
    normalizeOptionalString(task.ownerKey) === normalizeOptionalString(callerOwnerKey)
  );
}

/** Reads a task by id only when it is visible to the caller's owner key. */
export function getTaskByIdForOwner(params: {
  taskId: string;
  callerOwnerKey: string;
}): TaskRecord | undefined {
  const task = getTaskById(params.taskId);
  return task && canOwnerAccessTask(task, params.callerOwnerKey) ? task : undefined;
}

/** Finds a task by runtime run id while preserving owner scoping. */
export function findTaskByRunIdForOwner(params: {
  runId: string;
  callerOwnerKey: string;
}): TaskRecord | undefined {
  const task = findTaskByRunId(params.runId);
  return task && canOwnerAccessTask(task, params.callerOwnerKey) ? task : undefined;
}

/** Update an owner-visible task's notification policy. */
export function updateTaskNotifyPolicyForOwner(params: {
  taskId: string;
  callerOwnerKey: string;
  notifyPolicy: TaskNotifyPolicy;
}): TaskRecord | null {
  const task = getTaskByIdForOwner({
    taskId: params.taskId,
    callerOwnerKey: params.callerOwnerKey,
  });
  if (!task) {
    return null;
  }
  return updateTaskNotifyPolicyById({
    taskId: task.taskId,
    notifyPolicy: params.notifyPolicy,
  });
}

/** Mark an owner-visible task as cancelled with a caller-provided summary. */
export function cancelTaskByIdForOwner(params: {
  taskId: string;
  callerOwnerKey: string;
  endedAt: number;
  terminalSummary?: string | null;
}): TaskRecord | null {
  const task = getTaskByIdForOwner({
    taskId: params.taskId,
    callerOwnerKey: params.callerOwnerKey,
  });
  if (!task) {
    return null;
  }
  return markTaskTerminalRecordById({
    taskId: task.taskId,
    status: "cancelled",
    endedAt: params.endedAt,
    terminalSummary: params.terminalSummary,
  });
}

/** Lists tasks related to a parent or child session that the caller owns. */
export function listTasksForRelatedSessionKeyForOwner(params: {
  relatedSessionKey: string;
  callerOwnerKey: string;
}): TaskRecord[] {
  return listTasksForRelatedSessionKey(params.relatedSessionKey).filter((task) =>
    canOwnerAccessTask(task, params.callerOwnerKey),
  );
}

/** Builds a status snapshot from only the caller-visible related-session tasks. */
export function buildTaskStatusSnapshotForRelatedSessionKeyForOwner(params: {
  relatedSessionKey: string;
  callerOwnerKey: string;
}) {
  return buildTaskStatusSnapshot(
    listTasksForRelatedSessionKeyForOwner({
      relatedSessionKey: params.relatedSessionKey,
      callerOwnerKey: params.callerOwnerKey,
    }),
  );
}

/** Returns the newest caller-visible task related to a session key. */
export function findLatestTaskForRelatedSessionKeyForOwner(params: {
  relatedSessionKey: string;
  callerOwnerKey: string;
}): TaskRecord | undefined {
  return listTasksForRelatedSessionKeyForOwner(params)[0];
}

/** Resolves id, run id, related-session, or registry tokens through owner gates. */
export function resolveTaskForLookupTokenForOwner(params: {
  token: string;
  callerOwnerKey: string;
}): TaskRecord | undefined {
  const direct = getTaskByIdForOwner({
    taskId: params.token,
    callerOwnerKey: params.callerOwnerKey,
  });
  if (direct) {
    return direct;
  }
  const byRun = findTaskByRunIdForOwner({
    runId: params.token,
    callerOwnerKey: params.callerOwnerKey,
  });
  if (byRun) {
    return byRun;
  }
  const related = findLatestTaskForRelatedSessionKeyForOwner({
    relatedSessionKey: params.token,
    callerOwnerKey: params.callerOwnerKey,
  });
  if (related) {
    return related;
  }
  const raw = resolveTaskForLookupToken(params.token);
  return raw && canOwnerAccessTask(raw, params.callerOwnerKey) ? raw : undefined;
}
