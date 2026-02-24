import type { HeartbeatRunResult } from "../../infra/heartbeat-wake.js";
import { DEFAULT_AGENT_ID } from "../../routing/session-key.js";
import { resolveCronDeliveryPlan } from "../delivery.js";
import { sweepCronRunSessions } from "../session-reaper.js";
import type {
  CronDeliveryStatus,
  CronJob,
  CronRunOutcome,
  CronRunStatus,
  CronRunTelemetry,
} from "../types.js";
import {
  computeJobNextRunAtMs,
  nextWakeAtMs,
  recomputeNextRunsForMaintenance,
  resolveJobPayloadTextForMain,
} from "./jobs.js";
import { locked } from "./locked.js";
import type { CronEvent, CronServiceState } from "./state.js";
import { ensureLoaded, persist } from "./store.js";

const MAX_TIMER_DELAY_MS = 60_000;

/**
 * Minimum gap between consecutive fires of the same cron job.  This is a
 * safety net that prevents spin-loops when `computeJobNextRunAtMs` returns
 * a value within the same second as the just-completed run.  The guard
 * is intentionally generous (2 s) so it never masks a legitimate schedule
 * but always breaks an infinite re-trigger cycle.  (See #17821)
 */
const MIN_REFIRE_GAP_MS = 2_000;

/**
 * Maximum wall-clock time for a single job execution. Acts as a safety net
 * on top of the per-provider / per-agent timeouts to prevent one stuck job
 * from wedging the entire cron lane.
 */
export const DEFAULT_JOB_TIMEOUT_MS = 10 * 60_000; // 10 minutes

type TimedCronRunOutcome = CronRunOutcome &
  CronRunTelemetry & {
    jobId: string;
    delivered?: boolean;
    startedAt: number;
    endedAt: number;
  };

function resolveCronJobTimeoutMs(job: CronJob): number | undefined {
  const configuredTimeoutMs =
    job.payload.kind === "agentTurn" && typeof job.payload.timeoutSeconds === "number"
      ? Math.floor(job.payload.timeoutSeconds * 1_000)
      : undefined;
  if (configuredTimeoutMs === undefined) {
    return DEFAULT_JOB_TIMEOUT_MS;
  }
  return configuredTimeoutMs <= 0 ? undefined : configuredTimeoutMs;
}

export async function executeJobCoreWithTimeout(
  state: CronServiceState,
  job: CronJob,
): Promise<Awaited<ReturnType<typeof executeJobCore>>> {
  const jobTimeoutMs = resolveCronJobTimeoutMs(job);
  if (typeof jobTimeoutMs !== "number") {
    return await executeJobCore(state, job);
  }

  const runAbortController = new AbortController();
  let timeoutId: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      executeJobCore(state, job, runAbortController.signal),
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          runAbortController.abort(timeoutErrorMessage());
          reject(new Error(timeoutErrorMessage()));
        }, jobTimeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

function resolveRunConcurrency(state: CronServiceState): number {
  const raw = state.deps.cronConfig?.maxConcurrentRuns;
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return 1;
  }
  return Math.max(1, Math.floor(raw));
}
function timeoutErrorMessage(): string {
  return "cron: job execution timed out";
}

function isAbortError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  return err.name === "AbortError" || err.message === timeoutErrorMessage();
}
/**
 * Exponential backoff delays (in ms) indexed by consecutive error count.
 * After the last entry the delay stays constant.
 */
const ERROR_BACKOFF_SCHEDULE_MS = [
  30_000, // 1st error  →  30 s
  60_000, // 2nd error  →   1 min
  5 * 60_000, // 3rd error  →   5 min
  15 * 60_000, // 4th error  →  15 min
  60 * 60_000, // 5th+ error →  60 min
];

function errorBackoffMs(consecutiveErrors: number): number {
  const idx = Math.min(consecutiveErrors - 1, ERROR_BACKOFF_SCHEDULE_MS.length - 1);
  return ERROR_BACKOFF_SCHEDULE_MS[Math.max(0, idx)];
}

