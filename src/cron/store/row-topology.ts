import { isDeepStrictEqual } from "node:util";
import { stableStringify } from "../../agents/stable-stringify.js";
import type { CronJob, CronStoreFile } from "../types.js";
import { parseJsonObject } from "./scalar-codec.js";
import type { CronJobRow } from "./schema.js";

/** Fingerprints persisted topology while excluding mutable runtime columns. */
export function cronRowTopologyFingerprint(row: CronJobRow): string {
  const {
    store_key: _storeKey,
    updated_at: _updatedAt,
    next_run_at_ms: _nextRunAtMs,
    running_at_ms: _runningAtMs,
    last_run_at_ms: _lastRunAtMs,
    last_run_status: _lastRunStatus,
    last_error: _lastError,
    last_duration_ms: _lastDurationMs,
    consecutive_errors: _consecutiveErrors,
    consecutive_skipped: _consecutiveSkipped,
    schedule_error_count: _scheduleErrorCount,
    last_delivery_status: _lastDeliveryStatus,
    last_delivery_error: _lastDeliveryError,
    last_delivered: _lastDelivered,
    last_failure_alert_at_ms: _lastFailureAlertAtMs,
    state_json: _stateJson,
    runtime_updated_at_ms: _runtimeUpdatedAtMs,
    schedule_identity: _scheduleIdentity,
    ...topologyRow
  } = row;
  const jobJson = parseJsonObject<Record<string, unknown>>(row.job_json, {});
  delete jobJson.state;
  delete jobJson.updatedAtMs;
  return stableStringify({ ...topologyRow, job_json: jobJson });
}

function cronJobTopologyProjection(job: CronJob): Record<string, unknown> {
  const { state: _state, updatedAtMs: _updatedAtMs, ...projected } = job;
  if (job.schedule.kind === "every" && job.schedule.anchorMs === undefined) {
    projected.schedule = { ...job.schedule, anchorMs: job.createdAtMs };
  }
  return projected;
}

function cronRowTopologyMatches(params: {
  row: CronJobRow;
  job: CronJob;
  normalizeJob: (job: CronJob) => CronJob | null;
  loadRow: (row: CronJobRow) => {
    job?: CronJob;
    configJob?: Record<string, unknown>;
  };
}): boolean {
  const current = params.loadRow(params.row);
  const normalizedCurrent = current.job ? params.normalizeJob(current.job) : null;
  const normalizedCurrentConfig = current.configJob
    ? params.normalizeJob(current.configJob as CronJob)
    : null;
  return Boolean(
    normalizedCurrent &&
    normalizedCurrentConfig &&
    normalizedCurrent.id === params.job.id &&
    isDeepStrictEqual(
      cronJobTopologyProjection(normalizedCurrent),
      cronJobTopologyProjection(params.job),
    ) &&
    isDeepStrictEqual(
      cronJobTopologyProjection(normalizedCurrentConfig),
      cronJobTopologyProjection(params.job),
    ),
  );
}

export function cronStoreTopologyMatches(params: {
  rows: CronJobRow[];
  store: CronStoreFile;
  normalizeJob: (job: CronJob) => CronJob | null;
  loadRow: (row: CronJobRow) => {
    job?: CronJob;
    configJob?: Record<string, unknown>;
  };
}): boolean {
  if (params.rows.length !== params.store.jobs.length) {
    return false;
  }
  return params.store.jobs.every((job, index) => {
    const row = params.rows[index];
    const normalized = params.normalizeJob(job);
    return Boolean(
      row &&
      normalized &&
      cronRowTopologyMatches({
        row,
        job: normalized,
        normalizeJob: params.normalizeJob,
        loadRow: params.loadRow,
      }),
    );
  });
}
