import { resolveCronJobConfigRevision } from "../config-revision.js";
import { withCronMutationCommitHook } from "../mutation-completion.js";
import { createCronRunDiagnosticsFromError } from "../run-diagnostics.js";
import {
  adjudicateActiveCronRunReceiptInDatabase,
  CronRunReceiptConflictError,
  CronRunReceiptRevisionError,
  finishCronRunReceiptAsync,
  finishCronRunReceiptInDatabase,
  releaseLocalCronRunReceiptOwnership,
} from "../store/run-receipt-store.js";
import type { CronRunReceiptHandle } from "../store/run-receipt.types.js";
import type { CronReceiptTerminal } from "../store/runtime-worker.types.js";
import type { CronJob } from "../types.js";
import { normalizeCronRunErrorText } from "./execution-errors.js";
import { enrollForeignReceipt } from "./foreign-receipt-monitor.js";
import { locked } from "./locked.js";
import { retainManualOneShotOccurrence } from "./one-shot-schedule.js";
import { runWithCronAdmission } from "./run-admission-capacity.js";
import {
  activateReservedCronRun,
  releaseReservedCronRuns,
  releaseReservationOwnership,
  type QueuedCronRunReservation,
} from "./run-admission-mutation.js";
import { skipCronJobsWithoutOwners } from "./run-owner.js";
import {
  claimServiceCronRunReceiptInDatabase,
  markServiceCronJobActive,
  prepareServiceCronRunReceiptClaim,
} from "./run-receipts.js";
import { applyCronRuntimeRowsToState, commitCronRuntimeRows } from "./runtime-store.js";
import { type CronServiceState, emit } from "./state.js";
import { ensureLoaded } from "./store.js";
import {
  createCronOwnerExecutionIdentityAdmission,
  tryCreateCronTaskRunHandle,
} from "./task-runs.js";
import type { TimedCronRunOutcome } from "./timer-execution-timeout.js";
import { authorCronRunCompletion, executeJobCoreWithTimeout } from "./timer-job-runner.js";
import { isRunnableJob } from "./timer-runnable.js";

export {
  cancelCronRunAdmissionWaiters,
  resolveRunConcurrency,
  runWithCronAdmission,
  setCronRunCapacityListener,
  tryAcquireCronRunSlots,
} from "./run-admission-capacity.js";

export function matchesOnExitSchedule(
  job: CronJob,
  schedule: Extract<CronJob["schedule"], { kind: "on-exit" }>,
): boolean {
  return (
    job.schedule.kind === "on-exit" &&
    job.schedule.command === schedule.command &&
    job.schedule.cwd === schedule.cwd
  );
}

/** Track a persisted marker through shared admission and payload execution. */
export function reserveQueuedCronRun(
  state: CronServiceState,
  jobId: string,
  reservationAt: number,
  opts: { runReceipt: CronRunReceiptHandle; preserveWhenDisabled?: boolean; onExit?: boolean },
): object {
  const identity = {};
  state.queuedRunReservationsByJobId.set(jobId, {
    identity,
    lifecycleGeneration: state.lifecycleGeneration,
    markerAtMs: reservationAt,
    runReceipt: opts.runReceipt,
    preserveWhenDisabled: opts?.preserveWhenDisabled === true,
    ...(opts.onExit ? { onExit: true } : {}),
  });
  return identity;
}

export function releaseQueuedCronRun(
  state: CronServiceState,
  jobId: string,
  identity: object,
): boolean {
  const reservation = state.queuedRunReservationsByJobId.get(jobId);
  if (reservation?.identity !== identity) {
    return false;
  }
  state.queuedRunReservationsByJobId.delete(jobId);
  return true;
}

export function isQueuedCronRunReservationCurrent(
  state: CronServiceState,
  jobId: string,
  identity: object,
): boolean {
  const reservation = state.queuedRunReservationsByJobId.get(jobId);
  return (
    reservation?.identity === identity &&
    reservation.lifecycleGeneration === state.lifecycleGeneration
  );
}

