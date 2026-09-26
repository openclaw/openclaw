import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { normalizeSqliteNumber } from "../../infra/sqlite-number.js";
import type { DB } from "../../state/openclaw-state-db.generated.js";
import {
  cronRunRecordStoreKey,
  cronRunRecordToRunLogEntry,
  parseCronRunDetailJson,
  resolveCronRunRecordTimestamp,
} from "../run-history-detail.js";
import type { CronRunHistoryWrite, CronRunRecord } from "./run-history.types.js";
import type { CronRunReceiptWriteSchema } from "./run-receipt-write-admission.js";

const query = (db: DatabaseSync) =>
  getNodeSqliteKysely<Pick<DB, "task_runs" | "execution_owner_lifecycle_bindings">>(db);
const RETENTION_MS = 7 * 24 * 60 * 60_000;
const LOST_RETENTION_MS = 24 * 60 * 60_000;
const CRON_HISTORY_KEEP_PER_JOB = 2000;

function validateRetainedEnum(value: string, allowed: readonly string[], label: string): void {
  if (!allowed.includes(value)) {
    throw new Error(`Invalid persisted task ${label}: ${JSON.stringify(value)}`);
  }
}

function normalizeCronRunTimestamps(record: CronRunRecord): CronRunRecord {
  const originalCreatedAt = record.createdAt;
  let createdAt = originalCreatedAt;
  let startedAt = record.startedAt;
  let endedAt = record.endedAt;
  let lastEventAt = record.lastEventAt;
  // Retain the old lifecycle floor and synthesize terminal times before recovery or pruning.
  for (const candidate of [startedAt, lastEventAt, endedAt]) {
    if (candidate !== undefined && candidate < createdAt) {
      createdAt = candidate;
    }
  }
  if (startedAt !== undefined) {
    startedAt = Math.max(startedAt, createdAt);
  }
  if (record.status !== "queued" && record.status !== "running") {
    endedAt ??= lastEventAt ?? originalCreatedAt;
  }
  if (endedAt !== undefined) {
    endedAt = Math.max(endedAt, startedAt ?? createdAt);
  }
  if (lastEventAt !== undefined) {
    lastEventAt = Math.max(lastEventAt, endedAt ?? startedAt ?? createdAt);
  }
  return { ...record, createdAt, startedAt, endedAt, lastEventAt };
}

/** Reads only Cron facts from the admitted released table, without restoring Tasks. */
export function readCronRunRecordsInDatabase(db: DatabaseSync, jobId?: string): CronRunRecord[] {
  let select = query(db)
    .selectFrom("task_runs")
    .select([
      "task_id",
      "source_id",
      "run_id",
      "agent_id",
      "child_session_key",
      "created_at",
      "started_at",
      "ended_at",
      "last_event_at",
      "cleanup_after",
      "status",
      "scope_kind",
      "delivery_status",
      "notify_policy",
      "terminal_outcome",
      "error",
      "terminal_summary",
      "detail_json",
    ])
    .where("runtime", "=", "cron")
    .orderBy("created_at", "asc")
    .orderBy("task_id", "asc");
  if (jobId !== undefined) {
    select = select.where("source_id", "=", jobId);
  }
  return executeSqliteQuerySync(db, select).rows.map((row) => {
    // These released columns remain part of row admission even when Cron does not expose them.
    validateRetainedEnum(row.scope_kind, ["session", "system"], "scope kind");
    if (row.terminal_outcome !== null && row.terminal_outcome !== "") {
      validateRetainedEnum(row.terminal_outcome, ["succeeded", "blocked"], "terminal outcome");
    }
    validateRetainedEnum(
      row.status,
      ["queued", "running", "succeeded", "failed", "timed_out", "cancelled", "lost"],
      "status",
    );
    validateRetainedEnum(
      row.delivery_status,
      [
        "pending",
        "delivered",
        "session_queued",
        "failed",
        "dismissed",
        "parent_missing",
        "not_applicable",
      ],
      "delivery status",
    );
    validateRetainedEnum(
      row.notify_policy,
      ["done_only", "state_changes", "silent"],
      "notify policy",
    );

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
      cleanupAfter: normalizeSqliteNumber(row.cleanup_after),
      status: row.status,
      error: row.error || undefined,
      summary: row.terminal_summary ?? undefined,
      detail: row.detail_json === null ? undefined : parseCronRunDetailJson(row.detail_json),
    });
  });
}

