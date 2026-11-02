import { sql } from "kysely";
import { beginEngineStoreReadSnapshot } from "../../infra/database-engine/adapters.js";
import { jsonPickObject, jsonValid } from "../../infra/database-engine/json-values.js";
import {
  executeSqliteQuerySync,
  getNodeSqliteKysely,
  iterateSqliteQuerySync,
} from "../../infra/kysely-sync.js";
import { isPostgresSqlConnection, type EngineConnection } from "../../infra/sql-connection.js";
import { normalizeSqliteNumber } from "../../infra/sqlite-number.js";
import type { DB } from "../../state/openclaw-state-db.generated.js";
import {
  cronRunRecordStoreKey,
  cronRunRecordToRunLogEntry,
  parseCronRunDetailJson,
} from "../run-history-detail.js";
import { cronRunHistoryMatchesQuery } from "../run-history.js";
import type { CronRunHistoryCandidates } from "./read-only.types.js";
import { normalizeCronRunTimestamps } from "./run-history.kernel.js";
import type { CronRunRecord } from "./run-history.types.js";

const SELECTION_KEYS = [
  "kind",
  "storeKey",
  "status",
  "deliveryStatus",
  "runId",
  "runAtMs",
  "sessionId",
];
const SEARCH_KEYS = ["error", "summary", "deliveryError", "errorReason", "diagnostics", "delivery"];
const RESPONSE_KEYS = [
  ...SELECTION_KEYS,
  "completionStatus",
  "error",
  "summary",
  "result",
  "errorReason",
  "delivered",
  "deliveryError",
  "deliverySuppressionReason",
  "durationMs",
  "nextRunAtMs",
  "triggerFired",
  "model",
  "provider",
  "usage",
];
const TRACE_KEYS = ["diagnostics", "delivery", "failureNotificationDelivery"];
const CANDIDATE_BATCH_SIZE = 512;

function historyQuery(db: EngineConnection, keys: string[], search: boolean) {
  const query = getNodeSqliteKysely<Pick<DB, "task_runs">>(db);
  return query
    .selectFrom("task_runs")
    .select((eb) => [
      "task_id",
      "source_id",
      "run_id",
      "agent_id",
      "child_session_key",
      "created_at",
      "started_at",
      "ended_at",
      "last_event_at",
      "status",
      // Released malformed JSON is ignored by the history codec, not a query failure.
      /* kysely-allow-raw: Portable CASE bounds large JSON before it crosses the driver. */
      sql<string | null>`CASE WHEN ${jsonValid(db, eb.ref("detail_json"))}
      THEN ${jsonPickObject(db, eb.ref("detail_json"), keys)} END`.as("detail_json"),
      ...(search ? (["error", "terminal_summary"] as const) : []),
    ])
    .where("runtime", "=", "cron");
}

type HistoryRow = Awaited<ReturnType<ReturnType<typeof historyQuery>["execute"]>>[number];

function decodeHistoryRow(row: HistoryRow): CronRunRecord {
  return normalizeCronRunTimestamps({
    id: row.task_id,
    jobId: row.source_id || null,
    runId: row.run_id || undefined,
    agentId: row.agent_id || undefined,
    sessionKey: row.child_session_key || undefined,
    createdAt: normalizeSqliteNumber(row.created_at) ?? 0,
    startedAt: normalizeSqliteNumber(row.started_at),
    endedAt: normalizeSqliteNumber(row.ended_at),
    lastEventAt: normalizeSqliteNumber(row.last_event_at),
    status: row.status,
    error: row.error || undefined,
    summary: row.terminal_summary ?? undefined,
    detail: row.detail_json === null ? undefined : parseCronRunDetailJson(row.detail_json),
  });
}

function* readHistoryCandidateRows(
  db: EngineConnection,
  select: ReturnType<typeof historyQuery>,
): IterableIterator<HistoryRow> {
  if (!isPostgresSqlConnection(db)) {
    // One native statement owns the snapshot and releases each row's search payload.
    yield* iterateSqliteQuerySync(db, select);
    return;
  }
  // The PostgreSQL bridge buffers each result; keep large search details batch-bounded.
  const bounded = select.limit(CANDIDATE_BATCH_SIZE);
  const snapshot = beginEngineStoreReadSnapshot(db);
  try {
    let cursor: { createdAt: number; id: string } | undefined;
    for (;;) {
      const after = cursor;
      const rows = executeSqliteQuerySync(
        db,
        after
          ? bounded.where((eb) =>
              eb(eb.refTuple("created_at", "task_id"), ">", eb.tuple(after.createdAt, after.id)),
            )
          : bounded,
      ).rows;
      yield* rows;
      if (rows.length < CANDIDATE_BATCH_SIZE) {
        return;
      }
      const last = rows[rows.length - 1]!;
      // The cursor uses stored index values; the released codec can normalize createdAt.
      cursor = { createdAt: last.created_at, id: last.task_id };
    }
  } finally {
    snapshot.close();
  }
}

/** Exact totals and completion-time ordering need metadata, never every response payload. */
export function readCronRunHistoryCandidatesInDatabase(
  db: EngineConnection,
  storeKey: string,
  jobId?: string,
  search?: string,
  jobNameById?: Record<string, string>,
): CronRunHistoryCandidates {
  const keys = search?.trim() ? [...SELECTION_KEYS, ...SEARCH_KEYS] : SELECTION_KEYS;
  let select = historyQuery(db, keys, Boolean(search?.trim()))
    .orderBy("created_at", "asc")
    .orderBy("task_id", "asc");
  if (jobId !== undefined) {
    select = select.where("source_id", "=", jobId);
  }
  const records: CronRunRecord[] = [];
  const queryMatches: string[] | undefined = search?.trim() ? [] : undefined;
  for (const row of readHistoryCandidateRows(db, select)) {
    const record = decodeHistoryRow(row);
    if (cronRunRecordStoreKey(record) === storeKey) {
      if (queryMatches) {
        const entry = cronRunRecordToRunLogEntry(record);
        if (entry && cronRunHistoryMatchesQuery(entry, search!, jobNameById)) {
          queryMatches.push(record.id);
        }
        // Keep identities for alias ambiguity, but release this row's search payload.
        if (record.detail && typeof record.detail === "object" && !Array.isArray(record.detail)) {
          for (const key of SEARCH_KEYS) {
            delete record.detail[key];
          }
        }
        delete record.error;
        delete record.summary;
      }
      records.push(record);
    }
  }
  return { records, queryMatches };
}

/** Only the selected page crosses the driver; recovery state never enters a history response. */
export function readCronRunHistoryRecordsInDatabase(
  db: EngineConnection,
  storeKey: string,
  taskIds: string[],
  view?: "full" | "summary",
): CronRunRecord[] {
  if (taskIds.length === 0) {
    return [];
  }
  const keys = view === "summary" ? RESPONSE_KEYS : [...RESPONSE_KEYS, ...TRACE_KEYS];
  return executeSqliteQuerySync(
    db,
    historyQuery(db, keys, true).where("task_id", "in", taskIds).limit(taskIds.length),
  )
    .rows.map(decodeHistoryRow)
    .filter((row) => cronRunRecordStoreKey(row) === storeKey);
}
