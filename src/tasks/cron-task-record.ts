/** Projects retained task rows into Cron history without changing their lifecycle owner. */
import { cronRunRecordToRunLogEntry } from "../cron/run-history-detail.js";
import type { CronRunRecord } from "../cron/store/run-history.types.js";
import type { TaskRecord } from "./task-registry.types.js";

export function cronRunRecordFromTask(task: TaskRecord): CronRunRecord {
  return {
    id: task.taskId,
    jobId: task.sourceId ?? null,
    runId: task.runId,
    agentId: task.agentId,
    sessionKey: task.childSessionKey,
    createdAt: task.createdAt,
    startedAt: task.startedAt,
    endedAt: task.endedAt,
    lastEventAt: task.lastEventAt,
    cleanupAfter: task.cleanupAfter,
    status: task.status,
    error: task.error,
    summary: task.terminalSummary,
    detail: task.detail,
  };
}

export function cronTaskRecordToRunLogEntry(task: TaskRecord) {
  return task.runtime === "cron" ? cronRunRecordToRunLogEntry(cronRunRecordFromTask(task)) : null;
}
