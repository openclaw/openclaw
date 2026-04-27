import { readAcpSessionEntry } from "../acp/runtime/session-meta.js";
import { loadSessionStore, resolveStorePath } from "../config/sessions.js";
import { isCronJobActive } from "../cron/active-jobs.js";
import { getAgentRunContext } from "../infra/agent-events.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { deriveSessionChatType } from "../sessions/session-chat-type.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import { tryRecoverTaskBeforeMarkLost } from "./detached-task-runtime.js";
import { deleteTaskRecordById, ensureTaskRegistryReady, getTaskById, listTaskRecords, markTaskLostById, maybeDeliverTaskTerminalUpdate, resolveTaskForLookupToken, setTaskCleanupAfterById, } from "./runtime-internal.js";
import { configureTaskAuditTaskProvider, listTaskAuditFindings, summarizeTaskAuditFindings, } from "./task-registry.audit.js";
import { summarizeTaskRecords } from "./task-registry.summary.js";
const TASK_RECONCILE_GRACE_MS = 5 * 60_000;
const TASK_RETENTION_MS = 7 * 24 * 60 * 60_000;
const TASK_SWEEP_INTERVAL_MS = 60_000;
/**
 * Number of tasks to process before yielding to the event loop.
 * Keeps the main thread responsive during large sweeps.
 */
