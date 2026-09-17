import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  createAcpTaskBackingDetail,
  createManagedTaskBackingDetail,
  readManagedTaskBacking,
  readTaskBackingInstance,
  hasAuthoritativeTaskBackingFromRecords,
  selectCurrentCanonicalTaskBacking,
  type TaskBackingInstance,
} from "./task-backing-records.js";
import { getTaskFlowById } from "./task-flow-runtime-internal.js";
import {
  ensureTaskRegistryReady,
  taskIdsByRelatedSessionKey,
  tasks,
} from "./task-registry-state.js";
import type { JsonValue, TaskRecord, TaskRuntime, TaskScopeKind } from "./task-registry.types.js";

export {
  readTaskBackingInstance,
  createSubagentTaskBackingDetail,
  type TaskBackingInstance,
} from "./task-backing-records.js";

function isCanonicalBackingTask(task: TaskRecord): boolean {
  const flowId = task.parentFlowId?.trim();
  return Boolean(flowId && getTaskFlowById(flowId)?.syncMode === "task_mirrored");
}

function resolveCurrentCanonicalBacking(
  params: Omit<
    Parameters<typeof selectCurrentCanonicalTaskBacking>[0],
    "candidates" | "isTaskMirroredFlow"
  >,
) {
  ensureTaskRegistryReady();
  return selectCurrentCanonicalTaskBacking({
    ...params,
    candidates: [...(taskIdsByRelatedSessionKey.get(params.childSessionKey) ?? [])].flatMap(
      (taskId) => {
        const task = tasks.get(taskId);
        return task ? [task] : [];
      },
    ),
    isTaskMirroredFlow: (flowId) => getTaskFlowById(flowId)?.syncMode === "task_mirrored",
  });
}

export function createNextAcpTaskBackingDetail(params: {
  childSessionKey: string;
  instanceId: string;
}): JsonValue {
  ensureTaskRegistryReady();
  // ACP serializes turns per child session. Persisting the next generation here
  // keeps same-run-id replacements distinguishable after restart.
  let generation = 0;
  for (const taskId of taskIdsByRelatedSessionKey.get(params.childSessionKey) ?? []) {
    const task = tasks.get(taskId);
    const instance = task ? readTaskBackingInstance(task.detail) : undefined;
    // Requester candidates serve list queries; generation history keeps its owner/child scope.
    if (
      task &&
      (normalizeOptionalString(task.ownerKey) === params.childSessionKey ||
        normalizeOptionalString(task.childSessionKey) === params.childSessionKey) &&
      instance?.runtime === "acp" &&
      isCanonicalBackingTask(task)
    ) {
      generation = Math.max(generation, instance.generation);
    }
  }
  return createAcpTaskBackingDetail(params.instanceId, generation + 1);
}

export function resolveManagedTaskBackingDetail(params: {
  runtime: TaskRuntime;
  scopeKind: TaskScopeKind;
  ownerKey: string;
  childSessionKey: string;
  runId: string;
}): JsonValue | undefined {
  const current = resolveCurrentCanonicalBacking(params);
  return createManagedTaskBackingDetail(current);
}

export function getManagedTaskBackingInstance(task: TaskRecord): TaskBackingInstance | undefined {
  const flowId = task.parentFlowId?.trim();
  return flowId && getTaskFlowById(flowId)?.syncMode === "managed"
    ? readManagedTaskBacking(task.detail)?.instance
    : undefined;
}

/** A managed projection may control a child only while its exact canonical instance is current. */
export function hasAuthoritativeTaskBacking(task: TaskRecord): boolean {
  return hasAuthoritativeTaskBackingFromRecords(task, {
    isManagedFlow: (flowId) => getTaskFlowById(flowId)?.syncMode === "managed",
    resolveCurrentCanonicalBacking,
  });
}
