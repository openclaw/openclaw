import type { HeartbeatRunResult } from "../../infra/heartbeat-wake.js";
import type { CronJob } from "../types.js";
import type { CronEvent, CronServiceState } from "./state.js";
import {
  computeJobNextRunAtMs,
  nextWakeAtMs,
  recomputeNextRuns,
  resolveJobPayloadTextForMain,
} from "./jobs.js";
import { locked } from "./locked.js";
import { ensureLoaded, persist } from "./store.js";

const MAX_TIMEOUT_MS = 2 ** 31 - 1;

/** Default job timeout when payload.timeoutSeconds is not set (10 min). */
const DEFAULT_JOB_TIMEOUT_S = 10 * 60;

/** Multiplier applied to the job timeout to derive the hard cron-level timeout. */
const HARD_TIMEOUT_MULTIPLIER = 2;

/** How often the watchdog checks for a stuck `running` state (60 s). */
const WATCHDOG_INTERVAL_MS = 60_000;

/** Fallback ceiling for the watchdog threshold (30 min). */
const WATCHDOG_MAX_STUCK_MS = 30 * 60_000;

export function armTimer(state: CronServiceState) {
  if (state.timer) {
    clearTimeout(state.timer);
  }
  state.timer = null;
  if (!state.deps.cronEnabled) {
    return;
  }
  const nextAt = nextWakeAtMs(state);
  if (!nextAt) {
    return;
  }
  const delay = Math.max(nextAt - state.deps.nowMs(), 0);
  // Avoid TimeoutOverflowWarning when a job is far in the future.
  const clampedDelay = Math.min(delay, MAX_TIMEOUT_MS);
  state.timer = setTimeout(() => {
    void onTimer(state).catch((err) => {
      state.deps.log.error({ err: String(err) }, "cron: timer tick failed");
    });
  }, clampedDelay);
  state.timer.unref?.();

  // Fix 2: Ensure the watchdog is running whenever the timer is armed.
  if (!state.watchdogTimer) {
    startWatchdog(state);
  }
}

export async function onTimer(state: CronServiceState) {
  if (state.running) {
    // Fix 3: Log when onTimer bails because a previous run is still in progress.
    const stuckMs = state.runningStartedAtMs ? state.deps.nowMs() - state.runningStartedAtMs : null;
    state.deps.log.warn(
      { runningForMs: stuckMs },
      "cron: onTimer skipped — previous run still in progress",
    );
    return;
  }
  state.running = true;
  state.runningStartedAtMs = state.deps.nowMs();
  try {
    await locked(state, async () => {
      // Reload persisted due-times without recomputing so runDueJobs sees
      // the original nextRunAtMs values.  Recomputing first would advance
      // every/cron slots past the current tick when the timer fires late (#9788).
      await ensureLoaded(state, { forceReload: true, skipRecompute: true });
      await runDueJobs(state);
      recomputeNextRuns(state);
      await persist(state);
    });
  } finally {
    state.running = false;
    state.runningStartedAtMs = null;
    // Always re-arm so transient errors (e.g. ENOSPC) don't kill the scheduler.
    armTimer(state);
  }
}

export async function runDueJobs(state: CronServiceState) {
  if (!state.store) {
    return;
  }
  const now = state.deps.nowMs();
  const due = state.store.jobs.filter((j) => {
    if (!j.enabled) {
      return false;
    }
    if (typeof j.state.runningAtMs === "number") {
      return false;
    }
    const next = j.state.nextRunAtMs;
    return typeof next === "number" && now >= next;
  });
  for (const job of due) {
    await executeJob(state, job, now, { forced: false });
  }
}