function resolveDeliveryStatus(params: { job: CronJob; delivered?: boolean }): CronDeliveryStatus {
  if (params.delivered === true) {
    return "delivered";
  }
  if (params.delivered === false) {
    return "not-delivered";
  }
  return resolveCronDeliveryPlan(params.job).requested ? "unknown" : "not-requested";
}

/**
 * Apply the result of a job execution to the job's state.
 * Handles consecutive error tracking, exponential backoff, one-shot disable,
 * and nextRunAtMs computation. Returns `true` if the job should be deleted.
 */
export function applyJobResult(
  state: CronServiceState,
  job: CronJob,
  result: {
    status: CronRunStatus;
    error?: string;
    delivered?: boolean;
    startedAt: number;
    endedAt: number;
  },
): boolean {
  job.state.runningAtMs = undefined;
  job.state.lastRunAtMs = result.startedAt;
  job.state.lastRunStatus = result.status;
  job.state.lastStatus = result.status;
  job.state.lastDurationMs = Math.max(0, result.endedAt - result.startedAt);
  job.state.lastError = result.error;
  job.state.lastDelivered = result.delivered;
  const deliveryStatus = resolveDeliveryStatus({ job, delivered: result.delivered });
  job.state.lastDeliveryStatus = deliveryStatus;
  job.state.lastDeliveryError =
    deliveryStatus === "not-delivered" && result.error ? result.error : undefined;
  job.updatedAtMs = result.endedAt;

  // Track consecutive errors for backoff / auto-disable.
  if (result.status === "error") {
    job.state.consecutiveErrors = (job.state.consecutiveErrors ?? 0) + 1;
  } else {
    job.state.consecutiveErrors = 0;
  }

  const shouldDelete =
    job.schedule.kind === "at" && job.deleteAfterRun === true && result.status === "ok";

  if (!shouldDelete) {
    if (job.schedule.kind === "at") {
      // One-shot jobs are always disabled after ANY terminal status
      // (ok, error, or skipped). This prevents tight-loop rescheduling
      // when computeJobNextRunAtMs returns the past atMs value (#11452).
      job.enabled = false;
      job.state.nextRunAtMs = undefined;
      if (result.status === "error") {
        state.deps.log.warn(
          {
            jobId: job.id,
            jobName: job.name,
            consecutiveErrors: job.state.consecutiveErrors,
            error: result.error,
          },
          "cron: disabling one-shot job after error",
        );
      }
    } else if (result.status === "error" && job.enabled) {
      // Apply exponential backoff for errored jobs to prevent retry storms.
      const backoff = errorBackoffMs(job.state.consecutiveErrors ?? 1);
      const normalNext = computeJobNextRunAtMs(job, result.endedAt);
      const backoffNext = result.endedAt + backoff;
      // Use whichever is later: the natural next run or the backoff delay.
      job.state.nextRunAtMs =
        normalNext !== undefined ? Math.max(normalNext, backoffNext) : backoffNext;
      state.deps.log.info(
        {
          jobId: job.id,
          consecutiveErrors: job.state.consecutiveErrors,
          backoffMs: backoff,
          nextRunAtMs: job.state.nextRunAtMs,
        },
        "cron: applying error backoff",
      );
    } else if (job.enabled) {
      const naturalNext = computeJobNextRunAtMs(job, result.endedAt);
      if (job.schedule.kind === "cron") {
        // Safety net: ensure the next fire is at least MIN_REFIRE_GAP_MS
        // after the current run ended.  Prevents spin-loops when the
        // schedule computation lands in the same second due to
        // timezone/croner edge cases (see #17821).
        const minNext = result.endedAt + MIN_REFIRE_GAP_MS;
        job.state.nextRunAtMs =
          naturalNext !== undefined ? Math.max(naturalNext, minNext) : minNext;
      } else {
        job.state.nextRunAtMs = naturalNext;
      }
    } else {
      job.state.nextRunAtMs = undefined;
    }
  }

  return shouldDelete;
}

