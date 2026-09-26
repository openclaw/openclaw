import type { DatabaseSync } from "node:sqlite";
import { sql } from "kysely";
import { cronRunRecordStoreKey } from "../cron/run-history-detail.js";
import { getNodeSqliteKysely, prepareSqliteQueryIterator } from "../infra/kysely-sync.js";
import { normalizeSqliteNumber } from "../infra/sqlite-number.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import {
  compareCronHistoryRetentionOrder,
  CRON_HISTORY_KEEP_PER_JOB,
  hasCronRunHistory,
} from "./cron-history-retention.js";
import { normalizeTaskTimestamps } from "./task-registry-records.js";
import { captureTaskRetentionSource } from "./task-registry-retention-source.js";
import {
  prepareTaskRetention,
  type TaskRetentionInput,
  type TaskRetentionResult,
} from "./task-registry-retention.operation.js";
import {
  bindTaskRecord,
  deleteTaskRowsWithDeliveryState,
  readTaskRecord,
  upsertTaskRunRowInDatabase,
} from "./task-registry.store.kernel.js";
import { parseTaskStatus, type TaskRecord } from "./task-registry.types.js";
import { resolveEffectiveTaskCleanupAfter } from "./task-retention.js";

type CronHistoryRetentionRow = Pick<
  DB["task_runs"],
  "task_id" | "status" | "created_at" | "started_at" | "ended_at" | "last_event_at"
> & { store_key: string | null; has_history: number };

const cronHistoryReaders = new WeakMap<
  DatabaseSync,
  (sourceId: string) => IterableIterator<CronHistoryRetentionRow>
>();

function hasCurrentCronHistoryOverflow(db: DatabaseSync, current: TaskRecord): boolean {
  if (current.runtime !== "cron" || !current.sourceId || current.status === "lost") {
    return false;
  }
  let read = cronHistoryReaders.get(db);
  if (!read) {
    read = prepareSqliteQueryIterator<string, CronHistoryRetentionRow>(db, (parameter) =>
      getNodeSqliteKysely<DB>(db)
        .selectFrom("task_runs")
        .select(["task_id", "status", "created_at", "started_at", "ended_at", "last_event_at"])
        .select([
          sql<string | null>`CASE WHEN json_valid(detail_json) THEN
            CASE WHEN json_type(detail_json) = 'object'
              AND json_type(detail_json, '$.storeKey') = 'text'
            THEN json_extract(detail_json, '$.storeKey') END
          END`.as("store_key"),
          sql<number>`CASE WHEN json_valid(detail_json) THEN
            CASE WHEN json_type(detail_json) = 'object'
              AND json_extract(detail_json, '$.kind') = 'cron-run'
            THEN 1 ELSE 0 END
          ELSE 0 END`.as("has_history"),
        ])
        .where("runtime", "=", "cron")
        .where(
          "source_id",
          "=",
          parameter((sourceId) => sourceId),
        )
        .where("status", "not in", ["queued", "running", "lost"])
        // Traverse the existing index newest-first; the shared JS comparator decides rank.
        .orderBy("ended_at", "desc")
        .orderBy("created_at", "desc")
        .orderBy("task_id", "desc"),
    );
    cronHistoryReaders.set(db, read);
  }
  const storeKey = cronRunRecordStoreKey(current);
  const hasHistory = hasCronRunHistory(current);
  let newer = 0;
  for (const row of read(current.sourceId)) {
    if ((row.store_key ?? undefined) !== storeKey || (row.has_history === 1) !== hasHistory) {
      continue;
    }
    const candidate = normalizeTaskTimestamps({
      taskId: row.task_id,
      status: parseTaskStatus(row.status),
      createdAt: normalizeSqliteNumber(row.created_at) ?? 0,
      startedAt: normalizeSqliteNumber(row.started_at),
      endedAt: normalizeSqliteNumber(row.ended_at),
      lastEventAt: normalizeSqliteNumber(row.last_event_at),
    });
    if (compareCronHistoryRetentionOrder(candidate, current) < 0) {
      newer += 1;
      if (newer >= CRON_HISTORY_KEEP_PER_JOB) {
        return true;
      }
    }
  }
  return false;
}

/** The caller retains one transaction through current-row selection and its mutation. */
export function applyTaskRetentionInDatabase(
  db: DatabaseSync,
  input: TaskRetentionInput,
  assertCurrent: () => void,
): TaskRetentionResult {
  const current = readTaskRecord(db, input.taskId);
  if (!current || captureTaskRetentionSource(current).version !== input.sourceVersion) {
    return { kind: "unchanged" };
  }
  const result = prepareTaskRetention(current, input);
  if (result.kind === "unchanged") {
    return result;
  }
  if (
    result.kind === "pruned" &&
    input.cronHistoryOverflow &&
    input.now < resolveEffectiveTaskCleanupAfter(current) &&
    !hasCurrentCronHistoryOverflow(db, current)
  ) {
    // A peer can leave the partition while this unchanged candidate waits for writer custody.
    return { kind: "unchanged" };
  }
  assertCurrent();
  if (result.kind === "pruned") {
    deleteTaskRowsWithDeliveryState(db, input.taskId);
  } else {
    // A cleanup deadline does not replace the task's delivery state.
    upsertTaskRunRowInDatabase({ db }, bindTaskRecord(result.task));
  }
  return result;
}
