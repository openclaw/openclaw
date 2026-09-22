import { hostname } from "node:os";
import { buildAgentRunTerminalOutcome } from "../agents/agent-run-terminal-outcome.js";
import { AGENT_RUN_RESTART_ABORT_STOP_REASON } from "../agents/run-termination.js";
import { getFileLockProcessStartTime, isPidDefinitelyDead } from "../shared/pid-alive.js";
import { mapAgentRunTerminalOutcomeToTaskStatus } from "./task-registry-common.js";
import { applyTaskRecordPatch, normalizeTaskTimestamps } from "./task-registry-records.js";
import type { TaskRegistryStore, TaskRegistryStoreSnapshot } from "./task-registry.store.js";
import type { TaskExecutionOwner, TaskRecord } from "./task-registry.types.js";

export function captureTaskExecutionOwner(pid = process.pid): TaskExecutionOwner | undefined {
  const startIdentity = getFileLockProcessStartTime(pid);
  return Number.isSafeInteger(pid) && pid > 0 && startIdentity !== null
    ? { host: hostname(), pid, startIdentity }
    : undefined;
}

function isTaskExecutionOwnerDead(owner: TaskExecutionOwner): boolean {
  if (owner.host !== hostname()) {
    return false;
  }
  if (isPidDefinitelyDead(owner.pid)) {
    return true;
  }
  const startIdentity = getFileLockProcessStartTime(owner.pid);
  return startIdentity !== null && startIdentity !== owner.startIdentity;
}

function hasOrphanedExecution(task: TaskRecord): boolean {
  return (
    task.status === "running" &&
    task.endedAt === undefined &&
    task.executionOwner !== undefined &&
    isTaskExecutionOwnerDead(task.executionOwner)
  );
}

function settleOrphanedTaskAtRestore(task: TaskRecord, now: number): TaskRecord {
  const reason = "Task execution process exited before restart.";
  const outcome = buildAgentRunTerminalOutcome({
    status: "error",
    stopReason: AGENT_RUN_RESTART_ABORT_STOP_REASON,
    error: task.error ?? reason,
    startedAt: task.startedAt,
    endedAt: now,
  });
  return applyTaskRecordPatch(task, {
    status: mapAgentRunTerminalOutcomeToTaskStatus(outcome),
    endedAt: now,
    lastEventAt: now,
    error: outcome.error,
    terminalSummary: reason,
    terminalOutcome: undefined,
  });
}

function readRestoreSnapshot(store: TaskRegistryStore): TaskRegistryStoreSnapshot {
  const snapshot = store.loadSnapshot();
  return {
    tasks: new Map([...snapshot.tasks].map(([id, task]) => [id, normalizeTaskTimestamps(task)])),
    deliveryStates: snapshot.deliveryStates,
  };
}

export function restoreTaskExecutionSnapshot(store: TaskRegistryStore): {
  snapshot: TaskRegistryStoreSnapshot;
  settledTasks: TaskRecord[];
} {
  const snapshot = readRestoreSnapshot(store);
  if (![...snapshot.tasks.values()].some(hasOrphanedExecution)) {
    return { snapshot, settledTasks: [] };
  }
  const settle = () => {
    // Admission can yield to another writer; only its current rows authorize settlement.
    const current = readRestoreSnapshot(store);
    const settledTasks: TaskRecord[] = [];
    const now = Date.now();
    for (const [taskId, task] of current.tasks) {
      if (!hasOrphanedExecution(task)) {
        continue;
      }
      const next = settleOrphanedTaskAtRestore(task, now);
      store.upsertTaskWithDeliveryState({
        task: next,
        deliveryState: current.deliveryStates.get(taskId),
      });
      current.tasks.set(taskId, next);
      settledTasks.push(next);
    }
    return { snapshot: current, settledTasks };
  };
  return store.withMutation ? store.withMutation(settle) : settle();
}