/** Clears exact reservations through the worker, retrying only a known non-commit. */
export async function cleanupQueuedCronRunReservations(params: {
  state: CronServiceState;
  reservations: readonly QueuedCronRunReservation[];
  restoreLastError?: boolean;
  recompute?: "maintenance" | "startup-overflow";
  terminal?: CronReceiptTerminal;
  requireCurrentReceipt?: boolean;
}): Promise<void> {
  const { state, reservations } = params;
  let retrySafe = false;
  const attempt = () =>
    locked(state, async () => {
      retrySafe = false;
      await releaseReservedCronRuns({
        ...params,
        recompute: params.recompute !== undefined,
        onSettled: (outcome) => {
          retrySafe = outcome === "not-committed";
        },
      });
    });
  try {
    await attempt();
  } catch (error) {
    try {
      if (!retrySafe) {
        throw error;
      }
      await attempt();
    } catch (failure) {
      releaseReservationOwnership(state, reservations);
      throw failure;
    }
  }
}

/** Supersedes one activated run and releases only its exact durable marker.
 * Receipt terminalization shares the marker transaction, so no successor can
 * enter between dropping the fence and repairing scheduling state. */
export async function supersedeActivatedCronRun(params: {
  state: CronServiceState;
  jobId: string;
  reservationIdentity: object;
  runReceipt: ReturnType<typeof prepareServiceCronRunReceiptClaim>["handle"];
  reason: string;
}): Promise<void> {
  try {
    await cleanupQueuedCronRunReservations({
      state: params.state,
      reservations: [params],
      recompute: "maintenance",
      terminal: {
        handle: params.runReceipt,
        status: "superseded",
        finishedAtMs: params.state.deps.nowMs(),
        error: params.reason,
      },
    });
  } finally {
    releaseLocalCronRunReceiptOwnership(params.runReceipt);
  }
}

/** Persists queued markers only while no gateway owns an active run receipt.
 * Each retry re-reads and updates only pending rows, so excluded foreign jobs
 * can advance without a stale full-store snapshot overwriting their state.
 */
