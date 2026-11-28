import { safeParseJsonRecord } from "@openclaw/normalization-core/json-coercion";
import { executeSqliteQuerySync, sqliteStringSet } from "../../infra/kysely-sync.js";
import type { EngineConnection } from "../../infra/sql-connection.js";
import { tableExists } from "../../state/openclaw-state-db-schema-helpers.js";
import { parseAbsoluteTimeMs } from "../parse.js";
import { normalizeCronRunDiagnosticsCore } from "../run-diagnostics-normalize.js";
import { createCronExecutionId } from "../run-id.js";
import type { CronStoredJob } from "../types.js";
import { parseCronScheduledRunId } from "./run-request-id.js";
import { getCronStoreKysely } from "./schema.js";

/** Project an older timed occurrence onto the decoded jobs only when its scheduled receipt still exists. */
export function restoreLegacyTimedEnds(
  db: EngineConnection,
  storeKey: string,
  jobs: Iterable<CronStoredJob>,
) {
  const candidates = new Map<string, { job: CronStoredJob; at: number; lastRunAtMs: number }>();
  for (const job of jobs) {
    const state = job.state;
    if (
      job.enabled !== false ||
      job.schedule.kind !== "at" ||
      state.oneShotEnded !== undefined ||
      state.lastRunAtMs === undefined ||
      state.nextRunAtMs !== undefined ||
      state.autoDisabled ||
      state.admissionDeferred ||
      state.lastRunAtMs < (state.scheduleActivatedAtMs ?? 0)
    ) {
      continue;
    }
    const at = parseAbsoluteTimeMs(job.schedule.at);
    if (at !== null && state.lastRunAtMs >= at && state.forcePreservedNextRunAtMs !== at) {
      candidates.set(job.id, { job, at, lastRunAtMs: state.lastRunAtMs });
    }
  }
  if (!candidates.size || !tableExists(db, "cron_run_receipts") || !tableExists(db, "task_runs")) {
    return [];
  }
  // Terminal receipt history is bounded per job. A later manual run does not replace a scheduled end.
  const receipts = executeSqliteQuerySync(
    db,
    getCronStoreKysely(db)
      .selectFrom("cron_run_receipts")
      .select(["job_id", "receipt_id", "started_at_ms", "status"])
      .where("store_key", "=", storeKey)
      .where("job_id", "in", sqliteStringSet([...candidates.keys()]))
      .where("status", "in", ["ok", "error", "interrupted", "skipped"])
      .orderBy("job_id")
      .orderBy("started_at_ms", "desc")
      .orderBy("receipt_id", "desc"),
  ).rows;
  const latest = new Map<string, { job: CronStoredJob; skipped: boolean }>();
  for (const receipt of receipts) {
    const candidate = candidates.get(receipt.job_id);
    if (
      !candidate ||
      receipt.started_at_ms < (candidate.job.state.scheduleActivatedAtMs ?? 0) ||
      receipt.started_at_ms > candidate.lastRunAtMs
    ) {
      continue;
    }
    const slot = parseCronScheduledRunId(receipt.receipt_id);
    if (
      slot?.storeKey !== storeKey ||
      slot.jobId !== receipt.job_id ||
      slot.scheduledSlotMs < candidate.at
    ) {
      continue;
    }
    // A newer scheduled attempt supersedes earlier evidence, including a skip.
    candidates.delete(receipt.job_id);
    const runId = `${createCronExecutionId(receipt.job_id, receipt.started_at_ms)}:${receipt.receipt_id}`;
    latest.set(runId, { job: candidate.job, skipped: receipt.status === "skipped" });
  }
  if (!latest.size) {
    return [];
  }
  // The settled task records whether the scheduler armed a retry or a continuation.
  const records = executeSqliteQuerySync(
    db,
    getCronStoreKysely(db)
      .selectFrom("task_runs")
      // Stored JSON text may contain escape sequences PostgreSQL jsonb cannot represent.
      .select(["run_id", "detail_json"])
      .where("runtime", "=", "cron")
      .where("run_id", "in", sqliteStringSet([...latest.keys()]))
      .where("ended_at", "is not", null),
  ).rows;
  const recovered: CronStoredJob[] = [];
  for (const record of records) {
    const occurrence = record.run_id && latest.get(record.run_id);
    const detail = record.detail_json && safeParseJsonRecord(record.detail_json);
    if (
      !occurrence ||
      !detail ||
      detail.kind !== "cron-run" ||
      detail.storeKey !== storeKey ||
      detail.nextRunAtMs != null
    ) {
      continue;
    }
    // An explicit provider preflight is terminal here. Other old skips can be parent pauses.
    if (
      occurrence.skipped &&
      (detail.status !== "skipped" ||
        !normalizeCronRunDiagnosticsCore(detail.diagnostics)?.entries?.some(
          (entry) => entry.source === "model-preflight" || entry.source === "cron-preflight",
        ))
    ) {
      continue;
    }
    occurrence.job.state.oneShotEnded = true;
    recovered.push(occurrence.job);
  }
  return recovered;
}
