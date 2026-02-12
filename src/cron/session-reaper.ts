/**
 * Cron session reaper — prunes completed isolated cron run sessions
 * from the session store after a configurable retention period and
 * caps the number of run records per job to prevent unbounded growth.
 *
 * Pattern: sessions keyed as `...:cron:<jobId>:run:<uuid>` are ephemeral
 * run records. The base session (`...:cron:<jobId>`) is kept as-is.
 */

import type { CronConfig } from "../config/types.cron.js";
import type { Logger } from "./service/state.js";
import { parseDurationMs } from "../cli/parse-duration.js";
import { updateSessionStore } from "../config/sessions.js";
import { isCronRunSessionKey, parseCronRunJobId } from "../sessions/session-key-utils.js";

const DEFAULT_RETENTION_MS = 24 * 3_600_000; // 24 hours
const DEFAULT_MAX_RUNS_PER_JOB = 50;

/** Minimum interval between reaper sweeps (avoid running every timer tick). */
const MIN_SWEEP_INTERVAL_MS = 5 * 60_000; // 5 minutes

const lastSweepAtMsByStore = new Map<string, number>();

export function resolveRetentionMs(cronConfig?: CronConfig): number | null {
  if (cronConfig?.sessionRetention === false) {
    return null; // pruning disabled
  }
  const raw = cronConfig?.sessionRetention;
  if (typeof raw === "string" && raw.trim()) {
    try {
      return parseDurationMs(raw.trim(), { defaultUnit: "h" });
    } catch {
      return DEFAULT_RETENTION_MS;
    }
  }
  return DEFAULT_RETENTION_MS;
}

export function resolveMaxRunsPerJob(cronConfig?: CronConfig): number {
  const raw = cronConfig?.maxRunsPerJob;
  if (typeof raw === "number" && raw > 0 && Number.isFinite(raw)) {
    return Math.floor(raw);
  }
  return DEFAULT_MAX_RUNS_PER_JOB;
}

export type ReaperResult = {
  swept: boolean;
  pruned: number;
};

/**
 * Cap the number of run sessions per cron job, keeping only the most recent N.
 * Mutates `store` in-place. Returns the number of entries removed.
 */
export function capRunsPerJob(store: Record<string, unknown>, maxRunsPerJob: number): number {
  // Group cron run keys by job ID.
  const jobRuns = new Map<string, Array<{ key: string; updatedAt: number }>>();
  for (const key of Object.keys(store)) {
    if (!isCronRunSessionKey(key)) {
      continue;
    }
    const jobId = parseCronRunJobId(key);
    if (!jobId) {
      continue;
    }
    const entry = store[key] as { updatedAt?: number } | undefined;
    if (!entry) {
      continue;
    }
    let runs = jobRuns.get(jobId);
    if (!runs) {
      runs = [];
      jobRuns.set(jobId, runs);
    }
    runs.push({ key, updatedAt: entry.updatedAt ?? 0 });
  }

  let removed = 0;
  for (const runs of jobRuns.values()) {
    if (runs.length <= maxRunsPerJob) {
      continue;
    }
    // Sort descending by updatedAt (newest first).
    runs.sort((a, b) => b.updatedAt - a.updatedAt);
    // Remove excess (oldest) entries.
    for (let i = maxRunsPerJob; i < runs.length; i++) {
      delete store[runs[i].key];
      removed++;
    }
  }

  return removed;
}

/**
 * Sweep the session store and prune expired cron run sessions.
 * Designed to be called from the cron timer tick — self-throttles via
 * MIN_SWEEP_INTERVAL_MS to avoid excessive I/O.
 *
 * Two-phase pruning:
 *   1. TTL-based expiry — remove runs older than the retention window.
 *   2. Per-job cap — keep only the N most recent runs per cron job.
 *
 * Lock ordering: this function acquires the session-store file lock via
 * `updateSessionStore`. It must be called OUTSIDE of the cron service's
 * own `locked()` section to avoid lock-order inversions. The cron timer
 * calls this after all `locked()` sections have been released.
 */
export async function sweepCronRunSessions(params: {
  cronConfig?: CronConfig;
  /** Resolved path to sessions.json — required. */
  sessionStorePath: string;
  nowMs?: number;
  log: Logger;
  /** Override for testing — skips the min-interval throttle. */
  force?: boolean;
}): Promise<ReaperResult> {
  const now = params.nowMs ?? Date.now();
  const storePath = params.sessionStorePath;
  const lastSweepAtMs = lastSweepAtMsByStore.get(storePath) ?? 0;

  // Throttle: don't sweep more often than every 5 minutes.
  if (!params.force && now - lastSweepAtMs < MIN_SWEEP_INTERVAL_MS) {
    return { swept: false, pruned: 0 };
  }

  const retentionMs = resolveRetentionMs(params.cronConfig);
  const maxRunsPerJob = resolveMaxRunsPerJob(params.cronConfig);

  let pruned = 0;
  try {
    await updateSessionStore(storePath, (store) => {
      // Phase 1: TTL-based expiry.
      if (retentionMs !== null) {
        const cutoff = now - retentionMs;
        for (const key of Object.keys(store)) {
          if (!isCronRunSessionKey(key)) {
            continue;
          }
          const entry = store[key];
          if (!entry) {
            continue;
          }
          const updatedAt = entry.updatedAt ?? 0;
          if (updatedAt < cutoff) {
            delete store[key];
            pruned++;
          }
        }
      }

      // Phase 2: per-job cap (removes oldest runs when a job exceeds maxRunsPerJob).
      pruned += capRunsPerJob(store, maxRunsPerJob);
    });
  } catch (err) {
    params.log.warn({ err: String(err) }, "cron-reaper: failed to sweep session store");
    return { swept: false, pruned: 0 };
  }

  lastSweepAtMsByStore.set(storePath, now);

  if (pruned > 0) {
    params.log.info(
      { pruned, retentionMs, maxRunsPerJob },
      `cron-reaper: pruned ${pruned} expired cron run session(s)`,
    );
  }

  return { swept: true, pruned };
}

/** Reset the throttle timer (for tests). */
export function resetReaperThrottle(): void {
  lastSweepAtMsByStore.clear();
}
