// Normalizes task owner keys and checks requester access to task records.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { getRuntimeConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import {
  findTaskByRunId,
  getTaskById,
  listTasksForRelatedSessionKey,
  markTaskTerminalById as markTaskTerminalRecordById,
  resolveTaskForLookupToken,
  updateTaskNotifyPolicyById,
} from "./task-registry.js";
import type { TaskNotifyPolicy, TaskRecord } from "./task-registry.types.js";
import {
  resolveTaskSessionAgentId,
  resolveTaskSessionAgentIdAsync,
} from "./task-session-identity.js";
import { buildTaskStatusSnapshot } from "./task-status.js";

type TaskOwnerIdentity = {
  callerOwnerKey: string;
  callerAgentId?: string;
  config?: OpenClawConfig;
};

function resolveTaskOwnerCallerAgentId(
  task: TaskRecord,
  identity: TaskOwnerIdentity,
): string | undefined {
  if (
    task.scopeKind !== "session" ||
    normalizeOptionalString(task.ownerKey) !== normalizeOptionalString(identity.callerOwnerKey)
  ) {
    return undefined;
  }
  return (
    normalizeOptionalString(identity.callerAgentId) ??
    parseAgentSessionKey(identity.callerOwnerKey)?.agentId
  );
}

function taskAgentMatchesCaller(taskAgentId: string | undefined, callerAgentId: string): boolean {
  return (
    Boolean(taskAgentId) &&
    normalizeOptionalString(taskAgentId) === normalizeOptionalString(callerAgentId)
  );
}

function canOwnerAccessTask(task: TaskRecord, identity: TaskOwnerIdentity): boolean {
  const callerAgentId = resolveTaskOwnerCallerAgentId(task, identity);
  // Bare owner keys can collide across per-agent stores, so an unscoped caller
  // without a trusted agent identity must fail closed.
  if (!callerAgentId) {
    return false;
  }
  const taskAgentId = resolveTaskSessionAgentId(
    task.ownerKey,
    task.requesterAgentId,
    identity.config ?? getRuntimeConfig,
  );
  return taskAgentMatchesCaller(taskAgentId, callerAgentId);
}

export async function canOwnerAccessTaskAsync(
  task: TaskRecord,
  identity: TaskOwnerIdentity,
  readConfig: () => Promise<OpenClawConfig>,
): Promise<boolean> {
  const callerAgentId = resolveTaskOwnerCallerAgentId(task, identity);
  if (!callerAgentId) {
    return false;
  }
  const taskAgentId = identity.config
    ? resolveTaskSessionAgentId(task.ownerKey, task.requesterAgentId, identity.config)
    : await resolveTaskSessionAgentIdAsync(task.ownerKey, task.requesterAgentId, readConfig);
  return taskAgentMatchesCaller(taskAgentId, callerAgentId);
}

export function getTaskByIdForOwner(
  params: TaskOwnerIdentity & { taskId: string },
): TaskRecord | undefined {
  const task = getTaskById(params.taskId);
  return task && canOwnerAccessTask(task, params) ? task : undefined;
}

export function findTaskByRunIdForOwner(
  params: TaskOwnerIdentity & { runId: string },
): TaskRecord | undefined {
  const task = findTaskByRunId(params.runId);
  return task && canOwnerAccessTask(task, params) ? task : undefined;
}

/** Update an owner-visible task's notification policy. */
export function updateTaskNotifyPolicyForOwner(
  params: TaskOwnerIdentity & { taskId: string; notifyPolicy: TaskNotifyPolicy },
): TaskRecord | null {
  const task = getTaskByIdForOwner(params);
  if (!task) {
    return null;
  }
  return updateTaskNotifyPolicyById({
    taskId: task.taskId,
    notifyPolicy: params.notifyPolicy,
  });
}

/** Mark an owner-visible task as cancelled with a caller-provided summary. */
export function cancelTaskByIdForOwner(
  params: TaskOwnerIdentity & {
    taskId: string;
    endedAt: number;
    terminalSummary?: string | null;
  },
): TaskRecord | null {
  const task = getTaskByIdForOwner(params);
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

export function listTasksForRelatedSessionKeyForOwner(
  params: TaskOwnerIdentity & { relatedSessionKey: string },
): TaskRecord[] {
  return listTasksForRelatedSessionKey(params.relatedSessionKey).filter((task) =>
    canOwnerAccessTask(task, params),
  );
}

export function buildTaskStatusSnapshotForRelatedSessionKeyForOwner(
  params: TaskOwnerIdentity & { relatedSessionKey: string },
) {
  return buildTaskStatusSnapshot(listTasksForRelatedSessionKeyForOwner(params));
}

export function findLatestTaskForRelatedSessionKeyForOwner(
  params: TaskOwnerIdentity & { relatedSessionKey: string },
): TaskRecord | undefined {
  return listTasksForRelatedSessionKeyForOwner(params)[0];
}

export function resolveTaskForLookupTokenForOwner(
  params: TaskOwnerIdentity & { token: string },
): TaskRecord | undefined {
  const direct = getTaskByIdForOwner({
    ...params,
    taskId: params.token,
  });
  if (direct) {
    return direct;
  }
  const byRun = findTaskByRunIdForOwner({
    ...params,
    runId: params.token,
  });
  if (byRun) {
    return byRun;
  }
  const related = findLatestTaskForRelatedSessionKeyForOwner({
    ...params,
    relatedSessionKey: params.token,
  });
  if (related) {
    return related;
  }
  const raw = resolveTaskForLookupToken(params.token);
  return raw && canOwnerAccessTask(raw, params) ? raw : undefined;
}