function applyOutcomeToStoredJob(state: CronServiceState, result: TimedCronRunOutcome): void {
  const store = state.store;
  if (!store) {
    return;
  }
  const jobs = store.jobs;
  const job = jobs.find((entry) => entry.id === result.jobId);
  if (!job) {
    return;
  }

  const shouldDelete = applyJobResult(state, job, {
    status: result.status,
    error: result.error,
    delivered: result.delivered,
    startedAt: result.startedAt,
    endedAt: result.endedAt,
  });

  emitJobFinished(state, job, result, result.startedAt);

  if (shouldDelete) {
    store.jobs = jobs.filter((entry) => entry.id !== job.id);
    emit(state, { jobId: job.id, action: "removed" });
  }
}

export function armTimer(state: CronServiceState) {
  if (state.timer) {
    clearTimeout(state.timer);
  }
  state.timer = null;
  if (!state.deps.cronEnabled) {
    state.deps.log.debug({}, "cron: armTimer skipped - scheduler disabled");
    return;
  }
  const nextAt = nextWakeAtMs(state);
  if (!nextAt) {
    const jobCount = state.store?.jobs.length ?? 0;
    const enabledCount = state.store?.jobs.filter((j) => j.enabled).length ?? 0;
    const withNextRun =
      state.store?.jobs.filter((j) => j.enabled && typeof j.state.nextRunAtMs === "number")
        .length ?? 0;
    state.deps.log.debug(
      { jobCount, enabledCount, withNextRun },
      "cron: armTimer skipped - no jobs with nextRunAtMs",
    );
    return;
  }
  const now = state.deps.nowMs();
  const delay = Math.max(nextAt - now, 0);
  // Wake at least once a minute to avoid schedule drift and recover quickly
  // when the process was paused or wall-clock time jumps.
  const clampedDelay = Math.min(delay, MAX_TIMER_DELAY_MS);
  // Intentionally avoid an `async` timer callback:
  // Vitest's fake-timer helpers can await async callbacks, which would block
  // tests that simulate long-running jobs. Runtime behavior is unchanged.
  state.timer = setTimeout(() => {
    void onTimer(state).catch((err) => {
      state.deps.log.error({ err: String(err) }, "cron: timer tick failed");
    });
  }, clampedDelay);
  state.deps.log.debug(
    { nextAt, delayMs: clampedDelay, clamped: delay > MAX_TIMER_DELAY_MS },
    "cron: timer armed",
  );
}

function armRunningRecheckTimer(state: CronServiceState) {
  if (state.timer) {
    clearTimeout(state.timer);
  }
  state.timer = setTimeout(() => {
    void onTimer(state).catch((err) => {
      state.deps.log.error({ err: String(err) }, "cron: timer tick failed");
    });
  }, MAX_TIMER_DELAY_MS);
}

