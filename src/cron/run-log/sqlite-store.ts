import type { DatabaseSync } from "node:sqlite";
import type { Insertable, Selectable } from "kysely";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";
import type { CronRunLogEntry } from "../run-log-types.js";
import type { CronDeliveryStatus, CronRunStatus } from "../types.js";
import { parseCronRunLogEntryObject } from "./entry-codec.js";

type CronRunLogsTable = OpenClawStateKyselyDatabase["cron_run_logs"];
type CronRunLogDatabase = Pick<OpenClawStateKyselyDatabase, "cron_run_logs">;
type CronRunLogRow = Selectable<CronRunLogsTable>;
type CronRunLogInsert = Insertable<CronRunLogsTable>;

function getCronRunLogKysely(db: DatabaseSync) {
  return getNodeSqliteKysely<CronRunLogDatabase>(db);
}

function normalizeNumber(value: number | bigint | null): number | undefined {
  if (typeof value === "bigint") {
    return Number(value);
  }
  return typeof value === "number" ? value : undefined;
}

function booleanToInteger(value: boolean | undefined): number | null {
  return typeof value === "boolean" ? (value ? 1 : 0) : null;
}

function integerToBoolean(value: number | bigint | null): boolean | undefined {
  const normalized = normalizeNumber(value);
  return normalized == null ? undefined : normalized !== 0;
}

function bindCronRunLogRow(params: {
  storeKey: string;
  seq: number;
  entry: CronRunLogEntry;
}): CronRunLogInsert {
  const entry = params.entry;
  return {
    store_key: params.storeKey,
    job_id: entry.jobId,
    seq: params.seq,
    ts: entry.ts,
    status: entry.status ?? null,
    error: entry.error ?? null,
    summary: entry.summary ?? null,
    diagnostics_summary: entry.diagnostics?.summary ?? null,
    delivery_status: entry.deliveryStatus ?? null,
    delivery_error: entry.deliveryError ?? null,
    delivered: booleanToInteger(entry.delivered),
    session_id: entry.sessionId ?? null,
    session_key: entry.sessionKey ?? null,
    run_id: entry.runId ?? null,
    run_at_ms: entry.runAtMs ?? null,
    duration_ms: entry.durationMs ?? null,
    next_run_at_ms: entry.nextRunAtMs ?? null,
    model: entry.model ?? null,
    provider: entry.provider ?? null,
    total_tokens: entry.usage?.total_tokens ?? null,
    entry_json: JSON.stringify(entry),
    created_at: Date.now(),
  };
}

export function parseStoredRunLogEntry(row: CronRunLogRow): CronRunLogEntry | null {
  let rawEntry: unknown;
  try {
    rawEntry = JSON.parse(row.entry_json);
  } catch {
    return null;
  }
  const parsed = parseCronRunLogEntryObject(rawEntry, { jobId: row.job_id });
  if (!parsed) {
    return null;
  }
  return {
    ...parsed,
    ts: normalizeNumber(row.ts) ?? parsed.ts,
    jobId: row.job_id,
    status: (row.status as CronRunStatus | null) ?? parsed.status,
    error: row.error ?? parsed.error,
    summary: row.summary ?? parsed.summary,
    delivered: integerToBoolean(row.delivered) ?? parsed.delivered,
    deliveryStatus: (row.delivery_status as CronDeliveryStatus | null) ?? parsed.deliveryStatus,
    deliveryError: row.delivery_error ?? parsed.deliveryError,
    sessionId: row.session_id ?? parsed.sessionId,
    sessionKey: row.session_key ?? parsed.sessionKey,
    runId: row.run_id ?? parsed.runId,
    runAtMs: normalizeNumber(row.run_at_ms) ?? parsed.runAtMs,
    durationMs: normalizeNumber(row.duration_ms) ?? parsed.durationMs,
    nextRunAtMs: normalizeNumber(row.next_run_at_ms) ?? parsed.nextRunAtMs,
    model: row.model ?? parsed.model,
    provider: row.provider ?? parsed.provider,
  };
}

export function readCronRunLogRows(
  db: DatabaseSync,
  storeKey: string,
  jobId?: string,
): CronRunLogRow[] {
  let query = getCronRunLogKysely(db)
    .selectFrom("cron_run_logs")
    .selectAll()
    .where("store_key", "=", storeKey);
  if (jobId) {
    query = query.where("job_id", "=", jobId);
  }
  return executeSqliteQuerySync(db, query.orderBy("ts", "asc").orderBy("seq", "asc")).rows;
}

