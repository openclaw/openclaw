import type { HeartbeatRunResult } from "../../infra/heartbeat-wake.js";
import type { CronJob } from "../types.js";
import type { CronEvent, CronServiceState } from "./state.js";
import { logWarn } from "../../logger.js";
import {
  findBestSnapshot,
  formatSnapshotPrefix,
  hashResult,
  writeCronSnapshot,
} from "../snapshot.js";
import { computeJobNextRunAtMs, nextWakeAtMs, resolveJobPayloadTextForMain } from "./jobs.js";
import { locked } from "./locked.js";
import { ensureLoaded, persist } from "./store.js";

const MAX_TIMEOUT_MS = 2 ** 31 - 1;

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
      await ensureLoaded(state, { forceReload: true });
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

    // P0-3: Run isolated agent with retry-once on failure.
    let res = await state.deps.runIsolatedAgentJob({
      job,
      message: job.payload.message,
    });

    // Retry once on error after a short delay.
    if (res.status === "error") {
      logWarn(`[cron:${job.id}] First attempt failed (${res.error}), retrying in 5s...`);
      await new Promise<void>((resolve) => setTimeout(resolve, 5_000));
      res = await state.deps.runIsolatedAgentJob({
        job,
        message: job.payload.message,
      });
    }

    // P0-3: On success, write snapshot + check dedup.
    const outputText = res.outputText?.trim() ?? res.summary?.trim() ?? "";
    if (res.status === "ok" && outputText.length > 0) {
      // Write realtime snapshot.
      try {
        await writeCronSnapshot({
          storePath: state.deps.storePath,
          snapshot: {
            ts: state.deps.nowMs(),
            jobId: job.id,
            source: "realtime",
            result: outputText,
            durationMs: job.state.lastDurationMs,
          },
        });
      } catch {
        // best-effort
      }

      // Dedup: compare hash with last delivered.
      // job.state.lastDeliveredHash is persisted to disk via CronJobState → saveCronStore()
      // (called by persist() at the end of onTimer), so dedup survives process restarts.
      const currentHash = hashResult(outputText);
      if (job.state.lastDeliveredHash === currentHash) {
        logWarn(`[cron:${job.id}] Dedup: identical result, skipping delivery`);
        await finish("ok", undefined, res.summary);
        return;
      }
      job.state.lastDeliveredHash = currentHash;
    }

    // P0-3: On failure after retry, fall back to snapshot.
    if (res.status === "error") {
      logWarn(
        `[cron:${job.id}] Retry also failed (${res.error}), looking for snapshot fallback...`,
      );
      try {
        const snapshot = await findBestSnapshot({
          storePath: state.deps.storePath,
          jobId: job.id,
        });
        if (snapshot) {
          const prefix = formatSnapshotPrefix(snapshot);
          const fallbackSummary = `${prefix}${snapshot.result}`;
          // Deliver the snapshot as the summary instead of failing.
          res = {
            status: "ok",
            summary: fallbackSummary,
            outputText: fallbackSummary,
            error: undefined,
          };
          logWarn(
            `[cron:${job.id}] Using snapshot fallback from ${new Date(snapshot.ts).toISOString()}`,
          );
        } else {
          logWarn(`[cron:${job.id}] No snapshot available, task failed`);
        }
      } catch {
        // best-effort — original error stands
      }
    }

    // Post a short summary back to the main session so the user sees
    // the cron result without opening the isolated session.
    const summaryText = res.summary?.trim();
    const deliveryMode = job.delivery?.mode ?? "announce";
    if (summaryText && deliveryMode !== "none") {
      const prefix = "Cron";
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
}

export function emit(state: CronServiceState, evt: CronEvent) {
  try {
    state.deps.onEvent?.(evt);
  } catch {
    /* ignore */
  }
}