const SWEEP_YIELD_BATCH_SIZE = 25;
let sweeper = null;
let deferredSweep = null;
let sweepInProgress = false;
const defaultTaskRegistryMaintenanceRuntime = {
    readAcpSessionEntry,
    loadSessionStore,
    resolveStorePath,
    isCronJobActive,
    getAgentRunContext,
    parseAgentSessionKey,
    deleteTaskRecordById,
    ensureTaskRegistryReady,
    getTaskById,
    listTaskRecords,
    markTaskLostById,
    maybeDeliverTaskTerminalUpdate,
    resolveTaskForLookupToken,
    setTaskCleanupAfterById,
};
let taskRegistryMaintenanceRuntime = defaultTaskRegistryMaintenanceRuntime;
function findSessionEntryByKey(store, sessionKey) {
    const direct = store[sessionKey];
    if (direct) {
        return direct;
    }
    const normalized = normalizeLowercaseStringOrEmpty(sessionKey);
    for (const [key, entry] of Object.entries(store)) {
        if (normalizeLowercaseStringOrEmpty(key) === normalized) {
            return entry;
        }
    }
    return undefined;
}
function isActiveTask(task) {
    return task.status === "queued" || task.status === "running";
}
function isTerminalTask(task) {
    return !isActiveTask(task);
}
function hasLostGraceExpired(task, now) {
    const referenceAt = task.lastEventAt ?? task.startedAt ?? task.createdAt;
    return now - referenceAt >= TASK_RECONCILE_GRACE_MS;
}
function hasActiveCliRun(task) {
    const candidateRunIds = [task.sourceId, task.runId];
    for (const candidate of candidateRunIds) {
        const runId = candidate?.trim();
        if (runId && taskRegistryMaintenanceRuntime.getAgentRunContext(runId)) {
            return true;
        }
    }
    return false;
}
function hasBackingSession(task) {
    if (task.runtime === "cron") {
        const jobId = task.sourceId?.trim();
        return jobId ? taskRegistryMaintenanceRuntime.isCronJobActive(jobId) : false;
    }
    if (task.runtime === "cli" && hasActiveCliRun(task)) {
        return true;
    }
    const childSessionKey = task.childSessionKey?.trim();
    if (!childSessionKey) {
        return true;
    }
    if (task.runtime === "acp") {
        const acpEntry = taskRegistryMaintenanceRuntime.readAcpSessionEntry({
            sessionKey: childSessionKey,
        });
        if (!acpEntry || acpEntry.storeReadFailed) {
            return true;
        }
        return Boolean(acpEntry.entry);
    }
    if (task.runtime === "subagent" || task.runtime === "cli") {
        if (task.runtime === "cli") {
            const chatType = deriveSessionChatType(childSessionKey);
            if (chatType === "channel" || chatType === "group" || chatType === "direct") {
                return false;
            }
        }
        const agentId = taskRegistryMaintenanceRuntime.parseAgentSessionKey(childSessionKey)?.agentId;
        const storePath = taskRegistryMaintenanceRuntime.resolveStorePath(undefined, { agentId });
        const store = taskRegistryMaintenanceRuntime.loadSessionStore(storePath);
        return Boolean(findSessionEntryByKey(store, childSessionKey));
    }
    return true;
}
function shouldMarkLost(task, now) {
    if (!isActiveTask(task)) {
        return false;
    }
    if (!hasLostGraceExpired(task, now)) {
        return false;
    }
    return !hasBackingSession(task);
}
function shouldPruneTerminalTask(task, now) {
    if (!isTerminalTask(task)) {
        return false;
    }
    if (typeof task.cleanupAfter === "number") {
        return now >= task.cleanupAfter;
    }
    const terminalAt = task.endedAt ?? task.lastEventAt ?? task.createdAt;
    return now - terminalAt >= TASK_RETENTION_MS;
}
function shouldStampCleanupAfter(task) {
    return isTerminalTask(task) && typeof task.cleanupAfter !== "number";
}
function resolveCleanupAfter(task) {
    const terminalAt = task.endedAt ?? task.lastEventAt ?? task.createdAt;
    return terminalAt + TASK_RETENTION_MS;
}
function markTaskLost(task, now) {
    const cleanupAfter = task.cleanupAfter ?? projectTaskLost(task, now).cleanupAfter;
    const updated = taskRegistryMaintenanceRuntime.markTaskLostById({
        taskId: task.taskId,
        endedAt: task.endedAt ?? now,
        lastEventAt: now,
        error: task.error ?? "backing session missing",
        cleanupAfter,
    }) ?? task;
    void taskRegistryMaintenanceRuntime.maybeDeliverTaskTerminalUpdate(updated.taskId);
    return updated;
}
function projectTaskLost(task, now) {
    const projected = {
        ...task,
        status: "lost",
        endedAt: task.endedAt ?? now,
        lastEventAt: now,
        error: task.error ?? "backing session missing",
    };
    return {
        ...projected,
        ...(typeof projected.cleanupAfter === "number"
            ? {}
            : { cleanupAfter: resolveCleanupAfter(projected) }),
    };
}
export function reconcileTaskRecordForOperatorInspection(task) {
    const now = Date.now();
    if (!shouldMarkLost(task, now)) {
        return task;
    }
    return projectTaskLost(task, now);
}
export function reconcileInspectableTasks() {
    taskRegistryMaintenanceRuntime.ensureTaskRegistryReady();
    return taskRegistryMaintenanceRuntime
        .listTaskRecords()
        .map((task) => reconcileTaskRecordForOperatorInspection(task));
}
configureTaskAuditTaskProvider(reconcileInspectableTasks);
export function getInspectableTaskRegistrySummary() {
    return summarizeTaskRecords(reconcileInspectableTasks());
}
export function getInspectableTaskAuditSummary() {
    const tasks = reconcileInspectableTasks();
    return summarizeTaskAuditFindings(listTaskAuditFindings({ tasks }));
}
export function reconcileTaskLookupToken(token) {
    taskRegistryMaintenanceRuntime.ensureTaskRegistryReady();
    const task = taskRegistryMaintenanceRuntime.resolveTaskForLookupToken(token);
    return task ? reconcileTaskRecordForOperatorInspection(task) : undefined;
}
// Preview is synchronous and cannot call the async detached-task recovery hook,
// so recovered tasks are counted under reconciled here. The real sweep
// in runTaskRegistryMaintenance splits them into reconciled vs recovered.
export function previewTaskRegistryMaintenance() {
    taskRegistryMaintenanceRuntime.ensureTaskRegistryReady();
    const now = Date.now();
    let reconciled = 0;
    let cleanupStamped = 0;
    let pruned = 0;
    for (const task of taskRegistryMaintenanceRuntime.listTaskRecords()) {
        if (shouldMarkLost(task, now)) {
            reconciled += 1;
            continue;
        }
        if (shouldPruneTerminalTask(task, now)) {
            pruned += 1;
            continue;
        }
        if (shouldStampCleanupAfter(task)) {
            cleanupStamped += 1;
        }
    }
    return { reconciled, recovered: 0, cleanupStamped, pruned };
}
/**
 * Yield control back to the event loop so that pending I/O callbacks,
 * timers, and incoming requests can be processed between batches of
 * synchronous task-registry maintenance work.
 */
