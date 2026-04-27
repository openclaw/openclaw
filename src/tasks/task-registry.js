import crypto from "node:crypto";
import { createRequire } from "node:module";
import { onAgentEvent } from "../infra/agent-events.js";
import { formatErrorMessage } from "../infra/errors.js";
import { requestHeartbeatNow } from "../infra/heartbeat-wake.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { normalizeDeliveryContext } from "../utils/delivery-context.shared.js";
import { isDeliverableMessageChannel } from "../utils/message-channel.js";
import { formatTaskBlockedFollowupMessage, formatTaskStateChangeMessage, formatTaskTerminalMessage, isTerminalTaskStatus, shouldAutoDeliverTaskStateChange, shouldAutoDeliverTaskTerminalUpdate, shouldSuppressDuplicateTerminalDelivery, } from "./task-executor-policy.js";
import { getTaskFlowById, syncFlowFromTask, updateFlowRecordByIdExpectedRevision, } from "./task-flow-runtime-internal.js";
import { getTaskRegistryObservers, getTaskRegistryStore, resetTaskRegistryRuntimeForTests, } from "./task-registry.store.js";
import { summarizeTaskRecords } from "./task-registry.summary.js";
const log = createSubsystemLogger("tasks/registry");
const DEFAULT_TASK_RETENTION_MS = 7 * 24 * 60 * 60_000;
const tasks = new Map();
const taskDeliveryStates = new Map();
const taskIdsByRunId = new Map();
const taskIdsByOwnerKey = new Map();
const taskIdsByParentFlowId = new Map();
const taskIdsByRelatedSessionKey = new Map();
const tasksWithPendingDelivery = new Set();
let listenerStarted = false;
let listenerStop = null;
let restoreAttempted = false;
const TASK_REGISTRY_DELIVERY_RUNTIME_OVERRIDE_KEY = Symbol.for("openclaw.taskRegistry.deliveryRuntimeOverride");
const TASK_REGISTRY_CONTROL_RUNTIME_OVERRIDE_KEY = Symbol.for("openclaw.taskRegistry.controlRuntimeOverride");
const require = createRequire(import.meta.url);
const TASK_REGISTRY_CONTROL_RUNTIME_CANDIDATES = [
    "./task-registry-control.runtime.js",
    "./task-registry-control.runtime.ts",
];
let deliveryRuntimePromise = null;
let controlRuntimePromise = null;
export class ParentFlowLinkError extends Error {
    code;
    details;
    constructor(code, message, details) {
        super(message);
        this.code = code;
        this.details = details;
        this.name = "ParentFlowLinkError";
    }
}
export function isParentFlowLinkError(error) {
    return error instanceof ParentFlowLinkError;
}
function isActiveTaskStatus(status) {
    return status === "queued" || status === "running";
}
function isTerminalFlowStatus(status) {
    return (status === "succeeded" || status === "failed" || status === "cancelled" || status === "lost");
}
function assertTaskOwner(params) {
    const ownerKey = params.ownerKey.trim();
    if (!ownerKey && params.scopeKind !== "system") {
        throw new Error("Task ownerKey is required.");
    }
}
function assertParentFlowLinkAllowed(params) {
    const flowId = params.parentFlowId?.trim();
    if (!flowId) {
        return;
    }
    if (params.scopeKind !== "session") {
        throw new ParentFlowLinkError("scope_kind_not_session", "Only session-scoped tasks can link to flows.", { flowId });
    }
    const flow = getTaskFlowById(flowId);
    if (!flow) {
        throw new ParentFlowLinkError("parent_flow_not_found", `Parent flow not found: ${flowId}`, {
            flowId,
        });
    }
    if (normalizeOptionalString(flow.ownerKey) !== normalizeOptionalString(params.ownerKey)) {
        throw new ParentFlowLinkError("owner_key_mismatch", "Task ownerKey must match parent flow ownerKey.", { flowId });
    }
    if (flow.cancelRequestedAt != null) {
        throw new ParentFlowLinkError("cancel_requested", "Parent flow cancellation has already been requested.", { flowId, status: flow.status });
    }
    if (isTerminalFlowStatus(flow.status)) {
        throw new ParentFlowLinkError("terminal", `Parent flow is already ${flow.status}.`, {
            flowId,
            status: flow.status,
        });
    }
}
function cloneTaskRecord(record) {
    return { ...record };
}
function cloneTaskDeliveryState(state) {
    return {
        ...state,
        ...(state.requesterOrigin ? { requesterOrigin: { ...state.requesterOrigin } } : {}),
    };
}
function snapshotTaskRecords(source) {
    return [...source.values()].map((record) => cloneTaskRecord(record));
}
function emitTaskRegistryObserverEvent(createEvent) {
    const observers = getTaskRegistryObservers();
    if (!observers?.onEvent) {
        return;
    }
    try {
        observers.onEvent(createEvent());
    }
    catch (error) {
        log.warn("Task registry observer failed", {
            event: "task-registry",
            error,
        });
    }
}
function persistTaskRegistry() {
    getTaskRegistryStore().saveSnapshot({
        tasks,
        deliveryStates: taskDeliveryStates,
    });
}
function persistTaskUpsert(task) {
    const store = getTaskRegistryStore();
    const deliveryState = taskDeliveryStates.get(task.taskId);
    if (store.upsertTaskWithDeliveryState) {
        store.upsertTaskWithDeliveryState({
            task,
            ...(deliveryState ? { deliveryState } : {}),
        });
        return;
    }
    if (store.upsertTask) {
        store.upsertTask(task);
        return;
    }
    store.saveSnapshot({
        tasks,
        deliveryStates: taskDeliveryStates,
    });
}
function persistTaskDelete(taskId) {
    const store = getTaskRegistryStore();
    if (store.deleteTaskWithDeliveryState) {
        store.deleteTaskWithDeliveryState(taskId);
        return;
    }
    if (store.deleteTask) {
        store.deleteTask(taskId);
        return;
    }
    store.saveSnapshot({
        tasks,
        deliveryStates: taskDeliveryStates,
    });
}
function persistTaskDeliveryStateUpsert(state) {
    const store = getTaskRegistryStore();
    if (store.upsertDeliveryState) {
        store.upsertDeliveryState(state);
        return;
    }
    store.saveSnapshot({
        tasks,
        deliveryStates: taskDeliveryStates,
    });
}
function persistTaskDeliveryStateDelete(taskId) {
    const store = getTaskRegistryStore();
    if (store.deleteDeliveryState) {
        store.deleteDeliveryState(taskId);
        return;
    }
    store.saveSnapshot({
        tasks,
        deliveryStates: taskDeliveryStates,
    });
}
function ensureDeliveryStatus(params) {
    if (params.scopeKind === "system") {
        return "not_applicable";
    }
    return params.ownerKey.trim() ? "pending" : "parent_missing";
}
function ensureNotifyPolicy(params) {
    if (params.notifyPolicy) {
        return params.notifyPolicy;
    }
    const deliveryStatus = params.deliveryStatus ??
        ensureDeliveryStatus({
            ownerKey: params.ownerKey,
            scopeKind: params.scopeKind,
        });
    return deliveryStatus === "not_applicable" ? "silent" : "done_only";
}
function resolveTaskScopeKind(params) {
    if (params.scopeKind) {
        return params.scopeKind;
    }
    return params.requesterSessionKey.trim() ? "session" : "system";
}
function resolveTaskRequesterSessionKey(params) {
    const requesterSessionKey = params.requesterSessionKey?.trim();
    if (requesterSessionKey) {
        return requesterSessionKey;
    }
    if (params.scopeKind === "system") {
        return "";
    }
    return params.ownerKey?.trim() ?? "";
}
function resolveTaskOwnerKey(params) {
    return params.ownerKey?.trim() || params.requesterSessionKey.trim();
}
function normalizeTaskSummary(value) {
    const normalized = value?.replace(/\s+/g, " ").trim();
    return normalized || undefined;
}
function normalizeTaskStatus(value) {
    return value === "running" ||
        value === "queued" ||
        value === "succeeded" ||
        value === "failed" ||
        value === "timed_out" ||
        value === "cancelled" ||
        value === "lost"
        ? value
        : "queued";
}
function normalizeTaskTerminalOutcome(value) {
    return value === "succeeded" || value === "blocked" ? value : undefined;
}
function resolveTaskTerminalOutcome(params) {
    const normalized = normalizeTaskTerminalOutcome(params.terminalOutcome);
    if (normalized) {
        return normalized;
    }
    return params.status === "succeeded" ? "succeeded" : undefined;
}
function appendTaskEvent(event) {
    const summary = normalizeTaskSummary(event.summary);
    return {
        at: event.at,
        kind: event.kind,
        ...(summary ? { summary } : {}),
    };
}
function loadTaskRegistryDeliveryRuntime() {
    const deliveryRuntimeOverride = globalThis[TASK_REGISTRY_DELIVERY_RUNTIME_OVERRIDE_KEY];
    if (deliveryRuntimeOverride) {
        return Promise.resolve(deliveryRuntimeOverride);
    }
    deliveryRuntimePromise ??= import("./task-registry-delivery-runtime.js");
    return deliveryRuntimePromise;
}
function loadTaskRegistryControlRuntime() {
    const controlRuntimeOverride = globalThis[TASK_REGISTRY_CONTROL_RUNTIME_OVERRIDE_KEY];
    if (controlRuntimeOverride) {
        return Promise.resolve(controlRuntimeOverride);
    }
    // Registry reads happen far more often than task cancellation, so keep the ACP/subagent
    // control graph off the default import path until a cancellation flow actually needs it.
    controlRuntimePromise ??= Promise.resolve().then(() => {
        for (const candidate of TASK_REGISTRY_CONTROL_RUNTIME_CANDIDATES) {
            try {
                return require(candidate);
            }
            catch {
                // Try runtime/source candidates in order.
            }
        }
        throw new Error("Failed to load task registry control runtime.");
    });
    return controlRuntimePromise;
}
function addRunIdIndex(taskId, runId) {
    const trimmed = runId?.trim();
    if (!trimmed) {
        return;
    }
    let ids = taskIdsByRunId.get(trimmed);
    if (!ids) {
        ids = new Set();
        taskIdsByRunId.set(trimmed, ids);
    }
    ids.add(taskId);
}
function addIndexedKey(index, key, taskId) {
    let ids = index.get(key);
    if (!ids) {
        ids = new Set();
        index.set(key, ids);
    }
    ids.add(taskId);
}
function deleteIndexedKey(index, key, taskId) {
    const ids = index.get(key);
    if (!ids) {
        return;
    }
    ids.delete(taskId);
    if (ids.size === 0) {
        index.delete(key);
    }
}
function getTaskRelatedSessionIndexKeys(task) {
    return [
        ...new Set([
            normalizeOptionalString(task.ownerKey),
            normalizeOptionalString(task.childSessionKey),
        ].filter(Boolean)),
    ];
}
function addOwnerKeyIndex(taskId, task) {
    const key = normalizeOptionalString(task.ownerKey);
    if (!key) {
        return;
    }
    addIndexedKey(taskIdsByOwnerKey, key, taskId);
}
function deleteOwnerKeyIndex(taskId, task) {
    const key = normalizeOptionalString(task.ownerKey);
    if (!key) {
        return;
    }
    deleteIndexedKey(taskIdsByOwnerKey, key, taskId);
}
function addParentFlowIdIndex(taskId, task) {
    const key = task.parentFlowId?.trim();
    if (!key) {
        return;
    }
    addIndexedKey(taskIdsByParentFlowId, key, taskId);
}
function deleteParentFlowIdIndex(taskId, task) {
    const key = task.parentFlowId?.trim();
    if (!key) {
        return;
    }
    deleteIndexedKey(taskIdsByParentFlowId, key, taskId);
}
function addRelatedSessionKeyIndex(taskId, task) {
    for (const sessionKey of getTaskRelatedSessionIndexKeys(task)) {
        addIndexedKey(taskIdsByRelatedSessionKey, sessionKey, taskId);
    }
}
function deleteRelatedSessionKeyIndex(taskId, task) {
    for (const sessionKey of getTaskRelatedSessionIndexKeys(task)) {
        deleteIndexedKey(taskIdsByRelatedSessionKey, sessionKey, taskId);
    }
}
function rebuildRunIdIndex() {
    taskIdsByRunId.clear();
    for (const [taskId, task] of tasks.entries()) {
        addRunIdIndex(taskId, task.runId);
    }
}
function rebuildOwnerKeyIndex() {
    taskIdsByOwnerKey.clear();
    for (const [taskId, task] of tasks.entries()) {
        addOwnerKeyIndex(taskId, task);
    }
}
function rebuildParentFlowIdIndex() {
    taskIdsByParentFlowId.clear();
    for (const [taskId, task] of tasks.entries()) {
        addParentFlowIdIndex(taskId, task);
    }
}
function rebuildRelatedSessionKeyIndex() {
    taskIdsByRelatedSessionKey.clear();
    for (const [taskId, task] of tasks.entries()) {
        addRelatedSessionKeyIndex(taskId, task);
    }
}
function getTasksByRunId(runId) {
    const ids = taskIdsByRunId.get(runId.trim());
    if (!ids || ids.size === 0) {
        return [];
    }
    return [...ids]
        .map((taskId) => tasks.get(taskId))
        .filter((task) => Boolean(task));
}
function taskRunScopeKey(task) {
    return [
        task.runtime,
        task.scopeKind,
        normalizeOptionalString(task.ownerKey) ?? "",
        normalizeOptionalString(task.childSessionKey) ?? "",
    ].join("\u0000");
}
function getTasksByRunScope(params) {
    const matches = getTasksByRunId(params.runId).filter((task) => !params.runtime || task.runtime === params.runtime);
    const sessionKey = normalizeOptionalString(params.sessionKey);
    if (sessionKey) {
        const childMatches = matches.filter((task) => normalizeOptionalString(task.childSessionKey) === sessionKey);
        if (childMatches.length > 0) {
            return childMatches;
        }
        const ownerMatches = matches.filter((task) => task.scopeKind === "session" && normalizeOptionalString(task.ownerKey) === sessionKey);
        return ownerMatches;
    }
    const scopeKeys = new Set(matches.map((task) => taskRunScopeKey(task)));
    return scopeKeys.size <= 1 ? matches : [];
}
function getPeerTasksForDelivery(task) {
    if (!task.runId?.trim()) {
        return [];
    }
    return getTasksByRunId(task.runId).filter((candidate) => candidate.runtime === task.runtime &&
        candidate.scopeKind === task.scopeKind &&
        (normalizeOptionalString(candidate.ownerKey) ?? "") ===
            (normalizeOptionalString(task.ownerKey) ?? "") &&
        (normalizeOptionalString(candidate.childSessionKey) ?? "") ===
            (normalizeOptionalString(task.childSessionKey) ?? ""));
}
function taskLookupPriority(task) {
    const runtimePriority = task.runtime === "cli" ? 1 : 0;
    return runtimePriority;
}
function pickPreferredRunIdTask(matches) {
    return [...matches].toSorted((left, right) => {
        const priorityDiff = taskLookupPriority(left) - taskLookupPriority(right);
        if (priorityDiff !== 0) {
            return priorityDiff;
        }
        return left.createdAt - right.createdAt;
    })[0];
}
function compareTasksNewestFirst(left, right) {
    const createdAtDiff = right.createdAt - left.createdAt;
    if (createdAtDiff !== 0) {
        return createdAtDiff;
    }
    return (right.insertionIndex ?? 0) - (left.insertionIndex ?? 0);
}
function findExistingTaskForCreate(params) {
    const runId = params.runId?.trim();
    const runScopeMatches = runId
        ? getTasksByRunId(runId).filter((task) => task.runtime === params.runtime &&
            task.scopeKind === params.scopeKind &&
            (normalizeOptionalString(task.ownerKey) ?? "") ===
                (normalizeOptionalString(params.ownerKey) ?? "") &&
            (normalizeOptionalString(task.childSessionKey) ?? "") ===
                (normalizeOptionalString(params.childSessionKey) ?? "") &&
            (normalizeOptionalString(task.parentFlowId) ?? "") ===
                (normalizeOptionalString(params.parentFlowId) ?? ""))
        : [];
    const exact = runId
        ? runScopeMatches.find((task) => (normalizeOptionalString(task.label) ?? "") ===
            (normalizeOptionalString(params.label) ?? "") &&
            (normalizeOptionalString(task.task) ?? "") ===
                (normalizeOptionalString(params.task) ?? ""))
        : undefined;
    if (exact) {
        return exact;
    }
    if (!runId || params.runtime !== "acp") {
        return undefined;
    }
    if (runScopeMatches.length === 0) {
        return undefined;
    }
    return pickPreferredRunIdTask(runScopeMatches);
}
function mergeExistingTaskForCreate(existing, params) {
    const patch = {};
    const requesterOrigin = normalizeDeliveryContext(params.requesterOrigin);
    const currentDeliveryState = taskDeliveryStates.get(existing.taskId);
    if (requesterOrigin && !currentDeliveryState?.requesterOrigin) {
        upsertTaskDeliveryState({
            taskId: existing.taskId,
            requesterOrigin,
            lastNotifiedEventAt: currentDeliveryState?.lastNotifiedEventAt,
        });
    }
    if (params.sourceId?.trim() && !existing.sourceId?.trim()) {
        patch.sourceId = params.sourceId.trim();
    }
    if (params.taskKind?.trim() && !existing.taskKind?.trim()) {
        patch.taskKind = params.taskKind.trim();
    }
    if (params.parentFlowId?.trim() && !existing.parentFlowId?.trim()) {
        assertParentFlowLinkAllowed({
            ownerKey: existing.ownerKey,
            scopeKind: existing.scopeKind,
            parentFlowId: params.parentFlowId,
        });
        patch.parentFlowId = params.parentFlowId.trim();
    }
    if (params.parentTaskId?.trim() && !existing.parentTaskId?.trim()) {
        patch.parentTaskId = params.parentTaskId.trim();
    }
    if (params.agentId?.trim() && !existing.agentId?.trim()) {
        patch.agentId = params.agentId.trim();
    }
    const nextLabel = params.label?.trim();
    if (params.preferMetadata) {
        if (nextLabel && (normalizeOptionalString(existing.label) ?? "") !== nextLabel) {
            patch.label = nextLabel;
        }
        const nextTask = params.task.trim();
        if (nextTask && (normalizeOptionalString(existing.task) ?? "") !== nextTask) {
            patch.task = nextTask;
        }
    }
    else if (nextLabel && !existing.label?.trim()) {
        patch.label = nextLabel;
    }
    if (params.deliveryStatus === "pending" && existing.deliveryStatus !== "delivered") {
        patch.deliveryStatus = "pending";
    }
    const notifyPolicy = ensureNotifyPolicy({
        notifyPolicy: params.notifyPolicy,
        deliveryStatus: params.deliveryStatus,
        ownerKey: existing.ownerKey,
        scopeKind: existing.scopeKind,
    });
    if (notifyPolicy !== existing.notifyPolicy && existing.notifyPolicy === "silent") {
        patch.notifyPolicy = notifyPolicy;
    }
    if (Object.keys(patch).length === 0) {
        return cloneTaskRecord(existing);
    }
    return updateTask(existing.taskId, patch) ?? cloneTaskRecord(existing);
}
function taskTerminalDeliveryIdempotencyKey(task) {
    const outcome = task.status === "succeeded" ? (task.terminalOutcome ?? "default") : "default";
    return `task-terminal:${task.taskId}:${task.status}:${outcome}`;
}
function resolveTaskStateChangeIdempotencyKey(params) {
    if (params.owner.flowId) {
        return `flow-event:${params.owner.flowId}:${params.task.taskId}:${params.latestEvent.at}:${params.latestEvent.kind}`;
    }
    return `task-event:${params.task.taskId}:${params.latestEvent.at}:${params.latestEvent.kind}`;
}
function resolveTaskTerminalIdempotencyKey(task) {
    const owner = resolveTaskDeliveryOwner(task);
    if (owner.flowId) {
        const outcome = task.status === "succeeded" ? (task.terminalOutcome ?? "default") : "default";
        return `flow-terminal:${owner.flowId}:${task.taskId}:${task.status}:${outcome}`;
    }
    return taskTerminalDeliveryIdempotencyKey(task);
}
function getLinkedFlowForDelivery(task) {
    const flowId = task.parentFlowId?.trim();
    if (!flowId || task.scopeKind !== "session") {
        return undefined;
    }
    const flow = getTaskFlowById(flowId);
    if (!flow) {
        return undefined;
    }
    if (normalizeOptionalString(flow.ownerKey) !== normalizeOptionalString(task.ownerKey)) {
        return undefined;
    }
    return flow;
}
function resolveTaskDeliveryOwner(task) {
    const flow = getLinkedFlowForDelivery(task);
    if (flow) {
        return {
            sessionKey: flow.ownerKey.trim(),
            requesterOrigin: normalizeDeliveryContext(flow.requesterOrigin ?? taskDeliveryStates.get(task.taskId)?.requesterOrigin),
            flowId: flow.flowId,
        };
    }
    if (task.scopeKind !== "session") {
        return {};
    }
    return {
        sessionKey: task.ownerKey.trim(),
        requesterOrigin: normalizeDeliveryContext(taskDeliveryStates.get(task.taskId)?.requesterOrigin),
    };
}
function syncManagedFlowCancellationFromTask(task) {
    const flowId = task.parentFlowId?.trim();
    if (!flowId) {
        return;
    }
    let flow = getTaskFlowById(flowId);
    if (!flow ||
        flow.syncMode !== "managed" ||
        flow.cancelRequestedAt == null ||
        isTerminalFlowStatus(flow.status)) {
        return;
    }
    if (listTasksForFlowId(flowId).some((candidate) => isActiveTaskStatus(candidate.status))) {
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
        if (!flow ||
            flow.syncMode !== "managed" ||
            flow.cancelRequestedAt == null ||
            isTerminalFlowStatus(flow.status)) {
            return;
        }
        if (listTasksForFlowId(flowId).some((candidate) => isActiveTaskStatus(candidate.status))) {
            return;
        }
    }
}
function restoreTaskRegistryOnce() {
    if (restoreAttempted) {
        return;
    }
    restoreAttempted = true;
    try {
        const restored = getTaskRegistryStore().loadSnapshot();
        if (restored.tasks.size === 0 && restored.deliveryStates.size === 0) {
            return;
        }
        for (const [taskId, task] of restored.tasks.entries()) {
            tasks.set(taskId, task);
        }
        for (const [taskId, state] of restored.deliveryStates.entries()) {
            taskDeliveryStates.set(taskId, state);
        }
        rebuildRunIdIndex();
        rebuildOwnerKeyIndex();
        rebuildParentFlowIdIndex();
        rebuildRelatedSessionKeyIndex();
        emitTaskRegistryObserverEvent(() => ({
            kind: "restored",
            tasks: snapshotTaskRecords(tasks),
        }));
    }
    catch (error) {
        log.warn("Failed to restore task registry", { error });
    }
}
export function ensureTaskRegistryReady() {
    restoreTaskRegistryOnce();
    ensureListener();
}
function updateTask(taskId, patch) {
    const current = tasks.get(taskId);
    if (!current) {
        return null;
    }
    const next = { ...current, ...patch };
    if (isTerminalTaskStatus(next.status) && typeof next.cleanupAfter !== "number") {
        const terminalAt = next.endedAt ?? next.lastEventAt ?? Date.now();
        next.cleanupAfter = terminalAt + DEFAULT_TASK_RETENTION_MS;
    }
    const sessionIndexChanged = normalizeOptionalString(current.ownerKey) !== normalizeOptionalString(next.ownerKey) ||
        normalizeOptionalString(current.childSessionKey) !==
            normalizeOptionalString(next.childSessionKey);
    const parentFlowIndexChanged = current.parentFlowId?.trim() !== next.parentFlowId?.trim();
    tasks.set(taskId, next);
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
    persistTaskUpsert(next);
    try {
        syncFlowFromTask(next);
    }
    catch (error) {
        log.warn("Failed to sync parent flow from task update", {
            taskId,
            flowId: next.parentFlowId,
            error,
        });
    }
    try {
        syncManagedFlowCancellationFromTask(next);
    }
    catch (error) {
        log.warn("Failed to finalize managed flow cancellation from task update", {
            taskId,
            flowId: next.parentFlowId,
            error,
        });
    }
    emitTaskRegistryObserverEvent(() => ({
        kind: "upserted",
        task: cloneTaskRecord(next),
        previous: cloneTaskRecord(current),
    }));
    return cloneTaskRecord(next);
}
function upsertTaskDeliveryState(state) {
    const current = taskDeliveryStates.get(state.taskId);
    const next = {
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
    taskDeliveryStates.set(state.taskId, next);
    persistTaskDeliveryStateUpsert(next);
    return cloneTaskDeliveryState(next);
}
function getTaskDeliveryState(taskId) {
    const state = taskDeliveryStates.get(taskId);
    return state ? cloneTaskDeliveryState(state) : undefined;
}
function canDeliverTaskToRequesterOrigin(task) {
    const origin = resolveTaskDeliveryOwner(task).requesterOrigin;
    const channel = origin?.channel?.trim();
    const to = origin?.to?.trim();
    return Boolean(channel && to && isDeliverableMessageChannel(channel));
}
function resolveMissingOwnerDeliveryStatus(task) {
    return task.scopeKind === "system" ? "not_applicable" : "parent_missing";
}
function queueTaskSystemEvent(task, text) {
    const owner = resolveTaskDeliveryOwner(task);
    const ownerKey = owner.sessionKey?.trim();
    if (!ownerKey) {
        return false;
    }
    enqueueSystemEvent(text, {
        sessionKey: ownerKey,
        contextKey: `task:${task.taskId}`,
        deliveryContext: owner.requesterOrigin,
    });
    requestHeartbeatNow({
        reason: "background-task",
        sessionKey: ownerKey,
    });
    return true;
}
function queueBlockedTaskFollowup(task) {
    const followupText = formatTaskBlockedFollowupMessage(task);
    if (!followupText) {
        return false;
    }
    const owner = resolveTaskDeliveryOwner(task);
    const ownerKey = owner.sessionKey?.trim();
    if (!ownerKey) {
        return false;
    }
    enqueueSystemEvent(followupText, {
        sessionKey: ownerKey,
        contextKey: `task:${task.taskId}:blocked-followup`,
        deliveryContext: owner.requesterOrigin,
    });
    requestHeartbeatNow({
        reason: "background-task-blocked",
        sessionKey: ownerKey,
    });
    return true;
}
export async function maybeDeliverTaskTerminalUpdate(taskId) {
    ensureTaskRegistryReady();
    const current = tasks.get(taskId);
    if (!current || !shouldAutoDeliverTaskTerminalUpdate(current)) {
        return current ? cloneTaskRecord(current) : null;
    }
    if (tasksWithPendingDelivery.has(taskId)) {
        return cloneTaskRecord(current);
    }
    tasksWithPendingDelivery.add(taskId);
    try {
        const latest = tasks.get(taskId);
        if (!latest || !shouldAutoDeliverTaskTerminalUpdate(latest)) {
            return latest ? cloneTaskRecord(latest) : null;
        }
        const preferred = latest.runId
            ? pickPreferredRunIdTask(getPeerTasksForDelivery(latest))
            : undefined;
        if (shouldSuppressDuplicateTerminalDelivery({ task: latest, preferredTaskId: preferred?.taskId })) {
            return updateTask(taskId, {
                deliveryStatus: "not_applicable",
                lastEventAt: Date.now(),
            });
        }
        const owner = resolveTaskDeliveryOwner(latest);
        const ownerSessionKey = owner.sessionKey?.trim();
        if (!ownerSessionKey) {
            return updateTask(taskId, {
                deliveryStatus: resolveMissingOwnerDeliveryStatus(latest),
                lastEventAt: Date.now(),
            });
        }
        const eventText = formatTaskTerminalMessage(latest);
        if (!canDeliverTaskToRequesterOrigin(latest)) {
            try {
                queueTaskSystemEvent(latest, eventText);
                if (latest.terminalOutcome === "blocked") {
                    queueBlockedTaskFollowup(latest);
                }
                return updateTask(taskId, {
                    deliveryStatus: "session_queued",
                    lastEventAt: Date.now(),
                });
            }
            catch (error) {
                log.warn("Failed to queue background task session delivery", {
                    taskId,
                    ownerKey: latest.ownerKey,
                    error,
                });
                return updateTask(taskId, {
                    deliveryStatus: "failed",
                    lastEventAt: Date.now(),
                });
            }
        }
        try {
            const { sendMessage } = await loadTaskRegistryDeliveryRuntime();
            const requesterAgentId = parseAgentSessionKey(ownerSessionKey)?.agentId;
            const idempotencyKey = resolveTaskTerminalIdempotencyKey(latest);
            await sendMessage({
                channel: owner.requesterOrigin?.channel,
                to: owner.requesterOrigin?.to ?? "",
                accountId: owner.requesterOrigin?.accountId,
                threadId: owner.requesterOrigin?.threadId,
                content: eventText,
                agentId: requesterAgentId,
                idempotencyKey,
                mirror: {
                    sessionKey: ownerSessionKey,
                    agentId: requesterAgentId,
                    idempotencyKey,
                },
            });
            if (latest.terminalOutcome === "blocked") {
                queueBlockedTaskFollowup(latest);
            }
            return updateTask(taskId, {
                deliveryStatus: "delivered",
                lastEventAt: Date.now(),
            });
        }
        catch (error) {
            log.warn("Failed to deliver background task update", {
                taskId,
                ownerKey: ownerSessionKey,
                requesterOrigin: owner.requesterOrigin,
                error,
            });
            try {
                queueTaskSystemEvent(latest, eventText);
                if (latest.terminalOutcome === "blocked") {
                    queueBlockedTaskFollowup(latest);
                }
            }
            catch (fallbackError) {
                log.warn("Failed to queue background task fallback event", {
                    taskId,
                    ownerKey: latest.ownerKey,
                    error: fallbackError,
                });
            }
            return updateTask(taskId, {
                deliveryStatus: "failed",
                lastEventAt: Date.now(),
            });
        }
    }
    finally {
        tasksWithPendingDelivery.delete(taskId);
    }
}
export async function maybeDeliverTaskStateChangeUpdate(taskId, latestEvent) {
    ensureTaskRegistryReady();
    const current = tasks.get(taskId);
    if (!current || !shouldAutoDeliverTaskStateChange(current)) {
        return current ? cloneTaskRecord(current) : null;
    }
    const deliveryState = getTaskDeliveryState(taskId);
    if (!latestEvent || (deliveryState?.lastNotifiedEventAt ?? 0) >= latestEvent.at) {
        return cloneTaskRecord(current);
    }
    const eventText = formatTaskStateChangeMessage(current, latestEvent);
    if (!eventText) {
        return cloneTaskRecord(current);
    }
    try {
        const owner = resolveTaskDeliveryOwner(current);
        const ownerSessionKey = owner.sessionKey?.trim();
        if (!ownerSessionKey) {
            return updateTask(taskId, {
                deliveryStatus: resolveMissingOwnerDeliveryStatus(current),
                lastEventAt: Date.now(),
            });
        }
        if (!canDeliverTaskToRequesterOrigin(current)) {
            queueTaskSystemEvent(current, eventText);
            upsertTaskDeliveryState({
                taskId,
                requesterOrigin: deliveryState?.requesterOrigin,
                lastNotifiedEventAt: latestEvent.at,
            });
            return updateTask(taskId, {
                lastEventAt: Date.now(),
            });
        }
        const { sendMessage } = await loadTaskRegistryDeliveryRuntime();
        const requesterAgentId = parseAgentSessionKey(ownerSessionKey)?.agentId;
        const idempotencyKey = resolveTaskStateChangeIdempotencyKey({
            task: current,
            latestEvent,
            owner,
        });
        await sendMessage({
            channel: owner.requesterOrigin?.channel,
            to: owner.requesterOrigin?.to ?? "",
            accountId: owner.requesterOrigin?.accountId,
            threadId: owner.requesterOrigin?.threadId,
            content: eventText,
            agentId: requesterAgentId,
            idempotencyKey,
            mirror: {
                sessionKey: ownerSessionKey,
                agentId: requesterAgentId,
                idempotencyKey,
            },
        });
        upsertTaskDeliveryState({
            taskId,
            requesterOrigin: deliveryState?.requesterOrigin,
            lastNotifiedEventAt: latestEvent.at,
        });
        return updateTask(taskId, {
            lastEventAt: Date.now(),
        });
    }
    catch (error) {
        log.warn("Failed to deliver background task state change", {
            taskId,
            ownerKey: current.ownerKey,
            error,
        });
        return cloneTaskRecord(current);
    }
}
export function setTaskProgressById(params) {
    ensureTaskRegistryReady();
    const patch = {};
    if (params.progressSummary !== undefined) {
        patch.progressSummary = normalizeTaskSummary(params.progressSummary);
    }
    if (params.lastEventAt != null) {
        patch.lastEventAt = params.lastEventAt;
    }
    return updateTask(params.taskId, patch);
}
export function setTaskTimingById(params) {
    ensureTaskRegistryReady();
    const patch = {};
    if (params.startedAt != null) {
        patch.startedAt = params.startedAt;
    }
    if (params.endedAt != null) {
        patch.endedAt = params.endedAt;
    }
    if (params.lastEventAt != null) {
        patch.lastEventAt = params.lastEventAt;
    }
    return updateTask(params.taskId, patch);
}
export function setTaskCleanupAfterById(params) {
    ensureTaskRegistryReady();
    return updateTask(params.taskId, {
        cleanupAfter: params.cleanupAfter,
    });
}
export function markTaskTerminalById(params) {
    ensureTaskRegistryReady();
    return updateTask(params.taskId, {
        status: params.status,
        endedAt: params.endedAt,
        lastEventAt: params.lastEventAt ?? params.endedAt,
        ...(params.error !== undefined ? { error: params.error } : {}),
        ...(params.terminalSummary !== undefined
            ? { terminalSummary: normalizeTaskSummary(params.terminalSummary) }
            : {}),
        ...(params.terminalOutcome !== undefined
            ? {
                terminalOutcome: resolveTaskTerminalOutcome({
                    status: params.status,
                    terminalOutcome: params.terminalOutcome,
                }),
            }
            : {}),
    });
}
export function markTaskLostById(params) {
    ensureTaskRegistryReady();
    return updateTask(params.taskId, {
        status: "lost",
        endedAt: params.endedAt,
        lastEventAt: params.lastEventAt ?? params.endedAt,
        ...(params.error !== undefined ? { error: params.error } : {}),
        ...(params.cleanupAfter !== undefined ? { cleanupAfter: params.cleanupAfter } : {}),
    });
}
function updateTasksByRunId(params) {
    const matches = getTasksByRunScope(params);
    if (matches.length === 0) {
        return [];
    }
    const updated = [];
    for (const match of matches) {
        const task = updateTask(match.taskId, params.patch);
        if (task) {
            updated.push(task);
        }
    }
    return updated;
}
function ensureListener() {
    if (listenerStarted) {
        return;
    }
    listenerStarted = true;
    listenerStop = onAgentEvent((evt) => {
        restoreTaskRegistryOnce();
        const scopedTasks = getTasksByRunScope({
            runId: evt.runId,
            sessionKey: evt.sessionKey,
        });
        if (scopedTasks.length === 0) {
            return;
        }
        const now = evt.ts || Date.now();
        for (const current of scopedTasks) {
            if (isTerminalTaskStatus(current.status)) {
                continue;
            }
            const patch = {
                lastEventAt: now,
            };
            if (evt.stream === "lifecycle") {
                const phase = typeof evt.data?.phase === "string" ? evt.data.phase : undefined;
                const startedAt = typeof evt.data?.startedAt === "number" ? evt.data.startedAt : current.startedAt;
                const endedAt = typeof evt.data?.endedAt === "number" ? evt.data.endedAt : undefined;
                if (startedAt) {
                    patch.startedAt = startedAt;
                }
                if (phase === "start") {
                    patch.status = "running";
                }
                else if (phase === "end") {
                    patch.status = evt.data?.aborted === true ? "timed_out" : "succeeded";
                    patch.endedAt = endedAt ?? now;
                }
                else if (phase === "error") {
                    patch.status = "failed";
                    patch.endedAt = endedAt ?? now;
                    patch.error = typeof evt.data?.error === "string" ? evt.data.error : current.error;
                }
            }
            else if (evt.stream === "error") {
                patch.error = typeof evt.data?.error === "string" ? evt.data.error : current.error;
            }
            const stateChangeEvent = patch.status && patch.status !== current.status
                ? appendTaskEvent({
                    at: now,
                    kind: patch.status,
                    summary: patch.status === "failed"
                        ? (patch.error ?? current.error)
                        : patch.status === "succeeded"
                            ? current.terminalSummary
                            : undefined,
                })
                : undefined;
            const updated = updateTask(current.taskId, patch);
            if (updated) {
                void maybeDeliverTaskStateChangeUpdate(current.taskId, stateChangeEvent);
                void maybeDeliverTaskTerminalUpdate(current.taskId);
            }
        }
    });
}
export function createTaskRecord(params) {
    ensureTaskRegistryReady();
    const requesterSessionKey = resolveTaskRequesterSessionKey(params);
    const scopeKind = resolveTaskScopeKind({
        scopeKind: params.scopeKind,
        requesterSessionKey,
    });
    const ownerKey = resolveTaskOwnerKey({
        requesterSessionKey,
        ownerKey: params.ownerKey,
    });
    assertTaskOwner({
        ownerKey,
        scopeKind,
    });
    assertParentFlowLinkAllowed({
        ownerKey,
        scopeKind,
        parentFlowId: params.parentFlowId,
    });
    const existing = findExistingTaskForCreate({
        runtime: params.runtime,
        ownerKey,
        scopeKind,
        childSessionKey: params.childSessionKey,
        parentFlowId: params.parentFlowId,
        runId: params.runId,
        label: params.label,
        task: params.task,
    });
    if (existing) {
        return mergeExistingTaskForCreate(existing, params);
    }
    const now = Date.now();
    const taskId = crypto.randomUUID();
    const status = normalizeTaskStatus(params.status);
    const deliveryStatus = params.deliveryStatus ??
        ensureDeliveryStatus({
            ownerKey,
            scopeKind,
        });
    const notifyPolicy = ensureNotifyPolicy({
        notifyPolicy: params.notifyPolicy,
        deliveryStatus,
        ownerKey,
        scopeKind,
    });
    const lastEventAt = params.lastEventAt ?? params.startedAt ?? now;
    const record = {
        taskId,
        runtime: params.runtime,
        taskKind: normalizeOptionalString(params.taskKind),
        sourceId: normalizeOptionalString(params.sourceId),
        requesterSessionKey,
        ownerKey,
        scopeKind,
        childSessionKey: params.childSessionKey,
        parentFlowId: normalizeOptionalString(params.parentFlowId),
        parentTaskId: normalizeOptionalString(params.parentTaskId),
        agentId: normalizeOptionalString(params.agentId),
        runId: normalizeOptionalString(params.runId),
        label: normalizeOptionalString(params.label),
        task: params.task,
        status,
        deliveryStatus,
        notifyPolicy,
        createdAt: now,
        startedAt: params.startedAt,
        lastEventAt,
        cleanupAfter: params.cleanupAfter,
        progressSummary: normalizeTaskSummary(params.progressSummary),
        terminalSummary: normalizeTaskSummary(params.terminalSummary),
        terminalOutcome: resolveTaskTerminalOutcome({
            status,
            terminalOutcome: params.terminalOutcome,
        }),
    };
    if (isTerminalTaskStatus(record.status) && typeof record.cleanupAfter !== "number") {
        record.cleanupAfter =
            (record.endedAt ?? record.lastEventAt ?? record.createdAt) + DEFAULT_TASK_RETENTION_MS;
    }
    tasks.set(taskId, record);
    upsertTaskDeliveryState({
        taskId,
        requesterOrigin: normalizeDeliveryContext(params.requesterOrigin),
    });
    addRunIdIndex(taskId, record.runId);
    addOwnerKeyIndex(taskId, record);
    addParentFlowIdIndex(taskId, record);
    addRelatedSessionKeyIndex(taskId, record);
    persistTaskUpsert(record);
    try {
        syncFlowFromTask(record);
    }
    catch (error) {
        log.warn("Failed to sync parent flow from task create", {
            taskId: record.taskId,
            flowId: record.parentFlowId,
            error,
        });
    }
    emitTaskRegistryObserverEvent(() => ({
        kind: "upserted",
        task: cloneTaskRecord(record),
    }));
    if (isTerminalTaskStatus(record.status)) {
        void maybeDeliverTaskTerminalUpdate(taskId);
    }
    return cloneTaskRecord(record);
}
function updateTaskStateByRunId(params) {
    ensureTaskRegistryReady();
    const matches = getTasksByRunScope(params);
    if (matches.length === 0) {
        return [];
    }
    const updated = [];
    for (const current of matches) {
        const patch = {};
        const nextStatus = params.status ? normalizeTaskStatus(params.status) : current.status;
        const eventAt = params.lastEventAt ?? params.endedAt ?? Date.now();
        if (params.status) {
            patch.status = normalizeTaskStatus(params.status);
        }
        if (params.startedAt != null) {
            patch.startedAt = params.startedAt;
        }
        if (params.endedAt != null) {
            patch.endedAt = params.endedAt;
        }
        if (params.lastEventAt != null) {
            patch.lastEventAt = params.lastEventAt;
        }
        if (params.error !== undefined) {
            patch.error = params.error;
        }
        if (params.progressSummary !== undefined) {
            patch.progressSummary = normalizeTaskSummary(params.progressSummary);
        }
        if (params.terminalSummary !== undefined) {
            patch.terminalSummary = normalizeTaskSummary(params.terminalSummary);
        }
        if (params.terminalOutcome !== undefined) {
            patch.terminalOutcome = resolveTaskTerminalOutcome({
                status: nextStatus,
                terminalOutcome: params.terminalOutcome,
            });
        }
        const eventSummary = normalizeTaskSummary(params.eventSummary) ??
            (nextStatus === "failed"
                ? normalizeTaskSummary(params.error ?? current.error)
                : nextStatus === "succeeded"
                    ? normalizeTaskSummary(params.terminalSummary ?? current.terminalSummary)
                    : undefined);
        const shouldAppendEvent = (params.status && params.status !== current.status) ||
            Boolean(normalizeTaskSummary(params.eventSummary));
        const nextEvent = shouldAppendEvent
            ? appendTaskEvent({
                at: eventAt,
                kind: params.status && normalizeTaskStatus(params.status) !== current.status
                    ? normalizeTaskStatus(params.status)
                    : "progress",
                summary: eventSummary,
            })
            : undefined;
        const task = updateTask(current.taskId, patch);
        if (task) {
            updated.push(task);
            void maybeDeliverTaskStateChangeUpdate(task.taskId, nextEvent);
            void maybeDeliverTaskTerminalUpdate(task.taskId);
        }
    }
    return updated;
}
function updateTaskDeliveryByRunId(params) {
    ensureTaskRegistryReady();
    return updateTasksByRunId({
        runId: params.runId,
        runtime: params.runtime,
        sessionKey: params.sessionKey,
        patch: {
            deliveryStatus: params.deliveryStatus,
        },
    });
}
export function markTaskRunningByRunId(params) {
    return updateTaskStateByRunId({
        runId: params.runId,
        runtime: params.runtime,
        sessionKey: params.sessionKey,
        status: "running",
        startedAt: params.startedAt,
        lastEventAt: params.lastEventAt,
        progressSummary: params.progressSummary,
        eventSummary: params.eventSummary,
    });
}
export function recordTaskProgressByRunId(params) {
    return updateTaskStateByRunId({
        runId: params.runId,
        runtime: params.runtime,
        sessionKey: params.sessionKey,
        lastEventAt: params.lastEventAt,
        progressSummary: params.progressSummary,
        eventSummary: params.eventSummary,
    });
}
export function markTaskTerminalByRunId(params) {
    return updateTaskStateByRunId({
        runId: params.runId,
        runtime: params.runtime,
        sessionKey: params.sessionKey,
        status: params.status,
        startedAt: params.startedAt,
        endedAt: params.endedAt,
        lastEventAt: params.lastEventAt,
        error: params.error,
        progressSummary: params.progressSummary,
        terminalSummary: params.terminalSummary,
        terminalOutcome: params.terminalOutcome,
    });
}
export function setTaskRunDeliveryStatusByRunId(params) {
    return updateTaskDeliveryByRunId(params);
}
export function updateTaskNotifyPolicyById(params) {
    ensureTaskRegistryReady();
    return updateTask(params.taskId, {
        notifyPolicy: params.notifyPolicy,
        lastEventAt: Date.now(),
    });
}
export function linkTaskToFlowById(params) {
    ensureTaskRegistryReady();
    const flowId = params.flowId.trim();
    if (!flowId) {
        return null;
    }
    const current = tasks.get(params.taskId);
    if (!current) {
        return null;
    }
    if (current.parentFlowId?.trim()) {
        return cloneTaskRecord(current);
    }
    assertParentFlowLinkAllowed({
        ownerKey: current.ownerKey,
        scopeKind: current.scopeKind,
        parentFlowId: flowId,
    });
    return updateTask(params.taskId, {
        parentFlowId: flowId,
    });
}
export async function cancelTaskById(params) {
    ensureTaskRegistryReady();
    const task = tasks.get(params.taskId.trim());
    if (!task) {
        return { found: false, cancelled: false, reason: "Task not found." };
    }
    if (task.status === "succeeded" ||
        task.status === "failed" ||
        task.status === "timed_out" ||
        task.status === "lost" ||
        task.status === "cancelled") {
        return {
            found: true,
            cancelled: false,
            reason: "Task is already terminal.",
            task: cloneTaskRecord(task),
        };
    }
    const childSessionKey = task.childSessionKey?.trim();
    try {
        if (task.runtime !== "cli") {
            if (!childSessionKey) {
                return {
                    found: true,
                    cancelled: false,
                    reason: "Task has no cancellable child session.",
                    task: cloneTaskRecord(task),
                };
            }
            if (task.runtime === "acp") {
                const { getAcpSessionManager } = await loadTaskRegistryControlRuntime();
                await getAcpSessionManager().cancelSession({
                    cfg: params.cfg,
                    sessionKey: childSessionKey,
                    reason: "task-cancel",
                });
            }
            else if (task.runtime === "subagent") {
                const { killSubagentRunAdmin } = await loadTaskRegistryControlRuntime();
                const result = await killSubagentRunAdmin({
                    cfg: params.cfg,
                    sessionKey: childSessionKey,
                });
                if (!result.found || !result.killed) {
                    return {
                        found: true,
                        cancelled: false,
                        reason: result.found ? "Subagent was not running." : "Subagent task not found.",
                        task: cloneTaskRecord(task),
                    };
                }
            }
            else {
                return {
                    found: true,
                    cancelled: false,
                    reason: "Task runtime does not support cancellation yet.",
                    task: cloneTaskRecord(task),
                };
            }
        }
        const updated = updateTask(task.taskId, {
            status: "cancelled",
            endedAt: Date.now(),
            lastEventAt: Date.now(),
            error: "Cancelled by operator.",
        });
        if (updated) {
            void maybeDeliverTaskTerminalUpdate(updated.taskId);
        }
        return {
            found: true,
            cancelled: true,
            task: updated ?? cloneTaskRecord(task),
        };
    }
    catch (error) {
        return {
            found: true,
            cancelled: false,
            reason: formatErrorMessage(error),
            task: cloneTaskRecord(task),
        };
    }
}
export function listTaskRecords() {
    ensureTaskRegistryReady();
    return [...tasks.values()]
        .map((task, insertionIndex) => Object.assign({}, cloneTaskRecord(task), { insertionIndex }))
        .toSorted(compareTasksNewestFirst)
        .map(({ insertionIndex: _, ...task }) => task);
}
export function getTaskRegistrySummary() {
    ensureTaskRegistryReady();
    return summarizeTaskRecords(tasks.values());
}
export function getTaskRegistrySnapshot() {
    return {
        tasks: listTaskRecords(),
        deliveryStates: [...taskDeliveryStates.values()].map((state) => cloneTaskDeliveryState(state)),
    };
}
export function getTaskById(taskId) {
    ensureTaskRegistryReady();
    const task = tasks.get(taskId.trim());
    return task ? cloneTaskRecord(task) : undefined;
}
export function findTaskByRunId(runId) {
    ensureTaskRegistryReady();
    const task = pickPreferredRunIdTask(getTasksByRunId(runId));
    return task ? cloneTaskRecord(task) : undefined;
}
function listTasksFromIndex(index, key) {
    const ids = index.get(key);
    if (!ids || ids.size === 0) {
        return [];
    }
    return [...ids]
        .map((taskId, insertionIndex) => {
        const task = tasks.get(taskId);
        return task ? Object.assign({}, cloneTaskRecord(task), { insertionIndex }) : null;
    })
        .filter((task) => Boolean(task))
        .toSorted(compareTasksNewestFirst)
        .map(({ insertionIndex: _, ...task }) => task);
}
export function findLatestTaskForSessionKey(sessionKey) {
    const task = listTasksForSessionKey(sessionKey)[0];
    return task ? cloneTaskRecord(task) : undefined;
}
export function listTasksForSessionKey(sessionKey) {
    ensureTaskRegistryReady();
    const key = normalizeOptionalString(sessionKey);
    if (!key) {
        return [];
    }
    return listTasksFromIndex(taskIdsByRelatedSessionKey, key);
}
export function listTasksForAgentId(agentId) {
    ensureTaskRegistryReady();
    const lookup = agentId.trim();
    if (!lookup) {
        return [];
    }
    return snapshotTaskRecords(tasks)
        .filter((task) => task.agentId?.trim() === lookup)
        .toSorted(compareTasksNewestFirst);
}
export function findLatestTaskForOwnerKey(ownerKey) {
    const task = listTasksForOwnerKey(ownerKey)[0];
    return task ? cloneTaskRecord(task) : undefined;
}
export function findLatestTaskForFlowId(flowId) {
    const task = listTasksForFlowId(flowId)[0];
    return task ? cloneTaskRecord(task) : undefined;
}
export function listTasksForOwnerKey(ownerKey) {
    ensureTaskRegistryReady();
    const key = normalizeOptionalString(ownerKey);
    if (!key) {
        return [];
    }
    return listTasksFromIndex(taskIdsByOwnerKey, key);
}
export function listTasksForFlowId(flowId) {
    ensureTaskRegistryReady();
    const key = flowId.trim();
    if (!key) {
        return [];
    }
    return listTasksFromIndex(taskIdsByParentFlowId, key);
}
export function findLatestTaskForRelatedSessionKey(sessionKey) {
    const task = listTasksForRelatedSessionKey(sessionKey)[0];
    return task ? cloneTaskRecord(task) : undefined;
}
export function listTasksForRelatedSessionKey(sessionKey) {
    ensureTaskRegistryReady();
    const key = normalizeOptionalString(sessionKey);
    if (!key) {
        return [];
    }
    return listTasksFromIndex(taskIdsByRelatedSessionKey, key);
}
export function resolveTaskForLookupToken(token) {
    const lookup = token.trim();
    if (!lookup) {
        return undefined;
    }
    return (getTaskById(lookup) ?? findTaskByRunId(lookup) ?? findLatestTaskForRelatedSessionKey(lookup));
}
export function deleteTaskRecordById(taskId) {
    ensureTaskRegistryReady();
    const current = tasks.get(taskId);
    if (!current) {
        return false;
    }
    deleteOwnerKeyIndex(taskId, current);
    deleteParentFlowIdIndex(taskId, current);
    deleteRelatedSessionKeyIndex(taskId, current);
    tasks.delete(taskId);
    taskDeliveryStates.delete(taskId);
    rebuildRunIdIndex();
    persistTaskDelete(taskId);
    persistTaskDeliveryStateDelete(taskId);
    emitTaskRegistryObserverEvent(() => ({
        kind: "deleted",
        taskId: current.taskId,
        previous: cloneTaskRecord(current),
    }));
    return true;
}
export function resetTaskRegistryForTests(opts) {
    tasks.clear();
    taskDeliveryStates.clear();
    taskIdsByRunId.clear();
    taskIdsByOwnerKey.clear();
    taskIdsByParentFlowId.clear();
    taskIdsByRelatedSessionKey.clear();
    tasksWithPendingDelivery.clear();
    restoreAttempted = false;
    resetTaskRegistryRuntimeForTests();
    if (listenerStop) {
        listenerStop();
        listenerStop = null;
    }
    listenerStarted = false;
    deliveryRuntimePromise = null;
    controlRuntimePromise = null;
    if (opts?.persist !== false) {
        persistTaskRegistry();
    }
    // Always close the sqlite handle so Windows temp-dir cleanup can remove the
    // state directory even when a test intentionally skips persisting the reset.
    getTaskRegistryStore().close?.();
}
export function resetTaskRegistryDeliveryRuntimeForTests() {
    globalThis[TASK_REGISTRY_DELIVERY_RUNTIME_OVERRIDE_KEY] = null;
    deliveryRuntimePromise = null;
}
export function setTaskRegistryDeliveryRuntimeForTests(runtime) {
    globalThis[TASK_REGISTRY_DELIVERY_RUNTIME_OVERRIDE_KEY] = runtime;
    deliveryRuntimePromise = null;
}
export function resetTaskRegistryControlRuntimeForTests() {
    globalThis[TASK_REGISTRY_CONTROL_RUNTIME_OVERRIDE_KEY] = null;
    controlRuntimePromise = null;
}
export function setTaskRegistryControlRuntimeForTests(runtime) {
    globalThis[TASK_REGISTRY_CONTROL_RUNTIME_OVERRIDE_KEY] = runtime;
    controlRuntimePromise = null;
}
