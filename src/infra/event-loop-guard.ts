/**
 * Lightweight event-loop health guard for adaptive load shedding.
 *
 * Uses a simple timer-based approach (no perf_hooks dependency) to detect
 * event loop saturation without the overhead of monitorEventLoopDelay.
 * Suitable for hot-path checks during command enqueue.
 */

type EventLoopGuardState = {
  lastCheckMs: number;
  lastDelayMs: number;
  degradedSinceMs: number | null;
};

const state: EventLoopGuardState = {
  lastCheckMs: 0,
  lastDelayMs: 0,
  degradedSinceMs: null,
};

/** How often to re-sample event loop delay (ms). */
const SAMPLE_INTERVAL_MS = 500;
/** Delay threshold that triggers degradation (ms). 500ms avoids false positives from GC pauses. */
const DEGRADED_DELAY_THRESHOLD_MS = 500;
/** How long degradation must persist before load shedding kicks in (ms). 30s to ride out startup bursts. */
const DEGRADED_GRACE_MS = 30_000;

/**
 * Sample current event loop delay by measuring how long a setImmediate
 * callback takes to fire vs. the expected near-zero delay.
 */
function sampleEventLoopDelay(): number {
  const start = performance.now();
  return new Promise<number>((resolve) => {
    setImmediate(() => {
      resolve(performance.now() - start);
    });
  });
}

let pendingSample: Promise<number> | null = null;

function getOrStartSample(now: number): Promise<number> {
  if (pendingSample) {
    return pendingSample;
  }
  if (now - state.lastCheckMs < SAMPLE_INTERVAL_MS) {
    return Promise.resolve(state.lastDelayMs);
  }
  pendingSample = sampleEventLoopDelay().then((delay) => {
    pendingSample = null;
    state.lastCheckMs = Date.now();
    state.lastDelayMs = delay;

    if (delay >= DEGRADED_DELAY_THRESHOLD_MS) {
      if (state.degradedSinceMs === null) {
        state.degradedSinceMs = Date.now();
      }
    } else {
      state.degradedSinceMs = null;
    }

    return delay;
  });
  return pendingSample;
}

/**
 * Returns true when the event loop is degraded and load should be shed.
 * Grace period prevents false positives from transient spikes.
 */
export function isEventLoopDegraded(): boolean {
  if (state.degradedSinceMs === null) {
    return false;
  }
  return Date.now() - state.degradedSinceMs >= DEGRADED_GRACE_MS;
}

/**
 * Trigger a fresh event loop health sample. Called once per drain cycle
 * to keep the degradation signal up to date without paying the cost
 * on every single enqueue.
 */
export function triggerEventLoopHealthSample(): void {
  getOrStartSample(Date.now());
}

/**
 * Returns the last measured event loop delay in milliseconds.
 */
export function getLastEventLoopDelayMs(): number {
  return state.lastDelayMs;
}

/**
 * Reset degradation state (for tests).
 */
export function resetEventLoopGuardForTest(): void {
  state.lastCheckMs = 0;
  state.lastDelayMs = 0;
  state.degradedSinceMs = null;
  pendingSample = null;
}