/** Caller owns the exact transaction. History never authorizes execution or receipt adoption. */
export function recordCronRunInDatabase(db: DatabaseSync, input: CronRunHistoryWrite): void {
  const existing = readCronRunRecordsInDatabase(db, input.jobId).find(
    (row) =>
      row.runId === input.runId &&
      (cronRunRecordStoreKey(row) === input.storeKey ||
        (row.detail === undefined && row.runId === `cron:${input.jobId}:${input.startedAt}`)),
  );
  // Late incompatible outcomes cannot replace a terminal result. The same outcome may
  // gain its public manual-run ID and post-commit delivery facts on the final event.
  if (
    existing?.endedAt !== undefined &&
    existing.status !== "lost" &&
    existing.status !== "cancelled" &&
    existing.status !== input.status &&
    cronRunRecordToRunLogEntry(existing)
  ) {
    return;
  }
  const terminal = {
    child_session_key: input.sessionKey ?? null,
    status: existing?.status === "cancelled" ? "cancelled" : input.status,
    ended_at: input.endedAt,
    last_event_at: input.endedAt,
    cleanup_after: input.endedAt + RETENTION_MS,
    error: existing?.status === "cancelled" ? (existing.error ?? null) : (input.error ?? null),
    terminal_summary: input.summary ?? existing?.summary ?? null,
    detail_json: JSON.stringify(input.detail),
  };
  if (existing) {
    executeSqliteQuerySync(
      db,
      query(db)
        .updateTable("task_runs")
        .set(terminal)
        .where("task_id", "=", existing.id)
        .where("runtime", "=", "cron"),
    );
  } else {
    executeSqliteQuerySync(
      db,
      query(db)
        .insertInto("task_runs")
        .values({
          task_id: randomUUID(),
          runtime: "cron",
          task_kind: "automation_run",
          requester_session_key: "",
          owner_key: "",
          scope_kind: "system",
          task: input.jobId,
          delivery_status: "not_applicable",
          notify_policy: "silent",
          source_id: input.jobId,
          agent_id: input.agentId ?? null,
          run_id: input.runId,
          created_at: input.startedAt,
          started_at: input.startedAt,
          ...terminal,
        }),
    );
  }
}

/** Same seven-day/lost-day and separate history/quiet-count bounds as released cron rows. */
function collectExpiredCronRunIds(records: readonly CronRunRecord[], now: number): Set<string> {
  const expired = new Set<string>();
  const partitions = new Map<string, CronRunRecord[]>();
  for (const row of records) {
    if (row.status === "queued" || row.status === "running") {
      continue;
    }
    const timestamp = resolveCronRunRecordTimestamp(row);
    const defaultExpiry = timestamp + (row.status === "lost" ? LOST_RETENTION_MS : RETENTION_MS);
    const expiry =
      row.cleanupAfter === undefined
        ? defaultExpiry
        : row.status === "lost"
          ? Math.min(row.cleanupAfter, defaultExpiry)
          : row.cleanupAfter;
    if (now >= expiry) {
      expired.add(row.id);
    }
    // Released rows without a job identity retain only their time-based expiry.
    if (row.status === "lost" || !row.jobId) {
      continue;
    }
    const key = JSON.stringify([
      cronRunRecordStoreKey(row),
      row.jobId,
      isRecord(row.detail) && row.detail.kind === "cron-run",
    ]);
    const partition = partitions.get(key) ?? [];
    partition.push(row);
    partitions.set(key, partition);
  }
  for (const rows of partitions.values()) {
    rows.sort(
      (a, b) =>
        resolveCronRunRecordTimestamp(b) - resolveCronRunRecordTimestamp(a) ||
        b.createdAt - a.createdAt ||
        b.id.localeCompare(a.id),
    );
    for (const row of rows.slice(CRON_HISTORY_KEEP_PER_JOB)) {
      expired.add(row.id);
    }
  }
  return expired;
}

