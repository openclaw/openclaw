import type { HeartbeatRunResult } from "../../infra/heartbeat-wake.js";
import type { CronJob } from "../types.js";
import type { CronEvent, CronServiceState } from "./state.js";
import { isCronSystemEvent } from "../../infra/heartbeat-events-filter.js";
import { DEFAULT_AGENT_ID } from "../../routing/session-key.js";
import { resolveCronDeliveryPlan } from "../delivery.js";
import { sweepCronRunSessions } from "../session-reaper.js";
import {
  computeJobNextRunAtMs,
  nextWakeAtMs,
  recomputeNextRuns,
  resolveJobPayloadTextForMain,
} from "./jobs.js";
import { locked } from "./locked.js";
import { ensureLoaded, persist } from "./store.js";

const MAX_TIMER_DELAY_MS = 60_000;

/**
 * Maximum wall-clock time for a single job execution. Acts as a safety net
 * on top of the per-provider / per-agent timeouts to prevent one stuck job
 * from wedging the entire cron lane.
 */
const DEFAULT_JOB_TIMEOUT_MS = 10 * 60_000; // 10 minutes

/**
 * Tolerance window (in ms) for considering jobs "due" at the same time.
 * Jobs whose nextRunAtMs falls within this window of the current time
 * will be executed together in the same tick, ensuring they receive
 * the same batchEndedAt and thus the same computed nextRunAtMs.
 * This prevents anchorMs drift from causing concurrent jobs to diverge.
 */
const TICK_TOLERANCE_MS = 30_000;

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

/**
 * Apply the result of a job execution to the job's state.
 * Handles consecutive error tracking, exponential backoff, one-shot disable,
 * and nextRunAtMs computation. Returns `true` if the job should be deleted.
 */
function applyJobResult(
  state: CronServiceState,
  job: CronJob,
  result: {
    status: "ok" | "error" | "skipped";
    error?: string;
    startedAt: number;
    endedAt: number;
  },
): boolean {
  job.state.runningAtMs = undefined;
  job.state.lastRunAtMs = result.startedAt;
  job.state.lastStatus = result.status;
  job.state.lastDurationMs = Math.max(0, result.endedAt - result.startedAt);
  job.state.lastError = result.error;
  job.updatedAtMs = result.endedAt;

  // Track consecutive errors for backoff / auto-disable.
  if (result.status === "error") {
    job.state.consecutiveErrors = (job.state.consecutiveErrors ?? 0) + 1;
  } else {
    job.state.consecutiveErrors = 0;
  }

  const shouldDelete =
    job.schedule.kind === "at" &&
    job.deleteAfterRun === true &&
    (result.status === "ok" || result.status === "skipped");

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
      job.state.nextRunAtMs = computeJobNextRunAtMs(job, result.endedAt);
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
  state.timer = setTimeout(async () => {
    try {
      await onTimer(state);
    } catch (err) {
      state.deps.log.error({ err: String(err) }, "cron: timer tick failed");
    }
  }, clampedDelay);
  state.deps.log.debug(
    { nextAt, delayMs: clampedDelay, clamped: delay > MAX_TIMER_DELAY_MS },
    "cron: timer armed",
  );
}

