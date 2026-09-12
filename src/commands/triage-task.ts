// Register only actual admitted repair entry. Projection failure cannot veto repair.
import { observeTriageBacking, type TriageBackingReference } from "../infra/triage-backing.js";
import { createRunningTaskRun } from "../tasks/detached-task-runtime.js";
import type { TaskRecord } from "../tasks/task-registry.types.js";
import { findTaskByRunIdForStatus } from "../tasks/task-status-access.js";
import { readTriageTaskDetail } from "../tasks/triage-task.js";

export function startTriageRepairTask(params: {
  backing: TriageBackingReference;
  signal: AbortSignal;
  assertCurrent: () => void;
  originalUpdateRunId?: string;
}): string | undefined {
  const assertCurrent = () => {
    params.signal.throwIfAborted();
    params.assertCurrent();
  };
  assertCurrent();
  const backing = params.backing;
  // Managed helpers do not consume the joined task result. Repair still runs,
  // but only the original foreground parent can settle this optional projection.
  if (backing.generation.lifetime.kind !== "foreground") {
    return undefined;
  }
  const observation = observeTriageBacking(backing);
  if (
    observation.kind !== "matched" ||
    observation.phase !== "running" ||
    observation.helper !== "live" ||
    observation.executor !== "live" ||
    observation.lifetime !== "matched"
  ) {
    return undefined;
  }
  const runId = backing.generation.owner;
  const startedAt = Date.now();
  // Standalone triage has no authenticated session scope. Use the existing system scope.
  const request = {
    runtime: "cli" as const,
    taskKind: "triage_repair",
    sourceId: runId,
    runId,
    scopeKind: "system" as const,
    ownerKey: "",
    requesterSessionKey: "",
    task: "Repair installation",
    notifyPolicy: "silent" as const,
    deliveryStatus: "not_applicable" as const,
    startedAt,
    lastEventAt: startedAt,
    progressSummary: "Repair execution unconfirmed. Cancellation unavailable.",
  };
  const matchesRequest = (task: TaskRecord) =>
    task.runtime === request.runtime &&
    task.taskKind === request.taskKind &&
    task.sourceId === runId &&
    task.runId === runId &&
    task.scopeKind === request.scopeKind &&
    task.ownerKey === request.ownerKey &&
    task.requesterSessionKey === request.requesterSessionKey &&
    task.childSessionKey === undefined &&
    task.status === "running";
  let taskId: string | undefined;
  assertCurrent();
  try {
    // Existing projection is immutable here: do not revive or rebind a prior row.
    const task = findTaskByRunIdForStatus(runId) ? undefined : createRunningTaskRun(request);
    if (task && matchesRequest(task) && !readTriageTaskDetail(task)) {
      // The registry, not this caller, allocates taskId. Its existing create-dedup
      // operation attaches the fixed scope to that same record synchronously.
      const projected = createRunningTaskRun({
        ...request,
        detail: {
          kind: "triage_repair",
          version: 1,
          taskScope: {
            taskId: task.taskId,
            runtime: request.runtime,
            taskKind: request.taskKind,
            sourceId: runId,
            runId,
            ownerKey: task.ownerKey,
            scopeKind: task.scopeKind,
            requesterSessionKey: task.requesterSessionKey,
          },
          backing,
          ...(params.originalUpdateRunId
            ? { originalUpdateRunId: params.originalUpdateRunId }
            : {}),
          executionStartedAt: task.startedAt ?? startedAt,
        },
      });
      if (projected && matchesRequest(projected) && readTriageTaskDetail(projected)) {
        taskId = projected.taskId;
      }
    }
  } catch {
    // A task row is optional projection, not repair admission or success evidence.
  }
  assertCurrent();
  return taskId;
}
