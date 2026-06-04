/** Prunes expired per-run cron sessions and archives unreferenced transcripts. */
import { parseDurationMs } from "../cli/parse-duration.js";
import {
  applySessionEntryLifecycleMutation,
  listSessionEntries,
  type SessionEntryLifecycleRemoval,
} from "../config/sessions/session-accessor.js";
import type { CronConfig } from "../config/types.cron.js";
import { formatErrorMessage } from "../infra/errors.js";
import { isCronRunSessionKey, isCronSessionKey } from "../sessions/session-key-utils.js";
import { resolveCronAgentSessionKey } from "./isolated-agent/session-key.js";
import type { Logger } from "./service/state.js";
import { resolveCronSessionTargetSessionKey } from "./session-target.js";
import type { CronJob } from "./types.js";

const DEFAULT_RETENTION_MS = 24 * 3_600_000; // 24 hours

type CronAgentResolution = {
  defaultAgentId: string;
  resolveCronAgentId?: (requested?: string | null) => string;
};

/**
 * Resolves a cron job's agent id the way the runtime does when writing its base
 * row (a configured agent wins, else the default), so reaper keys match storage.
 */
export function resolveCronJobAgentId(
  job: Pick<CronJob, "agentId">,
  opts: CronAgentResolution,
): string {
  const resolved = opts.resolveCronAgentId?.(job.agentId);
  if (resolved && resolved.trim()) {
    return resolved;
  }
  return typeof job.agentId === "string" && job.agentId.trim() ? job.agentId : opts.defaultAgentId;
}

/** Base session keys owned by live cron jobs; these are preserved from retention pruning. */
export function buildKnownCronJobSessionKeys(
  jobs: readonly Pick<CronJob, "id" | "sessionTarget" | "agentId">[],
  opts: CronAgentResolution,
): Set<string> {
  const keys = new Set<string>();
  for (const job of jobs) {
    try {
      const sessionKey = resolveCronSessionTargetSessionKey(job.sessionTarget) ?? `cron:${job.id}`;
      keys.add(
        resolveCronAgentSessionKey({ sessionKey, agentId: resolveCronJobAgentId(job, opts) }),
      );
    } catch {
      // Skip malformed sessionTarget (e.g. "session:" empty id) so a single bad
      // job cannot throw the whole set construction out of the timer tick.
    }
  }
  return keys;
}

/**
 * Session-store paths the reaper sweeps: live jobs' agents, every configured
 * agent, and the default. Configured agents are included so a deleted job's
 * orphan is reaped even when no live job references that agent anymore.
 */
export function buildCronSweepStorePaths(opts: {
  jobs: readonly Pick<CronJob, "id" | "sessionTarget" | "agentId">[];
  configuredAgentIds: readonly string[];
  agentResolution: CronAgentResolution;
  resolveSessionStorePath?: (agentId?: string) => string;
  sessionStorePath?: string;
}): Set<string> {
  const paths = new Set<string>();
  const resolve = opts.resolveSessionStorePath;
  if (!resolve) {
    if (opts.sessionStorePath) {
      paths.add(opts.sessionStorePath);
    }
    return paths;
  }
  for (const job of opts.jobs) {
    paths.add(resolve(resolveCronJobAgentId(job, opts.agentResolution)));
  }
  for (const agentId of opts.configuredAgentIds) {
    paths.add(resolve(agentId));
  }
  paths.add(resolve(opts.agentResolution.defaultAgentId));
  return paths;
}

/** Minimum interval between reaper sweeps (avoid running every timer tick). */
const MIN_SWEEP_INTERVAL_MS = 5 * 60_000; // 5 minutes

const lastSweepAtMsByStore = new Map<string, number>();

/** Resolves cron run-session retention; `false` disables pruning, bad strings fall back safely. */
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

type ReaperResult = {
  swept: boolean;
  pruned: number;
};

