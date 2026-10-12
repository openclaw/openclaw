import { isAbortError } from "../../infra/abort-signal.js";
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
import { skipCronJobsWithoutOwners } from "./run-owner.js";
import { requestCronRuns, drainCronRunQueue } from "./run-queue.js";
import { emitInterruptedCronRun } from "./run-recovery-events.js";
import { recoverCronRunProposals } from "./run-recovery.js";
import { recomputeUnownedCronSchedules } from "./schedule-maintenance.js";
import type { CronServiceState } from "./state.js";
import {
  captureCronServiceMutationSource,
  ensureLoaded,
  runPostPersistCronNotifications,
} from "./store.js";
import { MAX_CRON_TIMER_DELAY_MS, MIN_REFIRE_GAP_MS } from "./timer-execution-timeout.js";
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
      const run = () => onAdmittedTimer(state);
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

/** Produces timed requests; the worker owns capacity and activation. */
async function onAdmittedTimer(state: CronServiceState) {
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
  try {
    const dueJobs = await locked(state, async () => {
      await ensureLoaded(state, { forceReload: true });
      if (state.stopped || state.startupCatchup || state.lifecycleGeneration !== generation) {
        state.deps.log.warn({}, "cron: due job request skipped - scheduler unavailable");
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
          async onRecovery(_proposal, result) {
            if (result.kind === "repaired") {
              repaired = true;
              await runPostPersistCronNotifications(state, result.notifications);
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

      return due;
    });

    if (state.stopped || state.lifecycleGeneration !== generation) {
      return;
    }
    const requests = await requestCronRuns(state, dueJobs);
    await drainCronRunQueue(state);
    if (state.lifecycleGeneration === generation) {
      // Queued rows are durable; completion pumps their next activation.
      armTimer(state);
    }
    const results = await Promise.allSettled(requests.map(({ completion }) => completion));
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") {
      throw failed.reason;
    }
  } finally {
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
