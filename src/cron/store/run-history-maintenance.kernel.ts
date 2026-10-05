import type { DatabaseSync } from "node:sqlite";
import { sql, type ExpressionBuilder, type Selectable } from "kysely";
import {
  executeSqliteQuerySync,
  getNodeSqliteKysely,
  sqliteStringSet,
} from "../../infra/kysely-sync.js";
import { normalizeSqliteNumber } from "../../infra/sqlite-number.js";
import {
  compareCronRunRecordsNewestFirst,
  parseCronRunDetailJson,
  resolveCronRunRecordTimestamp,
} from "../run-history-detail.js";
import {
  admittedCronRow,
  CRON_HISTORY_KEEP_PER_JOB,
  cronRunRetentionPartition,
  deleteCronRunRowsInDatabase,
  LOST_RETENTION_MS,
  normalizeCronRunTimestamps,
  RETENTION_MS,
  TERMINAL_STATUSES,
  unindexedRuntime,
  unindexedStatus,
  type CronRunHistoryDatabase,
} from "./run-history.kernel.js";
import type { CronRunOverflowCursor, CronRunRecord } from "./run-history.types.js";
import type { CronRunReceiptWriteSchema } from "./run-receipt-write-admission.js";

// Batched retention for Gateway maintenance; whole-table retention stays in run-history.kernel.
const query = (db: DatabaseSync) => getNodeSqliteKysely<CronRunHistoryDatabase>(db);
const CRON_HISTORY_DETAIL_CHUNK = 256;
// Rows one batch may visit while continuing ranked jobs; ranking itself is once per pass.
const CRON_HISTORY_SCAN_BUDGET = 4 * CRON_HISTORY_DETAIL_CHUNK;

// The terminal timestamp normalizeCronRunTimestamps derives for a stored non-active row.
const storedCronRunTimestamp =
  /* kysely-allow-raw: retention evaluates the normalized record timestamp without decoding rows. */
  sql<number>`max(coalesce(ended_at, last_event_at, created_at), coalesce(started_at, ended_at, last_event_at, created_at))`;
const lostCronRunExpiry =
  /* kysely-allow-raw: lost-row expiry mirrors collectExpiredCronRunIds without decoding rows. */
  sql<number>`min(coalesce(cleanup_after, ${storedCronRunTimestamp} + ${LOST_RETENTION_MS}), ${storedCronRunTimestamp} + ${LOST_RETENTION_MS})`;
const undatedCronRunExpiry =
  /* kysely-allow-raw: released rows without cleanup_after expire from their normalized timestamp. */
  sql<number>`${storedCronRunTimestamp} + ${RETENTION_MS}`;

type CronRunRowFilter = (
  eb: ExpressionBuilder<CronRunHistoryDatabase, "task_runs">,
) => ReturnType<typeof admittedCronRow>;

type CronRunOverflowScanRow = Pick<
  Selectable<CronRunHistoryDatabase["task_runs"]>,
  "task_id" | "status" | "created_at" | "started_at" | "ended_at" | "last_event_at"
>;

function normalizeCronRunOverflowRow(jobId: string, row: CronRunOverflowScanRow): CronRunRecord {
  return normalizeCronRunTimestamps({
    id: row.task_id,
    jobId,
    createdAt: normalizeSqliteNumber(row.created_at) ?? 0,
    startedAt: normalizeSqliteNumber(row.started_at),
    endedAt: normalizeSqliteNumber(row.ended_at),
    lastEventAt: normalizeSqliteNumber(row.last_event_at),
    status: row.status,
  });
}

function cronRunOverflowPartition(row: CronRunRecord, detailJson: string | null): string {
  return cronRunRetentionPartition({
    ...row,
    detail: detailJson === null ? undefined : parseCronRunDetailJson(detailJson),
  });
}