export async function onTimer(state: CronServiceState) {
  if (state.running) {
    // Re-arm the timer so the scheduler keeps ticking even when a job is
    // still executing.  Without this, a long-running job (e.g. an agentTurn
    // exceeding MAX_TIMER_DELAY_MS) causes the clamped 60 s timer to fire
    // while `running` is true.  The early return then leaves no timer set,
    // silently killing the scheduler until the next gateway restart.
    //
    // We use MAX_TIMER_DELAY_MS as a fixed re-check interval to avoid a
    // zero-delay hot-loop when past-due jobs are waiting for the current
    // execution to finish.
    // See: https://github.com/openclaw/openclaw/issues/12025
    armRunningRecheckTimer(state);
    return;
  }
  state.running = true;
  // Keep a watchdog timer armed while a tick is executing. If execution hangs
  // (for example in a provider call), the scheduler still wakes to re-check.
  armRunningRecheckTimer(state);
  try {
    const dueJobs = await locked(state, async () => {
      await ensureLoaded(state, { forceReload: true, skipRecompute: true });
      const due = findDueJobs(state);

      if (due.length === 0) {
        // Use maintenance-only recompute to avoid advancing past-due nextRunAtMs
        // values without execution. This prevents jobs from being silently skipped
        // when the timer wakes up but findDueJobs returns empty (see #13992).
        const changed = recomputeNextRunsForMaintenance(state);
        if (changed) {
          await persist(state);
        }
        return [];
      }

      const now = state.deps.nowMs();
      for (const job of due) {
        job.state.runningAtMs = now;
        job.state.lastError = undefined;
      }
      await persist(state);

      return due.map((j) => ({
        id: j.id,
        job: j,
      }));
    });

    const runDueJob = async (params: {
      id: string;
      job: CronJob;
    }): Promise<TimedCronRunOutcome> => {
      const { id, job } = params;
      const startedAt = state.deps.nowMs();
      job.state.runningAtMs = startedAt;
      emit(state, { jobId: job.id, action: "started", runAtMs: startedAt });
      const jobTimeoutMs = resolveCronJobTimeoutMs(job);

      try {
        const result = await executeJobCoreWithTimeout(state, job);
        return { jobId: id, ...result, startedAt, endedAt: state.deps.nowMs() };
      } catch (err) {
        const errorText = isAbortError(err) ? timeoutErrorMessage() : String(err);
        state.deps.log.warn(
          { jobId: id, jobName: job.name, timeoutMs: jobTimeoutMs ?? null },
          `cron: job failed: ${errorText}`,
        );
        return {
          jobId: id,
          status: "error",
          error: errorText,
          startedAt,
          endedAt: state.deps.nowMs(),
        };
      }
    };

    const concurrency = Math.min(resolveRunConcurrency(state), Math.max(1, dueJobs.length));
    const results: (TimedCronRunOutcome | undefined)[] = Array.from({ length: dueJobs.length });
    let cursor = 0;
    const workers = Array.from({ length: concurrency }, async () => {
      for (;;) {
        const index = cursor++;
        if (index >= dueJobs.length) {
          return;
        }
        const due = dueJobs[index];
        if (!due) {
          return;
        }
        results[index] = await runDueJob(due);
      }
    });
    await Promise.all(workers);

    const completedResults: TimedCronRunOutcome[] = results.filter(
      (entry): entry is TimedCronRunOutcome => entry !== undefined,
    );

    if (completedResults.length > 0) {
      await locked(state, async () => {
        await ensureLoaded(state, { forceReload: true, skipRecompute: true });

        for (const result of completedResults) {
          applyOutcomeToStoredJob(state, result);
        }

        // Use maintenance-only recompute to avoid advancing past-due
        // nextRunAtMs values that became due between findDueJobs and this
        // locked block.  The full recomputeNextRuns would silently skip
        // those jobs (advancing nextRunAtMs without execution), causing
        // daily cron schedules to jump 48 h instead of 24 h (#17852).
        recomputeNextRunsForMaintenance(state);
        await persist(state);
      });
    }
    // Piggyback session reaper on timer tick (self-throttled to every 5 min).
    const storePaths = new Set<string>();
    if (state.deps.resolveSessionStorePath) {
      const defaultAgentId = state.deps.defaultAgentId ?? DEFAULT_AGENT_ID;
      if (state.store?.jobs?.length) {
        for (const job of state.store.jobs) {
          const agentId =
            typeof job.agentId === "string" && job.agentId.trim() ? job.agentId : defaultAgentId;
          storePaths.add(state.deps.resolveSessionStorePath(agentId));
        }
      } else {
        storePaths.add(state.deps.resolveSessionStorePath(defaultAgentId));
      }
    } else if (state.deps.sessionStorePath) {
      storePaths.add(state.deps.sessionStorePath);
    }

    if (storePaths.size > 0) {
      const nowMs = state.deps.nowMs();
      for (const storePath of storePaths) {
        try {
          await sweepCronRunSessions({
            cronConfig: state.deps.cronConfig,
            sessionStorePath: storePath,
            nowMs,
            log: state.deps.log,
          });
        } catch (err) {
          state.deps.log.warn({ err: String(err), storePath }, "cron: session reaper sweep failed");
        }
      }
    }
  } finally {
    state.running = false;
    armTimer(state);
  }
}

function findDueJobs(state: CronServiceState): CronJob[] {
  if (!state.store) {
    return [];
  }
  const now = state.deps.nowMs();
  return collectRunnableJobs(state, now);
}

