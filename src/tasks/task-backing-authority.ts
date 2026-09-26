import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { createSqliteLifecycleAggregateError } from "../infra/sqlite-coordinator.js";
import {
  createAcpTaskBackingDetail,
  createManagedTaskBackingDetail,
  readManagedTaskBacking,
  readTaskBackingInstance,
  hasAuthoritativeTaskBackingFromRecords,
  selectCurrentCanonicalTaskBacking,
  type TaskBackingInstance,
} from "./task-backing-records.js";
import {
  getTaskFlowById,
  getTaskMirroredFlowIds,
  prepareTaskFlowRegistryRead,
  readResidentTaskFlow,
  type TaskFlowRegistryRead,
} from "./task-flow-runtime-internal.js";
import { prepareTaskRegistryRead, type TaskRegistryRead } from "./task-registry-read.js";
import { filterTasksByRunScope } from "./task-registry-records.js";
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

export type TaskBackingRead = Pick<
  TaskRegistryRead,
  "assertCurrent" | "getTaskById" | "getTasksByRunId"
> & {
  getTaskFlowById: TaskFlowRegistryRead["getTaskFlowById"];
  hasAuthoritativeTaskBacking(task: TaskRecord): boolean;
};

function taskCancellationNeedsFlowRead(read: TaskRegistryRead, taskId: string): boolean {
  const selected = read.getTaskById(taskId);
  if (!selected) {
    return false;
  }
  const runId = selected.runId?.trim();
  const peers =
    runId && (selected.runtime === "acp" || selected.runtime === "subagent")
      ? filterTasksByRunScope(read.getTasksByRunId(runId), {
          runtime: selected.runtime,
          sessionKey: selected.childSessionKey,
        })
      : [];
  return [selected, ...peers].some((record) => Boolean(record.parentFlowId?.trim()));
}

/** An unlinked selection can proceed independently of an unrelated broken flow registry. */
function createUnlinkedTaskBackingRead(read: TaskRegistryRead, taskId: string): TaskBackingRead {
  const flowRequired = () => {
    throw new Error("Task backing flow read requires preparation.");
  };
  const assertCurrent = () => {
    read.assertCurrent();
    if (taskCancellationNeedsFlowRead(read, taskId)) {
      flowRequired();
    }
  };
  const getTaskById = (id: string) => {
    assertCurrent();
    const current = read.getTaskById(id);
    if (current?.parentFlowId?.trim()) {
      flowRequired();
    }
    return current;
  };
  return {
    assertCurrent,
    getTaskById,
    getTasksByRunId(runId) {
      assertCurrent();
      const records = read.getTasksByRunId(runId);
      if (records.some((record) => record.parentFlowId?.trim())) {
        flowRequired();
      }
      return records;
    },
    getTaskFlowById: flowRequired,
    hasAuthoritativeTaskBacking(record) {
      const current = getTaskById(record.taskId);
      return current !== undefined && !record.parentFlowId?.trim();
    },
  };
}

/** Side effects prepare the selected task's required projections before synchronous guards. */
export async function prepareTaskBackingRead(
  selectedTaskId?: string,
): Promise<TaskBackingRead | undefined> {
  let selectedRead: TaskRegistryRead | undefined;
  if (selectedTaskId !== undefined) {
    selectedRead = await prepareTaskRegistryRead();
    if (!selectedRead) {
      return undefined;
    }
    if (!taskCancellationNeedsFlowRead(selectedRead, selectedTaskId)) {
      return createUnlinkedTaskBackingRead(selectedRead, selectedTaskId);
    }
  }
  const [taskRead, flowRead] = await Promise.allSettled([
    selectedRead ? Promise.resolve(selectedRead) : prepareTaskRegistryRead(),
    prepareTaskFlowRegistryRead(),
  ]);
  const errors = [taskRead, flowRead].flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (errors.length === 1) {
    throw errors[0];
  }
  if (errors.length > 1) {
    throw createSqliteLifecycleAggregateError(
      errors,
      "Task backing read preparation failed",
      errors[0],
    );
  }
  if (
    taskRead.status !== "fulfilled" ||
    flowRead.status !== "fulfilled" ||
    !taskRead.value ||
    !flowRead.value
  ) {
    return undefined;
  }
  const task = taskRead.value;
  const flow = flowRead.value;
  const assertCurrent = () => {
    task.assertCurrent();
    flow.assertCurrent();
  };
  assertCurrent();
  return {
    assertCurrent,
    getTasksByRunId: task.getTasksByRunId,
    getTaskById(taskId) {
      assertCurrent();
      if (!task.isTaskCurrent(taskId)) {
        return undefined;
      }
      const record = task.getTaskById(taskId);
      return record?.parentFlowId && !flow.isTaskFlowCurrent(record.parentFlowId)
        ? undefined
        : record;
    },
    getTaskFlowById: flow.getTaskFlowById,
    hasAuthoritativeTaskBacking(record) {
      assertCurrent();
      if (
        !task.isTaskCurrent(record.taskId) ||
        (record.parentFlowId && !flow.isTaskFlowCurrent(record.parentFlowId))
      ) {
        return false;
      }
      return hasAuthoritativeTaskBackingFromRecords(record, {
        isManagedFlow: (flowId) => flow.getTaskFlowById(flowId)?.syncMode === "managed",
        resolveCurrentCanonicalBacking: (scope) => {
          if (!task.isChildSessionCurrent(scope.childSessionKey)) {
            return undefined;
          }
          const candidates = task.listTaskRecordsForChildSessionKey(scope.childSessionKey);
          if (
            candidates.some(
              (candidate) =>
                candidate.parentFlowId && !flow.isTaskFlowCurrent(candidate.parentFlowId),
            )
          ) {
            return undefined;
          }
          return selectCurrentCanonicalTaskBacking({
            ...scope,
            candidates,
            isTaskMirroredFlow: (flowId) =>
              flow.getTaskFlowById(flowId)?.syncMode === "task_mirrored",
          });
        },
      });
    },
  };
}

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
  return hasAuthoritativeTaskBackingFromRecords(task, {
    isManagedFlow: (flowId) => getTaskFlowById(flowId)?.syncMode === "managed",
    resolveCurrentCanonicalBacking,
  });
}

/** Presentation ingestion consumes recorded facts; durable mutations recheck the canonical rows. */
export function hasResidentTaskBacking(task: TaskRecord): boolean {
  return hasAuthoritativeTaskBackingFromRecords(task, {
    isManagedFlow: (flowId) => readResidentTaskFlow(flowId)?.syncMode === "managed",
    resolveCurrentCanonicalBacking: (scope) =>
      selectCurrentCanonicalTaskBacking({
        ...scope,
        candidates: [...(taskIdsByRelatedSessionKey.get(scope.childSessionKey) ?? [])].flatMap(
          (taskId) => {
            const candidate = tasks.get(taskId);
            return candidate ? [candidate] : [];
          },
        ),
        isTaskMirroredFlow: (flowId) => readResidentTaskFlow(flowId)?.syncMode === "task_mirrored",
      }),
  });
}