export async function persistQueuedCronRunReservations(params: {
  state: CronServiceState;
  candidates: readonly CronJob[];
  immediateJobIds?: ReadonlySet<string>;
  reservedAtMs: number;
  scheduleMode?: "advance" | "preserve";
  manualRun?: {
    runId?: string;
    commitGuard?: () => void;
    terminalTracker?: { emitted: boolean };
    scheduleOwnershipAtMs?: number;
    onExit?: {
      commitGuard: () => void;
      onReserved: (job: CronJob, runReceipt: CronRunReceiptHandle) => void;
    };
  };
}): Promise<Array<{ job: CronJob; runReceipt: CronRunReceiptHandle }>> {
  // Manual runs reach reservations without the scheduler's earlier owner filter.
  const candidates = skipCronJobsWithoutOwners(
    params.state,
    [...params.candidates],
    params.reservedAtMs,
    {
      ...(params.scheduleMode ? { scheduleMode: params.scheduleMode } : {}),
      ...(params.manualRun ? { manualRun: params.manualRun } : {}),
    },
  );
  const pendingJobs = new Map(candidates.map((job) => [job.id, structuredClone(job)]));
  const preparedClaims = new Map(
    [...pendingJobs].map(([jobId, job]) => [
      jobId,
      prepareServiceCronRunReceiptClaim({
        state: params.state,
        job: params.manualRun?.onExit ? { ...job, enabled: false } : job,
        startedAtMs: params.reservedAtMs,
        requestRunId: params.manualRun?.runId,
      }),
    ]),
  );
  while (pendingJobs.size > 0) {
    const replacedReceipts: CronRunReceiptHandle[] = [];
    let reservationCommitted = false;
    try {
      const committedReservations = commitCronRuntimeRows({
        state: params.state,
        jobIds: pendingJobs.keys(),
        operationLabel: "cron.run-reservation",
        transactionHooks: params.manualRun ? withCronMutationCommitHook("cron.run") : undefined,
        mutate: ({ database, jobs }) => {
          (params.manualRun?.commitGuard ?? params.manualRun?.onExit?.commitGuard)?.();
          const jobIds = [...pendingJobs.keys()].toSorted();
          for (const jobId of jobIds) {
            if (!params.state.queuedRunReservationsByJobId.has(jobId)) {
              adjudicateActiveCronRunReceiptInDatabase({
                database,
                jobId,
                prepared: preparedClaims.get(jobId)!,
                finishedAtMs: params.reservedAtMs,
              });
            }
          }
          const committed: CronJob[] = [];
          for (const jobId of jobIds) {
            const job = jobs.get(jobId);
            const planned = pendingJobs.get(jobId);
            if (
              !job ||
              !planned ||
              job.enabled !== planned.enabled ||
              (!params.immediateJobIds?.has(jobId) &&
                job.state.nextRunAtMs !== planned.state.nextRunAtMs) ||
              job.state.lastRunAtMs !== planned.state.lastRunAtMs ||
              job.state.lastRunStatus !== planned.state.lastRunStatus ||
              job.state.queuedAtMs !== undefined ||
              job.state.runningAtMs !== undefined ||
              resolveCronJobConfigRevision(job) !== resolveCronJobConfigRevision(planned)
            ) {
              continue;
            }
            committed.push(job);
          }
          const reservations = committed.map((job) => {
            const prior = params.state.queuedRunReservationsByJobId.get(job.id)?.runReceipt;
            if (prior) {
              finishCronRunReceiptInDatabase({
                database,
                handle: prior,
                status: "superseded",
                finishedAtMs: params.reservedAtMs,
                error: "cron reservation replaced before activation",
              });
              replacedReceipts.push(prior);
            }
            return {
              job,
              runReceipt: claimServiceCronRunReceiptInDatabase(
                params.state,
                database,
                preparedClaims.get(job.id)!,
              ),
            };
          });
          const ownershipAtMs = params.manualRun?.scheduleOwnershipAtMs ?? params.reservedAtMs;
          for (const { job } of reservations) {
            if (params.manualRun?.onExit) {
              job.enabled = false;
              job.updatedAtMs = params.reservedAtMs;
              job.state.scheduleActivatedAtMs = params.reservedAtMs;
              delete job.state.nextRunAtMs;
              delete job.state.startupCatchupAtMs;
              delete job.state.pacedNextRunAtMs;
              delete job.state.forcePreservedNextRunAtMs;
            } else if (params.scheduleMode === "preserve") {
              retainManualOneShotOccurrence(job, ownershipAtMs);
            }
            job.state.queuedAtMs = params.reservedAtMs;
          }
          return {
            upsertJobIds: committed.map((job) => job.id),
            runHooks: reservations.length > 0,
            value: reservations,
          };
        },
      });
      reservationCommitted = true;
      for (const receipt of replacedReceipts) {
        releaseLocalCronRunReceiptOwnership(receipt);
      }
      const firstReservation = committedReservations[0];
      if (params.manualRun?.onExit && firstReservation) {
        const { job, runReceipt } = firstReservation;
        // Transfer watcher custody before publishing its terminal disable.
        params.manualRun.onExit.onReserved(job, runReceipt);
        applyCronRuntimeRowsToState(params.state, [job]);
        emit(params.state, {
          jobId: job.id,
          action: "updated",
          job,
          nextRunAtMs: job.state.nextRunAtMs,
        });
        return committedReservations;
      }
      const committedJobs = committedReservations.map(({ job }) => job);
      if (params.state.stopped) {
        const committedById = new Map(committedJobs.map((job) => [job.id, job] as const));
        if (params.state.store) {
          params.state.store.jobs = params.state.store.jobs.map(
            (job) => committedById.get(job.id) ?? job,
          );
        }
        return committedReservations;
      }
      // A failed refresh cannot orphan committed markers before local ownership.
      await ensureLoaded(params.state, { forceReload: true }).catch(() =>
        applyCronRuntimeRowsToState(params.state, committedJobs),
      );
      const receiptByJobId = new Map(
        committedReservations.map(({ job, runReceipt }) => [job.id, runReceipt] as const),
      );
      const reloadedReservations = (params.state.store?.jobs ?? [])
        .filter((job) => receiptByJobId.has(job.id))
        .map((job) => ({ job, runReceipt: receiptByJobId.get(job.id)! }));
      const reloadedJobIds = new Set(reloadedReservations.map(({ job }) => job.id));
      for (const reservation of committedReservations) {
        if (reloadedJobIds.has(reservation.job.id)) {
          continue;
        }
        await finishCronRunReceiptAsync({
          handle: reservation.runReceipt,
          status: "skipped",
          finishedAtMs: params.state.deps.nowMs(),
          error: "cron reservation job disappeared before local handoff",
        });
      }
      return reloadedReservations;
    } catch (error) {
      if (reservationCommitted) {
        throw error;
      }
      for (const prepared of preparedClaims.values()) {
        releaseLocalCronRunReceiptOwnership(prepared.handle);
      }
      if (!(error instanceof CronRunReceiptConflictError)) {
        throw error;
      }
      enrollForeignReceipt(params.state, error.candidate);
      pendingJobs.delete(error.candidate.jobId);
    }
  }
  await ensureLoaded(params.state, { forceReload: true });
  return [];
}

