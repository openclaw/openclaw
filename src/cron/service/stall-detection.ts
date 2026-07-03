// Cron event-loop stall detection: pauses all cron dispatch when the process's
// own event loop has been severely blocked, instead of scraping timer_delay
// values out of a log file (see module doc below for why).
import { monitorEventLoopDelay } from "node:perf_hooks";
import type { CronServiceState } from "./state.js";

/**
 * Design note (contract 20260602):
 *
 * A standalone reference script (cron-scheduler.js) assumed cron lane pausing
 * would be driven by scraping `timer_delay` values out of gateway.err.log. A
 * repo-wide search for `timer_delay` in `src/**` at the time this module was
 * written found zero emitters: nothing in the current gateway/cron/logging
 * stack ever writes a `timer_delay` field to any log. The original contract's
 * signal source does not exist in the production log stream - only in the
 * standalone script's assumed format - so porting the log-scraping approach
 * verbatim would wire this feature to a signal nothing produces.
 *
 * The gateway already samples real in-process event-loop delay in two places
 * (`src/gateway/server/event-loop-health.ts` and `src/logging/diagnostic.ts`),
 * both using Node's `perf_hooks.monitorEventLoopDelay` with a 1s WARN
 * threshold for lower-severity readiness/liveness signaling. That delay
 * metric *is* a legitimate, currently-live proxy for "the event loop is
 * stalled enough that cron dispatch would misbehave": cron jobs run on the
 * same event loop, so sustained multi-second scheduler delay is precisely the
 * condition that would cause a cron tick to fire very late or cron job
 * execution to start late, mirroring the failure mode the standalone script
 * was written to guard against (qp-comms-monitor missing its window while the
 * loop was blocked).
 *
 * This module intentionally does NOT reuse the shared 1s WARN threshold: that
 * threshold exists to flag comparatively routine GC/utilization blips for
 * readiness/liveness dashboards, not to gate cron execution. Instead it uses
 * its own monitor instance and a much higher, cron-specific threshold
 * (`CRON_STALL_EVENT_LOOP_DELAY_MS`, 10s) - 10x the shared WARN threshold -
 * chosen because:
 *   - It is far outside routine GC-pause / short burst territory (which the
 *     existing 1s warn threshold already tracks) and only trips on a
 *     genuinely severe, sustained block.
 *   - It is comfortably under cron's own maintenance re-check ceiling
 *     (MAX_TIMER_DELAY_MS = 60s in timer.ts), so a stall gets caught and
 *     paused well before it could itself be mistaken for a legitimate 60s
 *     re-arm gap.
 *   - It preserves the same order-of-magnitude severity relationship the
 *     original contract used (30s log-observed timer_delay vs. 1s incidental
 *     delay noise) while being calibrated to the different signal: a live,
 *     instantaneous in-process delay sample does not need the original's 60s
 *     lookback window (which existed only to smooth over discrete log-poll
 *     intervals), so the threshold here can be lower than 30s while remaining
 *     just as decisively "not a false positive".
 *
 * The pause duration (`CRON_STALL_PAUSE_MS`, 300_000ms / 5 minutes) is kept
 * identical to the original contract: it is not a signal-source-dependent
 * value, just the intended recovery grace period.
 */

/** Threshold (ms) of sustained event-loop delay that counts as a cron-affecting stall. */
export const CRON_STALL_EVENT_LOOP_DELAY_MS = 10_000;

/** How long cron dispatch stays paused once a stall is detected (5 minutes, matches contract). */
export const CRON_STALL_PAUSE_MS = 300_000;

/** Minimal event-loop delay monitor surface this module depends on (matches Node's real one). */
export type CronEventLoopDelayMonitor = {
  enable: () => void;
  disable: () => void;
  reset: () => void;
  percentile: (percentile: number) => number;
  readonly max: number;
};

export type CronStallDetectorDeps = {
  /** Clock override for tests. */
  now?: () => number;
  /** Delay monitor factory override for tests (defaults to real perf_hooks monitor). */
  createDelayMonitor?: (resolutionMs: number) => CronEventLoopDelayMonitor;
};

export type CronStallSample = {
  delayP99Ms: number;
  delayMaxMs: number;
};

export type CronStallDetector = {
  /** Samples current event-loop delay and resets the underlying monitor window. */
  sample: () => CronStallSample;
  /** Disposes the underlying monitor. Safe to call multiple times. */
  stop: () => void;
};