/**
 * Sweeps expired isolated cron run sessions and orphaned base cron sessions.
 *
 * Must run outside the cron service `locked()` section because this acquires
 * the session-store file lock; reversing that order can deadlock timer ticks.
 */
export async function sweepCronRunSessions(params: {
  cronConfig?: CronConfig;
  /** Resolved path to sessions.json — required. */
  sessionStorePath: string;
  nowMs?: number;
  log: Logger;
  /** Override for testing — skips the min-interval throttle. */
  force?: boolean;
  /**
   * Base session keys of every live cron job; these are preserved regardless of
   * age (they carry model/auth/label into the next run). Base keys absent from
   * it are deleted-job orphans, pruned when stale. Omit to disable base-key
   * pruning — orphans cannot be told from live jobs without it.
   */
  knownCronJobSessionKeys?: ReadonlySet<string>;
}): Promise<ReaperResult> {
  const now = params.nowMs ?? Date.now();
  const storePath = params.sessionStorePath;
  const lastSweepAtMs = lastSweepAtMsByStore.get(storePath) ?? 0;

  // Timer ticks can be frequent; throttle per store path to avoid repeated
  // session-store I/O while preserving a force path for deterministic tests.
  if (!params.force && now - lastSweepAtMs < MIN_SWEEP_INTERVAL_MS) {
    return { swept: false, pruned: 0 };
  }

  const retentionMs = resolveRetentionMs(params.cronConfig);
  if (retentionMs === null) {
    lastSweepAtMsByStore.set(storePath, now);
    return { swept: false, pruned: 0 };
  }

  let pruned = 0;
  let transcriptCleanupError: unknown;
  try {
    const cutoff = now - retentionMs;
    const allEntries = [...listSessionEntries({ storePath, clone: false })];

    const removals: SessionEntryLifecycleRemoval[] = [];
    for (const { sessionKey, entry } of allEntries) {
      if (!isCronSessionKey(sessionKey)) {
        continue;
      }
      if (!isCronRunSessionKey(sessionKey)) {
        // Base cron key carries a live job's model/auth/label into its next run;
        // prune only when the ownership set proves no live job owns it (an orphan
        // from a deleted job). No set means we cannot tell orphan from live.
        const owned = params.knownCronJobSessionKeys;
        if (!owned || owned.has(sessionKey)) {
          continue;
        }
      }
      const updatedAt = entry.updatedAt ?? 0;
      if (updatedAt < cutoff) {
        removals.push({
          sessionKey,
          expectedEntry: entry,
          ...(entry.sessionId ? { expectedSessionId: entry.sessionId } : {}),
          expectedUpdatedAt: entry.updatedAt,
          archiveRemovedTranscript: true,
        });
      }
    }
    if (removals.length > 0) {
      const result = await applySessionEntryLifecycleMutation({
        storePath,
        removals,
        restrictArchivedTranscriptsToStoreDir: true,
        cleanupArchivedTranscripts: {
          rules: [{ reason: "deleted", olderThanMs: retentionMs }],
          nowMs: now,
        },
        captureArtifactCleanupError: true,
      });
      pruned = result.removedEntries;
      transcriptCleanupError = result.artifactCleanupError;
    }
  } catch (err) {
    params.log.warn({ err: String(err) }, "cron-reaper: failed to sweep session store");
    return { swept: false, pruned: 0 };
  }

  lastSweepAtMsByStore.set(storePath, now);

  if (transcriptCleanupError) {
    params.log.warn(
      { err: formatErrorMessage(transcriptCleanupError) },
      "cron-reaper: transcript cleanup failed",
    );
  }

  if (pruned > 0) {
    params.log.info(
      { pruned, retentionMs },
      `cron-reaper: pruned ${pruned} expired cron session(s)`,
    );
  }

  return { swept: true, pruned };
}

/** Resets per-store reaper throttles between tests. */
export function resetReaperThrottle(): void {
  lastSweepAtMsByStore.clear();
}