export async function activateQueuedCronRun(params: {
  state: CronServiceState;
  job: CronJob;
  reservationIdentity: object;
  commitGuard?: () => void;
  onExitSchedule?: Extract<CronJob["schedule"], { kind: "on-exit" }>;
  onUnavailable?: () => void;
  onUnavailableRollbackError?: () => Promise<void>;
}): Promise<
  | {
      kind: "activated";
      job: CronJob;
      startedAt: number;
      runReceipt: ReturnType<typeof prepareServiceCronRunReceiptClaim>["handle"];
    }
  | { kind: "fenced" }
  | { kind: "unavailable"; reason: "stopped" }
> {
  const { state, job, reservationIdentity } = params;
  const startedAt = state.deps.nowMs();
  const reservation = state.queuedRunReservationsByJobId.get(job.id);
  const runReceipt = reservation?.runReceipt;
  if (!reservation || reservation.identity !== reservationIdentity || !runReceipt) {
    return { kind: "fenced" };
  }
  let activation: Awaited<ReturnType<typeof activateReservedCronRun>>;
  try {
    activation = await activateReservedCronRun({ ...params, startedAtMs: startedAt });
  } catch (error) {
    if (!(error instanceof CronRunReceiptRevisionError)) {
      throw error;
    }
  }
  if (!activation) {
    return { kind: "fenced" };
  }
  const { job: activatedJob, receipt: activatedReceipt } = activation;
  if (!state.stopped && reservation.lifecycleGeneration === state.lifecycleGeneration) {
    return { kind: "activated", job: activatedJob, startedAt, runReceipt: activatedReceipt };
  }

  params.onUnavailable?.();
  try {
    await releaseReservedCronRuns({
      state,
      reservations: [{ jobId: job.id, reservationIdentity }],
      onSettled() {},
      terminal: {
        handle: activatedReceipt,
        status: "skipped",
        finishedAtMs: state.deps.nowMs(),
        error: "cron service stopped",
      },
      requireCurrentReceipt: true,
    });
  } catch (error) {
    await params.onUnavailableRollbackError?.();
    throw error;
  } finally {
    releaseLocalCronRunReceiptOwnership(activatedReceipt);
  }
  releaseQueuedCronRun(state, job.id, reservationIdentity);
  return { kind: "unavailable", reason: "stopped" };
}

export async function executeQueuedCronRun(params: {
  state: CronServiceState;
  jobId: string;
  reservedAtMs: number;
  reservationIdentity: object;
  /** A scheduled dispatcher may reserve capacity before durable ownership. */
  admissionRelease?: () => void;
  runnableOptions?: Omit<Parameters<typeof isRunnableJob>[0], "state" | "job" | "nowMs">;
  isUnavailable?: () => boolean;
  onUnavailable?: () => void;
  onActivated?: () => void;
  onNotRunnable: (job: CronJob) => Promise<void>;
  onSetupError?: (job: CronJob, errorText: string) => void;
  /** Runs before admission release; true means terminal handling is complete. */
  onCompleted?: (outcome: TimedCronRunOutcome) => Promise<boolean>;
}): Promise<
  | { kind: "stopped" }
  | { kind: "skipped" }
  | { kind: "completed"; outcome: TimedCronRunOutcome; handled: boolean }
