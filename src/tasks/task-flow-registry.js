import crypto from "node:crypto";
import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { getTaskFlowRegistryObservers, getTaskFlowRegistryStore, resetTaskFlowRegistryRuntimeForTests, } from "./task-flow-registry.store.js";
const log = createSubsystemLogger("tasks/task-flow-registry");
const flows = new Map();
let restoreAttempted = false;
let restoreFailureMessage = null;
function cloneStructuredValue(value) {
    if (value === undefined) {
        return undefined;
    }
    return structuredClone(value);
}
function cloneFlowRecord(record) {
    return {
        ...record,
        ...(record.requesterOrigin
            ? { requesterOrigin: cloneStructuredValue(record.requesterOrigin) }
            : {}),
        ...(record.stateJson !== undefined
            ? { stateJson: cloneStructuredValue(record.stateJson) }
            : {}),
        ...(record.waitJson !== undefined ? { waitJson: cloneStructuredValue(record.waitJson) } : {}),
    };
}
function normalizeRestoredFlowRecord(record) {
    const syncMode = record.syncMode === "task_mirrored" ? "task_mirrored" : "managed";
    const controllerId = syncMode === "managed"
        ? (normalizeOptionalString(record.controllerId) ?? "core/legacy-restored")
        : undefined;
    return {
        ...record,
        syncMode,
        ownerKey: assertFlowOwnerKey(record.ownerKey),
        ...(record.requesterOrigin
            ? { requesterOrigin: cloneStructuredValue(record.requesterOrigin) }
            : {}),
        ...(controllerId ? { controllerId } : {}),
        currentStep: normalizeOptionalString(record.currentStep),
        blockedTaskId: normalizeOptionalString(record.blockedTaskId),
        blockedSummary: normalizeOptionalString(record.blockedSummary),
        ...(record.stateJson !== undefined
            ? { stateJson: cloneStructuredValue(record.stateJson) }
            : {}),
        ...(record.waitJson !== undefined ? { waitJson: cloneStructuredValue(record.waitJson) } : {}),
        revision: Math.max(0, record.revision),
        cancelRequestedAt: record.cancelRequestedAt ?? undefined,
        endedAt: record.endedAt ?? undefined,
    };
}
function snapshotFlowRecords(source) {
    return [...source.values()].map((record) => cloneFlowRecord(record));
}
function emitFlowRegistryObserverEvent(createEvent) {
    const observers = getTaskFlowRegistryObservers();
    if (!observers?.onEvent) {
        return;
    }
    try {
        observers.onEvent(createEvent());
    }
    catch {
        // Flow observers are best-effort only. They must not break registry writes.
    }
}
function ensureNotifyPolicy(notifyPolicy) {
    return notifyPolicy ?? "done_only";
}
function normalizeJsonBlob(value) {
    return value === undefined ? undefined : cloneStructuredValue(value);
}
function assertFlowOwnerKey(ownerKey) {
    const normalized = normalizeOptionalString(ownerKey);
    if (!normalized) {
        throw new Error("Flow ownerKey is required.");
    }
    return normalized;
}
function assertControllerId(controllerId) {
    const normalized = normalizeOptionalString(controllerId);
    if (!normalized) {
        throw new Error("Managed flow controllerId is required.");
    }
    return normalized;
}
function resolveFlowBlockedSummary(task) {
    if (task.status !== "succeeded" || task.terminalOutcome !== "blocked") {
        return undefined;
    }
    return (normalizeOptionalString(task.terminalSummary) ?? normalizeOptionalString(task.progressSummary));
}
export function deriveTaskFlowStatusFromTask(task) {
    if (task.status === "queued") {
        return "queued";
    }
    if (task.status === "running") {
        return "running";
    }
    if (task.status === "succeeded") {
        return task.terminalOutcome === "blocked" ? "blocked" : "succeeded";
    }
    if (task.status === "cancelled") {
        return "cancelled";
    }
    if (task.status === "lost") {
        return "lost";
    }
    return "failed";
}
function ensureFlowRegistryReady() {
    if (restoreAttempted) {
        return;
    }
    restoreAttempted = true;
    try {
        const restored = getTaskFlowRegistryStore().loadSnapshot();
        flows.clear();
        for (const [flowId, flow] of restored.flows) {
            flows.set(flowId, normalizeRestoredFlowRecord(flow));
        }
        restoreFailureMessage = null;
    }
    catch (error) {
        flows.clear();
        restoreFailureMessage = formatErrorMessage(error);
        log.warn("Failed to restore task-flow registry", { error });
        return;
    }
    emitFlowRegistryObserverEvent(() => ({
        kind: "restored",
        flows: snapshotFlowRecords(flows),
    }));
}
export function getTaskFlowRegistryRestoreFailure() {
    ensureFlowRegistryReady();
    return restoreFailureMessage;
}
function persistFlowRegistry() {
    getTaskFlowRegistryStore().saveSnapshot({
        flows: new Map(snapshotFlowRecords(flows).map((flow) => [flow.flowId, flow])),
    });
}
function persistFlowUpsert(flow) {
    const store = getTaskFlowRegistryStore();
    if (store.upsertFlow) {
        store.upsertFlow(cloneFlowRecord(flow));
        return;
    }
    persistFlowRegistry();
}
function persistFlowDelete(flowId) {
    const store = getTaskFlowRegistryStore();
    if (store.deleteFlow) {
        store.deleteFlow(flowId);
        return;
    }
    persistFlowRegistry();
}
function buildFlowRecord(params) {
    const now = params.createdAt ?? Date.now();
    const syncMode = params.syncMode ?? "managed";
    const controllerId = syncMode === "managed" ? assertControllerId(params.controllerId) : undefined;
    return {
        flowId: crypto.randomUUID(),
        syncMode,
        ownerKey: assertFlowOwnerKey(params.ownerKey),
        ...(params.requesterOrigin
            ? { requesterOrigin: cloneStructuredValue(params.requesterOrigin) }
            : {}),
        ...(controllerId ? { controllerId } : {}),
        revision: Math.max(0, params.revision ?? 0),
        status: params.status ?? "queued",
        notifyPolicy: ensureNotifyPolicy(params.notifyPolicy),
        goal: params.goal,
        currentStep: normalizeOptionalString(params.currentStep),
        blockedTaskId: normalizeOptionalString(params.blockedTaskId),
        blockedSummary: normalizeOptionalString(params.blockedSummary),
        ...(normalizeJsonBlob(params.stateJson) !== undefined
            ? { stateJson: normalizeJsonBlob(params.stateJson) }
            : {}),
        ...(normalizeJsonBlob(params.waitJson) !== undefined
            ? { waitJson: normalizeJsonBlob(params.waitJson) }
            : {}),
        ...(params.cancelRequestedAt != null ? { cancelRequestedAt: params.cancelRequestedAt } : {}),
        createdAt: now,
        updatedAt: params.updatedAt ?? now,
        ...(params.endedAt != null ? { endedAt: params.endedAt } : {}),
    };
}
function applyFlowPatch(current, patch) {
    const controllerId = patch.controllerId === undefined
        ? current.controllerId
        : normalizeOptionalString(patch.controllerId);
    if (current.syncMode === "managed") {
        assertControllerId(controllerId);
    }
    return {
        ...current,
        ...(patch.status ? { status: patch.status } : {}),
        ...(patch.notifyPolicy ? { notifyPolicy: patch.notifyPolicy } : {}),
        ...(patch.goal ? { goal: patch.goal } : {}),
        controllerId,
        currentStep: patch.currentStep === undefined
            ? current.currentStep
            : normalizeOptionalString(patch.currentStep),
        blockedTaskId: patch.blockedTaskId === undefined
            ? current.blockedTaskId
            : normalizeOptionalString(patch.blockedTaskId),
        blockedSummary: patch.blockedSummary === undefined
            ? current.blockedSummary
            : normalizeOptionalString(patch.blockedSummary),
        stateJson: patch.stateJson === undefined ? current.stateJson : normalizeJsonBlob(patch.stateJson),
        waitJson: patch.waitJson === undefined ? current.waitJson : normalizeJsonBlob(patch.waitJson),
        cancelRequestedAt: patch.cancelRequestedAt === undefined
            ? current.cancelRequestedAt
            : (patch.cancelRequestedAt ?? undefined),
        revision: current.revision + 1,
        updatedAt: patch.updatedAt ?? Date.now(),
        endedAt: patch.endedAt === undefined ? current.endedAt : (patch.endedAt ?? undefined),
    };
}
function writeFlowRecord(next, previous) {
    flows.set(next.flowId, next);
    persistFlowUpsert(next);
    emitFlowRegistryObserverEvent(() => ({
        kind: "upserted",
        flow: cloneFlowRecord(next),
        ...(previous ? { previous: cloneFlowRecord(previous) } : {}),
    }));
    return cloneFlowRecord(next);
}
export function createFlowRecord(params) {
    ensureFlowRegistryReady();
    const record = buildFlowRecord(params);
    return writeFlowRecord(record);
}
export function createManagedTaskFlow(params) {
    return createFlowRecord({
        ...params,
        syncMode: "managed",
        controllerId: assertControllerId(params.controllerId),
    });
}
export function createTaskFlowForTask(params) {
    const terminalFlowStatus = deriveTaskFlowStatusFromTask(params.task);
    const isTerminal = terminalFlowStatus === "succeeded" ||
        terminalFlowStatus === "blocked" ||
        terminalFlowStatus === "failed" ||
        terminalFlowStatus === "cancelled" ||
        terminalFlowStatus === "lost";
    const endedAt = isTerminal
        ? (params.task.endedAt ?? params.task.lastEventAt ?? params.task.createdAt)
        : undefined;
    return createFlowRecord({
        syncMode: "task_mirrored",
        ownerKey: params.task.ownerKey,
        requesterOrigin: params.requesterOrigin,
        status: terminalFlowStatus,
        notifyPolicy: params.task.notifyPolicy,
        goal: normalizeOptionalString(params.task.label) ?? (params.task.task.trim() || "Background task"),
        blockedTaskId: terminalFlowStatus === "blocked" ? normalizeOptionalString(params.task.taskId) : undefined,
        blockedSummary: resolveFlowBlockedSummary(params.task),
        createdAt: params.task.createdAt,
        updatedAt: params.task.lastEventAt ?? params.task.createdAt,
        ...(endedAt !== undefined ? { endedAt } : {}),
    });
}
function updateFlowRecordByIdUnchecked(flowId, patch) {
    ensureFlowRegistryReady();
    const current = flows.get(flowId);
    if (!current) {
        return null;
    }
    return writeFlowRecord(applyFlowPatch(current, patch), current);
}
export function updateFlowRecordByIdExpectedRevision(params) {
    ensureFlowRegistryReady();
    const current = flows.get(params.flowId);
    if (!current) {
        return {
            applied: false,
            reason: "not_found",
        };
    }
    if (current.revision !== params.expectedRevision) {
        return {
            applied: false,
            reason: "revision_conflict",
            current: cloneFlowRecord(current),
        };
    }
    return {
        applied: true,
        flow: writeFlowRecord(applyFlowPatch(current, params.patch), current),
    };
}
export function setFlowWaiting(params) {
    return updateFlowRecordByIdExpectedRevision({
        flowId: params.flowId,
        expectedRevision: params.expectedRevision,
        patch: {
            status: normalizeOptionalString(params.blockedTaskId) ||
                normalizeOptionalString(params.blockedSummary)
                ? "blocked"
                : "waiting",
            currentStep: params.currentStep,
            stateJson: params.stateJson,
            waitJson: params.waitJson,
            blockedTaskId: params.blockedTaskId,
            blockedSummary: params.blockedSummary,
            endedAt: null,
            updatedAt: params.updatedAt,
        },
    });
}
export function resumeFlow(params) {
    return updateFlowRecordByIdExpectedRevision({
        flowId: params.flowId,
        expectedRevision: params.expectedRevision,
        patch: {
            status: params.status ?? "queued",
            currentStep: params.currentStep,
            stateJson: params.stateJson,
            waitJson: null,
            blockedTaskId: null,
            blockedSummary: null,
            endedAt: null,
            updatedAt: params.updatedAt,
        },
    });
}
export function finishFlow(params) {
    const endedAt = params.endedAt ?? params.updatedAt ?? Date.now();
    return updateFlowRecordByIdExpectedRevision({
        flowId: params.flowId,
        expectedRevision: params.expectedRevision,
        patch: {
            status: "succeeded",
            currentStep: params.currentStep,
            stateJson: params.stateJson,
            waitJson: null,
            blockedTaskId: null,
            blockedSummary: null,
            endedAt,
            updatedAt: params.updatedAt ?? endedAt,
        },
    });
}
export function failFlow(params) {
    const endedAt = params.endedAt ?? params.updatedAt ?? Date.now();
    return updateFlowRecordByIdExpectedRevision({
        flowId: params.flowId,
        expectedRevision: params.expectedRevision,
        patch: {
            status: "failed",
            currentStep: params.currentStep,
            stateJson: params.stateJson,
            waitJson: null,
            blockedTaskId: params.blockedTaskId,
            blockedSummary: params.blockedSummary,
            endedAt,
            updatedAt: params.updatedAt ?? endedAt,
        },
    });
}
export function requestFlowCancel(params) {
    return updateFlowRecordByIdExpectedRevision({
        flowId: params.flowId,
        expectedRevision: params.expectedRevision,
        patch: {
            cancelRequestedAt: params.cancelRequestedAt ?? params.updatedAt ?? Date.now(),
            updatedAt: params.updatedAt,
        },
    });
}
export function syncFlowFromTask(task) {
    const flowId = task.parentFlowId?.trim();
    if (!flowId) {
        return null;
    }
    const flow = getTaskFlowById(flowId);
    if (!flow) {
        return null;
    }
    if (flow.syncMode !== "task_mirrored") {
        return flow;
    }
    const terminalFlowStatus = deriveTaskFlowStatusFromTask(task);
    const isTerminal = terminalFlowStatus === "succeeded" ||
        terminalFlowStatus === "blocked" ||
        terminalFlowStatus === "failed" ||
        terminalFlowStatus === "cancelled" ||
        terminalFlowStatus === "lost";
    return updateFlowRecordByIdUnchecked(flowId, {
        status: terminalFlowStatus,
        notifyPolicy: task.notifyPolicy,
        goal: normalizeOptionalString(task.label) ?? (task.task.trim() || "Background task"),
        blockedTaskId: terminalFlowStatus === "blocked" ? task.taskId.trim() || null : null,
        blockedSummary: terminalFlowStatus === "blocked" ? (resolveFlowBlockedSummary(task) ?? null) : null,
        waitJson: null,
        updatedAt: task.lastEventAt ?? Date.now(),
        ...(isTerminal
            ? {
                endedAt: task.endedAt ?? task.lastEventAt ?? Date.now(),
            }
            : { endedAt: null }),
    });
}
export function getTaskFlowById(flowId) {
    ensureFlowRegistryReady();
    const flow = flows.get(flowId);
    return flow ? cloneFlowRecord(flow) : undefined;
}
export function listTaskFlowsForOwnerKey(ownerKey) {
    ensureFlowRegistryReady();
    const normalizedOwnerKey = ownerKey.trim();
    if (!normalizedOwnerKey) {
        return [];
    }
    return [...flows.values()]
        .filter((flow) => flow.ownerKey.trim() === normalizedOwnerKey)
        .map((flow) => cloneFlowRecord(flow))
        .toSorted((left, right) => right.createdAt - left.createdAt);
}
export function findLatestTaskFlowForOwnerKey(ownerKey) {
    const flow = listTaskFlowsForOwnerKey(ownerKey)[0];
    return flow ? cloneFlowRecord(flow) : undefined;
}
export function resolveTaskFlowForLookupToken(token) {
    const lookup = token.trim();
    if (!lookup) {
        return undefined;
    }
    return getTaskFlowById(lookup) ?? findLatestTaskFlowForOwnerKey(lookup);
}
export function listTaskFlowRecords() {
    ensureFlowRegistryReady();
    return [...flows.values()]
        .map((flow) => cloneFlowRecord(flow))
        .toSorted((left, right) => right.createdAt - left.createdAt);
}
export function deleteTaskFlowRecordById(flowId) {
    ensureFlowRegistryReady();
    const current = flows.get(flowId);
    if (!current) {
        return false;
    }
    flows.delete(flowId);
    persistFlowDelete(flowId);
    emitFlowRegistryObserverEvent(() => ({
        kind: "deleted",
        flowId,
        previous: cloneFlowRecord(current),
    }));
    return true;
}
export function resetTaskFlowRegistryForTests(opts) {
    flows.clear();
    restoreAttempted = false;
    restoreFailureMessage = null;
    resetTaskFlowRegistryRuntimeForTests();
    if (opts?.persist !== false) {
        persistFlowRegistry();
    }
    getTaskFlowRegistryStore().close?.();
}