export function pruneCronRunHistoryInDatabase(
  db: DatabaseSync,
  now: number,
  schema: CronRunReceiptWriteSchema,
  records = readCronRunRecordsInDatabase(db),
): number {
  const ids = [...collectExpiredCronRunIds(records, now)];
  for (let offset = 0; offset < ids.length; offset += 500) {
    const batch = ids.slice(offset, offset + 500);
    executeSqliteQuerySync(
      db,
      // Canonical task_delivery_state.task_id uses ON DELETE CASCADE on this admitted handle.
      query(db).deleteFrom("task_runs").where("runtime", "=", "cron").where("task_id", "in", batch),
    );
    if (schema.executionOwnerLifecycleBindings) {
      // Released Cron rows used task identities; receipt and retired-feature bindings are separate.
      executeSqliteQuerySync(
        db,
        query(db)
          .deleteFrom("execution_owner_lifecycle_bindings")
          .where("owner_kind", "=", "task")
          .where("owner_id", "in", batch),
      );
    }
  }
  return ids.length;
}

/** Caller holds the transaction and retains live job/receipt decisions through commit. */
export function reconcileCronRunHistoryInDatabase(
  db: DatabaseSync,
  records: readonly CronRunRecord[],
  now: number,
  protectedJobIds: ReadonlySet<string>,
): Set<string> {
  const key = (row: CronRunRecord) =>
    JSON.stringify([cronRunRecordStoreKey(row), row.jobId, row.runId]);
  const firstByRun = new Map<string, CronRunRecord>();
  for (const row of records) {
    if (row.jobId?.trim() && row.runId?.trim() && !firstByRun.has(key(row))) {
      firstByRun.set(key(row), row);
    }
  }
  const reconciled = new Set<string>();
  for (const row of records) {
    const active = row.status === "queued" || row.status === "running";
    const recoverableLost =
      row.status === "lost" && row.error?.trim().toLowerCase().includes("backing session missing");
    if ((!active && !recoverableLost) || protectedJobIds.has(row.jobId?.trim() ?? "")) {
      continue;
    }
    // SQL supplies the former creation/id order. Unscoped rows match only other unscoped rows.
    const candidate = row.jobId?.trim() && row.runId?.trim() ? firstByRun.get(key(row)) : undefined;
    const recovery =
      candidate && ["succeeded", "failed", "timed_out", "cancelled"].includes(candidate.status)
        ? candidate
        : undefined;
    let next: CronRunRecord;
    if (recovery) {
      const endedAt = resolveCronRunRecordTimestamp(recovery);
      next = normalizeCronRunTimestamps({
        ...row,
        status: recovery.status,
        endedAt,
        lastEventAt: Math.max(row.lastEventAt ?? -Infinity, recovery.lastEventAt ?? endedAt),
        error: recovery.error,
        summary: recovery.summary ?? row.summary,
        detail: recovery.detail === undefined ? row.detail : recovery.detail,
      });
      next.cleanupAfter ??= resolveCronRunRecordTimestamp(next) + RETENTION_MS;
    } else {
      if (!active || now - (row.lastEventAt ?? row.startedAt ?? row.createdAt) < 5 * 60_000) {
        continue;
      }
      const endedAt = row.endedAt ?? now;
      const expiry = endedAt + LOST_RETENTION_MS;
      next = normalizeCronRunTimestamps({
        ...row,
        status: "lost",
        endedAt,
        lastEventAt: Math.max(now, row.lastEventAt ?? -Infinity),
        cleanupAfter: Math.min(row.cleanupAfter ?? expiry, expiry),
        error: row.error ?? "backing session missing",
      });
    }
    executeSqliteQuerySync(
      db,
      query(db)
        .updateTable("task_runs")
        .set({
          status: next.status,
          created_at: next.createdAt,
          started_at: next.startedAt ?? null,
          ended_at: next.endedAt ?? null,
          last_event_at: next.lastEventAt ?? null,
          cleanup_after: next.cleanupAfter ?? null,
          error: next.error ?? null,
          terminal_summary: next.summary ?? null,
          detail_json: next.detail === undefined ? null : JSON.stringify(next.detail),
        })
        .where("runtime", "=", "cron")
        .where("task_id", "=", row.id),
    );
    reconciled.add(row.id);
  }
  return reconciled;
}