function isRunnableJob(params: {
  job: CronJob;
  nowMs: number;
  skipJobIds?: ReadonlySet<string>;
  skipAtIfAlreadyRan?: boolean;
}): boolean {
  const { job, nowMs } = params;
  if (!job.state) {
    job.state = {};
  }
  if (!job.enabled) {
    return false;
  }
  if (params.skipJobIds?.has(job.id)) {
    return false;
  }
  if (typeof job.state.runningAtMs === "number") {
    return false;
  }
  if (params.skipAtIfAlreadyRan && job.schedule.kind === "at" && job.state.lastStatus) {
    // Any terminal status (ok, error, skipped) means the job already ran at least once.
    // Don't re-fire it on restart — applyJobResult disables one-shot jobs, but guard
    // here defensively (#13845).
    return false;
  }
  const next = job.state.nextRunAtMs;
  return typeof next === "number" && nowMs >= next;
}

function collectRunnableJobs(
  state: CronServiceState,
  nowMs: number,
  opts?: { skipJobIds?: ReadonlySet<string>; skipAtIfAlreadyRan?: boolean },
): CronJob[] {
  if (!state.store) {
    return [];
  }
  return state.store.jobs.filter((job) =>
    isRunnableJob({
      job,
      nowMs,
      skipJobIds: opts?.skipJobIds,
      skipAtIfAlreadyRan: opts?.skipAtIfAlreadyRan,
    }),
  );
}

export async function runMissedJobs(
  state: CronServiceState,
  opts?: { skipJobIds?: ReadonlySet<string> },
) {
  const startupCandidates = await locked(state, async () => {
    await ensureLoaded(state, { skipRecompute: true });
    if (!state.store) {
      return [] as Array<{ jobId: string; job: CronJob }>;
    }
    const now = state.deps.nowMs();
    const skipJobIds = opts?.skipJobIds;
    const missed = collectRunnableJobs(state, now, { skipJobIds, skipAtIfAlreadyRan: true });
    if (missed.length === 0) {
      return [] as Array<{ jobId: string; job: CronJob }>;
    }
    state.deps.log.info(
      { count: missed.length, jobIds: missed.map((j) => j.id) },
      "cron: running missed jobs after restart",
    );
    for (const job of missed) {
      job.state.runningAtMs = now;
      job.state.lastError = undefined;
    }
    await persist(state);
    return missed.map((job) => ({ jobId: job.id, job }));
  });

  if (startupCandidates.length === 0) {
    return;
  }

  const outcomes: Array<TimedCronRunOutcome> = [];
  for (const candidate of startupCandidates) {
    const startedAt = state.deps.nowMs();
    emit(state, { jobId: candidate.job.id, action: "started", runAtMs: startedAt });
    try {
      const result = await executeJobCoreWithTimeout(state, candidate.job);
      outcomes.push({
        jobId: candidate.jobId,
        status: result.status,
        error: result.error,
        summary: result.summary,
        delivered: result.delivered,
        sessionId: result.sessionId,
        sessionKey: result.sessionKey,
        model: result.model,
        provider: result.provider,
        usage: result.usage,
        startedAt,
        endedAt: state.deps.nowMs(),
      });
    } catch (err) {
      outcomes.push({
        jobId: candidate.jobId,
        status: "error",
        error: String(err),
        startedAt,
        endedAt: state.deps.nowMs(),
      });
    }
  }

  await locked(state, async () => {
    await ensureLoaded(state, { forceReload: true, skipRecompute: true });
    if (!state.store) {
      return;
    }

    for (const result of outcomes) {
      applyOutcomeToStoredJob(state, result);
    }

    // Preserve any new past-due nextRunAtMs values that became due while
    // startup catch-up was running. They should execute on a future tick
    // instead of being silently advanced.
    recomputeNextRunsForMaintenance(state);
    await persist(state);
  });
}

export async function runDueJobs(state: CronServiceState) {
  if (!state.store) {
    return;
  }
  const now = state.deps.nowMs();
  const due = collectRunnableJobs(state, now);
  for (const job of due) {
    await executeJob(state, job, now, { forced: false });
  }
}

