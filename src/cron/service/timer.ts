import type { CronConfig, CronRetryOn } from "../../config/types.cron.js";
import type { HeartbeatRunResult } from "../../infra/heartbeat-wake.js";
import type { CronDeliveryStatus, CronJob } from "../types.js";
import type { CronEvent, CronServiceState } from "./state.js";
import { DEFAULT_AGENT_ID } from "../../routing/session-key.js";
import { resolveCronDeliveryPlan } from "../delivery.js";
import { sweepCronRunSessions } from "../session-reaper.js";
<<<<<<< HEAD
=======
import type {
  CronDeliveryStatus,
  CronJob,
  CronMessageChannel,
  CronRunOutcome,
  CronRunStatus,
  CronRunTelemetry,
} from "../types.js";
>>>>>>> 4637b90c0 (feat(cron): configurable failure alerts for repeated job errors (openclaw#24789) thanks @0xbrak)
import {
  computeJobNextRunAtMs,
  nextWakeAtMs,
  recomputeNextRunsForMaintenance,
  resolveJobPayloadTextForMain,
} from "./jobs.js";
import { locked } from "./locked.js";
import { ensureLoaded, persist } from "./store.js";
import { DEFAULT_JOB_TIMEOUT_MS, resolveCronJobTimeoutMs } from "./timeout-policy.js";

export { DEFAULT_JOB_TIMEOUT_MS } from "./timeout-policy.js";

const MAX_TIMER_DELAY_MS = 60_000;

/**
<<<<<<< HEAD
=======
 * Minimum gap between consecutive fires of the same cron job.  This is a
 * safety net that prevents spin-loops when `computeJobNextRunAtMs` returns
 * a value within the same second as the just-completed run.  The guard
 * is intentionally generous (2 s) so it never masks a legitimate schedule
 * but always breaks an infinite re-trigger cycle.  (See #17821)
 */
const MIN_REFIRE_GAP_MS = 2_000;
const DEFAULT_FAILURE_ALERT_AFTER = 2;
const DEFAULT_FAILURE_ALERT_COOLDOWN_MS = 60 * 60_000; // 1 hour

type TimedCronRunOutcome = CronRunOutcome &
  CronRunTelemetry & {
    jobId: string;
    delivered?: boolean;
    deliveryAttempted?: boolean;
    startedAt: number;
    endedAt: number;
  };

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
>>>>>>> 4637b90c0 (feat(cron): configurable failure alerts for repeated job errors (openclaw#24789) thanks @0xbrak)
 * Exponential backoff delays (in ms) indexed by consecutive error count.
 * After the last entry the delay stays constant.
 */
const DEFAULT_BACKOFF_SCHEDULE_MS = [
  30_000, // 1st error  →  30 s
  60_000, // 2nd error  →   1 min
  5 * 60_000, // 3rd error  →   5 min
  15 * 60_000, // 4th error  →  15 min
  60 * 60_000, // 5th+ error →  60 min
];

<<<<<<< HEAD
/**
 * Minimum gap between consecutive runs to prevent sub-second cron
 * expressions from overwhelming the system.
 */
const MIN_REFIRE_GAP_MS = 2_000;

function errorBackoffMs(consecutiveErrors: number): number {
  const idx = Math.min(consecutiveErrors - 1, ERROR_BACKOFF_SCHEDULE_MS.length - 1);
  return ERROR_BACKOFF_SCHEDULE_MS[Math.max(0, idx)];
=======
function errorBackoffMs(
  consecutiveErrors: number,
  scheduleMs = DEFAULT_BACKOFF_SCHEDULE_MS,
): number {
  const idx = Math.min(consecutiveErrors - 1, scheduleMs.length - 1);
  return scheduleMs[Math.max(0, idx)];
}

/** Default max retries for one-shot jobs on transient errors (#24355). */
const DEFAULT_MAX_TRANSIENT_RETRIES = 3;

const TRANSIENT_PATTERNS: Record<string, RegExp> = {
  rate_limit: /(rate[_ ]limit|too many requests|429|resource has been exhausted|cloudflare)/i,
  network: /(network|econnreset|econnrefused|fetch failed|socket)/i,
  timeout: /(timeout|etimedout)/i,
  server_error: /\b5\d{2}\b/,
};

function isTransientCronError(error: string | undefined, retryOn?: CronRetryOn[]): boolean {
  if (!error || typeof error !== "string") {
    return false;
  }
  const keys = retryOn?.length ? retryOn : (Object.keys(TRANSIENT_PATTERNS) as CronRetryOn[]);
  return keys.some((k) => TRANSIENT_PATTERNS[k]?.test(error));
}

function resolveRetryConfig(cronConfig?: CronConfig) {
  const retry = cronConfig?.retry;
  return {
    maxAttempts:
      typeof retry?.maxAttempts === "number" ? retry.maxAttempts : DEFAULT_MAX_TRANSIENT_RETRIES,
    backoffMs:
      Array.isArray(retry?.backoffMs) && retry.backoffMs.length > 0
        ? retry.backoffMs
        : DEFAULT_BACKOFF_SCHEDULE_MS.slice(0, 3),
    retryOn: Array.isArray(retry?.retryOn) && retry.retryOn.length > 0 ? retry.retryOn : undefined,
  };
>>>>>>> ea3955cd7 (fix(cron): add retry policy for one-shot jobs on transient errors (#24355) (openclaw#24435) thanks @hugenshen)
}

function normalizeCronMessageChannel(input: unknown): CronMessageChannel | undefined {
  if (typeof input !== "string") {
    return undefined;
  }
  const channel = input.trim().toLowerCase();
  return channel ? (channel as CronMessageChannel) : undefined;
}

function normalizeTo(input: unknown): string | undefined {
  if (typeof input !== "string") {
    return undefined;
  }
  const to = input.trim();
  return to ? to : undefined;
}

function clampPositiveInt(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  const floored = Math.floor(value);
  return floored >= 1 ? floored : fallback;
}

function clampNonNegativeInt(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  const floored = Math.floor(value);
  return floored >= 0 ? floored : fallback;
}

function resolveFailureAlert(
  state: CronServiceState,
  job: CronJob,
): { after: number; cooldownMs: number; channel: CronMessageChannel; to?: string } | null {
  const globalConfig = state.deps.cronConfig?.failureAlert;
  const jobConfig = job.failureAlert === false ? undefined : job.failureAlert;

  if (job.failureAlert === false) {
    return null;
  }
  if (!jobConfig && globalConfig?.enabled !== true) {
    return null;
  }

  return {
    after: clampPositiveInt(jobConfig?.after ?? globalConfig?.after, DEFAULT_FAILURE_ALERT_AFTER),
    cooldownMs: clampNonNegativeInt(
      jobConfig?.cooldownMs ?? globalConfig?.cooldownMs,
      DEFAULT_FAILURE_ALERT_COOLDOWN_MS,
    ),
    channel:
      normalizeCronMessageChannel(jobConfig?.channel) ??
      normalizeCronMessageChannel(job.delivery?.channel) ??
      "last",
    to: normalizeTo(jobConfig?.to) ?? normalizeTo(job.delivery?.to),
  };
}

function emitFailureAlert(
  state: CronServiceState,
  params: {
    job: CronJob;
    error?: string;
    consecutiveErrors: number;
    channel: CronMessageChannel;
    to?: string;
  },
) {
  const safeJobName = params.job.name || params.job.id;
  const truncatedError = (params.error?.trim() || "unknown error").slice(0, 200);
  const text = [
    `Cron job "${safeJobName}" failed ${params.consecutiveErrors} times`,
    `Last error: ${truncatedError}`,
  ].join("\n");

  if (state.deps.sendCronFailureAlert) {
    void state.deps
      .sendCronFailureAlert({
        job: params.job,
        text,
        channel: params.channel,
        to: params.to,
      })
      .catch((err) => {
        state.deps.log.warn(
          { jobId: params.job.id, err: String(err) },
          "cron: failure alert delivery failed",
        );
      });
    return;
  }

  state.deps.enqueueSystemEvent(text, { agentId: params.job.agentId });
  if (params.job.wakeMode === "now") {
    state.deps.requestHeartbeatNow({ reason: `cron:${params.job.id}:failure-alert` });
  }
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
    status: "ok" | "error" | "skipped";
    error?: string;
    delivered?: boolean;
    startedAt: number;
    endedAt: number;
  },
): boolean {
  job.state.runningAtMs = undefined;
  job.state.lastRunAtMs = result.startedAt;
  job.state.lastStatus = result.status;
  job.state.lastRunStatus = result.status;
  job.state.lastDurationMs = Math.max(0, result.endedAt - result.startedAt);
  job.state.lastError = result.error;
  if (result.delivered !== undefined) {
    job.state.lastDelivered = result.delivered;
  }

  // Compute delivery status. Explicit `delivered` from the runner takes priority
  // over the delivery plan — if the runner reported a value, trust it.
  const deliveryPlan = resolveCronDeliveryPlan(job);
  if (result.delivered === true) {
    job.state.lastDeliveryStatus = "delivered" as CronDeliveryStatus;
  } else if (result.delivered === false) {
    job.state.lastDeliveryStatus = "not-delivered" as CronDeliveryStatus;
  } else if (!deliveryPlan.requested) {
    job.state.lastDeliveryStatus = "not-requested" as CronDeliveryStatus;
  } else {
    job.state.lastDeliveryStatus = "unknown" as CronDeliveryStatus;
  }

  job.updatedAtMs = result.endedAt;

  // Track consecutive errors for backoff / auto-disable.
  if (result.status === "error") {
    job.state.consecutiveErrors = (job.state.consecutiveErrors ?? 0) + 1;
    const alertConfig = resolveFailureAlert(state, job);
    if (alertConfig && job.state.consecutiveErrors >= alertConfig.after) {
      const now = state.deps.nowMs();
      const lastAlert = job.state.lastFailureAlertAtMs;
      const inCooldown =
        typeof lastAlert === "number" && now - lastAlert < Math.max(0, alertConfig.cooldownMs);
      if (!inCooldown) {
        emitFailureAlert(state, {
          job,
          error: result.error,
          consecutiveErrors: job.state.consecutiveErrors,
          channel: alertConfig.channel,
          to: alertConfig.to,
        });
        job.state.lastFailureAlertAtMs = now;
      }
    }
  } else {
    job.state.consecutiveErrors = 0;
    job.state.lastFailureAlertAtMs = undefined;
  }

  const shouldDelete =
    job.schedule.kind === "at" && job.deleteAfterRun === true && result.status === "ok";

  if (!shouldDelete) {
    if (job.schedule.kind === "at") {
      if (result.status === "ok" || result.status === "skipped") {
        // One-shot done or skipped: disable to prevent tight-loop (#11452).
        job.enabled = false;
        job.state.nextRunAtMs = undefined;
      } else if (result.status === "error") {
        const retryConfig = resolveRetryConfig(state.deps.cronConfig);
        const transient = isTransientCronError(result.error, retryConfig.retryOn);
        // consecutiveErrors is always set to ≥1 by the increment block above.
        const consecutive = job.state.consecutiveErrors;
        if (transient && consecutive <= retryConfig.maxAttempts) {
          // Schedule retry with backoff (#24355).
          const backoff = errorBackoffMs(consecutive, retryConfig.backoffMs);
          job.state.nextRunAtMs = result.endedAt + backoff;
          state.deps.log.info(
            {
              jobId: job.id,
              jobName: job.name,
              consecutiveErrors: consecutive,
              backoffMs: backoff,
              nextRunAtMs: job.state.nextRunAtMs,
            },
            "cron: scheduling one-shot retry after transient error",
          );
        } else {
          // Permanent error or max retries exhausted: disable.
          // Note: deleteAfterRun:true only triggers on ok (see shouldDelete above),
          // so exhausted-retry jobs are disabled but intentionally kept in the store
          // to preserve the error state for inspection.
          job.enabled = false;
          job.state.nextRunAtMs = undefined;
          state.deps.log.warn(
            {
              jobId: job.id,
              jobName: job.name,
              consecutiveErrors: consecutive,
              error: result.error,
              reason: transient ? "max retries exhausted" : "permanent error",
            },
            "cron: disabling one-shot job after error",
          );
        }
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
      const computed = computeJobNextRunAtMs(job, result.endedAt);
      const minNext = result.endedAt + MIN_REFIRE_GAP_MS;
      job.state.nextRunAtMs = computed !== undefined ? Math.max(computed, minNext) : undefined;
    } else {
      job.state.nextRunAtMs = undefined;
    }
  }

  return shouldDelete;
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
      state.store?.jobs.filter(
        (j) =>
          j.enabled &&
          typeof j.state.nextRunAtMs === "number" &&
          Number.isFinite(j.state.nextRunAtMs),
      ).length ?? 0;
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
    // See: https://github.com/hanzoai/bot/issues/12025
    if (state.timer) {
      clearTimeout(state.timer);
    }
    state.timer = setTimeout(() => {
      void onTimer(state).catch((err) => {
        state.deps.log.error({ err: String(err) }, "cron: timer tick failed");
      });
    }, MAX_TIMER_DELAY_MS);
    return;
  }
  state.running = true;
  // Arm a watchdog timer so the scheduler re-checks even if the
  // current execution hangs. The finally block re-arms with normal timing.
  if (state.timer) {
    clearTimeout(state.timer);
  }
  state.timer = setTimeout(() => {
    void onTimer(state).catch((err) => {
      state.deps.log.error({ err: String(err) }, "cron: timer tick failed");
    });
  }, MAX_TIMER_DELAY_MS);
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

    const results: Array<{
      jobId: string;
      status: "ok" | "error" | "skipped";
      error?: string;
      summary?: string;
      sessionId?: string;
      sessionKey?: string;
      delivered?: boolean;
      startedAt: number;
      endedAt: number;
    }> = [];

    const runOneJob = async (entry: { id: string; job: CronJob }) => {
      const { id, job } = entry;
      const startedAt = state.deps.nowMs();
      job.state.runningAtMs = startedAt;
      emit(state, { jobId: job.id, action: "started", runAtMs: startedAt });

      const jobTimeoutMs = resolveCronJobTimeoutMs(job);

      try {
        const abortController = new AbortController();
        let timeoutId: NodeJS.Timeout | undefined;
        if (jobTimeoutMs !== undefined) {
          timeoutId = setTimeout(() => {
            abortController.abort("cron: job execution timed out");
          }, jobTimeoutMs);
        }
        const result = await Promise.race([
          executeJobCore(state, job, abortController.signal),
          ...(jobTimeoutMs !== undefined
            ? [
                new Promise<never>((_, reject) => {
                  abortController.signal.addEventListener(
                    "abort",
                    () => reject(new Error(String(abortController.signal.reason))),
                    { once: true },
                  );
                }),
              ]
            : []),
        ]).finally(() => {
          if (timeoutId) clearTimeout(timeoutId);
        });
        results.push({ jobId: id, ...result, startedAt, endedAt: state.deps.nowMs() });
      } catch (err) {
        state.deps.log.warn(
          { jobId: id, jobName: job.name, timeoutMs: jobTimeoutMs },
          `cron: job failed: ${String(err)}`,
        );
        results.push({
          jobId: id,
          status: "error",
          error: String(err),
          startedAt,
          endedAt: state.deps.nowMs(),
        });
      }
    };

    const maxConcurrent = state.deps.cronConfig?.maxConcurrentRuns ?? 1;
    if (maxConcurrent > 1 && dueJobs.length > 1) {
      // Run jobs concurrently up to the limit.
      const pending = new Set<Promise<void>>();
      for (const entry of dueJobs) {
        const p = runOneJob(entry).finally(() => pending.delete(p));
        pending.add(p);
        if (pending.size >= maxConcurrent) {
          await Promise.race(pending);
        }
      }
      await Promise.all(pending);
    } else {
      for (const entry of dueJobs) {
        await runOneJob(entry);
      }
    }

    if (results.length > 0) {
      await locked(state, async () => {
        await ensureLoaded(state, { forceReload: true, skipRecompute: true });

        for (const result of results) {
          const job = state.store?.jobs.find((j) => j.id === result.jobId);
          if (!job) {
            continue;
          }

          const shouldDelete = applyJobResult(state, job, {
            status: result.status,
            error: result.error,
            delivered: result.delivered,
            startedAt: result.startedAt,
            endedAt: result.endedAt,
          });

          emitJobFinished(state, job, result, result.startedAt);

          if (shouldDelete && state.store) {
            state.store.jobs = state.store.jobs.filter((j) => j.id !== job.id);
            emit(state, { jobId: job.id, action: "removed" });
          }
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
    // One-shot with terminal status: skip unless it's a transient-error retry.
    // Retries have nextRunAtMs > lastRunAtMs (scheduled after the failed run) (#24355).
    // ok/skipped or error-without-retry always skip (#13845).
    const lastRun = job.state.lastRunAtMs;
    const nextRun = job.state.nextRunAtMs;
    if (
      job.state.lastStatus === "error" &&
      job.enabled &&
      typeof nextRun === "number" &&
      typeof lastRun === "number" &&
      nextRun > lastRun
    ) {
      return nowMs >= nextRun;
    }
    return false;
  }
  const next = job.state.nextRunAtMs;
  return typeof next === "number" && Number.isFinite(next) && nowMs >= next;
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
  await ensureLoaded(state, { skipRecompute: true });
  if (!state.store) {
    return;
  }
  const now = state.deps.nowMs();
  const skipJobIds = opts?.skipJobIds;
  const missed = collectRunnableJobs(state, now, { skipJobIds, skipAtIfAlreadyRan: true });

  if (missed.length > 0) {
    state.deps.log.info(
      { count: missed.length, jobIds: missed.map((j) => j.id) },
      "cron: running missed jobs after restart",
    );
    for (const job of missed) {
      await executeJob(state, job, now, { forced: false });
    }
  }
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
): Promise<{
  status: "ok" | "error" | "skipped";
  error?: string;
  errorKind?: string;
  summary?: string;
  sessionId?: string;
  sessionKey?: string;
  delivered?: boolean;
  deliveryAttempted?: boolean;
}> {
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
    // Preserve the job session namespace for main-target reminders so heartbeat
    // routing can deliver follow-through in the originating channel/thread.
    // Downstream gateway wiring canonicalizes/guards this key per agent.
    const targetMainSessionKey = job.sessionKey;
    state.deps.enqueueSystemEvent(text, {
      agentId: job.agentId,
      sessionKey: targetMainSessionKey,
      contextKey: `cron:${job.id}`,
    });
    if (job.wakeMode === "now" && state.deps.runHeartbeatOnce) {
      const reason = `cron:${job.id}`;
      const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
      const maxWaitMs = state.deps.wakeNowHeartbeatBusyMaxWaitMs ?? 2 * 60_000;
      const retryDelayMs = state.deps.wakeNowHeartbeatBusyRetryDelayMs ?? 250;
      const waitStartedAt = state.deps.nowMs();

      let heartbeatResult: HeartbeatRunResult;
      for (;;) {
        if (abortSignal?.aborted) {
          return { status: "error", error: "cron: job execution timed out", summary: text };
        }
        heartbeatResult = await state.deps.runHeartbeatOnce({
          reason,
          agentId: job.agentId,
          sessionKey: targetMainSessionKey,
          // Cron-triggered heartbeats should deliver to the last active channel.
          // Without this override, heartbeat target defaults to "none" (since
          // e2362d35) and cron main-session responses are silently swallowed.
          // See: https://github.com/hanzoai/bot/issues/28508
          heartbeat: { target: "last" },
        });
        if (
          heartbeatResult.status !== "skipped" ||
          heartbeatResult.reason !== "requests-in-flight"
        ) {
          break;
        }
        if (state.deps.nowMs() - waitStartedAt > maxWaitMs) {
          if (abortSignal?.aborted) {
            return { status: "error" as const, error: "cron: job execution timed out", summary: text };
          }
          state.deps.requestHeartbeatNow({
            reason,
            agentId: job.agentId,
            sessionKey: targetMainSessionKey,
          });
          return { status: "ok", summary: text };
        }
        await delay(retryDelayMs);
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
        return { status: "error" as const, error: "cron: job execution timed out", summary: text };
      }
      state.deps.requestHeartbeatNow({
        reason: `cron:${job.id}`,
        agentId: job.agentId,
        sessionKey: targetMainSessionKey,
      });
      return { status: "ok", summary: text };
    }
  }

  if (job.payload.kind !== "agentTurn") {
    return { status: "skipped", error: "isolated job requires payload.kind=agentTurn" };
  }

  const res = await state.deps.runIsolatedAgentJob({
    job,
    message: job.payload.message,
    abortSignal,
  });

  // Post a short summary back to the main session — but only when the
  // isolated run did NOT already deliver its output to the target channel
  // and no outbound delivery attempt was made. When `res.delivered` is
  // true, or `res.deliveryAttempted` is true, or the error is a
  // delivery-target config issue, skip the fallback to avoid duplicates
  // or noise from misconfigured delivery targets.
  // See: https://github.com/hanzoai/bot/issues/15692
  const summaryText = res.summary?.trim();
  const deliveryPlan = resolveCronDeliveryPlan(job);
  if (
    summaryText &&
    deliveryPlan.requested &&
    !res.delivered &&
    !res.deliveryAttempted &&
    res.errorKind !== "delivery-target"
  ) {
    const prefix = "Cron";
    const label =
      res.status === "error" ? `${prefix} (error): ${summaryText}` : `${prefix}: ${summaryText}`;
    state.deps.enqueueSystemEvent(label, {
      agentId: job.agentId,
      contextKey: `cron:${job.id}`,
    });
    if (job.wakeMode === "now") {
      state.deps.requestHeartbeatNow({ reason: `cron:${job.id}` });
    }
  }

  return {
    status: res.status,
    error: res.error,
    errorKind: res.errorKind,
    summary: res.summary,
    sessionId: res.sessionId,
    sessionKey: res.sessionKey,
    delivered: res.delivered,
    deliveryAttempted: res.deliveryAttempted,
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

  const jobTimeoutMs = resolveCronJobTimeoutMs(job);
  const abortController = new AbortController();
  let timeoutId: NodeJS.Timeout | undefined;
  if (jobTimeoutMs !== undefined) {
    timeoutId = setTimeout(() => {
      abortController.abort("cron: job execution timed out");
    }, jobTimeoutMs);
  }

  let coreResult: {
    status: "ok" | "error" | "skipped";
    error?: string;
    errorKind?: string;
    summary?: string;
    sessionId?: string;
    sessionKey?: string;
    delivered?: boolean;
    deliveryAttempted?: boolean;
  };
  try {
    coreResult = await Promise.race([
      executeJobCore(state, job, abortController.signal),
      ...(jobTimeoutMs !== undefined
        ? [
            new Promise<never>((_, reject) => {
              abortController.signal.addEventListener(
                "abort",
                () => reject(new Error(String(abortController.signal.reason))),
                { once: true },
              );
            }),
          ]
        : []),
    ]);
  } catch (err) {
    coreResult = { status: "error", error: String(err) };
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
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

  await persist(state);
}

function emitJobFinished(
  state: CronServiceState,
  job: CronJob,
  result: {
    status: "ok" | "error" | "skipped";
    error?: string;
    summary?: string;
    sessionId?: string;
    sessionKey?: string;
    delivered?: boolean;
  },
  runAtMs: number,
) {
  emit(state, {
    jobId: job.id,
    action: "finished",
    status: result.status,
    error: result.error,
    summary: result.summary,
    sessionId: result.sessionId,
    sessionKey: result.sessionKey,
    delivered: result.delivered,
    deliveryStatus: job.state.lastDeliveryStatus,
    deliveryError: job.state.lastDeliveryError,
    runAtMs,
    durationMs: job.state.lastDurationMs,
    nextRunAtMs: job.state.nextRunAtMs,
  });
}

/**
 * Execute a cron job's core logic with a timeout wrapper.
 * Returns a superset of the {@link executeJobCore} result that includes
 * delivery and telemetry fields used by `ops.ts`.
 */
export async function executeJobCoreWithTimeout(
  state: CronServiceState,
  job: CronJob,
): Promise<{
  status: "ok" | "error" | "skipped";
  error?: string;
  errorKind?: string;
  summary?: string;
  sessionId?: string;
  sessionKey?: string;
  delivered?: boolean;
  deliveryAttempted?: boolean;
  model?: string;
  provider?: string;
  usage?: unknown;
}> {
  const jobTimeoutMs = resolveCronJobTimeoutMs(job);
  const abortController = new AbortController();
  let timeoutId: NodeJS.Timeout | undefined;
  if (jobTimeoutMs !== undefined) {
    timeoutId = setTimeout(() => {
      abortController.abort("cron: job execution timed out");
    }, jobTimeoutMs);
  }
  try {
    return await Promise.race([
      executeJobCore(state, job, abortController.signal),
      ...(jobTimeoutMs !== undefined
        ? [
            new Promise<never>((_, reject) => {
              abortController.signal.addEventListener(
                "abort",
                () => reject(new Error(String(abortController.signal.reason))),
                { once: true },
              );
            }),
          ]
        : []),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
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