/**
 * Ranks one job once and walks it newest first, decoding payloads a chunk at a time until
 * `limit` overflow rows are found or the unread rows can no longer push any partition past
 * the cap. A walk that fills `limit` returns a cursor so later batches of the sweep scan the
 * rest of the backlog without ranking the job again; one that stops short drained the job.
 */
function rankCronRunCapOverflow(
  db: DatabaseSync,
  jobId: string,
  excluded: CronRunRowFilter,
  limit: number,
): { overflow: string[]; cursor?: CronRunOverflowCursor } {
  const ordered = executeSqliteQuerySync(
    db,
    query(db)
      .selectFrom("task_runs")
      .select(["task_id", "status", "created_at", "started_at", "ended_at", "last_event_at"])
      .where("runtime", "=", "cron")
      .where("source_id", "=", jobId)
      .where(unindexedStatus, "in", TERMINAL_STATUSES)
      .where(admittedCronRow)
      .where(excluded),
  )
    .rows.map((row) => normalizeCronRunOverflowRow(jobId, row))
    .toSorted(compareCronRunRecordsNewestFirst);
  const counts = new Map<string, number>();
  const boundaries: CronRunOverflowCursor["boundaries"] = [];
  let largest = 0;
  let offset = 0;
  const overflow: string[] = [];
  // An unseen partition gains at most the unread rows; a seen one cannot pass largest + unread.
  while (
    overflow.length < limit &&
    offset < ordered.length &&
    largest + ordered.length - offset > CRON_HISTORY_KEEP_PER_JOB
  ) {
    const chunk = ordered.slice(offset, offset + CRON_HISTORY_DETAIL_CHUNK);
    offset += chunk.length;
    const details = new Map(
      executeSqliteQuerySync(
        db,
        query(db)
          .selectFrom("task_runs")
          .select(["task_id", "detail_json"])
          .where("task_id", "in", sqliteStringSet(chunk.map((row) => row.id))),
      ).rows.map((row) => [row.task_id, row.detail_json]),
    );
    for (const row of chunk) {
      const partition = cronRunOverflowPartition(row, details.get(row.id) ?? null);
      const count = (counts.get(partition) ?? 0) + 1;
      counts.set(partition, count);
      largest = Math.max(largest, count);
      if (count === CRON_HISTORY_KEEP_PER_JOB) {
        boundaries.push({ partition, row });
      }
      if (count > CRON_HISTORY_KEEP_PER_JOB && overflow.push(row.id) >= limit) {
        break;
      }
    }
  }
  return overflow.length < limit ? { overflow } : { overflow, cursor: { jobId, boundaries } };
}

/**
 * Continues a ranked job oldest first on the (runtime, source_id, ended_at, ...) index,
 * undated rows before dated ones, and stops at the newest boundary. Each visited row is
 * decoded once per sweep; it is overflow when its own partition's boundary is newer, as the
 * ranking decided. Partitions the ranking did not fill wait for the job's next ranking.
 */