export async function executeJobCore(
  state: CronServiceState,
  job: CronJob,
  abortSignal?: AbortSignal,
): Promise<CronRunOutcome & CronRunTelemetry & { delivered?: boolean }> {
  const resolveAbortError = () => ({
    status: "error" as const,
    error: timeoutErrorMessage(),
  });
  const waitWithAbort = async (ms: number) => {
    if (!abortSignal) {
      await new Promise<void>((resolve) => setTimeout(resolve, ms));
      return;
    }
    if (abortSignal.aborted) {
      return;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        abortSignal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        abortSignal.removeEventListener("abort", onAbort);
        resolve();
      };
      abortSignal.addEventListener("abort", onAbort, { once: true });
    });
  };

  if (abortSignal?.aborted) {
    return resolveAbortError();
  }
  if (job.sessionTarget === "main") {
    const text = resolveJobPayloadTextForMain(job);
    if (!text) {
      const kind = job.payload.kind;
      return {
        status: "skipped",
        error:
          kind === "systemEvent"
            ? "main job requires non-empty systemEvent text"
            : 'main job requires payload.kind="systemEvent"',
      };
    }
    state.deps.enqueueSystemEvent(text, {
      agentId: job.agentId,
      sessionKey: job.sessionKey,
      contextKey: `cron:${job.id}`,
    });
    if (job.wakeMode === "now" && state.deps.runHeartbeatOnce) {
      const reason = `cron:${job.id}`;
      const maxWaitMs = state.deps.wakeNowHeartbeatBusyMaxWaitMs ?? 2 * 60_000;
      const retryDelayMs = state.deps.wakeNowHeartbeatBusyRetryDelayMs ?? 250;
      const waitStartedAt = state.deps.nowMs();

      let heartbeatResult: HeartbeatRunResult;
      for (;;) {
        if (abortSignal?.aborted) {
          return resolveAbortError();
        }
        heartbeatResult = await state.deps.runHeartbeatOnce({
          reason,
          agentId: job.agentId,
          sessionKey: job.sessionKey,
        });
        if (
          heartbeatResult.status !== "skipped" ||
          heartbeatResult.reason !== "requests-in-flight"
        ) {
          break;
        }
        if (abortSignal?.aborted) {
          return resolveAbortError();
        }
        if (state.deps.nowMs() - waitStartedAt > maxWaitMs) {
          if (abortSignal?.aborted) {
            return resolveAbortError();
          }
          state.deps.requestHeartbeatNow({
            reason,
            agentId: job.agentId,
            sessionKey: job.sessionKey,
          });
          return { status: "ok", summary: text };
        }
        await waitWithAbort(retryDelayMs);
      }

      if (heartbeatResult.status === "ran") {
        return { status: "ok", summary: text };
      } else if (heartbeatResult.status === "skipped") {
        return { status: "skipped", error: heartbeatResult.reason, summary: text };
      } else {
        return { status: "error", error: heartbeatResult.reason, summary: text };
      }
    } else {
      if (abortSignal?.aborted) {
        return resolveAbortError();
      }
      state.deps.requestHeartbeatNow({
        reason: `cron:${job.id}`,
        agentId: job.agentId,
        sessionKey: job.sessionKey,
      });
      return { status: "ok", summary: text };
    }
  }

  if (job.payload.kind !== "agentTurn") {
    return { status: "skipped", error: "isolated job requires payload.kind=agentTurn" };
  }
  if (abortSignal?.aborted) {
    return resolveAbortError();
  }

  const res = await state.deps.runIsolatedAgentJob({
    job,
    message: job.payload.message,
    abortSignal,
  });

  if (abortSignal?.aborted) {
    return { status: "error", error: timeoutErrorMessage() };
  }

  // Post a short summary back to the main session — but only when the
  // isolated run did NOT already deliver its output to the target channel.
  // When `res.delivered` is true the announce flow (or direct outbound
  // delivery) already sent the result, so posting the summary to main
  // would wake the main agent and cause a duplicate message.
  // See: https://github.com/openclaw/openclaw/issues/15692
  const summaryText = res.summary?.trim();
  const deliveryPlan = resolveCronDeliveryPlan(job);
  const suppressMainSummary =
    res.status === "error" && res.errorKind === "delivery-target" && deliveryPlan.requested;
  if (summaryText && deliveryPlan.requested && !res.delivered && !suppressMainSummary) {
    const prefix = "Cron";
    const label =
      res.status === "error" ? `${prefix} (error): ${summaryText}` : `${prefix}: ${summaryText}`;
    state.deps.enqueueSystemEvent(label, {
      agentId: job.agentId,
      sessionKey: job.sessionKey,
      contextKey: `cron:${job.id}`,
    });
    if (job.wakeMode === "now") {
      state.deps.requestHeartbeatNow({
        reason: `cron:${job.id}`,
        agentId: job.agentId,
        sessionKey: job.sessionKey,
      });
    }
  }

  return {
    status: res.status,
    error: res.error,
    summary: res.summary,
    delivered: res.delivered,
    sessionId: res.sessionId,
    sessionKey: res.sessionKey,
    model: res.model,
    provider: res.provider,
    usage: res.usage,
  };
}

