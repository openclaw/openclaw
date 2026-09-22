import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  createAcpTaskBackingDetail,
  createManagedTaskBackingDetail,
  readManagedTaskBacking,
  readTaskBackingInstance,
  sameTaskBackingInstance,
  selectCurrentCanonicalTaskBacking,
  type TaskBackingInstance,
} from "./task-backing-records.js";
import { getTaskFlowById, getTaskMirroredFlowIds } from "./task-flow-runtime-internal.js";
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

function resolveCurrentCanonicalBacking(
  params: Omit<
    Parameters<typeof selectCurrentCanonicalTaskBacking>[0],
    "candidates" | "isTaskMirroredFlow"
  >,
) {
  ensureTaskRegistryReady();
  const candidates = [...(taskIdsByRelatedSessionKey.get(params.childSessionKey) ?? [])].flatMap(
    (taskId) => {
      const task = tasks.get(taskId);
      return task ? [task] : [];
    },
  );
  let mirroredFlowIds: ReadonlySet<string> | undefined;
  return selectCurrentCanonicalTaskBacking({
    ...params,
    candidates,
    isTaskMirroredFlow: (flowId) => {
      mirroredFlowIds ??= getTaskMirroredFlowIds(
        candidates.flatMap((task) => (task.parentFlowId ? [task.parentFlowId.trim()] : [])),
      );
      return mirroredFlowIds.has(flowId);
    },
  });
}

export function createNextAcpTaskBackingDetail(params: {
  childSessionKey: string;
  instanceId: string;
}): JsonValue {
  ensureTaskRegistryReady();
  const candidateIds = taskIdsByRelatedSessionKey.get(params.childSessionKey) ?? [];
  let mirroredFlowIds: ReadonlySet<string> | undefined;
  const isCanonicalBackingTask = (task: TaskRecord): boolean => {
    const firstFlowId = task.parentFlowId?.trim();
    if (!firstFlowId) {
      return false;
    }
    mirroredFlowIds ??= getTaskMirroredFlowIds(
      (function* () {
        // Restore observers can remove the selected task or append to this live index.
        yield firstFlowId;
        for (const taskId of candidateIds) {
          const flowId = tasks.get(taskId)?.parentFlowId?.trim();
          if (flowId) {
            yield flowId;
          }
        }
      })(),
    );
    return mirroredFlowIds.has(firstFlowId);
  };
  // ACP serializes turns per child session. Persisting the next generation here
  // keeps same-run-id replacements distinguishable after restart.
  let generation = 0;
  let existingGeneration: number | undefined;
  for (const taskId of candidateIds) {
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
      if (instance.instanceId === params.instanceId) {
        existingGeneration = Math.max(existingGeneration ?? 0, instance.generation);
      }
    }
  }
  return createAcpTaskBackingDetail(params.instanceId, existingGeneration ?? generation + 1);
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
  if (task.runtime !== "acp" && task.runtime !== "subagent") {
    return true;
  }
  const flowId = task.parentFlowId?.trim();
  if (!flowId || getTaskFlowById(flowId)?.syncMode !== "managed") {
    return true;
  }
  const childSessionKey = task.childSessionKey?.trim();
  if (!childSessionKey) {
    return true;
  }
  const runId = task.runId?.trim();
  const managed = readManagedTaskBacking(task.detail);
  if (!runId || !managed) {
    return false;
  }
  const current = resolveCurrentCanonicalBacking({
    runtime: task.runtime,
    scopeKind: task.scopeKind,
    ownerKey: task.ownerKey,
    childSessionKey,
    runId,
  });
  return Boolean(
    current &&
    current.task.taskId === managed.taskId &&
    sameTaskBackingInstance(current.instance, managed.instance),
  );
}