function scanCronRunCapOverflow(
  db: DatabaseSync,
  cursor: CronRunOverflowCursor,
  excluded: CronRunRowFilter,
  limit: number,
  budget: number,
): { overflow: string[]; visited: number; next?: CronRunOverflowCursor } {
  const { jobId } = cursor;
  const boundaries = new Map(cursor.boundaries.map(({ partition, row }) => [partition, row]));
  const newest = Math.max(
    ...cursor.boundaries.map(({ row }) => resolveCronRunRecordTimestamp(row)),
  );
  let scan = cursor.scan ?? { dated: false };
  const overflow: string[] = [];
  let visited = 0;
  while (overflow.length < limit && visited < budget) {
    const base = query(db)
      .selectFrom("task_runs")
      .select([
        "task_id",
        "status",
        "created_at",
        "started_at",
        "ended_at",
        "last_event_at",
        "detail_json",
      ])
      .where("runtime", "=", "cron")
      .where("source_id", "=", jobId)
      .where(unindexedStatus, "in", TERMINAL_STATUSES)
      .where(admittedCronRow)
      .where(excluded)
      .where(storedCronRunTimestamp, "<=", newest);
    const position = scan;
    const rows = executeSqliteQuerySync(
      db,
      (position.dated
        ? base
            .where("ended_at", "<=", newest)
            .where((eb) => {
              const after = position.after;
              return after
                ? eb.and([
                    eb("ended_at", ">=", after.endedAt),
                    eb.or([
                      eb("ended_at", ">", after.endedAt),
                      eb("created_at", ">", after.createdAt),
                      eb.and([
                        eb("created_at", "=", after.createdAt),
                        eb("task_id", ">", after.id),
                      ]),
                    ]),
                  ])
                : eb.and([]);
            })
            .orderBy("ended_at", "asc")
        : base.where("ended_at", "is", null).where((eb) => {
            const after = position.after;
            return after
              ? eb.or([
                  eb("created_at", ">", after.createdAt),
                  eb.and([eb("created_at", "=", after.createdAt), eb("task_id", ">", after.id)]),
                ])
              : eb.and([]);
          })
      )
        .orderBy("created_at", "asc")
        .orderBy("task_id", "asc")
        .limit(CRON_HISTORY_DETAIL_CHUNK),
    ).rows;
    for (const stored of rows) {
      visited += 1;
      const row = normalizeCronRunOverflowRow(jobId, stored);
      // The scan position uses stored columns, which the index orders, not normalized times.
      const endedAt = normalizeSqliteNumber(stored.ended_at);
      const createdAt = normalizeSqliteNumber(stored.created_at) ?? 0;
      scan =
        endedAt === undefined
          ? { dated: false, after: { createdAt, id: row.id } }
          : { dated: true, after: { endedAt, createdAt, id: row.id } };
      const boundary = boundaries.get(cronRunOverflowPartition(row, stored.detail_json));
      if (
        boundary &&
        compareCronRunRecordsNewestFirst(row, boundary) > 0 &&
        overflow.push(row.id) >= limit
      ) {
        break;
      }
    }
    if (rows.length < CRON_HISTORY_DETAIL_CHUNK && overflow.length < limit) {
      if (position.dated) {
        return { overflow, visited };
      }
      scan = { dated: true };
    }
  }
  return { overflow, visited, next: { ...cursor, scan } };
}

/**
 * Deletes at most `limit` expired rows inside the caller's transaction. Per-partition
 * overflow goes first, ranked as in pruneCronRunHistoryInDatabase; time expiry then
 * follows cleanup_after, oldest first. Jobs in `settled` had no overflow left earlier in
 * this sweep and are not walked again; jobs in `cursors` continue from their earlier
 * ranking instead of being ranked again. Only admitted rows with known statuses are
 * selected, so rows the kernel cannot decode stay in place instead of failing the sweep.
 */
