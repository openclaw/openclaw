import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { JsonValue, TaskRecord, TaskRuntime, TaskScopeKind } from "./task-registry.types.js";

const TASK_BACKING_DETAIL_KIND = "task_backing_instance";
/** Owner-minted identity persisted in canonical tasks and copied into managed projections. */
export type TaskBackingInstance =
  | { runtime: "acp"; instanceId: string; generation: number }
  | { runtime: "subagent"; generation: number };

type TaskBackingDetail = TaskBackingInstance & { kind: typeof TASK_BACKING_DETAIL_KIND };
type ManagedTaskBacking = { taskId: string; instance: TaskBackingInstance };

export function readTaskBackingInstance(value: unknown): TaskBackingInstance | undefined {
  const detail = asOptionalRecord(value);
  if (detail?.kind !== TASK_BACKING_DETAIL_KIND) {
    return undefined;
  }
  if (detail.runtime === "acp") {
    const instanceId = typeof detail.instanceId === "string" ? detail.instanceId.trim() : "";
    return instanceId &&
      typeof detail.generation === "number" &&
      Number.isSafeInteger(detail.generation) &&
      detail.generation > 0
      ? { runtime: "acp", instanceId, generation: detail.generation }
      : undefined;
  }
  if (
    detail.runtime === "subagent" &&
    typeof detail.generation === "number" &&
    Number.isSafeInteger(detail.generation) &&
    detail.generation > 0
  ) {
    return { runtime: "subagent", generation: detail.generation };
  }
  return undefined;
}

export function readManagedTaskBacking(value: unknown): ManagedTaskBacking | undefined {
  const detail = asOptionalRecord(value);
  const taskId = typeof detail?.taskId === "string" ? detail.taskId.trim() : "";
  const instance = readTaskBackingInstance(detail);
  return taskId && instance ? { taskId, instance } : undefined;
}

export function sameTaskBackingInstance(
  left: TaskBackingInstance,
  right: TaskBackingInstance,
): boolean {
  return left.runtime === "acp" && right.runtime === "acp"
    ? left.instanceId === right.instanceId && left.generation === right.generation
    : left.runtime === "subagent" && right.runtime === "subagent"
      ? left.generation === right.generation
      : false;
}

export function selectLatestCanonicalTaskBacking(params: {
  runtime: TaskRuntime;
  scopeKind: TaskScopeKind;
  childSessionKey: string;
  candidates: readonly TaskRecord[];
  isTaskMirroredFlow: (flowId: string) => boolean;
}): { task: TaskRecord; instance: TaskBackingInstance } | undefined {
  const candidates = params.candidates
    .flatMap((task) => {
      const instance = readTaskBackingInstance(task.detail);
      return instance &&
        instance.runtime === params.runtime &&
        task.runtime === params.runtime &&
        task.scopeKind === params.scopeKind &&
        task.childSessionKey?.trim() === params.childSessionKey &&
        Boolean(task.parentFlowId?.trim() && params.isTaskMirroredFlow(task.parentFlowId.trim()))
        ? [{ task, instance }]
        : [];
    })
    .toSorted((left, right) => {
      const generationDelta = right.instance.generation - left.instance.generation;
      if (generationDelta !== 0) {
        return generationDelta;
      }
      return (
        right.task.createdAt - left.task.createdAt ||
        right.task.taskId.localeCompare(left.task.taskId)
      );
    });
  return candidates[0];
}

export function selectCurrentCanonicalTaskBacking(
  params: Parameters<typeof selectLatestCanonicalTaskBacking>[0] & {
    ownerKey: string;
    runId: string;
  },
): ReturnType<typeof selectLatestCanonicalTaskBacking> {
  const current = selectLatestCanonicalTaskBacking(params);
  return current?.task.ownerKey === params.ownerKey && current.task.runId?.trim() === params.runId
    ? current
    : undefined;
}

export function createAcpTaskBackingDetail(instanceId: string, generation = 1): TaskBackingDetail {
  return { kind: TASK_BACKING_DETAIL_KIND, runtime: "acp", instanceId, generation };
}

export function createSubagentTaskBackingDetail(generation: number): TaskBackingDetail {
  return { kind: TASK_BACKING_DETAIL_KIND, runtime: "subagent", generation };
}

export function createManagedTaskBackingDetail(
  current: ReturnType<typeof selectCurrentCanonicalTaskBacking>,
): JsonValue | undefined {
  return current
    ? current.instance.runtime === "acp"
      ? {
          ...createAcpTaskBackingDetail(current.instance.instanceId, current.instance.generation),
          taskId: current.task.taskId,
        }
      : {
          ...createSubagentTaskBackingDetail(current.instance.generation),
          taskId: current.task.taskId,
        }
    : undefined;
}