export async function executeJob(
  state: CronServiceState,
  job: CronJob,
  nowMs: number,
  opts: { forced: boolean },
) {
  const startedAt = state.deps.nowMs();
  job.state.runningAtMs = startedAt;
  job.state.lastError = undefined;
  emit(state, { jobId: job.id, action: "started", runAtMs: startedAt });

  let deleted = false;

  const finish = async (status: "ok" | "error" | "skipped", err?: string, summary?: string) => {
    const endedAt = state.deps.nowMs();
    job.state.runningAtMs = undefined;
    job.state.lastRunAtMs = startedAt;
    job.state.lastStatus = status;
    job.state.lastDurationMs = Math.max(0, endedAt - startedAt);
    job.state.lastError = err;

    const shouldDelete =
      job.schedule.kind === "at" && status === "ok" && job.deleteAfterRun === true;

    if (!shouldDelete) {
      if (job.schedule.kind === "at" && status === "ok") {
        // One-shot job completed successfully; disable it.
        job.enabled = false;
        job.state.nextRunAtMs = undefined;
      } else if (job.enabled) {
        job.state.nextRunAtMs = computeJobNextRunAtMs(job, endedAt);
      } else {
        job.state.nextRunAtMs = undefined;
      }
    }

    emit(state, {
      jobId: job.id,
      action: "finished",
      status,
      error: err,
      summary,
      runAtMs: startedAt,
      durationMs: job.state.lastDurationMs,
      nextRunAtMs: job.state.nextRunAtMs,
    });

    if (shouldDelete && state.store) {
      state.store.jobs = state.store.jobs.filter((j) => j.id !== job.id);
      deleted = true;
      emit(state, { jobId: job.id, action: "removed" });
    }
  };

  try {
    if (job.sessionTarget === "main") {
      const text = resolveJobPayloadTextForMain(job);
      if (!text) {
        const kind = job.payload.kind;
        await finish(
          "skipped",
          kind === "systemEvent"
            ? "main job requires non-empty systemEvent text"
            : 'main job requires payload.kind="systemEvent"',
        );
        return;
      }
      state.deps.enqueueSystemEvent(text, { agentId: job.agentId });
      if (job.wakeMode === "now" && state.deps.runHeartbeatOnce) {
        const reason = `cron:${job.id}`;
        const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
        const maxWaitMs = 2 * 60_000;
        const waitStartedAt = state.deps.nowMs();

        let heartbeatResult: HeartbeatRunResult;
        for (;;) {
          heartbeatResult = await state.deps.runHeartbeatOnce({ reason });
          if (
            heartbeatResult.status !== "skipped" ||
            heartbeatResult.reason !== "requests-in-flight"
          ) {
            break;
          }
          if (state.deps.nowMs() - waitStartedAt > maxWaitMs) {
            heartbeatResult = {
              status: "skipped",
              reason: "timeout waiting for main lane to become idle",
            };
            break;
          }
          await delay(250);
        }

        if (heartbeatResult.status === "ran") {
          await finish("ok", undefined, text);
        } else if (heartbeatResult.status === "skipped") {
          await finish("skipped", heartbeatResult.reason, text);
        } else {
          await finish("error", heartbeatResult.reason, text);
        }
      } else {
        // wakeMode is "next-heartbeat" or runHeartbeatOnce not available
        state.deps.requestHeartbeatNow({ reason: `cron:${job.id}` });
        await finish("ok", undefined, text);
      }
      return;
    }

    if (job.payload.kind !== "agentTurn") {
      await finish("skipped", "isolated job requires payload.kind=agentTurn");
      return;
    }

    // Fix 1: Hard timeout wrapper around runIsolatedAgentJob.
    // Uses 2× the job's own timeout (or default) as a safety-net ceiling so a
    // hung isolated job can never block the cron service indefinitely.
    const jobTimeoutS = job.payload.timeoutSeconds ?? DEFAULT_JOB_TIMEOUT_S;
    const hardTimeoutMs = jobTimeoutS * 1000 * HARD_TIMEOUT_MULTIPLIER;
    const res = await promiseWithTimeout(
      state.deps.runIsolatedAgentJob({
        job,
        message: job.payload.message,
      }),
      hardTimeoutMs,
      `cron job ${job.id} (${job.name}) exceeded hard timeout of ${hardTimeoutMs / 1000}s`,
    );

    // Post a short summary back to the main session so the user sees
    // the cron result without opening the isolated session.
    const summaryText = res.summary?.trim();
    const deliveryMode = job.delivery?.mode ?? "announce";
    if (summaryText && deliveryMode !== "none") {
      const prefix = "📋 Cron";
      const label =
        res.status === "error" ? `${prefix} (error): ${summaryText}` : `${prefix}: ${summaryText}`;
      state.deps.enqueueSystemEvent(label, { agentId: job.agentId });
      if (job.wakeMode === "now") {
        state.deps.requestHeartbeatNow({ reason: `cron:${job.id}` });
      }
    }

    if (res.status === "ok") {
      await finish("ok", undefined, res.summary);
    } else if (res.status === "skipped") {
      await finish("skipped", undefined, res.summary);
    } else {
      await finish("error", res.error ?? "cron job failed", res.summary);
    }
  } catch (err) {
    await finish("error", String(err));
  } finally {
    job.updatedAtMs = nowMs;
    if (!opts.forced && job.enabled && !deleted) {
      // Keep nextRunAtMs in sync in case the schedule advanced during a long run.
      job.state.nextRunAtMs = computeJobNextRunAtMs(job, state.deps.nowMs());
    }
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
  stopWatchdog(state);
}

// ---------------------------------------------------------------------------
// Fix 1 helper: Promise.race with a timeout
// ---------------------------------------------------------------------------

class CronHardTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CronHardTimeoutError";
  }
}

function promiseWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new CronHardTimeoutError(message)), timeoutMs);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

// ---------------------------------------------------------------------------
// Fix 2: Watchdog — detects permanently stuck `state.running`
// ---------------------------------------------------------------------------

/**
 * Compute the watchdog threshold: 2× the longest job timeout among all enabled
 * jobs, clamped to a minimum of 2× DEFAULT_JOB_TIMEOUT_S and a maximum of
 * WATCHDOG_MAX_STUCK_MS.
 */
function computeWatchdogThresholdMs(state: CronServiceState): number {
  let maxTimeoutS = DEFAULT_JOB_TIMEOUT_S;
  for (const job of state.store?.jobs ?? []) {
    if (!job.enabled) continue;
    if (job.payload.kind === "agentTurn" && typeof job.payload.timeoutSeconds === "number") {
      maxTimeoutS = Math.max(maxTimeoutS, job.payload.timeoutSeconds);
    }
  }
  const thresholdMs = maxTimeoutS * 1000 * HARD_TIMEOUT_MULTIPLIER;
  return Math.min(thresholdMs, WATCHDOG_MAX_STUCK_MS);
}

/**
 * Start the watchdog interval. Safe to call multiple times — restarts if already
 * running. Called from `armTimer`.
 */
export function startWatchdog(state: CronServiceState) {
  stopWatchdog(state);
  state.watchdogTimer = setInterval(() => {
    checkWatchdog(state);
  }, WATCHDOG_INTERVAL_MS);
  state.watchdogTimer.unref?.();
}

function stopWatchdog(state: CronServiceState) {
  if (state.watchdogTimer) {
    clearInterval(state.watchdogTimer);
  }
  state.watchdogTimer = null;
}

function checkWatchdog(state: CronServiceState) {
  if (!state.running || state.runningStartedAtMs === null) {
    return;
  }
  const runningForMs = state.deps.nowMs() - state.runningStartedAtMs;
  const thresholdMs = computeWatchdogThresholdMs(state);
  if (runningForMs <= thresholdMs) {
    return;
  }
  state.deps.log.error(
    { runningForMs, thresholdMs },
    "cron: watchdog — state.running stuck, forcibly resetting and re-arming timer",
  );
  state.running = false;
  state.runningStartedAtMs = null;
  armTimer(state);
}

export function emit(state: CronServiceState, evt: CronEvent) {
  try {
    state.deps.onEvent?.(evt);
  } catch {
    /* ignore */
  }
}
