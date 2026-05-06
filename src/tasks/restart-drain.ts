import { emitDiagnosticEvent } from "../infra/diagnostic-events.js";
import { listTaskRecords, markTaskTerminalById } from "./runtime-internal.js";
import type { TaskRecord } from "./task-registry.types.js";

export const RESTART_ZOMBIE_TASK_ERROR = "zombie_promoted_during_restart";

export type RestartZombieTaskPromotion = {
  task: TaskRecord;
  updated: TaskRecord;
  ageMs: number;
};

export function listRunningRestartTaskRuns(): TaskRecord[] {
  return listTaskRecords().filter((task) => task.status === "running" && !task.endedAt);
}

function resolveTaskLastEventAt(task: TaskRecord): number | undefined {
  return task.lastEventAt ?? task.startedAt ?? task.createdAt;
}

export function promoteRestartZombieTaskRuns(params: {
  nowMs?: number;
  zombieTtlMs: number;
}): RestartZombieTaskPromotion[] {
  const nowMs = params.nowMs ?? Date.now();
  const zombieTtlMs = Math.max(0, params.zombieTtlMs);
  const cutoffMs = nowMs - zombieTtlMs;
  const promotions: RestartZombieTaskPromotion[] = [];

  for (const task of listRunningRestartTaskRuns()) {
    const lastEventAt = resolveTaskLastEventAt(task);
    if (lastEventAt === undefined || lastEventAt >= cutoffMs) {
      continue;
    }
    const updated = markTaskTerminalById({
      taskId: task.taskId,
      status: "failed",
      endedAt: nowMs,
      lastEventAt: nowMs,
      error: RESTART_ZOMBIE_TASK_ERROR,
      terminalSummary: RESTART_ZOMBIE_TASK_ERROR,
    });
    if (!updated) {
      continue;
    }
    const ageMs = nowMs - lastEventAt;
    promotions.push({ task, updated, ageMs });
    emitDiagnosticEvent({
      type: "task.zombie_promoted",
      taskId: task.taskId,
      runtime: task.runtime,
      runId: task.runId,
      lastEventAt,
      ageMs,
      zombieTtlMs,
      reason: RESTART_ZOMBIE_TASK_ERROR,
    });
  }

  return promotions;
}
