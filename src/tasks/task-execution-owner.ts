import { hostname } from "node:os";
import { buildAgentRunTerminalOutcome } from "../agents/agent-run-terminal-outcome.js";
import { AGENT_RUN_RESTART_ABORT_STOP_REASON } from "../agents/run-termination.js";
import { getFileLockProcessStartTime, isPidDefinitelyDead } from "../shared/pid-alive.js";
import { mapAgentRunTerminalOutcomeToTaskStatus } from "./task-registry-common.js";
import { applyTaskRecordPatch, normalizeTaskTimestamps } from "./task-registry-records.js";
import type {
  TaskExecutionRestoreStore,
  TaskRegistryStoreSnapshot,
} from "./task-registry.store.types.js";
import type { TaskExecutionOwner, TaskRecord } from "./task-registry.types.js";

export type TaskExecutionRestoreResult = {
  snapshot: TaskRegistryStoreSnapshot;
  settledTasks: TaskRecord[];
};

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

function readRestoreSnapshot(
  loadSnapshot: () => TaskRegistryStoreSnapshot,
): TaskRegistryStoreSnapshot {
  const snapshot = loadSnapshot();
  return {
    tasks: new Map([...snapshot.tasks].map(([id, task]) => [id, normalizeTaskTimestamps(task)])),
    deliveryStates: snapshot.deliveryStates,
  };
}

export function restoreTaskExecutionSnapshot(
  store: TaskExecutionRestoreStore,
  loadSnapshot: () => TaskRegistryStoreSnapshot = () => store.loadSnapshot(),
  assertCurrent?: () => void,
): TaskExecutionRestoreResult {
  const snapshot = readRestoreSnapshot(loadSnapshot);
  const candidates = [...snapshot.tasks.values()].filter(hasOrphanedExecution);
  if (candidates.length === 0) {
    return { snapshot, settledTasks: [] };
  }
  const settledTasks: TaskRecord[] = [];
  for (const candidate of candidates) {
    const settle = () => {
      // Each task keeps its commit boundary; admission may outlive a changed execution owner.
      assertCurrent?.();
      const current = store.loadMutationSnapshot
        ? store.loadMutationSnapshot([{ taskId: candidate.taskId }])
        : loadSnapshot();
      assertCurrent?.();
      const stored = current.tasks.get(candidate.taskId);
      const task = stored && normalizeTaskTimestamps(stored);
      if (!task || !hasOrphanedExecution(task)) {
        return undefined;
      }
      const next = settleOrphanedTaskAtRestore(task, Date.now());
      store.upsertTaskWithDeliveryState({
        task: next,
        deliveryState: current.deliveryStates.get(task.taskId),
      });
      return next;
    };
    const settled = store.withMutation ? store.withMutation(settle) : settle();
    if (settled) {
      settledTasks.push(settled);
    }
  }
  return { snapshot: readRestoreSnapshot(loadSnapshot), settledTasks };
}
