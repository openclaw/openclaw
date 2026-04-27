import { normalizeOptionalString } from "../shared/string-coerce.js";
import { findTaskByRunId, getTaskById, listTasksForRelatedSessionKey, markTaskTerminalById as markTaskTerminalRecordById, resolveTaskForLookupToken, updateTaskNotifyPolicyById, } from "./task-registry.js";
import { buildTaskStatusSnapshot } from "./task-status.js";
function canOwnerAccessTask(task, callerOwnerKey) {
    return (task.scopeKind === "session" &&
        normalizeOptionalString(task.ownerKey) === normalizeOptionalString(callerOwnerKey));
}
export function getTaskByIdForOwner(params) {
    const task = getTaskById(params.taskId);
    return task && canOwnerAccessTask(task, params.callerOwnerKey) ? task : undefined;
}
export function findTaskByRunIdForOwner(params) {
    const task = findTaskByRunId(params.runId);
    return task && canOwnerAccessTask(task, params.callerOwnerKey) ? task : undefined;
}
/** Update an owner-visible task's notification policy. */
export function updateTaskNotifyPolicyForOwner(params) {
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
export function cancelTaskByIdForOwner(params) {
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
export function listTasksForRelatedSessionKeyForOwner(params) {
    return listTasksForRelatedSessionKey(params.relatedSessionKey).filter((task) => canOwnerAccessTask(task, params.callerOwnerKey));
}
export function buildTaskStatusSnapshotForRelatedSessionKeyForOwner(params) {
    return buildTaskStatusSnapshot(listTasksForRelatedSessionKeyForOwner({
        relatedSessionKey: params.relatedSessionKey,
        callerOwnerKey: params.callerOwnerKey,
    }));
}
export function findLatestTaskForRelatedSessionKeyForOwner(params) {
    return listTasksForRelatedSessionKeyForOwner(params)[0];
}
export function resolveTaskForLookupTokenForOwner(params) {
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