/**
 * Execute a job. This version is used by the `run` command and other
 * places that need the full execution with state updates.
 */
export async function executeJob(
  state: CronServiceState,
  job: CronJob,
  _nowMs: number,
  _opts: { forced: boolean },
) {
  if (!job.state) {
    job.state = {};
  }
  const startedAt = state.deps.nowMs();
  job.state.runningAtMs = startedAt;
  job.state.lastError = undefined;
  emit(state, { jobId: job.id, action: "started", runAtMs: startedAt });

  let coreResult: {
    status: CronRunStatus;
    delivered?: boolean;
  } & CronRunOutcome &
    CronRunTelemetry;
  try {
    coreResult = await executeJobCore(state, job);
  } catch (err) {
    coreResult = { status: "error", error: String(err) };
  }

  const endedAt = state.deps.nowMs();
  const shouldDelete = applyJobResult(state, job, {
    status: coreResult.status,
    error: coreResult.error,
    delivered: coreResult.delivered,
    startedAt,
    endedAt,
  });

  emitJobFinished(state, job, coreResult, startedAt);

  if (shouldDelete && state.store) {
    state.store.jobs = state.store.jobs.filter((j) => j.id !== job.id);
    emit(state, { jobId: job.id, action: "removed" });
  }
}

function emitJobFinished(
  state: CronServiceState,
  job: CronJob,
  result: {
    status: CronRunStatus;
    delivered?: boolean;
  } & CronRunOutcome &
    CronRunTelemetry,
  runAtMs: number,
) {
  emit(state, {
    jobId: job.id,
    action: "finished",
    status: result.status,
    error: result.error,
    summary: result.summary,
    delivered: result.delivered,
    deliveryStatus: job.state.lastDeliveryStatus,
    deliveryError: job.state.lastDeliveryError,
    sessionId: result.sessionId,
    sessionKey: result.sessionKey,
    runAtMs,
    durationMs: job.state.lastDurationMs,
    nextRunAtMs: job.state.nextRunAtMs,
    model: result.model,
    provider: result.provider,
    usage: result.usage,
  });
}

export function wake(
  state: CronServiceState,
  opts: { mode: "now" | "next-heartbeat"; text: string },
) {
  const text = opts.text.trim();
  if (!text) {
    return { ok: false } as const;
  }
  state.deps.enqueueSystemEvent(text);
  if (opts.mode === "now") {
    state.deps.requestHeartbeatNow({ reason: "wake" });
  }
  return { ok: true } as const;
}

export function stopTimer(state: CronServiceState) {
  if (state.timer) {
    clearTimeout(state.timer);
  }
  state.timer = null;
}

export function emit(state: CronServiceState, evt: CronEvent) {
  try {
    state.deps.onEvent?.(evt);
  } catch {
    /* ignore */
  }
}
