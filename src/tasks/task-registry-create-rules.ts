import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { readTaskBackingInstance } from "./task-backing-records.js";
import { ensureNotifyPolicy } from "./task-registry-common.js";
import { compareTasksForRunIdLookup } from "./task-registry-records.js";
import type {
  JsonValue,
  TaskDeliveryState,
  TaskDeliveryStatus,
  TaskNotifyPolicy,
  TaskRecord,
  TaskRuntime,
  TaskScopeKind,
} from "./task-registry.types.js";

export function selectExistingTaskForCreate(params: {
  runtime: TaskRuntime;
  ownerKey: string;
  scopeKind: TaskScopeKind;
  childSessionKey?: string;
  parentFlowId?: string;
  runId?: string;
  label?: string;
  task: string;
  detail?: JsonValue;
  candidates: readonly TaskRecord[];
  isTaskMirroredFlow: (flowId: string) => boolean;
}): TaskRecord | undefined {
  const runId = params.runId?.trim();
  const requestedBacking =
    params.runtime === "acp" ? readTaskBackingInstance(params.detail) : undefined;
  const runScopeMatches = runId
    ? params.candidates.filter((task) => {
        if (
          task.runId?.trim() !== runId ||
          task.runtime !== params.runtime ||
          task.scopeKind !== params.scopeKind ||
          (normalizeOptionalString(task.ownerKey) ?? "") !==
            (normalizeOptionalString(params.ownerKey) ?? "") ||
          (normalizeOptionalString(task.childSessionKey) ?? "") !==
            (normalizeOptionalString(params.childSessionKey) ?? "")
        ) {
          return false;
        }
        if (requestedBacking?.runtime === "acp") {
          const backing = readTaskBackingInstance(task.detail);
          if (backing?.runtime !== "acp" || backing.instanceId !== requestedBacking.instanceId) {
            return false;
          }
        }
        if (params.runtime === "acp" && !params.parentFlowId?.trim()) {
          const existingFlowId = task.parentFlowId?.trim();
          return !existingFlowId || params.isTaskMirroredFlow(existingFlowId);
        }
        return (
          (normalizeOptionalString(task.parentFlowId) ?? "") ===
          (normalizeOptionalString(params.parentFlowId) ?? "")
        );
      })
    : [];
  const exact = runId
    ? runScopeMatches.find(
        (task) =>
          (normalizeOptionalString(task.label) ?? "") ===
            (normalizeOptionalString(params.label) ?? "") &&
          (normalizeOptionalString(task.task) ?? "") ===
            (normalizeOptionalString(params.task) ?? ""),
      )
    : undefined;
  if (exact) {
    return exact;
  }
  if (!runId || params.runtime !== "acp") {
    return undefined;
  }
  return runScopeMatches.toSorted(compareTasksForRunIdLookup)[0];
}

export type TaskCreateMergeParams = {
  taskKind?: string;
  requesterOrigin?: TaskDeliveryState["requesterOrigin"];
  sourceId?: string;
  parentFlowId?: string;
  parentTaskId?: string;
  agentId?: string;
  requesterAgentId?: string;
  label?: string;
  task: string;
  preferMetadata?: boolean;
  deliveryStatus?: TaskDeliveryStatus;
  notifyPolicy?: TaskNotifyPolicy;
  detail?: JsonValue;
};

export function buildTaskCreateMergePatch(
  existing: TaskRecord,
  params: TaskCreateMergeParams,
): Partial<TaskRecord> {
  const patch: Partial<TaskRecord> = {};
  for (const key of [
    "sourceId",
    "taskKind",
    "parentFlowId",
    "parentTaskId",
    "agentId",
    "requesterAgentId",
  ] as const) {
    const value = params[key]?.trim();
    if (value && !existing[key]?.trim()) {
      patch[key] = value;
    }
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
  } else if (nextLabel && !existing.label?.trim()) {
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
  if (params.detail !== undefined) {
    const currentBacking = readTaskBackingInstance(existing.detail);
    const nextBacking = readTaskBackingInstance(params.detail);
    if (
      currentBacking?.runtime !== "acp" ||
      nextBacking?.runtime !== "acp" ||
      currentBacking.instanceId !== nextBacking.instanceId ||
      nextBacking.generation >= currentBacking.generation
    ) {
      patch.detail = params.detail;
    }
  }
  return patch;
}
