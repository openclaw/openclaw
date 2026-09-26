import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { parseAgentSessionKey } from "../routing/session-key.js";
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
  if (
    detail?.kind !== TASK_BACKING_DETAIL_KIND ||
    typeof detail.generation !== "number" ||
    !Number.isSafeInteger(detail.generation) ||
    detail.generation <= 0
  ) {
    return undefined;
  }
  if (detail.runtime === "acp") {
    const instanceId = typeof detail.instanceId === "string" ? detail.instanceId.trim() : "";
    return instanceId ? { runtime: "acp", instanceId, generation: detail.generation } : undefined;
  }
  if (detail.runtime === "subagent") {
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

/** Exclude replaced ACP instances without changing each lookup owner's tie order. */
export function filterCurrentTaskRunBackings(
  matches: readonly TaskRecord[],
  isTaskMirroredFlow: (flowId: string) => boolean,
): TaskRecord[] {
  const acpScopes = new Map<
    string,
    { childSessionKey: string; scopeKind: TaskScopeKind; candidates: TaskRecord[] }
  >();
  for (const task of matches) {
    const childSessionKey = normalizeOptionalString(task.childSessionKey);
    if (task.runtime !== "acp" || !childSessionKey) {
      continue;
    }
    const scope = JSON.stringify([
      task.scopeKind,
      normalizeOptionalString(task.agentId) ?? parseAgentSessionKey(task.childSessionKey)?.agentId,
      childSessionKey,
    ]);
    const group = acpScopes.get(scope);
    if (group) {
      group.candidates.push(task);
    } else {
      acpScopes.set(scope, { childSessionKey, scopeKind: task.scopeKind, candidates: [task] });
    }
  }
  const superseded = new Set<string>();
  for (const { childSessionKey, scopeKind, candidates } of acpScopes.values()) {
    const current = selectLatestCanonicalTaskBacking({
      runtime: "acp",
      scopeKind,
      childSessionKey,
      candidates,
      isTaskMirroredFlow,
    });
    if (!current) {
      continue;
    }
    for (const candidate of candidates) {
      const backing = readTaskBackingInstance(candidate.detail);
      if (!backing || !sameTaskBackingInstance(backing, current.instance)) {
        superseded.add(candidate.taskId);
      }
    }
  }
  return matches.filter((candidate) => !superseded.has(candidate.taskId));
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
    ? { kind: TASK_BACKING_DETAIL_KIND, ...current.instance, taskId: current.task.taskId }
    : undefined;
}

/** The same canonical-instance decision serves native projections and admitted database reads. */
export function hasAuthoritativeTaskBackingFromRecords(
  task: TaskRecord,
  readers: {
    isManagedFlow: (flowId: string) => boolean;
    resolveCurrentCanonicalBacking: (
      scope: Omit<
        Parameters<typeof selectCurrentCanonicalTaskBacking>[0],
        "candidates" | "isTaskMirroredFlow"
      >,
    ) => ReturnType<typeof selectCurrentCanonicalTaskBacking>;
  },
): boolean {
  if (task.runtime !== "acp" && task.runtime !== "subagent") {
    return true;
  }
  const flowId = task.parentFlowId?.trim();
  if (!flowId || !readers.isManagedFlow(flowId)) {
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
  const current = readers.resolveCurrentCanonicalBacking({
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
