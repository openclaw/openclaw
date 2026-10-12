import { isHeartbeatTaskCronJob } from "../heartbeat-task.js";
import { tryCronScheduleIdentity } from "../schedule-identity.js";
import type { StartupDeferredJob } from "../store/runtime-worker.types.js";
import type { CronJob } from "../types.js";
import { locked } from "./locked.js";
import { skipCronJobsWithoutOwners } from "./run-owner.js";
import { requestCronRuns } from "./run-queue.js";
import { recomputeUnownedCronSchedules } from "./schedule-maintenance.js";
import { deferCronStartupJobs, planCronStartup } from "./scheduler-mutations.js";
import type { CronServiceState } from "./state.js";
import { captureCronServiceMutationSource, ensureLoaded } from "./store.js";
import {
  DEFAULT_MAX_MISSED_JOBS_PER_RESTART,
  DEFAULT_MISSED_JOB_STAGGER_MS,
  DEFAULT_STARTUP_DEFERRED_MISSED_AGENT_JOB_DELAY_MS,
} from "./timer-execution-timeout.js";

type StartupCatchupPlan = {
  lifecycleGeneration: number;
  candidates: CronJob[];
  deferredJobs: StartupDeferredJob[];
};

/** Runs or defers missed startup jobs using restart catch-up limits. */
export async function runMissedJobs(
  state: CronServiceState,
  opts?: { skipJobIds?: ReadonlySet<string>; deferAgentWork?: boolean },
): Promise<void> {
  if (state.stopped) {
    return;
  }
  const source = captureCronServiceMutationSource(state);
  const catchup = {};
  state.startupCatchup = catchup;
  try {
    const plan = await planStartupCatchup(state, source, opts);
    if (plan.candidates.length === 0 && plan.deferredJobs.length === 0) {
      return;
    }
    try {
      // Startup work remains oldest-first and sequential; the worker owns each
      // request and its capacity wait before the existing executor starts.
      for (const job of plan.candidates) {
        if (state.stopped || state.lifecycleGeneration !== plan.lifecycleGeneration) {
          break;
        }
        const requests = await requestCronRuns(state, [job], { source: "startup" });
        await Promise.all(requests.map(({ completion }) => completion));
      }
    } finally {
      await locked(state, async () => {
        if (state.stopped || state.lifecycleGeneration !== plan.lifecycleGeneration) {
          return;
        }
        await ensureLoaded(state, { forceReload: true });
        await deferCronStartupJobs({
          state,
          source,
          deferredJobs: plan.deferredJobs,
          staggerMs: Math.max(0, state.deps.missedJobStaggerMs ?? DEFAULT_MISSED_JOB_STAGGER_MS),
        });
        await recomputeUnownedCronSchedules(state, { repairFutureCronNextRunAtMs: false });
      });
    }
  } finally {
    // A stopped/replaced startup cannot release a newer catch-up's timer fence.
    if (state.startupCatchup === catchup) {
      state.startupCatchup = undefined;
    }
  }
}

async function planStartupCatchup(
  state: CronServiceState,
  source: ReturnType<typeof captureCronServiceMutationSource>,
  opts?: { skipJobIds?: ReadonlySet<string>; deferAgentWork?: boolean },
): Promise<StartupCatchupPlan> {
  const lifecycleGeneration = state.lifecycleGeneration;
  const maxImmediate = Math.max(
    0,
    state.deps.maxMissedJobsPerRestart ?? DEFAULT_MAX_MISSED_JOBS_PER_RESTART,
  );
  return locked(state, async () => {
    await ensureLoaded(state);
    if (state.stopped || state.lifecycleGeneration !== lifecycleGeneration || !state.store) {
      return { lifecycleGeneration, candidates: [], deferredJobs: [] };
    }

    const now = state.deps.nowMs();
    const candidates = await planCronStartup({
      state,
      source,
      jobIds: state.store.jobs.map((job) => job.id),
      skipJobIds: opts?.skipJobIds,
      nowMs: now,
    });
    if (state.stopped || state.lifecycleGeneration !== lifecycleGeneration) {
      return { lifecycleGeneration, candidates: [], deferredJobs: [] };
    }
    const missed = await skipCronJobsWithoutOwners(state, candidates, now, {
      source,
    });
    if (missed.length === 0 || state.stopped || state.lifecycleGeneration !== lifecycleGeneration) {
      return { lifecycleGeneration, candidates: [], deferredJobs: [] };
    }
    const sorted = missed.toSorted(
      (a, b) => (a.state.nextRunAtMs ?? 0) - (b.state.nextRunAtMs ?? 0),
    );
    const deferredAgentJobs: CronJob[] = [];
    const startupEligible: CronJob[] = [];
    for (const job of sorted) {
      const waitsForAgent =
        job.payload.kind === "agentTurn" ||
        job.payload.kind === "heartbeat" ||
        isHeartbeatTaskCronJob(job) ||
        (job.sessionTarget === "main" &&
          job.payload.kind === "systemEvent" &&
          job.wakeMode === "now");
      (opts?.deferAgentWork && waitsForAgent ? deferredAgentJobs : startupEligible).push(job);
    }
    const startupCandidates = startupEligible.slice(0, maxImmediate);
    const deferredOverflow = startupEligible.slice(maxImmediate);
    const deferredAgentDelayMs = Math.max(
      0,
      state.deps.startupDeferredMissedAgentJobDelayMs ??
        DEFAULT_STARTUP_DEFERRED_MISSED_AGENT_JOB_DELAY_MS,
    );
    // Heartbeat waits can be unlimited too; agent work must not own scheduler startup.
    const deferredJob = (job: CronJob, delayMs?: number): StartupDeferredJob => ({
      jobId: job.id,
      ...(delayMs === undefined ? {} : { delayMs }),
      // Pacing belongs to this schedule occurrence, not its label or payload
      // contents. Declarative reconciliation must not erase the deferral.
      scheduleIdentity: tryCronScheduleIdentity(job),
      createdAtMs: job.createdAtMs,
      payloadKind: job.payload.kind,
      scheduleActivatedAtMs: job.state.scheduleActivatedAtMs,
      nextRunAtMs: job.state.nextRunAtMs,
      lastRunAtMs: job.state.lastRunAtMs,
      lastRunStatus: job.state.lastRunStatus,
    });
    const deferred: StartupDeferredJob[] = [
      ...deferredOverflow.map((job) => deferredJob(job)),
      ...deferredAgentJobs.map((job) => deferredJob(job, deferredAgentDelayMs)),
    ];
    if (deferred.length > 0) {
      state.deps.log.info(
        {
          immediateCount: startupCandidates.length,
          deferredCount: deferred.length,
          totalMissed: missed.length,
        },
        "cron: staggering missed jobs to prevent gateway overload",
      );
    }
    if (deferredAgentJobs.length > 0) {
      state.deps.log.info(
        {
          count: deferredAgentJobs.length,
          jobIds: deferredAgentJobs.map((job) => job.id),
          delayMs: deferredAgentDelayMs,
        },
        "cron: deferring missed agent jobs until after gateway startup",
      );
    }
    if (startupCandidates.length > 0) {
      state.deps.log.info(
        { count: startupCandidates.length, jobIds: startupCandidates.map((j) => j.id) },
        "cron: running missed jobs after restart",
      );
    }
    return { lifecycleGeneration, candidates: startupCandidates, deferredJobs: deferred };
  });
}
