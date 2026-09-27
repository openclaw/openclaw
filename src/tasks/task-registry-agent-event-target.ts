import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  createAcpTaskBackingDetail,
  createSubagentTaskBackingDetail,
  readTaskBackingInstance,
  type TaskBackingInstance,
} from "./task-backing-records.js";
import { captureTaskPersistenceReceipt } from "./task-registry-records.js";
import {
  parseTaskRuntime,
  parseTaskScopeKind,
  parseTaskStatus,
  type TaskPersistenceReceipt,
  type TaskRecord,
} from "./task-registry.types.js";

export type TaskAgentEventTarget = TaskPersistenceReceipt &
  Pick<TaskRecord, "status" | "startedAt" | "lastEventAt"> & {
    backing?: TaskBackingInstance;
  };

type TaskCreationOperation = "tasks.createRecord" | "flows.runTask";

export function captureTaskAgentEventTarget(task: TaskRecord): TaskAgentEventTarget {
  return {
    ...captureTaskPersistenceReceipt(task),
    status: task.status,
    startedAt: task.startedAt,
    lastEventAt: task.lastEventAt,
    backing: readTaskBackingInstance(task.detail),
  };
}

/** A creation receipt carries its selected identity, not task prose or a projected row. */
export function captureTaskCreationEventTarget(
  task: TaskRecord,
  operation: TaskCreationOperation,
  requestedTaskId: string,
) {
  const target = captureTaskAgentEventTarget(task);
  const backing = target.backing;
  return {
    kind: "task-creation-event-target",
    operation,
    requestedTaskId,
    target: {
      ...target,
      backing:
        backing?.runtime === "acp"
          ? createAcpTaskBackingDetail(backing.instanceId, backing.generation)
          : backing
            ? createSubagentTaskBackingDetail(backing.generation)
            : undefined,
    },
  };
}

export function readTaskCreationEventTarget(
  facts: unknown,
  operation: TaskCreationOperation,
  requestedTaskId: string,
): TaskAgentEventTarget | undefined {
  if (facts === undefined) {
    return undefined;
  }
  if (
    !isRecord(facts) ||
    facts.kind !== "task-creation-event-target" ||
    facts.operation !== operation ||
    facts.requestedTaskId !== requestedTaskId ||
    !isRecord(facts.target)
  ) {
    throw new Error("Task creation event target differs from its retained producer");
  }
  const target = facts.target;
  const backing = readTaskBackingInstance(target.backing);
  if (
    typeof target.taskId !== "string" ||
    !target.taskId ||
    typeof target.ownerKey !== "string" ||
    typeof target.runId !== "string" ||
    !target.runId ||
    typeof target.createdAt !== "number" ||
    !Number.isFinite(target.createdAt) ||
    (target.childSessionKey !== undefined && typeof target.childSessionKey !== "string") ||
    (target.taskKind !== undefined && typeof target.taskKind !== "string") ||
    (target.startedAt !== undefined &&
      (typeof target.startedAt !== "number" || !Number.isFinite(target.startedAt))) ||
    (target.lastEventAt !== undefined &&
      (typeof target.lastEventAt !== "number" || !Number.isFinite(target.lastEventAt))) ||
    (target.backing !== undefined && !backing)
  ) {
    throw new Error("Task creation event target is invalid");
  }
  return {
    taskId: target.taskId,
    ownerKey: target.ownerKey,
    runId: target.runId,
    createdAt: target.createdAt,
    childSessionKey: target.childSessionKey,
    taskKind: target.taskKind,
    startedAt: target.startedAt,
    lastEventAt: target.lastEventAt,
    runtime: parseTaskRuntime(target.runtime),
    scopeKind: parseTaskScopeKind(target.scopeKind),
    status: parseTaskStatus(target.status),
    backing,
  };
}
