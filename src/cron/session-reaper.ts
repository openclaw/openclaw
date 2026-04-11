/**
 * Cron session reaper — prunes completed isolated cron run sessions
 * from the session store after a configurable retention period.
 *
 * Pattern: sessions keyed as `...:cron:<jobId>:run:<uuid>` are ephemeral
 * run records. The base session (`...:cron:<jobId>`) is kept as-is.
 */

import { parseDurationMs } from "../cli/parse-duration.js";
import { loadSessionStore } from "../config/sessions/store-load.js";
import { archiveRemovedSessionTranscripts, updateSessionStore } from "../config/sessions/store.js";
import type { CronConfig } from "../config/types.cron.js";
import { cleanupArchivedSessionTranscripts } from "../gateway/session-utils.fs.js";
import { isCronRunSessionKey } from "../sessions/session-key-utils.js";
import type { Logger } from "./service/state.js";

const DEFAULT_RETENTION_MS = 24 * 3_600_000; // 24 hours

/**
 * How long a cron:run session may stay in status="running" before the reaper
 * assumes the gateway crashed mid-run and marks it done.  Two hours covers
 * any realistic cron job while still cleaning up within a reasonable window
 * after a hard restart.
 */
const ORPHAN_RUNNING_THRESHOLD_MS = 2 * 3_600_000; // 2 hours

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

export type ReaperResult = {
  swept: boolean;
  pruned: number;
  /** Sessions whose status was "running" but haven't been updated recently — marked done. */
  orphansRecovered: number;
};

/**
 * Sweep the session store and prune expired cron run sessions.
 * Designed to be called from the cron timer tick — self-throttles via
 * MIN_SWEEP_INTERVAL_MS to avoid excessive I/O.
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
    return { swept: false, pruned: 0, orphansRecovered: 0 };
  }

  const retentionMs = resolveRetentionMs(params.cronConfig);
  if (retentionMs === null) {
    lastSweepAtMsByStore.set(storePath, now);
    return { swept: false, pruned: 0, orphansRecovered: 0 };
  }

  let pruned = 0;
  let orphansRecovered = 0;
  const prunedSessions = new Map<string, string | undefined>();
  try {
    await updateSessionStore(storePath, (store) => {
      const cutoff = now - retentionMs;
      const orphanCutoff = now - ORPHAN_RUNNING_THRESHOLD_MS;
      for (const key of Object.keys(store)) {
        if (!isCronRunSessionKey(key)) {
          continue;
        }
        const entry = store[key];
        if (!entry) {
          continue;
        }
        const updatedAt = entry.updatedAt ?? 0;
        // Recover orphaned "running" sessions before the deletion cutoff check.
        // If a run is still marked "running" but hasn't been updated for longer
        // than ORPHAN_RUNNING_THRESHOLD_MS, the gateway likely crashed mid-run.
        if (entry.status === "running" && updatedAt < orphanCutoff) {
          store[key] = { ...entry, status: "done", endedAt: updatedAt };
          orphansRecovered++;
          // Skip the retention-prune check — let the next sweep delete it so
          // the UI briefly reflects the corrected "done" status.
          continue;
        }
        if (updatedAt < cutoff) {
          if (!prunedSessions.has(entry.sessionId) || entry.sessionFile) {
            prunedSessions.set(entry.sessionId, entry.sessionFile);
          }
          delete store[key];
          pruned++;
        }
      }
    });
  } catch (err) {
    params.log.warn({ err: String(err) }, "cron-reaper: failed to sweep session store");
    return { swept: false, pruned: 0, orphansRecovered: 0 };
  }

  lastSweepAtMsByStore.set(storePath, now);

  if (prunedSessions.size > 0) {
    try {
      const store = loadSessionStore(storePath, { skipCache: true });
      const referencedSessionIds = new Set(
        Object.values(store)
          .map((entry) => entry?.sessionId)
          .filter((id): id is string => Boolean(id)),
      );
      const archivedDirs = await archiveRemovedSessionTranscripts({
        removedSessionFiles: prunedSessions,
        referencedSessionIds,
        storePath,
        reason: "deleted",
        restrictToStoreDir: true,
      });
      if (archivedDirs.size > 0) {
        await cleanupArchivedSessionTranscripts({
          directories: [...archivedDirs],
          olderThanMs: retentionMs,
          reason: "deleted",
          nowMs: now,
        });
      }
    } catch (err) {
      params.log.warn({ err: String(err) }, "cron-reaper: transcript cleanup failed");
    }
  }

  if (orphansRecovered > 0) {
    params.log.info(
      { orphansRecovered },
      `cron-reaper: recovered ${orphansRecovered} orphaned running cron run session(s)`,
    );
  }
  if (pruned > 0) {
    params.log.info(
      { pruned, retentionMs },
      `cron-reaper: pruned ${pruned} expired cron run session(s)`,
    );
  }

  return { swept: true, pruned, orphansRecovered };
}

/** Reset the throttle timer (for tests). */
export function resetReaperThrottle(): void {
  lastSweepAtMsByStore.clear();
}