export async function onTimer(state: CronServiceState) {
  if (state.running) {
    state.deps.log.info({}, "cron: onTimer skipped - already running");
    return;
  }
  state.running = true;
  try {
    const dueJobs = await locked(state, async () => {
      await ensureLoaded(state, { forceReload: true, skipRecompute: true });
      const due = findDueJobs(state);

      state.deps.log.info(
        { count: due.length, jobs: due.map((j) => ({ id: j.id, name: j.name })) },
        "cron: due jobs found",
      );

      if (due.length === 0) {
        const changed = recomputeNextRuns(state);
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

    // Execute all due jobs concurrently. Isolated jobs spawn independent
    // subagent processes so there is no reason to serialize them. Each job
    // still has its own per-job timeout via Promise.race.
    const results = await Promise.all(
      dueJobs.map(async ({ id, job }, i) => {
        state.deps.log.info(
          { jobId: id, jobName: job.name, index: i + 1, total: dueJobs.length },
          "cron: executing job",
        );
        const startedAt = state.deps.nowMs();
        job.state.runningAtMs = startedAt;
        emit(state, { jobId: job.id, action: "started", runAtMs: startedAt });

        const jobTimeoutMs =
          job.payload.kind === "agentTurn" && typeof job.payload.timeoutSeconds === "number"
            ? job.payload.timeoutSeconds * 1_000
            : DEFAULT_JOB_TIMEOUT_MS;

        try {
          let timeoutId: NodeJS.Timeout;
          const result = await Promise.race([
            executeJobCore(state, job),
            new Promise<never>((_, reject) => {
              timeoutId = setTimeout(
                () => reject(new Error("cron: job execution timed out")),
                jobTimeoutMs,
              );
            }),
          ]).finally(() => clearTimeout(timeoutId!));
          const endedAt = state.deps.nowMs();
          state.deps.log.info(
            { jobId: id, status: result.status, durationMs: endedAt - startedAt },
            "cron: job execution completed",
          );
          return { jobId: id, ...result, startedAt, endedAt };
        } catch (err) {
          state.deps.log.warn(
            { jobId: id, jobName: job.name, timeoutMs: jobTimeoutMs },
            `cron: job failed: ${String(err)}`,
          );
          return {
            jobId: id,
            status: "error" as const,
            error: String(err),
            startedAt,
            endedAt: state.deps.nowMs(),
          };
        }
      }),
    );

    if (results.length > 0) {
      await locked(state, async () => {
        await ensureLoaded(state, { forceReload: true, skipRecompute: true });

        // Create a unified batch time for all concurrent jobs to ensure they
        // all get the same nextRunAtMs calculation (#11452).
        const batchEndedAt = state.deps.nowMs();

        const jobsToDelete: string[] = [];

        for (const result of results) {
          const job = state.store?.jobs.find((j) => j.id === result.jobId);
          if (!job) {
            continue;
          }

          const shouldDelete = applyJobResult(state, job, {
            status: result.status,
            error: result.error,
            startedAt: result.startedAt,
            endedAt: batchEndedAt,
          });

          if (shouldDelete) {
            jobsToDelete.push(job.id);
          }
        }

        // For all jobs in this batch that have nextRunAtMs computed,
        // unify them to the earliest one to prevent anchorMs drift (#11452).
        const batchJobIds = new Set(results.map((r) => r.jobId));
        const batchJobs =
          state.store?.jobs.filter(
            (j) =>
              batchJobIds.has(j.id) &&
              !jobsToDelete.includes(j.id) &&
              typeof j.state.nextRunAtMs === "number",
          ) ?? [];

        if (batchJobs.length > 1) {
          const earliestNextRun = Math.min(...batchJobs.map((j) => j.state.nextRunAtMs!));
          for (const job of batchJobs) {
            job.state.nextRunAtMs = earliestNextRun;
          }
        }

        // Emit events after unifying nextRunAtMs
        for (const result of results) {
          const job = state.store?.jobs.find((j) => j.id === result.jobId);
          if (!job) {
            continue;
          }

          emit(state, {
            jobId: job.id,
            action: "finished",
            status: result.status,
            error: result.error,
            summary: result.summary,
            sessionId: result.sessionId,
            sessionKey: result.sessionKey,
            runAtMs: result.startedAt,
            durationMs: job.state.lastDurationMs,
            nextRunAtMs: job.state.nextRunAtMs,
          });

          if (jobsToDelete.includes(job.id) && state.store) {
            state.store.jobs = state.store.jobs.filter((j) => j.id !== job.id);
            emit(state, { jobId: job.id, action: "removed" });
          }
        }

        recomputeNextRuns(state);
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

export function findDueJobs(state: CronServiceState): CronJob[] {
  if (!state.store) {
    return [];
  }
  const now = state.deps.nowMs();
  // Find the earliest nextRunAtMs among all eligible jobs
  let earliestDue: number | undefined;
  for (const j of state.store.jobs) {
    if (!j.state) {
      j.state = {};
    }
    if (!j.enabled || typeof j.state.runningAtMs === "number") {
      continue;
    }
    const next = j.state.nextRunAtMs;
    if (typeof next === "number" && now >= next) {
      if (earliestDue === undefined || next < earliestDue) {
        earliestDue = next;
      }
    }
  }

  // If no jobs are due, return empty
  if (earliestDue === undefined) {
    return [];
  }

  // Return all jobs within TICK_TOLERANCE_MS of the earliest due job
  const toleranceWindow = earliestDue + TICK_TOLERANCE_MS;
  return state.store.jobs.filter((j) => {
    if (!j.state) {
      j.state = {};
    }
    if (!j.enabled) {
      return false;
    }
    if (typeof j.state.runningAtMs === "number") {
      return false;
    }
    const next = j.state.nextRunAtMs;
    return typeof next === "number" && next <= toleranceWindow;
  });
}

export async function runMissedJobs(state: CronServiceState) {
  if (!state.store) {
    return;
  }
  const now = state.deps.nowMs();
  const missed = state.store.jobs.filter((j) => {
    if (!j.state) {
      j.state = {};
    }
    if (!j.enabled) {
      return false;
    }
    if (typeof j.state.runningAtMs === "number") {
      return false;
    }
    const next = j.state.nextRunAtMs;
    if (j.schedule.kind === "at" && j.state.lastStatus === "ok") {
      return false;
    }
    return typeof next === "number" && now >= next;
  });

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
  const due = state.store.jobs.filter((j) => {
    if (!j.state) {
      j.state = {};
    }
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

async function executeJobCore(
  state: CronServiceState,
  job: CronJob,
): Promise<{
  status: "ok" | "error" | "skipped";
  error?: string;
  summary?: string;
  sessionId?: string;
  sessionKey?: string;
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
    const targetSessionKey = job.targetSessionKey?.trim() || undefined;
    state.deps.enqueueSystemEvent(text, { agentId: job.agentId, sessionKey: targetSessionKey });
    if (job.wakeMode === "now" && state.deps.runHeartbeatOnce) {
      const reason = `cron:${job.id}`;
      const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
      const maxWaitMs = 2 * 60_000;
      const waitStartedAt = state.deps.nowMs();

      let heartbeatResult: HeartbeatRunResult;
      for (;;) {
        heartbeatResult = await state.deps.runHeartbeatOnce({
          reason,
          sessionKey: targetSessionKey,
        });
        if (
          heartbeatResult.status !== "skipped" ||
          heartbeatResult.reason !== "requests-in-flight"
        ) {
          break;
        }
        if (state.deps.nowMs() - waitStartedAt > maxWaitMs) {
          state.deps.requestHeartbeatNow({ reason });
          return { status: "ok", summary: text };
        }
        await delay(250);
      }

      if (heartbeatResult.status === "ran") {
        return { status: "ok", summary: text };
      } else if (heartbeatResult.status === "skipped") {
        return { status: "skipped", error: heartbeatResult.reason, summary: text };
      } else {
        return { status: "error", error: heartbeatResult.reason, summary: text };
      }
    } else {
      state.deps.requestHeartbeatNow({ reason: `cron:${job.id}` });
      return { status: "ok", summary: text };
    }
  }

  if (job.payload.kind !== "agentTurn") {
    return { status: "skipped", error: "isolated job requires payload.kind=agentTurn" };
  }

  const res = await state.deps.runIsolatedAgentJob({
    job,
    message: job.payload.message,
  });

  // Post a short summary back to the main session only when announce
  // delivery was requested and we are confident no outbound delivery path
  // ran. If delivery was attempted but final ack is uncertain, suppress the
  // main summary to avoid duplicate user-facing sends.
  // See: https://github.com/openclaw/openclaw/issues/15692
  //
  // Also suppress heartbeat-only summaries (e.g. "HEARTBEAT_OK") — these
  // are internal ack tokens that should never leak into user conversations.
  // See: https://github.com/openclaw/openclaw/issues/32013
  const summaryText = res.summary?.trim();
  const deliveryPlan = resolveCronDeliveryPlan(job);
  const suppressMainSummary =
    res.status === "error" && res.errorKind === "delivery-target" && deliveryPlan.requested;
  if (
    summaryText &&
    isCronSystemEvent(summaryText) &&
    deliveryPlan.requested &&
    !res.delivered &&
    res.deliveryAttempted !== true &&
    !suppressMainSummary
  ) {
    const prefix = "Cron";
    const label =
      res.status === "error" ? `${prefix} (error): ${summaryText}` : `${prefix}: ${summaryText}`;
    state.deps.enqueueSystemEvent(label, { agentId: job.agentId });
    if (job.wakeMode === "now") {
      state.deps.requestHeartbeatNow({ reason: `cron:${job.id}` });
    }
  }

  return {
    status: res.status,
    error: res.error,
    summary: res.summary,
    sessionId: res.sessionId,
    sessionKey: res.sessionKey,
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
    status: "ok" | "error" | "skipped";
    error?: string;
    summary?: string;
    sessionId?: string;
    sessionKey?: string;
  };
  try {
    coreResult = await executeJobCore(state, job);
  } catch (err) {
    coreResult = { status: "error", error: String(err) };
  }

  const endedAt = state.deps.nowMs();
  const shouldDelete = applyJobResult(state, job, {
    status: coreResult.status,
    error: coreResult.error,
    startedAt,
    endedAt,
  });

  emit(state, {
    jobId: job.id,
    action: "finished",
    status: coreResult.status,
    error: coreResult.error,
    summary: coreResult.summary,
    sessionId: coreResult.sessionId,
    sessionKey: coreResult.sessionKey,
    runAtMs: startedAt,
    durationMs: job.state.lastDurationMs,
    nextRunAtMs: job.state.nextRunAtMs,
  });

  if (shouldDelete && state.store) {
    state.store.jobs = state.store.jobs.filter((j) => j.id !== job.id);
    emit(state, { jobId: job.id, action: "removed" });
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
