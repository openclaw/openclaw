import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import { tryCronScheduleIdentity } from "../schedule-identity.js";
import type { CronJob, CronStoreFile } from "../types.js";
import { mergeCronRuntimeStateFields } from "./runtime-merge.js";
import { getCronStoreKysely, type CronJobRow } from "./schema.js";
import { bindStateColumns, stateFromRow } from "./state-codec.js";

/** Applies state-only writes as per-job deltas when another process advanced the partition. */
export function writeCronRuntimeRowDeltas(params: {
  db: DatabaseSync;
  storeKey: string;
  store: CronStoreFile;
  expectedRuntimeRevision?: number;
  currentRuntimeRevision?: number;
  expectedRuntimeStateByJobId?: ReadonlyMap<string, CronJob["state"] | undefined>;
  expectedRuntimeUpdatedAtMsByJobId?: ReadonlyMap<string, number>;
  scheduleIdentityFromRow: (row: CronJobRow) => string | undefined;
  conflictError: () => Error;
  incrementRevision: () => number;
}): number {
  const revisionChanged =
    params.expectedRuntimeRevision !== undefined &&
    params.currentRuntimeRevision !== undefined &&
    params.expectedRuntimeRevision !== params.currentRuntimeRevision;
  const hasRuntimeBaselines =
    params.expectedRuntimeStateByJobId !== undefined &&
    params.expectedRuntimeUpdatedAtMsByJobId !== undefined;
  // Pre-upgrade writers may change rows without advancing the aggregate revision.
  // Per-job baselines still isolate this caller's deltas from those sibling writes.
  const compareCurrentRows = revisionChanged || hasRuntimeBaselines;
  const currentStates = compareCurrentRows
    ? new Map(
        executeSqliteQuerySync(
          params.db,
          getCronStoreKysely(params.db)
            .selectFrom("cron_jobs")
            .selectAll()
            .where("store_key", "=", params.storeKey),
        ).rows.map((row) => [
          row.job_id,
          {
            state: stateFromRow(row),
            updatedAtMs: row.runtime_updated_at_ms ?? row.updated_at,
            persistedScheduleIdentity: row.schedule_identity,
            schedulingIdentity: params.scheduleIdentityFromRow(row),
          },
        ]),
      )
    : undefined;
  // Resolve against a detached store: SQLite may roll back after any row update,
  // and the caller publishes the committed snapshot only after the transaction returns.
  const mergedStore = structuredClone(params.store);
  const runtimeJobsToWrite: CronJob[] = [];
  const scheduleIdentitiesToRepair: Array<{ jobId: string; scheduleIdentity: string | null }> = [];
  for (const job of mergedStore.jobs) {
    if (!compareCurrentRows) {
      runtimeJobsToWrite.push(job);
      continue;
    }
    const current = currentStates?.get(job.id);
    const hasExpectedState = params.expectedRuntimeStateByJobId?.has(job.id) === true;
    const hasExpectedUpdatedAtMs = params.expectedRuntimeUpdatedAtMsByJobId?.has(job.id) === true;
    if (!current || !hasExpectedState || !hasExpectedUpdatedAtMs) {
      if (revisionChanged) {
        throw params.conflictError();
      }
      // A state-only save cannot create or restore a row that lacks the caller's baseline.
      continue;
    }
    const expected = params.expectedRuntimeStateByJobId?.get(job.id) ?? {};
    const expectedUpdatedAtMs = params.expectedRuntimeUpdatedAtMsByJobId!.get(job.id)!;
    const scheduleIdentity =
      tryCronScheduleIdentity(job as unknown as Record<string, unknown>) ?? null;
    if ((current.schedulingIdentity ?? null) !== scheduleIdentity) {
      // The row's current schedule, not its possibly stale identity column, is authoritative.
      throw params.conflictError();
    }
    const localRuntimeChanged =
      !isDeepStrictEqual(job.state ?? {}, expected) || job.updatedAtMs !== expectedUpdatedAtMs;
    if (!localRuntimeChanged) {
      if (current.persistedScheduleIdentity !== scheduleIdentity) {
        scheduleIdentitiesToRepair.push({ jobId: job.id, scheduleIdentity });
      }
      continue;
    }
    const mergedState = mergeCronRuntimeStateFields({
      current: current.state,
      next: job.state ?? {},
      expected,
    });
    if (!mergedState) {
      throw params.conflictError();
    }
    job.state = mergedState;
    job.updatedAtMs = Math.max(job.updatedAtMs, current.updatedAtMs);
    runtimeJobsToWrite.push(job);
  }
  // Resolve every job before the first row write. Direct callers therefore cannot
  // persist an early delta when a later job proves the snapshot is conflicting.
  for (const job of runtimeJobsToWrite) {
    executeSqliteQuerySync(
      params.db,
      getCronStoreKysely(params.db)
        .updateTable("cron_jobs")
        .set({
          ...bindStateColumns(job.state ?? {}),
          state_json: JSON.stringify(job.state ?? {}),
          runtime_updated_at_ms: job.updatedAtMs,
          schedule_identity:
            tryCronScheduleIdentity(job as unknown as Record<string, unknown>) ?? null,
        })
        .where("store_key", "=", params.storeKey)
        .where("job_id", "=", job.id),
    );
  }
  for (const repair of scheduleIdentitiesToRepair) {
    executeSqliteQuerySync(
      params.db,
      getCronStoreKysely(params.db)
        .updateTable("cron_jobs")
        .set({ schedule_identity: repair.scheduleIdentity })
        .where("store_key", "=", params.storeKey)
        .where("job_id", "=", repair.jobId),
    );
  }
  return params.incrementRevision();
}