> {
  const { state } = params;
  const executeAdmitted = async () => {
    const started = await locked(state, async () => {
      await ensureLoaded(state, { forceReload: true });
      if (params.isUnavailable?.() || state.stopped) {
        params.onUnavailable?.();
        return undefined;
      }
      const job = state.store?.jobs.find((entry) => entry.id === params.jobId);
      if (
        !job ||
        !isQueuedCronRunReservationCurrent(state, params.jobId, params.reservationIdentity) ||
        job.state.queuedAtMs !== params.reservedAtMs
      ) {
        const ownership = state.queuedRunReservationsByJobId.get(params.jobId);
        if (
          job &&
          ownership?.identity === params.reservationIdentity &&
          job.state.queuedAtMs === params.reservedAtMs
        ) {
          await params.onNotRunnable(job);
          return undefined;
        }
        if (ownership?.identity === params.reservationIdentity) {
          // A concurrent disable/remove wiped the queued marker while this
          // reservation waited on admission. Its receipt is still running and
          // locally owned; abandoning it here would self-fence the job forever
          // (every later reservation hits the receipt-conflict monitor), so
          // terminalize like cleanupQueuedCronRunReservations does. locked()
          // is non-reentrant, hence the direct finish instead of that helper.
          try {
            await finishCronRunReceiptAsync({
              handle: ownership.runReceipt,
              status: "skipped",
              finishedAtMs: state.deps.nowMs(),
              error: "cron reservation fenced by concurrent mutation",
            });
          } catch {
            // finishCronRunReceipt retained ownership and scheduled a retry.
          }
        }
        releaseQueuedCronRun(state, params.jobId, params.reservationIdentity);
        return undefined;
      }
      const runnableJob = structuredClone(job);
      delete runnableJob.state.queuedAtMs;
      if (
        !isRunnableJob({
          state,
          job: runnableJob,
          nowMs: state.deps.nowMs(),
          ...params.runnableOptions,
        })
      ) {
        await params.onNotRunnable(job);
        return undefined;
      }
      const activation = await activateQueuedCronRun({
        state,
        job,
        reservationIdentity: params.reservationIdentity,
        onUnavailable: params.onUnavailable,
      });
      if (activation.kind !== "activated") {
        return undefined;
      }
      params.onActivated?.();
      const executionJob = structuredClone(activation.job);
      executionJob.state.runningAtMs = activation.startedAt;
      executionJob.state.lastError = undefined;
      const taskRun = tryCreateCronTaskRunHandle({
        state,
        job: executionJob,
        startedAt: activation.startedAt,
        runReceipt: activation.runReceipt,
      });
      return {
        executionJob,
        taskRun,
        startedAt: activation.startedAt,
        runReceipt: activation.runReceipt,
        // Publish the occurrence before releasing the mutation lock, including during setup.
        activeJobMarker: markServiceCronJobActive(state, activation.job, activation.runReceipt),
      };
    });
    if (!started) {
      return undefined;
    }
    const { executionJob, taskRun, activeJobMarker } = started;
    const taskRunId = taskRun?.runId;
    emit(state, {
      jobId: executionJob.id,
      action: "started",
      job: executionJob,
      runAtMs: started.startedAt,
    });
    const base = {
      jobId: params.jobId,
      job: executionJob,
      taskRunId,
      activeJobMarker,
      reservationIdentity: params.reservationIdentity,
      startedAt: started.startedAt,
      runReceipt: started.runReceipt,
    };
    let outcome: TimedCronRunOutcome;
    try {
      const result = await executeJobCoreWithTimeout(state, executionJob, {
        runId: taskRunId,
        activeJobMarker,
        runReceipt: started.runReceipt,
        executionIdentity: createCronOwnerExecutionIdentityAdmission({
          state,
          runReceipt: started.runReceipt,
          taskId: taskRun?.taskId,
          flowId: taskRun?.flowId,
        }),
      });
      outcome = { ...base, ...result, endedAt: state.deps.nowMs() };
    } catch (error) {
      const receiptSettlementDisposition =
        error instanceof CronRunReceiptRevisionError && error.reason === "owner-unavailable"
          ? "owner-unavailable"
          : undefined;
      const errorText =
        error instanceof CronRunReceiptRevisionError
          ? error.message
          : normalizeCronRunErrorText(error);
      params.onSetupError?.(executionJob, errorText);
      outcome = {
        ...base,
        ...authorCronRunCompletion(state, executionJob, {
          status: "error",
          error: errorText,
          diagnostics: createCronRunDiagnosticsFromError("cron-setup", errorText, {
            nowMs: state.deps.nowMs,
          }),
        }),
        ...(receiptSettlementDisposition ? { receiptSettlementDisposition } : {}),
        endedAt: state.deps.nowMs(),
      };
    }
    return { outcome, handled: (await params.onCompleted?.(outcome)) === true };
  };
  const admission = await runWithCronAdmission(
    state,
    executeAdmitted,
    params.admissionRelease,
  ).catch(async (error: unknown) => {
    // Release this producer's exact reservation even when admission or activation
    // failed before execution; callers' batch cleanup is only a safety net.
    await cleanupQueuedCronRunReservations({
      state,
      reservations: [{ jobId: params.jobId, reservationIdentity: params.reservationIdentity }],
      recompute: "maintenance",
    });
    throw error;
  });
  if (admission.kind === "stopped") {
    return { kind: "stopped" };
  }
  if (!admission.value) {
    return { kind: "skipped" };
  }
  return { kind: "completed", ...admission.value };
}
