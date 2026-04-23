// Coordinates the startup of native approval handlers across all channel
// bootstraps in a single OpenClaw process.
//
// Without coordination, an install with many channel accounts — e.g. 11
// configured Matrix accounts, or 4+ Telegram bots — opens that many loopback
// gateway websockets on the same tick when channels start. The loopback
// gateway's preauth pipeline then contends with itself; handshake timers
// saturate and every one of those connections logs `handshake-timeout` /
// `gateway closed (1000)`, which each bootstrap then retries. The result is
// a sustained 1 Hz reconnect storm against the process's own loopback.
//
// Two primitives are applied here, both channel-agnostic:
//
//   1. Randomized startup jitter. The first handler start on each bootstrap
//      sleeps for a uniformly-random interval in [0, jitterMs). For a herd
//      of N accounts, this spreads them across the jitter window instead of
//      landing at the same millisecond.
//
//   2. A process-scoped semaphore that caps how many handler starts may run
//      their `createChannelApprovalHandlerFromCapability` + `handler.start()`
//      sequence concurrently. Excess starts queue FIFO and acquire a slot as
//      earlier starts finish (success OR failure). This is a hard ceiling on
//      concurrent loopback preauth handshakes from this process regardless of
//      how many channels are enabled.
//
// Both primitives are bypassed cleanly when a bootstrap generation advances
// (context replaced / unregistered / cleanup), via the `isCanceled` callback.
// Retry-after-failure backoff is orthogonal and lives in the bootstrap's
// retry timer.

const DEFAULT_START_JITTER_MS = 2_000;
const DEFAULT_MAX_CONCURRENT_STARTS = 3;
// Hard ceiling on how long a single handler-start may hold its concurrency
// slot. A well-behaved `handler.start()` only needs the slot for the preauth
// handshake critical section (single-digit seconds at most), but a handler
// whose `start()` blocks on unbounded application work — e.g. replaying
// pending approvals through `exec-approval-channel-runtime` — would otherwise
// pin the slot and starve every other channel/account waiting for a slot.
// After this cap the slot is force-released; the original `start()` continues
// to run in the background but no longer blocks unrelated bootstraps.
const DEFAULT_START_SLOT_MAX_HOLD_MS = 30_000;
const START_JITTER_ENV_VAR = "OPENCLAW_APPROVAL_HANDLER_START_JITTER_MS";
const MAX_CONCURRENT_STARTS_ENV_VAR = "OPENCLAW_APPROVAL_HANDLER_MAX_CONCURRENT_STARTS";
const START_SLOT_MAX_HOLD_ENV_VAR = "OPENCLAW_APPROVAL_HANDLER_START_SLOT_MAX_HOLD_MS";

export type ApprovalHandlerStartCoordinator = {
  waitJitter: (isCanceled: () => boolean) => Promise<void>;
  acquireStartSlot: (isCanceled: () => boolean) => Promise<() => void>;
};

export type ApprovalHandlerStartCoordinatorOptions = {
  jitterMs?: number;
  maxConcurrentStarts?: number;
  startSlotMaxHoldMs?: number;
  random?: () => number;
};

function readNonNegativeIntEnv(name: string, env: NodeJS.ProcessEnv): number | undefined {
  const raw = env[name];
  if (raw === undefined) {
    return undefined;
  }
  // Require a pure non-negative integer. Number.parseInt is too lenient — it
  // happily accepts "100ms", "3.5", "42banana" etc., silently ignoring the
  // tail. An env var that looks wrong should be rejected, not coerced.
  if (!/^\d+$/.test(raw)) {
    return undefined;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return undefined;
  }
  return parsed;
}

function readPositiveIntEnv(name: string, env: NodeJS.ProcessEnv): number | undefined {
  const parsed = readNonNegativeIntEnv(name, env);
  if (parsed === undefined || parsed < 1) {
    return undefined;
  }
  return parsed;
}

export function resolveApprovalHandlerStartJitterMs(env: NodeJS.ProcessEnv = process.env): number {
  return readNonNegativeIntEnv(START_JITTER_ENV_VAR, env) ?? DEFAULT_START_JITTER_MS;
}