function buildRunLogWhereClause(params: {
  storeKey: string;
  jobId?: string;
  statuses: CronRunStatus[] | null;
  deliveryStatuses: CronDeliveryStatus[] | null;
  runId?: string;
}): { whereSql: string; values: Array<string | number> } {
  const clauses = ["store_key = ?"];
  const values: Array<string | number> = [params.storeKey];
  if (params.jobId) {
    clauses.push("job_id = ?");
    values.push(params.jobId);
  }
  if (params.statuses?.length) {
    clauses.push(`status IN (${params.statuses.map(() => "?").join(", ")})`);
    values.push(...params.statuses);
  }
  if (params.deliveryStatuses?.length) {
    clauses.push(
      `COALESCE(delivery_status, 'not-requested') IN (${params.deliveryStatuses
        .map(() => "?")
        .join(", ")})`,
    );
    values.push(...params.deliveryStatuses);
  }
  const runId = params.runId?.trim();
  if (runId) {
    clauses.push("run_id = ?");
    values.push(runId);
  }
  return { whereSql: clauses.join(" AND "), values };
}

export function countCronRunLogRows(params: {
  db: DatabaseSync;
  storeKey: string;
  jobId?: string;
  statuses: CronRunStatus[] | null;
  deliveryStatuses: CronDeliveryStatus[] | null;
  runId?: string;
}): number {
  const { whereSql, values } = buildRunLogWhereClause(params);
  const row = params.db
    .prepare(`SELECT COUNT(*) AS count FROM cron_run_logs WHERE ${whereSql}`)
    .get(...values) as { count?: number | bigint } | undefined;
  return normalizeNumber(row?.count ?? null) ?? 0;
}

export function readCronRunLogRowsPage(params: {
  db: DatabaseSync;
  storeKey: string;
  jobId?: string;
  statuses: CronRunStatus[] | null;
  deliveryStatuses: CronDeliveryStatus[] | null;
  runId?: string;
  sortDir: "asc" | "desc";
  offset?: number;
  limit?: number;
}): CronRunLogRow[] {
  const { whereSql, values } = buildRunLogWhereClause(params);
  const order = params.sortDir === "asc" ? "ASC" : "DESC";
  const limitSql =
    params.limit === undefined || params.offset === undefined ? "" : " LIMIT ? OFFSET ?";
  const limitValues =
    params.limit === undefined || params.offset === undefined ? [] : [params.limit, params.offset];
  return params.db
    .prepare(
      `SELECT * FROM cron_run_logs WHERE ${whereSql} ORDER BY ts ${order}, seq ${order}${limitSql}`,
    )
    .all(...values, ...limitValues) as CronRunLogRow[];
}

function nextCronRunLogSeq(db: DatabaseSync, storeKey: string, jobId: string): number {
  const row = db
    .prepare(
      "SELECT COALESCE(MAX(seq), 0) AS seq FROM cron_run_logs WHERE store_key = ? AND job_id = ?",
    )
    .get(storeKey, jobId) as { seq?: number | bigint } | undefined;
  return (normalizeNumber(row?.seq ?? null) ?? 0) + 1;
}

export function insertCronRunLogEntry(
  db: DatabaseSync,
  storeKey: string,
  entry: CronRunLogEntry,
): void {
  const seq = nextCronRunLogSeq(db, storeKey, entry.jobId);
  executeSqliteQuerySync(
    db,
    getCronRunLogKysely(db)
      .insertInto("cron_run_logs")
      .values(bindCronRunLogRow({ storeKey, seq, entry })),
  );
}

export function pruneCronRunLogRows(
  db: DatabaseSync,
  storeKey: string,
  jobId: string,
  keepLines: number,
): void {
  const keep = Math.max(1, Math.floor(keepLines));
  db.prepare(
    `DELETE FROM cron_run_logs
     WHERE store_key = ? AND job_id = ?
       AND seq NOT IN (
         SELECT seq FROM cron_run_logs
         WHERE store_key = ? AND job_id = ?
         ORDER BY seq DESC
         LIMIT ?
       )`,
  ).run(storeKey, jobId, storeKey, jobId, keep);
}
