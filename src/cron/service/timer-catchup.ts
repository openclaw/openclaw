import { isHeartbeatTaskCronJob } from "../heartbeat-task.js";
import { tryCronScheduleIdentity } from "../schedule-identity.js";
import type { StartupDeferredJob } from "../store/runtime-worker.types.js";
import type { CronJob } from "../types.js";
import { locked } from "./locked.js";
import { releaseReservedCronRuns } from "./run-admission-mutation.js";
import {
  cleanupQueuedCronRunReservations,
  executeQueuedCronRun,
  persistQueuedCronRunReservations,
  reserveQueuedCronRun,
} from "./run-admission.js";
import { skipCronJobsWithoutOwners } from "./run-owner.js";
import { recomputeUnownedCronSchedules } from "./schedule-maintenance.js";
import { planCronStartup } from "./scheduler-mutations.js";
import type { CronServiceState } from "./state.js";
import { captureCronServiceMutationSource, ensureLoaded } from "./store.js";
import {
  DEFAULT_MAX_MISSED_JOBS_PER_RESTART,
  DEFAULT_MISSED_JOB_STAGGER_MS,
  DEFAULT_STARTUP_DEFERRED_MISSED_AGENT_JOB_DELAY_MS,
  type StartupCatchupCandidate,
  type StartupCatchupExecution,
  type StartupCatchupPlan,
  type TimedCronRunOutcome,
} from "./timer-execution-timeout.js";
import { maybeNotifyIsolatedAgentSetupTimeout } from "./timer-notifications.js";
import { createCompletedCronRunOutcomeDrain } from "./timer-outcome-finalization.js";

type StartupMutationContext = {
  source: ReturnType<typeof captureCronServiceMutationSource>;
  nonRetryableReservations: Set<object>;
};

async function commitStartupCatchupRows(
  params: {
    state: CronServiceState;
    reservations: readonly Pick<StartupCatchupCandidate, "jobId" | "reservationIdentity">[];
    deferredJobs?: readonly StartupDeferredJob[];
    staggerMs?: number;
  },
  mutation: StartupMutationContext,
): Promise<void> {
  const reservations = params.reservations.filter(
    (reservation) => !mutation.nonRetryableReservations.has(reservation.reservationIdentity),
  );
  const deferredJobs = params.deferredJobs ?? [];
  if (reservations.length === 0 && deferredJobs.length === 0) {
    return;
  }
  const receiptContext = reservations
    .map(({ jobId, reservationIdentity }) => {
      const owner = params.state.queuedRunReservationsByJobId.get(jobId);
      return owner?.identity === reservationIdentity ? owner.runReceiptContext : undefined;
    })
    .find((context) => context !== undefined);
  await releaseReservedCronRuns({
    state: params.state,
    context: receiptContext ?? mutation.source.context,
    storeKey: mutation.source.storeKey,
    reservations,
    nowMs: params.state.deps.nowMs(),
    policy: {
      kind: "startup-settlement",
      deferredJobs: [...deferredJobs],
      staggerMs: params.staggerMs ?? 0,
    },
    // Draining reservations outlive a stopped scheduler; new deferrals do not.
    assertCurrent: () => {
      mutation.source.assertStorageCurrent();
      if (deferredJobs.length > 0) {
        mutation.source.assertCurrent();
      }
    },
    onSettled(outcome) {
      if (outcome !== "not-committed") {
        for (const reservation of reservations) {
          mutation.nonRetryableReservations.add(reservation.reservationIdentity);
        }
      }
    },
  });
}

async function releaseStartupCatchupReservationsAfterFailure(
  state: CronServiceState,
  plan: StartupCatchupPlan,
  outcomes: readonly TimedCronRunOutcome[],
  mutation: StartupMutationContext,
): Promise<void> {
  const startedJobIds = new Set(outcomes.map((outcome) => outcome.jobId));
  await cleanupQueuedCronRunReservations({
    state,
    reservations: plan.candidates.filter(
      (candidate) =>
        !startedJobIds.has(candidate.jobId) &&
        !mutation.nonRetryableReservations.has(candidate.reservationIdentity),
    ),
    recompute: "startup-overflow",
  });
}

