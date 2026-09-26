/** Enforces the task-ledger retention bound for terminal cron history. */
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  cronRunRecordStoreKey,
  resolveCronRunRecordTimestamp,
} from "../cron/run-history-detail.js";
import type { TaskRecord } from "./task-registry.types.js";
import { resolveEffectiveTaskCleanupAfter } from "./task-retention.js";

// Replaces configurable cron.runLog.keepLines with one ledger-owned bound.
export const CRON_HISTORY_KEEP_PER_JOB = 2000;

function isTerminalTask(task: TaskRecord): boolean {
  return task.status !== "queued" && task.status !== "running";
}

type CronHistoryRetentionPartition = {
  history: TaskRecord[];
  quiet: TaskRecord[];
};

export function hasCronRunHistory(task: Pick<TaskRecord, "detail">): boolean {
  return isRecord(task.detail) && task.detail.kind === "cron-run";
}

export function compareCronHistoryRetentionOrder(
  left: Pick<TaskRecord, "taskId" | "createdAt" | "endedAt" | "lastEventAt">,
  right: Pick<TaskRecord, "taskId" | "createdAt" | "endedAt" | "lastEventAt">,
): number {
  return (
    resolveCronRunRecordTimestamp(right) - resolveCronRunRecordTimestamp(left) ||
    right.createdAt - left.createdAt ||
    right.taskId.localeCompare(left.taskId)
  );
}

export function collectCronHistoryOverflowTaskIds(tasks: readonly TaskRecord[]): Set<string> {
  // Cron job ids are unique only within a configured store. Retention must
  // use the same storeKey/sourceId partition as history reads.
  const byStore = new Map<string | undefined, Map<string, CronHistoryRetentionPartition>>();
  for (const task of tasks) {
    if (
      task.runtime !== "cron" ||
      !task.sourceId ||
      !isTerminalTask(task) ||
      task.status === "lost"
    ) {
      continue;
    }
    const storeKey = cronRunRecordStoreKey(task);
    const bySource = byStore.get(storeKey) ?? new Map<string, CronHistoryRetentionPartition>();
    const partition = bySource.get(task.sourceId) ?? { history: [], quiet: [] };
    // Quiet watcher ticks have no history entry. Bound them separately so
    // ordinary non-firing evaluations cannot evict actual run history.
    const rows = hasCronRunHistory(task) ? partition.history : partition.quiet;
    rows.push(task);
    bySource.set(task.sourceId, partition);
    byStore.set(storeKey, bySource);
  }
  const overflow = new Set<string>();
  for (const bySource of byStore.values()) {
    for (const partition of bySource.values()) {
      for (const rows of [partition.history, partition.quiet]) {
        rows.sort(compareCronHistoryRetentionOrder);
        for (const task of rows.slice(CRON_HISTORY_KEEP_PER_JOB)) {
          overflow.add(task.taskId);
        }
      }
    }
  }
  return overflow;
}

export function shouldPruneTerminalTask(
  task: TaskRecord,
  now: number,
  cronHistoryOverflowTaskIds: Pick<ReadonlySet<string>, "has">,
): boolean {
  if (!isTerminalTask(task)) {
    return false;
  }
  if (cronHistoryOverflowTaskIds.has(task.taskId)) {
    return true;
  }
  return now >= resolveEffectiveTaskCleanupAfter(task);
}
