import fs from "node:fs";
import { normalizeStoredCronJobs } from "../store-migration.js";
import { loadCronStore, saveCronStore } from "../store.js";
import type { CronJob } from "../types.js";
import {
  computeJobNextRunAtMs,
  recordScheduleComputeError,
  recomputeNextRuns,
  shouldTreatUndefinedNextRunAsScheduleError,
} from "./jobs.js";
import { schedulesEqual } from "./schedule-equality.js";
import type { CronServiceState } from "./state.js";

async function getFileMtimeMs(path: string): Promise<number | null> {
  try {
    const stats = await fs.promises.stat(path);
    return stats.mtimeMs;
  } catch {
    return null;
  }
}

function resolveExternalRepairComputeBaseMs(params: {
  nowMs: number;
  fileMtimeMs: number | null;
  reloadedUpdatedAtMs: number;
  previousUpdatedAtMs: number;
  previousEnabled: boolean;
  reloadedEnabled: boolean;
}): number {
  const {
    nowMs,
    fileMtimeMs,
    reloadedUpdatedAtMs,
    previousUpdatedAtMs,
    previousEnabled,
    reloadedEnabled,
  } = params;
  const normalizedFileMtimeMs =
    typeof fileMtimeMs === "number" && Number.isFinite(fileMtimeMs)
      ? Math.max(0, Math.floor(fileMtimeMs))
      : Number.NEGATIVE_INFINITY;
  if (reloadedEnabled && !previousEnabled) {
    return nowMs;
  }
  if (!Number.isFinite(reloadedUpdatedAtMs)) {
    return Number.isFinite(normalizedFileMtimeMs) ? Math.min(nowMs, normalizedFileMtimeMs) : nowMs;
  }
  const normalizedReloadedUpdatedAtMs = Math.max(0, Math.floor(reloadedUpdatedAtMs));
  const normalizedPreviousUpdatedAtMs = Number.isFinite(previousUpdatedAtMs)
    ? Math.max(0, Math.floor(previousUpdatedAtMs))
    : Number.NEGATIVE_INFINITY;
  if (normalizedReloadedUpdatedAtMs <= normalizedPreviousUpdatedAtMs) {
    if (normalizedFileMtimeMs > normalizedPreviousUpdatedAtMs) {
      return Math.min(nowMs, normalizedFileMtimeMs);
    }
    return nowMs;
  }
  return Math.min(nowMs, normalizedReloadedUpdatedAtMs);
}