function yieldToEventLoop() {
    return new Promise((resolve) => setImmediate(resolve));
}
function startScheduledSweep() {
    if (sweepInProgress) {
        return;
    }
    sweepInProgress = true;
    const clearSweepInProgress = () => {
        sweepInProgress = false;
    };
    sweepTaskRegistry().then(clearSweepInProgress, clearSweepInProgress);
}
export async function runTaskRegistryMaintenance() {
    taskRegistryMaintenanceRuntime.ensureTaskRegistryReady();
    const now = Date.now();
    let reconciled = 0;
    let recovered = 0;
    let cleanupStamped = 0;
    let pruned = 0;
    const tasks = taskRegistryMaintenanceRuntime.listTaskRecords();
    let processed = 0;
    for (const task of tasks) {
        const current = taskRegistryMaintenanceRuntime.getTaskById(task.taskId);
        if (!current) {
            continue;
        }
        if (shouldMarkLost(current, now)) {
            const recovery = await tryRecoverTaskBeforeMarkLost({
                taskId: current.taskId,
                runtime: current.runtime,
                task: current,
                now,
            });
            const freshAfterHook = taskRegistryMaintenanceRuntime.getTaskById(current.taskId);
            if (!freshAfterHook || !shouldMarkLost(freshAfterHook, now)) {
                processed += 1;
                if (processed % SWEEP_YIELD_BATCH_SIZE === 0) {
                    await yieldToEventLoop();
                }
                continue;
            }
            if (recovery.recovered) {
                recovered += 1;
                processed += 1;
                if (processed % SWEEP_YIELD_BATCH_SIZE === 0) {
                    await yieldToEventLoop();
                }
                continue;
            }
            const next = markTaskLost(freshAfterHook, now);
            if (next.status === "lost") {
                reconciled += 1;
            }
            processed += 1;
            if (processed % SWEEP_YIELD_BATCH_SIZE === 0) {
                await yieldToEventLoop();
            }
            continue;
        }
        if (shouldPruneTerminalTask(current, now) &&
            taskRegistryMaintenanceRuntime.deleteTaskRecordById(current.taskId)) {
            pruned += 1;
            processed += 1;
            if (processed % SWEEP_YIELD_BATCH_SIZE === 0) {
                await yieldToEventLoop();
            }
            continue;
        }
        if (shouldStampCleanupAfter(current) &&
            taskRegistryMaintenanceRuntime.setTaskCleanupAfterById({
                taskId: current.taskId,
                cleanupAfter: resolveCleanupAfter(current),
            })) {
            cleanupStamped += 1;
        }
        processed += 1;
        if (processed % SWEEP_YIELD_BATCH_SIZE === 0) {
            await yieldToEventLoop();
        }
    }
    return { reconciled, recovered, cleanupStamped, pruned };
}
export async function sweepTaskRegistry() {
    return runTaskRegistryMaintenance();
}
export function startTaskRegistryMaintenance() {
    taskRegistryMaintenanceRuntime.ensureTaskRegistryReady();
    deferredSweep = setTimeout(() => {
        deferredSweep = null;
        startScheduledSweep();
    }, 5_000);
    deferredSweep.unref?.();
    if (sweeper) {
        return;
    }
    sweeper = setInterval(startScheduledSweep, TASK_SWEEP_INTERVAL_MS);
    sweeper.unref?.();
}
export function stopTaskRegistryMaintenance() {
    if (deferredSweep) {
        clearTimeout(deferredSweep);
        deferredSweep = null;
    }
    if (sweeper) {
        clearInterval(sweeper);
        sweeper = null;
    }
    sweepInProgress = false;
}
export const stopTaskRegistryMaintenanceForTests = stopTaskRegistryMaintenance;
export function setTaskRegistryMaintenanceRuntimeForTests(runtime) {
    taskRegistryMaintenanceRuntime = runtime;
}
export function resetTaskRegistryMaintenanceRuntimeForTests() {
    taskRegistryMaintenanceRuntime = defaultTaskRegistryMaintenanceRuntime;
}
export function getReconciledTaskById(taskId) {
    const task = getTaskById(taskId);
    return task ? reconcileTaskRecordForOperatorInspection(task) : undefined;
}