const CRON_STALL_MONITOR_RESOLUTION_MS = 20;

function nanosecondsToMilliseconds(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.round((value / 1_000_000) * 10) / 10;
}

/** Creates a dedicated event-loop delay sampler for cron stall detection. */
export function createCronStallDetector(deps: CronStallDetectorDeps = {}): CronStallDetector {
  const createDelayMonitor =
    deps.createDelayMonitor ??
    ((resolutionMs: number) =>
      monitorEventLoopDelay({ resolution: resolutionMs }) as unknown as CronEventLoopDelayMonitor);

  let monitor: CronEventLoopDelayMonitor | null = null;
  try {
    monitor = createDelayMonitor(CRON_STALL_MONITOR_RESOLUTION_MS);
    monitor.enable();
    monitor.reset();
  } catch {
    monitor = null;
  }

  return {
    sample: () => {
      if (!monitor) {
        return { delayP99Ms: 0, delayMaxMs: 0 };
      }
      const delayP99Ms = nanosecondsToMilliseconds(monitor.percentile(99));
      const delayMaxMs = nanosecondsToMilliseconds(monitor.max);
      monitor.reset();
      return { delayP99Ms, delayMaxMs };
    },
    stop: () => {
      monitor?.disable();
      monitor = null;
    },
  };
}

/**
 * Pure decision function: given a fresh delay sample and the current pause
 * state, returns the pausedUntil epoch-ms value that should be in effect.
 *
 *   - If a pause window is already active (currentPausedUntil > nowMs), it is
 *     preserved unchanged (a fresh stall does not shorten or restart it here;
 *     callers re-sample every tick so a still-stalled loop naturally keeps
 *     tripping this once the window lapses).
 *   - Otherwise, if the sample exceeds the threshold, a new pause window of
 *     `pauseMs` starting at `nowMs` is returned.
 *   - Otherwise, returns null (not paused).
 */
export function resolveCronStallPauseUntil(params: {
  sample: CronStallSample;
  nowMs: number;
  currentPausedUntil: number | null;
  thresholdMs?: number;
  pauseMs?: number;
}): number | null {
  const thresholdMs = params.thresholdMs ?? CRON_STALL_EVENT_LOOP_DELAY_MS;
  const pauseMs = params.pauseMs ?? CRON_STALL_PAUSE_MS;

  if (typeof params.currentPausedUntil === "number" && params.currentPausedUntil > params.nowMs) {
    return params.currentPausedUntil;
  }

  const stalled =
    params.sample.delayP99Ms >= thresholdMs || params.sample.delayMaxMs >= thresholdMs;
  if (!stalled) {
    return null;
  }
  return params.nowMs + pauseMs;
}

/** Returns whether cron dispatch is currently paused given the state's pausedUntil field. */
export function isCronDispatchPaused(state: CronServiceState, nowMs: number): boolean {
  return typeof state.pausedUntil === "number" && state.pausedUntil > nowMs;
}

/**
 * Lazily creates (once) the state's stall detector, samples it, and updates
 * `state.pausedUntil` per `resolveCronStallPauseUntil`. Intended to be called
 * once per cron timer tick (see `onTimer` in timer.ts).
 */
export function updateCronStallPause(state: CronServiceState): void {
  state.stallDetector ??= createCronStallDetector({ now: state.deps.nowMs });
  const sample = state.stallDetector.sample();
  const nowMs = state.deps.nowMs();
  const nextPausedUntil = resolveCronStallPauseUntil({
    sample,
    nowMs,
    currentPausedUntil: state.pausedUntil,
  });
  if (nextPausedUntil !== state.pausedUntil) {
    if (nextPausedUntil !== null) {
      state.deps.log.warn(
        {
          delayP99Ms: sample.delayP99Ms,
          delayMaxMs: sample.delayMaxMs,
          thresholdMs: CRON_STALL_EVENT_LOOP_DELAY_MS,
          pausedUntil: nextPausedUntil,
          pauseMs: CRON_STALL_PAUSE_MS,
        },
        "cron: event-loop stall detected - pausing all cron dispatch",
      );
    } else {
      state.deps.log.info({}, "cron: event-loop stall pause window elapsed - resuming dispatch");
    }
  }
  state.pausedUntil = nextPausedUntil;
}
