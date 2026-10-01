import type { OpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.types.js";
import { captureCronMutationCommit } from "../mutation-completion.js";
import { createCronRunDiagnosticsFromError } from "../run-diagnostics.js";
import { cronStoreKey } from "../store/key.js";
import {
  CronRunReceiptRevisionError,
  finishCronRunReceiptAsync,
  releaseLocalCronRunReceiptOwnership,
} from "../store/run-receipt-store.js";
import type { CronRunReceiptHandle } from "../store/run-receipt.types.js";
import type { CronReceiptTerminal } from "../store/runtime-worker.types.js";
import type { CronJob } from "../types.js";
import { normalizeCronRunErrorText } from "./execution-errors.js";
import { enrollForeignReceipt } from "./foreign-receipt-monitor.js";
import { locked } from "./locked.js";
import { runWithCronAdmission } from "./run-admission-capacity.js";
import {
  activateReservedCronRun,
  releaseReservedCronRuns,
  releaseReservationOwnership,
  reserveCronRuns,
  type QueuedCronRunReservation,
} from "./run-admission-mutation.js";
import { createCronOwnerExecutionIdentityAdmission, createCronRunHandle } from "./run-history.js";
import { skipCronJobsWithoutOwners } from "./run-owner.js";
import { markServiceCronJobActive } from "./run-receipts.js";
import { applyCronRuntimeRowsToState } from "./runtime-publication.js";
import { type CronServiceState, emit } from "./state.js";
import { captureCronServiceMutationSource, ensureLoaded } from "./store.js";
import type { TimedCronRunOutcome } from "./timer-execution-timeout.js";
import { authorCronRunCompletion, executeJobCoreWithTimeout } from "./timer-job-runner.js";
import { isRunnableJob } from "./timer-runnable.js";

type ReservedCronRun = {
  job: CronJob;
  runReceipt: CronRunReceiptHandle;
  runReceiptContext: OpenClawStateWorkerContext;
};

export {
  cancelCronRunAdmissionWaiters,
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
  opts: {
    runReceipt: CronRunReceiptHandle;
    runReceiptContext: OpenClawStateWorkerContext;
    preserveWhenDisabled?: boolean;
    onExit?: boolean;
    lifecycleGeneration?: number;
  },
): object {
  const identity = {};
  state.queuedRunReservationsByJobId.set(jobId, {
    identity,
    lifecycleGeneration: opts.lifecycleGeneration ?? state.lifecycleGeneration,
    markerAtMs: reservationAt,
    runReceipt: opts.runReceipt,
    runReceiptContext: opts.runReceiptContext,
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
  context?: OpenClawStateWorkerContext;
  reservations: readonly QueuedCronRunReservation[];
  restoreLastError?: boolean;
  recompute?: "maintenance" | "startup-overflow";
  terminal?: CronReceiptTerminal;
  requireCurrentReceipt?: boolean;
}): Promise<void> {
  const { state, reservations } = params;
  const context =
    params.context ??
    reservations
      .map(({ jobId, reservationIdentity }) => {
        const owner = state.queuedRunReservationsByJobId.get(jobId);
        return owner?.identity === reservationIdentity ? owner.runReceiptContext : undefined;
      })
      .find((candidate) => candidate !== undefined);
  if (!context) {
    if (params.terminal) {
      throw new Error("Cron reservation terminalization lost its original receipt context");
    }
    return;
  }
  let retrySafe = false;
  const attempt = () =>
    locked(state, async () => {
      retrySafe = false;
      await releaseReservedCronRuns({
        ...params,
        context,
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
  runReceipt: CronRunReceiptHandle;
  runReceiptContext: OpenClawStateWorkerContext;
  reason: string;
}): Promise<void> {
  try {
    await cleanupQueuedCronRunReservations({
      state: params.state,
      context: params.runReceiptContext,
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
  source?: ReturnType<typeof captureCronServiceMutationSource>;
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
      onReserved: (
        job: CronJob,
        runReceipt: CronRunReceiptHandle,
        runReceiptContext: OpenClawStateWorkerContext,
      ) => void;
    };
  };
}): Promise<ReservedCronRun[]> {
  const generation = params.state.lifecycleGeneration;
  if (params.state.stopped) {
    return [];
  }
  const source = params.source ?? captureCronServiceMutationSource(params.state);
  // Manual runs reach reservations without the scheduler's earlier owner filter.
  const candidates = await skipCronJobsWithoutOwners(
    params.state,
    [...params.candidates],
    params.reservedAtMs,
    {
      source,
      ...(params.scheduleMode ? { scheduleMode: params.scheduleMode } : {}),
      ...(params.manualRun ? { manualRun: params.manualRun } : {}),
    },
  );
  if (params.state.stopped || params.state.lifecycleGeneration !== generation) {
    return [];
  }
  source.assertCurrent();
  const pendingJobs = new Map(candidates.map((job) => [job.id, structuredClone(job)]));
  if (pendingJobs.size === 0) {
    await ensureLoaded(params.state, { forceReload: true });
    return [];
  }
  const context = source.context;
  const storeKey = source.storeKey;
  const retired = () => params.state.stopped || params.state.lifecycleGeneration !== generation;
  const retiredError = new Error("Cron service stopped before run reservation");
  const assertCurrent = () => {
    context.admission.assertCurrent();
    if (cronStoreKey(params.state.deps.storePath) !== storeKey) {
      throw new Error("Cron reservation store changed before commit");
    }
    if (retired()) {
      throw retiredError;
    }
    (params.manualRun?.commitGuard ?? params.manualRun?.onExit?.commitGuard)?.();
    if (retired()) {
      throw retiredError;
    }
  };
  const cleanupUnhandedReservations = async (committed: ReservedCronRun[]) => {
    const reservations = committed.map(({ job, runReceipt }) => {
      const existing = params.state.queuedRunReservationsByJobId.get(job.id);
      return {
        jobId: job.id,
        reservationIdentity:
          existing?.runReceipt.receiptId === runReceipt.receiptId
            ? existing.identity
            : reserveQueuedCronRun(params.state, job.id, params.reservedAtMs, {
                runReceipt,
                runReceiptContext: context,
                lifecycleGeneration: generation,
              }),
      };
    });
    if (reservations.length === 0) {
      return;
    }
    try {
      await releaseReservedCronRuns({
        state: params.state,
        context,
        reservations,
        recompute: true,
        onSettled() {},
      });
    } finally {
      releaseReservationOwnership(params.state, reservations);
    }
  };
  const markCommitted = params.manualRun ? captureCronMutationCommit("cron.run") : undefined;
  while (pendingJobs.size > 0) {
    let reservationCommitted = false;
    let committedReservations: ReservedCronRun[] = [];
    try {
      const conflict = await reserveCronRuns({
        state: params.state,
        context,
        candidates: pendingJobs,
        immediateJobIds: params.immediateJobIds,
        reservedAtMs: params.reservedAtMs,
        requestRunId: params.manualRun?.runId,
        preserveSchedule: params.scheduleMode === "preserve",
        scheduleOwnershipAtMs: params.manualRun?.scheduleOwnershipAtMs ?? params.reservedAtMs,
        onExit: params.manualRun?.onExit !== undefined,
        assertCurrent,
        onCommitted(outcome) {
          reservationCommitted = true;
          committedReservations = outcome.reservations.map((reservation) => ({
            ...reservation,
            runReceiptContext: context,
          }));
          if (committedReservations.length > 0) {
            markCommitted?.();
          }
          for (const receipt of outcome.replacedReceipts) {
            releaseLocalCronRunReceiptOwnership(receipt);
          }
          const first = committedReservations[0];
          if (params.manualRun?.onExit && first) {
            params.manualRun.onExit.onReserved(
              first.job,
              first.runReceipt,
              first.runReceiptContext,
            );
          }
        },
      });
      if (conflict) {
        enrollForeignReceipt(params.state, conflict);
        pendingJobs.delete(conflict.jobId);
        continue;
      }
      const firstReservation = committedReservations[0];
      if (params.manualRun?.onExit && firstReservation) {
        const { job } = firstReservation;
        // Matching commit publication already transferred custody to the watcher.
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
      if (retired()) {
        applyCronRuntimeRowsToState(params.state, committedJobs);
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
        .map((job) => ({
          job,
          runReceipt: receiptByJobId.get(job.id)!,
          runReceiptContext: context,
        }));
      const reloadedJobIds = new Set(reloadedReservations.map(({ job }) => job.id));
      for (const reservation of committedReservations) {
        if (reloadedJobIds.has(reservation.job.id)) {
          continue;
        }
        await finishCronRunReceiptAsync(
          {
            handle: reservation.runReceipt,
            status: "skipped",
            finishedAtMs: params.state.deps.nowMs(),
            error: "cron reservation job disappeared before local handoff",
          },
          context,
        );
      }
      context.admission.assertCurrent();
      return reloadedReservations;
    } catch (error) {
      if (reservationCommitted) {
        try {
          await cleanupUnhandedReservations(committedReservations);
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            "Cron reservation handoff and cleanup failed",
            { cause: cleanupError },
          );
        }
      }
      if (error === retiredError) {
        return [];
      }
      throw error;
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
      runReceipt: CronRunReceiptHandle;
      runReceiptContext: OpenClawStateWorkerContext;
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
    return {
      kind: "activated",
      job: activatedJob,
      startedAt,
      runReceipt: activatedReceipt,
      runReceiptContext: reservation.runReceiptContext,
    };
  }

  params.onUnavailable?.();
  try {
    await releaseReservedCronRuns({
      state,
      context: reservation.runReceiptContext,
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
  runnableOptions?: Omit<Parameters<typeof isRunnableJob>[0], "job" | "nowMs">;
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
            await finishCronRunReceiptAsync(
              {
                handle: ownership.runReceipt,
                status: "skipped",
                finishedAtMs: state.deps.nowMs(),
                error: "cron reservation fenced by concurrent mutation",
              },
              ownership.runReceiptContext,
            );
          } catch {
            // finishCronRunReceiptAsync retained ownership and scheduled a retry.
          }
        }
        releaseQueuedCronRun(state, params.jobId, params.reservationIdentity);
        return undefined;
      }
      const runnableJob = structuredClone(job);
      delete runnableJob.state.queuedAtMs;
      if (
        !isRunnableJob({
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
      const taskRun = createCronRunHandle({
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
        runReceiptContext: activation.runReceiptContext,
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
      runReceiptContext: started.runReceiptContext,
    };
    let outcome: TimedCronRunOutcome;
    try {
      const result = await executeJobCoreWithTimeout(state, executionJob, {
        runId: taskRunId,
        activeJobMarker,
        runReceipt: started.runReceipt,
        runReceiptContext: started.runReceiptContext,
        executionIdentity: createCronOwnerExecutionIdentityAdmission({
          state,
          runReceipt: started.runReceipt,
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
