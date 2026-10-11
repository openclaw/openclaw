import pMap, { pMapSkip } from "p-map";
import { DEFAULT_CRON_MAX_CONCURRENT_RUNS } from "../../config/cron-limits.js";
import { isAbortError } from "../../infra/abort-signal.js";
import { formatErrorMessage } from "../../infra/errors.js";
import type { GatewaySchedulerScope } from "../../infra/gateway-scheduler.js";
import { SqliteWorkerAdmissionTimeoutError } from "../../infra/sqlite-worker-contract.js";
import { formatTimestamp } from "../../logging/timestamps.js";
import {
  beginGatewayRootWorkAdmissionWhenOpen,
  GatewayDrainingError,
} from "../../process/gateway-work-admission.js";
import { normalizeAgentId, resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { runInDetachedAsyncContext } from "../../shared/detached-async-context.js";
import { sweepCronRunSessions } from "../session-reaper.js";
import type { InterruptedStartupRun } from "../store/run-recovery.types.js";
import type { CronJob } from "../types.js";
import { enrollForeignReceipt } from "./foreign-receipt-monitor.js";
import {
  isStaleFutureCronSlot,
  needsCronTimerMaintenance,
  summarizeCronJobSchedule,
} from "./jobs-scheduling.js";
import { locked } from "./locked.js";
import { releaseReservedCronRuns } from "./run-admission-mutation.js";
import {
  cleanupQueuedCronRunReservations,
  executeQueuedCronRun,
  persistQueuedCronRunReservations,
  reserveQueuedCronRun,
  setCronRunCapacityListener,
  tryAcquireCronRunSlots,
} from "./run-admission.js";
import { skipCronJobsWithoutOwners } from "./run-owner.js";
import { emitInterruptedCronRun } from "./run-recovery-events.js";
import { recoverCronRunProposals } from "./run-recovery.js";
import { recomputeUnownedCronSchedules } from "./schedule-maintenance.js";
import type { CronServiceState } from "./state.js";
import {
  captureCronServiceMutationSource,
  ensureLoaded,
  runPostPersistCronNotifications,
} from "./store.js";
import { resolveCronJobTimeoutMs } from "./timeout-policy.js";
import { createCronCapacityRecheckGate } from "./timer-capacity-recheck.js";
import {
  MAX_CRON_TIMER_DELAY_MS,
  MIN_REFIRE_GAP_MS,
  type TimedCronRunOutcome,
} from "./timer-execution-timeout.js";
import { maybeNotifyIsolatedAgentSetupTimeout } from "./timer-notifications.js";
import {
  createCompletedCronRunOutcomeDrain,
  finalizeCompletedCronRunOutcomes,
} from "./timer-outcome-finalization.js";
import { collectRunnableJobs } from "./timer-runnable.js";

/** Arms the cron timer for the next wake or a maintenance recheck. */
export function armTimer(state: CronServiceState) {
  stopTimer(state);
  if (state.stopped || state.schedulingPaused || state.startupCatchup) {
    state.deps.log.debug({}, "cron: armTimer skipped - scheduler stopped");
    return;
  }
  if (!state.deps.cronEnabled) {
    state.deps.log.debug({}, "cron: armTimer skipped - scheduler disabled");
    return;
  }
  const { nextWakeAtMs: nextAt, jobCount, enabledCount } = summarizeCronJobSchedule(state);
  if (!nextAt) {
    // Enabled timed jobs can intentionally remain unscheduled after a failed
    // computation; the minute watchdog retries them until bounded auto-disable.
    const withNextRun = 0;
    if (enabledCount > 0) {
      armRunningRecheckTimer(state);
      state.deps.log.debug(
        { jobCount, enabledCount, withNextRun, delayMs: MAX_CRON_TIMER_DELAY_MS },
        "cron: timer armed for maintenance recheck",
      );
      return;
    }
    state.deps.log.debug(
      { jobCount, enabledCount, withNextRun },
      "cron: armTimer skipped - no jobs with nextRunAtMs",
    );
    return;
  }
  const now = state.deps.nowMs();
  const delay = Math.max(nextAt - now, 0);
  // A past-due slot blocked by a run marker must use the refire floor; otherwise
  // re-arming at zero delay creates the hot loop fixed by #13992.
  const flooredDelay = delay === 0 ? MIN_REFIRE_GAP_MS : delay;
  // Wake at least once a minute to avoid schedule drift and recover quickly
  // when the process was paused or wall-clock time jumps.
  const clampedDelay = Math.min(flooredDelay, MAX_CRON_TIMER_DELAY_MS);
  setCronTimer(state, clampedDelay);
  state.deps.log.debug(
    {
      nextAt,
      nextAtIso: formatTimestamp(new Date(nextAt), { style: "long" }),
      delayMs: clampedDelay,
      clamped: delay > MAX_CRON_TIMER_DELAY_MS,
    },
    "cron: timer armed",
  );
}

function armRunningRecheckTimer(state: CronServiceState) {
  if (state.stopped || state.schedulingPaused) {
    return;
  }
  setCronTimer(state, MAX_CRON_TIMER_DELAY_MS);
}

export function stopTimer(state: CronServiceState) {
  state.timer?.cancel();
  state.timer = null;
}

function setCronTimer(state: CronServiceState, delayMs: number): void {
  const scheduler = state.schedulerScope;
  state.timer = scheduler.schedule({
    id: `cron:${state.deps.storePath}:due`,
    delayMs,
    run: () => {
      state.timer = null;
      return runInDetachedAsyncContext(() => onTimer(state, scheduler)).catch((err: unknown) => {
        state.deps.log.error({ err: String(err) }, "cron: timer tick failed");
      });
    },
  });
}

/** Capacity wakes have their own scoped registration, independent of the current batch. */
function requestImmediateCronRecheck(
  state: CronServiceState,
  scheduler: GatewaySchedulerScope,
): void {
  if (
    state.stopped ||
    state.schedulingPaused ||
    !state.deps.cronEnabled ||
    scheduler !== state.schedulerScope ||
    scheduler.signal.aborted
  ) {
    return;
  }
  scheduler.schedule({
    id: `cron:${state.deps.storePath}:capacity`,
    delayMs: 0,
    run: () =>
      runInDetachedAsyncContext(() => onTimer(state, scheduler)).catch((err: unknown) => {
        state.deps.log.error({ err: String(err) }, "cron: immediate capacity recheck failed");
      }),
  });
}

/** Handles one cron timer tick under the process-wide root work admission. */
export async function onTimer(state: CronServiceState, scheduler = state.schedulerScope) {
  if (scheduler !== state.schedulerScope || scheduler.signal.aborted) {
    return;
  }
  const lifecycleGeneration = state.lifecycleGeneration;
  let admission;
  try {
    // A restart signal can be rejected after temporarily closing admission.
    // Wait for that decision so the consumed timer is not silently lost.
    admission = await beginGatewayRootWorkAdmissionWhenOpen("cron:timer-tick", scheduler.signal);
  } catch (err) {
    if (err instanceof GatewayDrainingError || (scheduler.signal.aborted && isAbortError(err))) {
      return;
    }
    throw err;
  }
  try {
    // Reopening admission cannot transfer a retired tick to a restarted scheduler.
    if (state.lifecycleGeneration === lifecycleGeneration) {
      const run = () => onAdmittedTimer(state, scheduler);
      await admission.run(() =>
        state.deps.runSchedulerOwned ? state.deps.runSchedulerOwned(run) : run(),
      );
    }
  } catch (error) {
    if (!(error instanceof SqliteWorkerAdmissionTimeoutError)) {
      throw error;
    }
    state.deps.log.warn({ err: String(error) }, "cron: worker admission delayed; retrying later");
  } finally {
    admission.release();
  }
}

/** Loads due jobs, reserves them, executes, persists, and re-arms. */
async function onAdmittedTimer(state: CronServiceState, scheduler: GatewaySchedulerScope) {
  if (state.stopped || state.schedulingPaused || state.startupCatchup) {
    return;
  }
  const source = captureCronServiceMutationSource(state);
  const generation = state.lifecycleGeneration;
  state.running = true;
  state.activeTimerTicks += 1;
  // Keep a watchdog timer armed while a tick is executing. If execution hangs
  // (for example in a provider call), the scheduler still wakes to re-check.
  armRunningRecheckTimer(state);
  const capacityRechecks = createCronCapacityRecheckGate(() =>
    requestImmediateCronRecheck(state, scheduler),
  );
  let allowEmptyCapacityRecheck = false;
  try {
    const dueJobs = await locked(state, async () => {
      await ensureLoaded(state, { forceReload: true });
      if (state.stopped || state.startupCatchup || state.lifecycleGeneration !== generation) {
        state.deps.log.warn({}, "cron: due job reservation skipped - scheduler unavailable");
        return [];
      }
      const proposals = (state.store?.jobs ?? [])
        .filter((job) => job.state.queuedAtMs !== undefined || job.state.runningAtMs !== undefined)
        .map((job) => ({
          jobId: job.id,
          queuedAtMs: job.state.queuedAtMs,
          runningAtMs: job.state.runningAtMs,
        }));
      let repaired = false;
      const interruptedRuns: InterruptedStartupRun[] = [];
      try {
        await recoverCronRunProposals(state, proposals, {
          isCurrent: () => !state.startupCatchup && state.lifecycleGeneration === generation,
          onRecovery(_proposal, result) {
            if (result.kind === "repaired") {
              repaired = true;
              runPostPersistCronNotifications(state, result.notifications);
              if (result.interrupted) {
                interruptedRuns.push(result.interrupted);
              }
            } else if (result.receipt && result.receipt.ownerPid !== process.pid) {
              enrollForeignReceipt(state, result.receipt);
            }
          },
        });
      } finally {
        if (repaired) {
          await ensureLoaded(state, { forceReload: true });
        }
        for (const interrupted of interruptedRuns) {
          await emitInterruptedCronRun(state, interrupted);
        }
      }
      // These interruptions already committed; publish them before fencing new scheduling work.
      if (state.stopped || state.startupCatchup || state.lifecycleGeneration !== generation) {
        return [];
      }
      const dueCheckNow = state.deps.nowMs();
      const due = await skipCronJobsWithoutOwners(
        state,
        collectRunnableJobs(state, dueCheckNow),
        dueCheckNow,
        { source },
      );
      if (state.stopped || state.startupCatchup || state.lifecycleGeneration !== generation) {
        return [];
      }

      if (due.length === 0) {
        if (!state.store?.jobs.some((job) => needsCronTimerMaintenance(job, dueCheckNow))) {
          return [];
        }
        const repairFuture = state.store.jobs.some((job) =>
          isStaleFutureCronSlot(job, dueCheckNow),
        );
        await recomputeUnownedCronSchedules(state, {
          recomputeExpired: true,
          nowMs: dueCheckNow,
          repairFutureCronNextRunAtMs: repairFuture,
        });

        return [];
      }

      const admissionReleases = tryAcquireCronRunSlots(state, due.length);
      const admittedDue = due.slice(0, admissionReleases.length);
      if (admittedDue.length < due.length) {
        // Keep unreserved work durable and wake it as soon as shared capacity
        // becomes available. A partial batch gates that wake until its own
        // receipt-backed reservations have either activated or been fenced.
        setCronRunCapacityListener(
          state,
          admittedDue.length > 0
            ? () => capacityRechecks.request()
            : () =>
                // A zero-admission tick returns before this wake and cannot drain it.
                requestImmediateCronRecheck(state, scheduler),
        );
        allowEmptyCapacityRecheck = admittedDue.length > 0;
      }
      if (admittedDue.length === 0) {
        return [];
      }

      const now = state.deps.nowMs();
      try {
        const reservedJobs = await persistQueuedCronRunReservations({
          state,
          source,
          candidates: admittedDue,
          reservedAtMs: now,
        });
        const reservedDue = reservedJobs.map(({ job, runReceipt, runReceiptContext }, index) => ({
          id: job.id,
          job,
          reservedAtMs: now,
          reservationIdentity: reserveQueuedCronRun(state, job.id, now, {
            runReceipt,
            runReceiptContext,
            lifecycleGeneration: generation,
          }),
          releaseAdmission: admissionReleases[index]!,
        }));
        if (reservedDue.length === 0 && allowEmptyCapacityRecheck) {
          // Releasing an unused slot is not progress. Retry immediately only
          // when the refreshed store removed a candidate from the due set;
          // otherwise child ticks retain their parents and starve the event loop.
          const stillDue = new Set(
            collectRunnableJobs(state, state.deps.nowMs()).map((job) => job.id),
          );
          allowEmptyCapacityRecheck = admittedDue.some((job) => !stillDue.has(job.id));
        }
        for (const releaseAdmission of admissionReleases.slice(reservedDue.length)) {
          releaseAdmission();
        }
        return reservedDue;
      } catch (error) {
        for (const releaseAdmission of admissionReleases) {
          releaseAdmission();
        }
        throw error;
      }
    });

    if (state.lifecycleGeneration === generation) {
      // Future unclaimed work must stay armed while this batch executes. When
      // overdue work is capacity-blocked, the release listener is the fast path
      // and this minute timer is only a bounded safety recheck.
      if (state.runAdmission.capacityListener) {
        armRunningRecheckTimer(state);
      } else {
        armTimer(state);
      }
    }

    const concurrency = Math.min(DEFAULT_CRON_MAX_CONCURRENT_RUNS, Math.max(1, dueJobs.length));
    capacityRechecks.initializeActivations(dueJobs.length, allowEmptyCapacityRecheck);
    const completedOutcomeDrain = createCompletedCronRunOutcomeDrain(state);
    const claimedIndexes = new Set<number>();
    let reservationReleaseError: unknown;
    let setupTimeoutNotified = false;
    let stopAdmittingDueJobs = false;
    const releaseUnclaimedDueJobReservationsWithRetry = async () => {
      const unclaimed = dueJobs.filter((_, index) => !claimedIndexes.has(index));
      const reservations = unclaimed.map((due) => ({
        jobId: due.id,
        reservationIdentity: due.reservationIdentity,
      }));
      try {
        await cleanupQueuedCronRunReservations({
          state,
          reservations,
          recompute: "maintenance",
        });
      } finally {
        for (const due of unclaimed) {
          due.releaseAdmission();
        }
      }
    };
    // Retired batches still own their reservations until canonical cleanup settles.
    if (state.stopped || state.lifecycleGeneration !== generation) {
      capacityRechecks.abort();
      if (dueJobs.length > 0) {
        await releaseUnclaimedDueJobReservationsWithRetry();
      }
      return;
    }
    // Skipped mappers must not claim reservations: recovery releases those rows,
    // while already-started jobs drain under the same service-wide cap.
    let completedResults: TimedCronRunOutcome[];
    let batchExecutionError: unknown;
    try {
      completedResults = await pMap(
        dueJobs,
        async (due, index): Promise<TimedCronRunOutcome | typeof pMapSkip> => {
          let initialActivationSettled = false;
          const settleThisInitialActivation = (allowRecheck: boolean) => {
            if (initialActivationSettled) {
              return;
            }
            initialActivationSettled = true;
            capacityRechecks.settleActivation(allowRecheck);
          };
          if (stopAdmittingDueJobs || state.stopped) {
            stopAdmittingDueJobs = true;
            settleThisInitialActivation(false);
            return pMapSkip;
          }
          try {
            const execution = await executeQueuedCronRun({
              state,
              jobId: due.id,
              reservedAtMs: due.reservedAtMs,
              reservationIdentity: due.reservationIdentity,
              admissionRelease: due.releaseAdmission,
              isUnavailable: () => stopAdmittingDueJobs,
              onUnavailable: () => {
                stopAdmittingDueJobs = true;
              },
              onActivated: () => {
                claimedIndexes.add(index);
                settleThisInitialActivation(true);
              },
              onNotRunnable: async () => {
                const owner = state.queuedRunReservationsByJobId.get(due.id);
                if (owner?.identity !== due.reservationIdentity) {
                  return;
                }
                await releaseReservedCronRuns({
                  state,
                  context: owner.runReceiptContext,
                  storeKey: owner.runReceipt.storeKey,
                  reservations: [{ jobId: due.id, reservationIdentity: due.reservationIdentity }],
                  policy: { kind: "scheduled-ineligible" },
                  onSettled() {},
                });
              },
              onSetupError: (job, errorText) => {
                state.deps.log.warn(
                  {
                    jobId: due.id,
                    jobName: job.name,
                    timeoutMs: resolveCronJobTimeoutMs(job) ?? null,
                  },
                  `cron: job failed: ${errorText}`,
                );
              },
              onCompleted: async (result) => {
                if (!result.isolatedAgentSetupTimeout) {
                  // Drain finished state independently: a slow sibling must not
                  // strand outcomes, and store I/O must not own execution slots.
                  completedOutcomeDrain.enqueue(result);
                  return true;
                }
                let finalizedResults: TimedCronRunOutcome[];
                try {
                  finalizedResults = await finalizeCompletedCronRunOutcomes(state, [result], {
                    clearOnFailure: false,
                  });
                } catch {
                  return false;
                }
                if (
                  finalizedResults.length > 0 &&
                  !setupTimeoutNotified &&
                  maybeNotifyIsolatedAgentSetupTimeout(state, result)
                ) {
                  setupTimeoutNotified = true;
                  stopAdmittingDueJobs = true;
                  try {
                    await releaseUnclaimedDueJobReservationsWithRetry();
                  } catch (err) {
                    reservationReleaseError = err;
                  }
                }
                return true;
              },
            });
            if (execution.kind === "stopped") {
              stopAdmittingDueJobs = true;
              return pMapSkip;
            }
            if (execution.kind === "skipped") {
              settleThisInitialActivation(!stopAdmittingDueJobs && !state.stopped);
              return pMapSkip;
            }
            if (execution.handled) {
              return pMapSkip;
            }
            return execution.outcome;
          } catch (error) {
            stopAdmittingDueJobs = true;
            batchExecutionError ??= error;
            return pMapSkip;
          } finally {
            settleThisInitialActivation(false);
          }
        },
        // Let already-admitted mappers drain so their outcomes can be persisted
        // even when a sibling activation fails.
        { concurrency, stopOnError: false },
      );
    } catch (error) {
      let finalizationError: unknown;
      try {
        await completedOutcomeDrain.flush();
      } catch (drainError) {
        finalizationError = drainError;
      }
      await releaseUnclaimedDueJobReservationsWithRetry();
      if (finalizationError) {
        throw finalizationError instanceof Error
          ? finalizationError
          : new Error(formatErrorMessage(finalizationError));
      }
      throw error instanceof AggregateError && error.errors.length > 0 ? error.errors[0] : error;
    }
    let postBatchError = reservationReleaseError;
    try {
      await completedOutcomeDrain.flush();
    } catch (error) {
      // Finalization errors still need to release every unclaimed durable
      // reservation before the failed timer batch can exit.
      postBatchError ??= error;
      stopAdmittingDueJobs = true;
    }
    if (stopAdmittingDueJobs) {
      try {
        await releaseUnclaimedDueJobReservationsWithRetry();
      } catch (error) {
        postBatchError ??= error;
      }
    }

    if (completedResults.length > 0) {
      const finalizedResults = await finalizeCompletedCronRunOutcomes(state, completedResults);
      for (const result of finalizedResults) {
        if (
          !setupTimeoutNotified &&
          result.isolatedAgentSetupTimeout &&
          maybeNotifyIsolatedAgentSetupTimeout(state, result)
        ) {
          setupTimeoutNotified = true;
          break;
        }
      }
    }
    if (postBatchError) {
      throw postBatchError instanceof Error
        ? postBatchError
        : new Error(formatErrorMessage(postBatchError));
    }
    if (batchExecutionError) {
      throw batchExecutionError instanceof Error
        ? batchExecutionError
        : new Error(formatErrorMessage(batchExecutionError));
    }
  } finally {
    capacityRechecks.abort();
    try {
      // Reaper discovery is maintenance: failure must never strand the timer
      // or leave the scheduler's execution slot permanently occupied.
      if (
        state.lifecycleGeneration === generation &&
        (state.deps.resolveSessionStorePath || state.deps.sessionStorePath)
      ) {
        const configuredDefaultAgentId = (
          state.deps.resolveDefaultAgentId?.() ?? state.deps.defaultAgentId
        )?.trim();
        const defaultAgentId = configuredDefaultAgentId
          ? normalizeAgentId(configuredDefaultAgentId)
          : undefined;
        const reaperAgentIds = new Set(
          ((await state.deps.resolveSessionStoreAgentIds?.()) ?? []).map(normalizeAgentId),
        );
        const resolveJobAgentId = (job: CronJob): string | undefined => {
          if (typeof job.agentId === "string" && job.agentId.trim()) {
            return normalizeAgentId(job.agentId);
          }
          try {
            return resolveAgentIdFromSessionKey(job.sessionKey, defaultAgentId);
          } catch {
            // An ownerless legacy job needs a configured default for cleanup.
            // Other prepared owners remain valid reaper targets without one.
            return undefined;
          }
        };
        for (const job of state.store?.jobs ?? []) {
          const agentId = resolveJobAgentId(job);
          if (agentId) {
            reaperAgentIds.add(agentId);
          }
        }
        if (defaultAgentId) {
          reaperAgentIds.add(defaultAgentId);
        }

        if (reaperAgentIds.size > 0) {
          const nowMs = state.deps.nowMs();
          for (const agentId of reaperAgentIds) {
            const storePath = state.deps.resolveSessionStorePath
              ? state.deps.resolveSessionStorePath(agentId)
              : state.deps.sessionStorePath;
            if (!storePath) {
              continue;
            }
            try {
              await sweepCronRunSessions({
                agentId,
                cronConfig: state.deps.cronConfig,
                sessionStorePath: storePath,
                isAgentAvailable: state.deps.isAgentAvailable,
                nowMs,
                log: state.deps.log,
              });
            } catch (err) {
              state.deps.log.warn(
                { err: String(err), storePath },
                "cron: session reaper sweep failed",
              );
            }
          }
        }
      }
    } catch (err) {
      state.deps.log.warn({ err: String(err) }, "cron: session reaper preparation failed");
    } finally {
      state.activeTimerTicks = Math.max(0, state.activeTimerTicks - 1);
      state.running = state.activeTimerTicks > 0;
      if (!state.running && state.lifecycleGeneration === generation) {
        armTimer(state);
      }
    }
  }
}