export function pruneCronRunHistoryBatchInDatabase(
  db: DatabaseSync,
  now: number,
  schema: CronRunReceiptWriteSchema,
  options: {
    limit: number;
    exclude: readonly string[];
    settled?: readonly string[];
    cursors?: readonly CronRunOverflowCursor[];
  },
): { pruned: number; more: boolean; settled: string[]; cursors: CronRunOverflowCursor[] } {
  const { limit, exclude } = options;
  const skipped = new Set(options.settled);
  const excluded: CronRunRowFilter = (eb) =>
    exclude.length === 0 ? eb.and([]) : eb("task_id", "not in", sqliteStringSet(exclude));
  // The (runtime, source_id, ...) index covers this count, so it never reads row payloads.
  const cappedJobIds = executeSqliteQuerySync(
    db,
    query(db)
      .selectFrom("task_runs")
      .select("source_id")
      .where("runtime", "=", "cron")
      .where("source_id", "is not", null)
      .where("source_id", "!=", "")
      .groupBy("source_id")
      .having((eb) => eb.fn.countAll(), ">", CRON_HISTORY_KEEP_PER_JOB),
  ).rows.flatMap((row) => (row.source_id && !skipped.has(row.source_id) ? [row.source_id] : []));
  const carried = new Map(options.cursors?.map((cursor) => [cursor.jobId, cursor]));
  const ids: string[] = [];
  const settled: string[] = [];
  const cursors: CronRunOverflowCursor[] = [];
  let budget = CRON_HISTORY_SCAN_BUDGET;
  let ranked = false;
  let stopped = false;
  for (const jobId of cappedJobIds) {
    const cursor = carried.get(jobId);
    if (stopped || (cursor && budget <= 0)) {
      stopped = true;
      if (cursor) {
        cursors.push(cursor);
      }
      continue;
    }
    if (cursor) {
      const scan = scanCronRunCapOverflow(db, cursor, excluded, limit - ids.length, budget);
      budget -= scan.visited;
      ids.push(...scan.overflow);
      if (scan.next) {
        cursors.push(scan.next);
        stopped = ids.length >= limit;
        continue;
      }
      // A finished scan leaves the job to one more ranking, which settles it once drained.
    }
    // Each batch ranks at most one job; the next job waits for the next batch.
    if (ids.length >= limit || ranked) {
      stopped = true;
      continue;
    }
    ranked = true;
    // Rows this batch already chose are ranked as if deleted; that cannot change other ranks.
    const chosen = [...ids];
    const walk = rankCronRunCapOverflow(
      db,
      jobId,
      (eb) =>
        chosen.length === 0
          ? excluded(eb)
          : eb.and([excluded(eb), eb("task_id", "not in", sqliteStringSet(chosen))]),
      limit - ids.length,
    );
    ids.push(...walk.overflow);
    if (walk.cursor) {
      cursors.push(walk.cursor);
    } else {
      // Deleting overflow never changes another row's rank, so a short walk drains the job.
      settled.push(jobId);
    }
    stopped = ids.length >= limit;
  }
  const pending = stopped || cursors.length > 0;
  const expirySelects = [
    () =>
      query(db)
        .selectFrom("task_runs")
        .select("task_id")
        .where("cleanup_after", "<=", now)
        .where(unindexedRuntime, "=", "cron")
        .where(unindexedStatus, "in", TERMINAL_STATUSES)
        .where(admittedCronRow)
        .where(excluded)
        .orderBy("cleanup_after", "asc")
        .orderBy("task_id", "asc"),
    () =>
      query(db)
        .selectFrom("task_runs")
        .select("task_id")
        .where("runtime", "=", "cron")
        .where("status", "=", "lost")
        .where(lostCronRunExpiry, "<=", now)
        .where(admittedCronRow)
        .where(excluded)
        .orderBy(storedCronRunTimestamp, "asc")
        .orderBy("task_id", "asc"),
    () =>
      query(db)
        .selectFrom("task_runs")
        .select("task_id")
        .where("cleanup_after", "is", null)
        .where(unindexedRuntime, "=", "cron")
        .where(unindexedStatus, "in", TERMINAL_STATUSES)
        .where(undatedCronRunExpiry, "<=", now)
        .where(admittedCronRow)
        .where(excluded)
        .orderBy(storedCronRunTimestamp, "asc")
        .orderBy("task_id", "asc"),
  ];
  // Time expiry starts only after every capped job has been walked and its overflow removed.
  for (const select of expirySelects) {
    if (pending || ids.length >= limit) {
      break;
    }
    // Overflow rows may also be expired; skip them rather than shrinking the batch.
    const taken = new Set(ids);
    ids.push(
      ...executeSqliteQuerySync(db, select().limit(limit - ids.length + taken.size))
        .rows.map((row) => row.task_id)
        .filter((id) => !taken.has(id))
        .slice(0, limit - ids.length),
    );
  }
  deleteCronRunRowsInDatabase(db, schema, ids);
  return { pruned: ids.length, more: pending || ids.length >= limit, settled, cursors };
}
