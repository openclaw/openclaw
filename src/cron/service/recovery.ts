/**
 * Cron recovery: detect and replay missed job occurrences after gateway restart.
 */

import type { CronJob } from "../types.js";
import type { CronServiceState } from "./state.js";

type ReplayCandidate = {
  job: CronJob;
  scheduledAtMs: number;
  reason: "scheduler_down";
};

/**
 * On cron service start, detect missed occurrences and replay them if policy allows.
 * This is called once during startup, after jobs are loaded.
 */
export async function recoverMissedRuns(state: CronServiceState): Promise<void> {
  if (!state.executionStore) return;
  if (!state.store) return;

  const now = state.deps.nowMs();
  const missed = state.executionStore.getMissedOccurrences(now);

  if (missed.length === 0) return;

  state.deps.log.info({ count: missed.length }, "cron: found missed occurrences");

  const candidates: ReplayCandidate[] = [];

  for (const occurrence of missed) {
    const job = state.store.jobs.find((j) => j.id === occurrence.jobId);
    if (!job) {
      // Job was deleted
      state.executionStore.markSkippedStale(
        occurrence.jobId,
        occurrence.scheduledAtMs,
        "job_deleted",
      );
      continue;
    }

    if (!job.enabled) {
      // Job is disabled
      state.executionStore.markSkippedStale(
        occurrence.jobId,
        occurrence.scheduledAtMs,
        "job_disabled",
      );
      continue;
    }

    const replayPolicy = job.replay ?? { mode: "never" };
    if (replayPolicy.mode === "never") {
      // No replay policy
      state.executionStore.markSkippedStale(
        occurrence.jobId,
        occurrence.scheduledAtMs,
        "no_replay_policy",
      );
      continue;
    }

    const windowMs = replayPolicy.windowMs ?? 3600000; // 1 hour default
    const age = now - occurrence.scheduledAtMs;
    if (age > windowMs) {
      // Too old to replay
      state.executionStore.markSkippedStale(
        occurrence.jobId,
        occurrence.scheduledAtMs,
        "outside_window",
      );
      continue;
    }

    // Mark as missed first
    state.executionStore.markMissed(occurrence.jobId, occurrence.scheduledAtMs, "scheduler_down");

    candidates.push({
      job,
      scheduledAtMs: occurrence.scheduledAtMs,
      reason: "scheduler_down",
    });
  }

  if (candidates.length === 0) {
    state.deps.log.info("cron: no occurrences to replay");
    return;
  }

  // Apply per-job replay limits
  const jobReplayCounts = new Map<string, number>();
  const toReplay: ReplayCandidate[] = [];

  for (const candidate of candidates) {
    const count = jobReplayCounts.get(candidate.job.id) ?? 0;
    const maxReplays = candidate.job.replay?.maxReplaysPerRecovery ?? 5;

    if (count >= maxReplays) {
      state.executionStore.markSkippedStale(
        candidate.job.id,
        candidate.scheduledAtMs,
        "max_replays_exceeded",
      );
      continue;
    }

    jobReplayCounts.set(candidate.job.id, count + 1);
    toReplay.push(candidate);
  }

  state.deps.log.info({ count: toReplay.length }, "cron: replaying missed occurrences");

  // Enqueue recovery messages
  for (const { job, scheduledAtMs, reason } of toReplay) {
    const text = resolveRecoveryMessageText(job, scheduledAtMs, now);
    if (!text) {
      state.executionStore.markSkippedStale(job.id, scheduledAtMs, "no_text");
      continue;
    }

    state.deps.enqueueSystemEvent(text, { agentId: job.agentId });
    state.executionStore.markReplayed(job.id, scheduledAtMs, now);

    if (job.wakeMode === "now") {
      state.deps.requestHeartbeatNow({ reason: `cron:recovery:${job.id}` });
    }
  }
}

/**
 * Resolve the recovery message text with "Late — gateway was down..." prefix.
 */
function resolveRecoveryMessageText(
  job: CronJob,
  scheduledAtMs: number,
  nowMs: number,
): string | null {
  if (job.payload.kind !== "systemEvent") return null;

  const originalText = job.payload.text.trim();
  if (!originalText) return null;

  const scheduledDate = new Date(scheduledAtMs).toLocaleString();
  const prefix = `Late — gateway was down at scheduled time (${scheduledDate})`;

  return `${prefix}\n\n${originalText}`;
}
