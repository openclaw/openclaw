import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import type { TaskRecord } from "./task-registry.types.js";

function toTaskActivity(task: TaskRecord) {
  return {
    id: task.taskId,
    runtime: task.runtime,
    status: task.status,
    title: task.label ?? `${task.runtime} task`,
    createdAt: task.createdAt,
    ...(task.startedAt !== undefined ? { startedAt: task.startedAt } : {}),
    ...(task.endedAt !== undefined ? { endedAt: task.endedAt } : {}),
    ...(task.lastEventAt !== undefined ? { updatedAt: task.lastEventAt } : {}),
    ...(task.label ? { label: task.label } : {}),
    ...(task.progressSummary ? { progressSummary: task.progressSummary } : {}),
    ...(task.runId ? { runId: task.runId } : {}),
    ...(task.childSessionKey ? { childSessionKey: task.childSessionKey } : {}),
  };
}

function toTaskActivityContext(task: TaskRecord) {
  return {
    requesterSessionKey: task.requesterSessionKey,
    ownerKey: task.ownerKey,
    ...(task.childSessionKey ? { childSessionKey: task.childSessionKey } : {}),
    ...(task.parentTaskId ? { parentTaskId: task.parentTaskId } : {}),
    ...(task.agentId ? { agentId: task.agentId } : {}),
  };
}

function isTerminalStatus(task: TaskRecord): boolean {
  return (
    task.status === "succeeded" ||
    task.status === "failed" ||
    task.status === "timed_out" ||
    task.status === "cancelled" ||
    task.status === "lost"
  );
}

/** Emit metadata-only task lifecycle hooks without delaying task registry writes. */
export function emitTaskCreatedHook(task: TaskRecord): void {
  const runner = getGlobalHookRunner();
  if (!runner?.hasHooks("task_created")) {
    return;
  }
  void runner
    .runTaskCreated({ task: toTaskActivity(task) }, toTaskActivityContext(task))
    .catch(() => {});
}

export function emitTaskUpdatedHook(params: { task: TaskRecord; previous: TaskRecord }): void {
  const runner = getGlobalHookRunner();
  if (!runner) {
    return;
  }
  const event = {
    task: toTaskActivity(params.task),
    previous: toTaskActivity(params.previous),
  };
  const context = toTaskActivityContext(params.task);
  if (runner.hasHooks("task_updated")) {
    void runner.runTaskUpdated(event, context).catch(() => {});
  }
  if (!isTerminalStatus(params.previous) && isTerminalStatus(params.task)) {
    emitTaskFinishedHook(params.task, params.previous);
  }
}

export function emitTaskFinishedHook(task: TaskRecord, previous?: TaskRecord): void {
  const runner = getGlobalHookRunner();
  if (!runner?.hasHooks("task_finished")) {
    return;
  }
  void runner
    .runTaskFinished(
      {
        task: toTaskActivity(task),
        ...(previous ? { previous: toTaskActivity(previous) } : {}),
      },
      toTaskActivityContext(task),
    )
    .catch(() => {});
}

export function emitTaskDeletedHook(task: TaskRecord): void {
  const runner = getGlobalHookRunner();
  if (!runner?.hasHooks("task_deleted")) {
    return;
  }
  void runner
    .runTaskDeleted({ task: toTaskActivity(task) }, toTaskActivityContext(task))
    .catch(() => {});
}