export function resolveApprovalHandlerMaxConcurrentStarts(
  env: NodeJS.ProcessEnv = process.env,
): number {
  return readPositiveIntEnv(MAX_CONCURRENT_STARTS_ENV_VAR, env) ?? DEFAULT_MAX_CONCURRENT_STARTS;
}

export function resolveApprovalHandlerStartSlotMaxHoldMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  return readPositiveIntEnv(START_SLOT_MAX_HOLD_ENV_VAR, env) ?? DEFAULT_START_SLOT_MAX_HOLD_MS;
}

export function createApprovalHandlerStartCoordinator(
  options: ApprovalHandlerStartCoordinatorOptions = {},
): ApprovalHandlerStartCoordinator {
  const jitterMs = Math.max(
    0,
    Math.trunc(options.jitterMs ?? resolveApprovalHandlerStartJitterMs()),
  );
  const maxConcurrent = Math.max(
    1,
    Math.trunc(options.maxConcurrentStarts ?? resolveApprovalHandlerMaxConcurrentStarts()),
  );
  const startSlotMaxHoldMs = Math.max(
    1,
    Math.trunc(options.startSlotMaxHoldMs ?? resolveApprovalHandlerStartSlotMaxHoldMs()),
  );
  const random = options.random ?? Math.random;

  let active = 0;
  const waiters: Array<(release: () => void) => void> = [];

  const releaseSlot = () => {
    const next = waiters.shift();
    if (next) {
      next(releaseSlot);
      return;
    }
    active -= 1;
  };

  // Schedule a force-release after `startSlotMaxHoldMs`. If the caller's
  // explicit release fires first, the timer just no-ops. If `handler.start()`
  // is hung or doing unbounded post-handshake work, the timer releases the
  // slot so unrelated bootstraps can proceed.
  const scheduleHoldTimeout = (forceRelease: () => void): (() => void) => {
    const timer = setTimeout(forceRelease, startSlotMaxHoldMs);
    timer.unref?.();
    return () => clearTimeout(timer);
  };

  const waitJitter = (isCanceled: () => boolean): Promise<void> => {
    if (jitterMs <= 0 || isCanceled()) {
      return Promise.resolve();
    }
    // Clamp to [0, jitterMs). Math.random() is spec'd to return < 1, so the
    // clamp is belt-and-suspenders against injected RNGs (or exotic runtimes)
    // that can return exactly 1 — without it, a pathological RNG extends the
    // wait to the full jitterMs instead of the advertised upper-exclusive bound.
    const sampled = Math.min(jitterMs - 1, Math.floor(random() * jitterMs));
    if (sampled <= 0) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        resolve();
      }, sampled);
      timer.unref?.();
    });
  };

  const wrapWithHoldTimeout = (rawRelease: () => void): (() => void) => {
    let released = false;
    const safeRelease = () => {
      if (released) {
        return;
      }
      released = true;
      cancelHoldTimer();
      rawRelease();
    };
    const cancelHoldTimer = scheduleHoldTimeout(safeRelease);
    return safeRelease;
  };

  const acquireStartSlot = (isCanceled: () => boolean): Promise<() => void> => {
    if (isCanceled()) {
      // Canceled callers never actually entered the critical section, so hand
      // back a no-op release and do not bump active count.
      return Promise.resolve(() => {});
    }
    if (active < maxConcurrent) {
      active += 1;
      return Promise.resolve(wrapWithHoldTimeout(releaseSlot));
    }
    return new Promise<() => void>((resolve) => {
      waiters.push((release) => {
        resolve(wrapWithHoldTimeout(release));
      });
    });
  };

  return {
    waitJitter,
    acquireStartSlot,
  };
}

let defaultCoordinator: ApprovalHandlerStartCoordinator | null = null;

export function getDefaultApprovalHandlerStartCoordinator(): ApprovalHandlerStartCoordinator {
  if (!defaultCoordinator) {
    defaultCoordinator = createApprovalHandlerStartCoordinator();
  }
  return defaultCoordinator;
}

// Test-only: reset the process-wide default coordinator between test cases so
// one test's queued waiters cannot leak into the next.
export function _resetDefaultApprovalHandlerStartCoordinatorForTests(): void {
  defaultCoordinator = null;
}