function repairNextRunsAfterExternalReload(params: {
  state: CronServiceState;
  previousJobs: CronJob[] | undefined;
}): boolean {
  const { state, previousJobs } = params;
  const skipRecomputeJobIds = state.skipNextReloadRepairRecomputeJobIds;
  if (!state.store || previousJobs === undefined) {
    return false;
  }
  if (skipRecomputeJobIds.size > 0) {
    const currentJobIds = new Set(state.store.jobs.map((job) => job.id));
    for (const jobId of skipRecomputeJobIds) {
      if (!currentJobIds.has(jobId)) {
        skipRecomputeJobIds.delete(jobId);
      }
    }
  }

  const previousById = new Map(previousJobs.map((job) => [job.id, job]));
  const now = state.deps.nowMs();
  let changed = false;

  for (const job of state.store.jobs) {
    const previous = previousById.get(job.id);
    if (!previous) {
      continue;
    }
    if (
      typeof previous.state.runningAtMs === "number" &&
      (typeof job.state.runningAtMs !== "number" ||
        job.state.runningAtMs !== previous.state.runningAtMs)
    ) {
      job.state.runningAtMs = previous.state.runningAtMs;
      changed = true;
    }

    const scheduleChanged = !schedulesEqual(previous.schedule, job.schedule);
    const enabledChanged = previous.enabled !== job.enabled;
    if (!scheduleChanged && !enabledChanged) {
      continue;
    }

    skipRecomputeJobIds.delete(job.id);
    const computeBaseMs = resolveExternalRepairComputeBaseMs({
      nowMs: now,
      fileMtimeMs: state.storeFileMtimeMs,
      reloadedUpdatedAtMs: job.updatedAtMs,
      previousUpdatedAtMs: previous.updatedAtMs,
      previousEnabled: previous.enabled,
      reloadedEnabled: job.enabled,
    });
    let nextRunAtMs: number | undefined;
    try {
      nextRunAtMs = job.enabled ? computeJobNextRunAtMs(job, computeBaseMs) : undefined;
      if (nextRunAtMs === undefined && shouldTreatUndefinedNextRunAsScheduleError(job)) {
        const err =
          job.schedule.kind === "every"
            ? new Error("invalid every schedule: everyMs must be a finite number")
            : job.schedule.kind === "at"
              ? new Error("invalid at schedule: at must be a valid absolute timestamp")
              : new Error("invalid cron schedule: expr is required");
        if (recordScheduleComputeError({ state, job, err })) {
          changed = true;
        }
        skipRecomputeJobIds.add(job.id);
        continue;
      }
      if (job.enabled && job.state.scheduleErrorCount !== undefined) {
        job.state.scheduleErrorCount = undefined;
        changed = true;
      }
    } catch (err) {
      if (recordScheduleComputeError({ state, job, err })) {
        changed = true;
      }
      skipRecomputeJobIds.add(job.id);
      continue;
    }
    if (job.state.nextRunAtMs !== nextRunAtMs) {
      job.state.nextRunAtMs = nextRunAtMs;
      changed = true;
    }
    if (!job.enabled && job.state.runningAtMs !== undefined) {
      job.state.runningAtMs = undefined;
      changed = true;
    }

    state.deps.log.debug(
      {
        jobId: job.id,
        scheduleChanged,
        enabledChanged,
        computeBaseMs,
        nextRunAtMs: job.state.nextRunAtMs,
      },
      "cron: repaired nextRunAtMs after external reload",
    );
  }

  return changed;
}

export async function ensureLoaded(
  state: CronServiceState,
  opts?: {
    forceReload?: boolean;
    /** Skip recomputing nextRunAtMs after load so the caller can run due
     *  jobs against the persisted values first (see onTimer). */
    skipRecompute?: boolean;
  },
) {
  // Fast path: store is already in memory. Other callers (add, list, run, …)
  // trust the in-memory copy to avoid a stat syscall on every operation.
  if (state.store && !opts?.forceReload) {
    return;
  }
  // Force reload always re-reads the file to avoid missing cross-service
  // edits on filesystems with coarse mtime resolution.

  const previousJobs = state.store?.jobs;
  const fileMtimeMs = await getFileMtimeMs(state.deps.storePath);
  const loaded = await loadCronStore(state.deps.storePath);
  const jobs = (loaded.jobs ?? []) as unknown as Array<Record<string, unknown>>;
  const { mutated } = normalizeStoredCronJobs(jobs);
  state.store = { version: 1, jobs: jobs as unknown as CronJob[] };
  state.storeLoadedAtMs = state.deps.nowMs();
  state.storeFileMtimeMs = fileMtimeMs;
  const repairedExternalReload = repairNextRunsAfterExternalReload({
    state,
    previousJobs,
  });

  if (!opts?.skipRecompute) {
    recomputeNextRuns(state);
  }

  if (mutated || repairedExternalReload) {
    await persist(state, { skipBackup: true });
  }
}

export function warnIfDisabled(state: CronServiceState, action: string) {
  if (state.deps.cronEnabled) {
    return;
  }
  if (state.warnedDisabled) {
    return;
  }
  state.warnedDisabled = true;
  state.deps.log.warn(
    { enabled: false, action, storePath: state.deps.storePath },
    "cron: scheduler disabled; jobs will not run automatically",
  );
}

export async function persist(state: CronServiceState, opts?: { skipBackup?: boolean }) {
  if (!state.store) {
    return;
  }
  await saveCronStore(state.deps.storePath, state.store, opts);
  // Update file mtime after save to prevent immediate reload
  state.storeFileMtimeMs = await getFileMtimeMs(state.deps.storePath);
}