/** Runs or defers missed startup jobs using restart catch-up limits. */
export async function runMissedJobs(
  state: CronServiceState,
  opts?: { skipJobIds?: ReadonlySet<string>; deferAgentWork?: boolean },
): Promise<void> {
  if (state.stopped) {
    return;
  }
  const mutation: StartupMutationContext = {
    source: captureCronServiceMutationSource(state),
    nonRetryableReservations: new Set(),
  };
  const catchup = {};
  state.startupCatchup = catchup;
  try {
    const plan = await planStartupCatchup(state, mutation, opts);
    if (plan.candidates.length === 0 && plan.deferredJobs.length === 0) {
      return;
    }

    const completedOutcomeDrain = createCompletedCronRunOutcomeDrain(state, {
      discardWhenStopped: true,
      repairFutureCronNextRunAtMs: false,
    });
    const execution = await executeStartupCatchupPlan(state, plan, completedOutcomeDrain, mutation);
    let finalizedOutcomes: TimedCronRunOutcome[];
    try {
      let completedOutcomes: TimedCronRunOutcome[];
      try {
        completedOutcomes = await completedOutcomeDrain.flush();
      } catch (drainError) {
        // Preserve overflow wake times and release every unstarted reservation
        // even when a completed sibling's terminal store write has failed.
        await applyStartupCatchupOutcomes(state, plan, execution.outcomes, mutation);
        throw drainError;
      }
      finalizedOutcomes = await applyStartupCatchupOutcomes(
        state,
        plan,
        completedOutcomes,
        mutation,
      );
    } catch (finalizationError) {
      try {
        await releaseStartupCatchupReservationsAfterFailure(
          state,
          plan,
          execution.outcomes,
          mutation,
        );
      } catch (cleanupError) {
        state.deps.log.warn(
          { err: String(cleanupError) },
          execution.ok
            ? "cron: failed to release startup catch-up reservations after finalization error"
            : "cron: failed to release startup catch-up reservations after execution error",
        );
      }
      throw execution.ok ? finalizationError : execution.error;
    }
    for (const outcome of finalizedOutcomes) {
      maybeNotifyIsolatedAgentSetupTimeout(state, outcome);
    }
    if (!execution.ok) {
      throw execution.error;
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
  mutation: StartupMutationContext,
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
      source: mutation.source,
      jobIds: state.store.jobs.map((job) => job.id),
      skipJobIds: opts?.skipJobIds,
      nowMs: now,
    });
    if (state.stopped || state.lifecycleGeneration !== lifecycleGeneration) {
      return { lifecycleGeneration, candidates: [], deferredJobs: [] };
    }
    const missed = await skipCronJobsWithoutOwners(state, candidates, now, {
      source: mutation.source,
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
    const reservedStartupCandidates = await persistQueuedCronRunReservations({
      state,
      candidates: startupCandidates,
      source: mutation.source,
      reservedAtMs: now,
    });

    return {
      lifecycleGeneration,
      candidates: reservedStartupCandidates.map(({ job, runReceipt, runReceiptContext }) => ({
        jobId: job.id,
        job,
        reservedAtMs: now,
        reservationIdentity: reserveQueuedCronRun(state, job.id, now, {
          runReceipt,
          runReceiptContext,
          lifecycleGeneration,
        }),
      })),
      deferredJobs: deferred,
    };
  });
}

async function executeStartupCatchupPlan(
  state: CronServiceState,
  plan: StartupCatchupPlan,
  completedOutcomeDrain: ReturnType<typeof createCompletedCronRunOutcomeDrain>,
  mutation: StartupMutationContext,
): Promise<StartupCatchupExecution> {
  const outcomes: TimedCronRunOutcome[] = [];
  try {
    for (const candidate of plan.candidates) {
      if (state.stopped || state.lifecycleGeneration !== plan.lifecycleGeneration) {
        break;
      }
      const execution = await executeQueuedCronRun({
        state,
        jobId: candidate.jobId,
        reservedAtMs: candidate.reservedAtMs,
        reservationIdentity: candidate.reservationIdentity,
        runnableOptions: {
          skipAtIfAlreadyRan: true,
          allowCronMissedRunByLastRun: true,
        },
        onNotRunnable: async () => {
          await commitStartupCatchupRows({ state, reservations: [candidate] }, mutation);
        },
      });
      if (execution.kind === "stopped") {
        break;
      }
      if (execution.kind === "completed") {
        // Catch-up execution stays sequential, while completed outcomes
        // persist in coalesced batches before slower siblings have to drain.
        outcomes.push(execution.outcome);
        completedOutcomeDrain.enqueue(execution.outcome);
      }
    }
  } catch (error) {
    return { ok: false, outcomes, error };
  }
  return { ok: true, outcomes };
}

async function applyStartupCatchupOutcomes(
  state: CronServiceState,
  plan: StartupCatchupPlan,
  outcomes: TimedCronRunOutcome[],
  mutation: StartupMutationContext,
): Promise<TimedCronRunOutcome[]> {
  const staggerMs = Math.max(0, state.deps.missedJobStaggerMs ?? DEFAULT_MISSED_JOB_STAGGER_MS);
  await locked(state, async () => {
    // Each completed run is already durable. Reload before releasing or
    // staggering sibling reservations so their current rows stay authoritative.
    await ensureLoaded(state, { forceReload: true });
    if (!state.store) {
      return;
    }
    const startedJobIds = new Set(outcomes.map((outcome) => outcome.jobId));
    const pendingReleases = plan.candidates.filter(
      (candidate) =>
        !startedJobIds.has(candidate.jobId) &&
        !mutation.nonRetryableReservations.has(candidate.reservationIdentity),
    );
    if (
      state.stopped ||
      state.lifecycleGeneration !== plan.lifecycleGeneration ||
      (outcomes.length === 0 && plan.deferredJobs.length === 0)
    ) {
      if (pendingReleases.length > 0) {
        await commitStartupCatchupRows({ state, reservations: pendingReleases }, mutation);
      }
      return;
    }
    await commitStartupCatchupRows(
      {
        state,
        reservations: pendingReleases,
        deferredJobs: plan.deferredJobs,
        staggerMs,
      },
      mutation,
    );
    await recomputeUnownedCronSchedules(state, {
      repairFutureCronNextRunAtMs: false,
    });
  });
  return outcomes;
}
