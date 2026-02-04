import type { HeartbeatRunResult } from "../../infra/heartbeat-wake.js";
import type { CronJob } from "../types.js";
import type { CronEvent, CronServiceState } from "./state.js";
import { computeJobNextRunAtMs, nextWakeAtMs, resolveJobPayloadTextForMain } from "./jobs.js";
import { locked } from "./locked.js";
import { ensureLoaded, persist } from "./store.js";

const MAX_TIMEOUT_MS = 2 ** 31 - 1;
/**
 * Maximum consecutive failures before auto-disabling a cron job.
 * This prevents infinite retry loops from freezing the API with rate-limit errors.
 */
const MAX_CONSECUTIVE_FAILURES = 3;

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
}

export async function onTimer(state: CronServiceState) {
  if (state.running) {
    return;
  }
  state.running = true;
  try {
    await locked(state, async () => {
      await ensureLoaded(state);
      await runDueJobs(state);
      await persist(state);
      armTimer(state);
    });
  } finally {
    state.running = false;
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
  _nowMs: number,
  opts: { forced: boolean },
) {
  const startedAt = state.deps.nowMs();
  job.state.runningAtMs = startedAt;
  job.state.lastError = undefined;
  emit(state, { jobId: job.id, action: "started", runAtMs: startedAt });

  let deleted = false;

  const finish = async (
    status: "ok" | "error" | "skipped",
    err?: unknown,
    summary?: string,
    outputText?: string,
  ) => {
    const endedAt = state.deps.nowMs();
    job.state.runningAtMs = undefined;
    job.state.lastRunAtMs = startedAt;
    job.state.lastStatus = status;
    job.state.lastDurationMs = Math.max(0, endedAt - startedAt);

    // Safely convert error to string
    if (err === undefined) {
      job.state.lastError = undefined;
    } else if (typeof err === "string") {
      job.state.lastError = err;
    } else if (err instanceof Error) {
      job.state.lastError = err.message;
    } else if (err !== null && typeof err === "object" && "message" in err) {
      // Handle error-like objects with a message property
      const errObj = err as { message: unknown };
      job.state.lastError =
        typeof errObj.message === "string" ? errObj.message : String(errObj.message);
    } else {
      try {
        job.state.lastError = JSON.stringify(err);
      } catch {
        // Last resort: use a generic error message when we can't serialize
        job.state.lastError = "Unknown error (could not serialize)";
      }
    }

    // Track consecutive failures
    if (status === "error") {
      job.state.consecutiveFailures = (job.state.consecutiveFailures ?? 0) + 1;
    } else if (status === "ok" || status === "skipped") {
      // Reset failure counter on success or skipped (skipped = not applicable/no-op)
      job.state.consecutiveFailures = 0;
    }

    // Auto-disable job after max consecutive failures to prevent infinite retry loop
    const isMaxFailuresExceeded = (job.state.consecutiveFailures ?? 0) >= MAX_CONSECUTIVE_FAILURES;

    const shouldDelete =
      job.schedule.kind === "at" && status === "ok" && job.deleteAfterRun === true;

    if (!shouldDelete) {
      if (job.schedule.kind === "at" && status === "ok") {
        // One-shot job completed successfully; disable it.
        job.enabled = false;
        job.state.nextRunAtMs = undefined;
      } else if (isMaxFailuresExceeded && status === "error") {
        // Auto-disable ONLY after max consecutive failures on error
        job.enabled = false;
        job.state.nextRunAtMs = undefined;
        const errorMsg = `Job disabled after ${job.state.consecutiveFailures} consecutive failures`;
        state.deps.log.error(
          { jobId: job.id, jobName: job.name, consecutiveFailures: job.state.consecutiveFailures },
          `[cron] ${errorMsg}`,
        );
      } else if (job.enabled) {
        // For isolated tasks, implement exponential backoff on failure
        if (job.sessionTarget === "isolated" && status === "error") {
          const failureCount = job.state.consecutiveFailures ?? 1;
          // Exponential backoff: 1s, 2s, 4s
          const baseDelayMs = 1000 * Math.pow(2, failureCount - 1);
          const backoffDelayMs = Math.min(baseDelayMs, 3600000); // Cap at 1 hour

          // Reschedule with backoff instead of using normal nextRunAtMs calculation
          job.state.nextRunAtMs = endedAt + backoffDelayMs;
          state.deps.log.warn(
            { jobId: job.id, jobName: job.name, backoffMs: backoffDelayMs, failureCount },
            `[cron] Isolated task failed. Retrying in ${backoffDelayMs}ms (exponential backoff)`,
          );
        } else {
          job.state.nextRunAtMs = computeJobNextRunAtMs(job, endedAt);
        }
      } else {
        job.state.nextRunAtMs = undefined;
      }
    }

    emit(state, {
      jobId: job.id,
      action: "finished",
      status,
      error: job.state.lastError,
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

    if (job.sessionTarget === "isolated") {
      const prefix = job.isolation?.postToMainPrefix?.trim() || "Cron";
      const mode = job.isolation?.postToMainMode ?? "summary";

      let body = (summary ?? job.state.lastError ?? status).trim();
      if (mode === "full") {
        // Prefer full agent output if available; fall back to summary.
        const maxCharsRaw = job.isolation?.postToMainMaxChars;
        const maxChars = Number.isFinite(maxCharsRaw) ? Math.max(0, maxCharsRaw as number) : 8000;
        const fullText = (outputText ?? "").trim();
        if (fullText) {
          body = fullText.length > maxChars ? `${fullText.slice(0, maxChars)}…` : fullText;
        }
      }

      const statusPrefix = status === "ok" ? prefix : `${prefix} (${status})`;
      state.deps.enqueueSystemEvent(`${statusPrefix}: ${body}`, {
        agentId: job.agentId,
      });
      if (job.wakeMode === "now") {
        state.deps.requestHeartbeatNow({ reason: `cron:${job.id}:post` });
      }
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

    const res = await state.deps.runIsolatedAgentJob({
      job,
      message: job.payload.message,
    });
    if (res.status === "ok") {
      await finish("ok", undefined, res.summary, res.outputText);
    } else if (res.status === "skipped") {
      await finish("skipped", undefined, res.summary, res.outputText);
    } else {
      await finish("error", res.error ?? "cron job failed", res.summary, res.outputText);
    }
  } catch (err) {
    await finish("error", err);
  } finally {
    // Use current time for updatedAtMs to reflect actual completion time
    job.updatedAtMs = state.deps.nowMs();
    // Sync nextRunAtMs for non-failure cases (preserving failure protection backoff timing)
    if (!opts.forced && job.enabled && !deleted && job.state.lastStatus !== "error") {
      // Keep nextRunAtMs in sync in case the schedule advanced during a long run.
      // Skip for error status since failure protection has already set the backoff time.
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
}

export function emit(state: CronServiceState, evt: CronEvent) {
  try {
    state.deps.onEvent?.(evt);
  } catch {
    /* ignore */
  }
}
