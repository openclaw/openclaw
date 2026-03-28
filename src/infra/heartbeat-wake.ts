import {
  isHeartbeatActionWakeReason,
  normalizeHeartbeatWakeReason,
  resolveHeartbeatReasonKind,
} from "./heartbeat-reason.js";

export type HeartbeatRunResult =
  | { status: "ran"; durationMs: number }
  | { status: "skipped"; reason: string }
  | { status: "failed"; reason: string };

export type HeartbeatWakeHandler = (opts: {
  reason?: string;
  agentId?: string;
  sessionKey?: string;
}) => Promise<HeartbeatRunResult>;

let heartbeatsEnabled = true;

export function setHeartbeatsEnabled(enabled: boolean) {
  heartbeatsEnabled = enabled;
}

export function areHeartbeatsEnabled(): boolean {
  return heartbeatsEnabled;
}

// `readyAt` tracks the earliest coalesced time a target wants to run.
// `notBeforeAt` is a hard floor for retries/cooldowns that fresh wakes
// for the same target must not bypass.
type PendingWakeReason = {
  reason: string;
  priority: number;
  requestedAt: number;
  readyAt: number;
  notBeforeAt: number;
  agentId?: string;
  sessionKey?: string;
};

let handler: HeartbeatWakeHandler | null = null;
let handlerGeneration = 0;
const pendingWakes = new Map<string, PendingWakeReason>();
let scheduled = false;
let running = false;
let timer: NodeJS.Timeout | null = null;
let timerDueAt: number | null = null;

// Circuit breaker: track consecutive failures *per wake target* to prevent
// retry storms. After MAX_CONSECUTIVE_FAILURES for a given target, stop
// retrying that target for BREAKER_COOLDOWN_MS. Other targets are unaffected.
// The breaker auto-resets (half-open) after the cooldown so heartbeats
// self-heal once dependencies recover, without requiring a lifecycle restart.
type BreakerState = { failures: number; trippedAt: number };
const breakerByTarget = new Map<string, BreakerState>();
const MAX_CONSECUTIVE_FAILURES = 5;
const MAX_RETRY_BACKOFF_MS = 60_000;
const BREAKER_COOLDOWN_MS = 5 * 60_000; // 5 minutes
// Safety cap: evict the oldest breaker entry (by insertion order) when the map
// grows beyond this size. In practice the count is bounded by active
// agent/session targets, but this prevents unbounded growth if something
// generates many unique failing target keys.
const MAX_BREAKER_ENTRIES = 1_000;

function getBreakerState(targetKey: string): BreakerState {
  let state = breakerByTarget.get(targetKey);
  if (!state) {
    // Evict oldest entry if we hit the cap.
    if (breakerByTarget.size >= MAX_BREAKER_ENTRIES) {
      const oldest = breakerByTarget.keys().next().value;
      if (oldest !== undefined) {
        breakerByTarget.delete(oldest);
      }
    }
    state = { failures: 0, trippedAt: 0 };
    breakerByTarget.set(targetKey, state);
  }
  return state;
}

/** Check if a target's breaker is tripped (open). Returns true if the target should be skipped. */
function isBreakerOpen(targetKey: string): boolean {
  const state = breakerByTarget.get(targetKey);
  if (!state || state.failures < MAX_CONSECUTIVE_FAILURES) {
    return false;
  }
  const elapsed = Date.now() - state.trippedAt;
  if (elapsed >= BREAKER_COOLDOWN_MS) {
    // Half-open: allow one probe attempt after the cooldown.
    state.failures = MAX_CONSECUTIVE_FAILURES - 1;
    return false;
  }
  return true;
}

const DEFAULT_COALESCE_MS = 250;
const DEFAULT_RETRY_MS = 1_000;
const REASON_PRIORITY = {
  RETRY: 0,
  INTERVAL: 1,
  DEFAULT: 2,
  ACTION: 3,
} as const;

function resolveReasonPriority(reason: string): number {
  const kind = resolveHeartbeatReasonKind(reason);
  if (kind === "retry") {
    return REASON_PRIORITY.RETRY;
  }
  if (kind === "interval") {
    return REASON_PRIORITY.INTERVAL;
  }
  if (isHeartbeatActionWakeReason(reason)) {
    return REASON_PRIORITY.ACTION;
  }
  return REASON_PRIORITY.DEFAULT;
}

/** Exponential backoff capped at MAX_RETRY_BACKOFF_MS. */
function computeRetryBackoffMs(failures: number): number {
  // 1s, 2s, 4s, 8s, 16s, 32s, 60s, 60s, ...
  return Math.min(DEFAULT_RETRY_MS * Math.pow(2, Math.max(0, failures - 1)), MAX_RETRY_BACKOFF_MS);
}

function normalizeWakeReason(reason?: string): string {
  return normalizeHeartbeatWakeReason(reason);
}

function resolveRetryWakeReason(reason?: string): string {
  const normalizedReason = normalizeWakeReason(reason);
  return resolveHeartbeatReasonKind(normalizedReason) === "interval" ? "retry" : normalizedReason;
}

function normalizeWakeTarget(value?: string): string | undefined {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed || undefined;
}

function getWakeTargetKey(params: { agentId?: string; sessionKey?: string }) {
  const agentId = normalizeWakeTarget(params.agentId);
  const sessionKey = normalizeWakeTarget(params.sessionKey);
  return `${agentId ?? ""}::${sessionKey ?? ""}`;
}

function getBreakerRemainingMs(targetKey: string): number | null {
  const state = breakerByTarget.get(targetKey);
  if (!state || state.failures < MAX_CONSECUTIVE_FAILURES) {
    return null;
  }
  return Math.max(0, BREAKER_COOLDOWN_MS - (Date.now() - state.trippedAt));
}

function resolveWakeReadyAt(requestedAt: number, readyAt?: number): number {
  if (typeof readyAt !== "number" || !Number.isFinite(readyAt)) {
    return requestedAt;
  }
  return Math.max(requestedAt, readyAt);
}

function resolveWakeNotBeforeAt(requestedAt: number, notBeforeAt?: number): number {
  if (typeof notBeforeAt !== "number" || !Number.isFinite(notBeforeAt)) {
    return requestedAt;
  }
  return Math.max(requestedAt, notBeforeAt);
}

function resolvePendingWakeDueAt(wake: PendingWakeReason): number {
  return Math.max(wake.readyAt, wake.notBeforeAt);
}

function getNextPendingWakeDelayMs(now = Date.now()): number | null {
  let nextDueAt = Infinity;
  for (const wake of pendingWakes.values()) {
    const dueAt = resolvePendingWakeDueAt(wake);
    if (dueAt < nextDueAt) {
      nextDueAt = dueAt;
    }
  }
  return Number.isFinite(nextDueAt) ? Math.max(0, nextDueAt - now) : null;
}

function queuePendingWakeReason(params?: {
  reason?: string;
  requestedAt?: number;
  readyAt?: number;
  notBeforeAt?: number;
  agentId?: string;
  sessionKey?: string;
}) {
  const requestedAt = params?.requestedAt ?? Date.now();
  const readyAt = resolveWakeReadyAt(requestedAt, params?.readyAt);
  const notBeforeAt = resolveWakeNotBeforeAt(requestedAt, params?.notBeforeAt);
  const normalizedReason = normalizeWakeReason(params?.reason);
  const normalizedAgentId = normalizeWakeTarget(params?.agentId);
  const normalizedSessionKey = normalizeWakeTarget(params?.sessionKey);
  const wakeTargetKey = getWakeTargetKey({
    agentId: normalizedAgentId,
    sessionKey: normalizedSessionKey,
  });
  const next: PendingWakeReason = {
    reason: normalizedReason,
    priority: resolveReasonPriority(normalizedReason),
    requestedAt,
    readyAt,
    notBeforeAt,
    agentId: normalizedAgentId,
    sessionKey: normalizedSessionKey,
  };
  const previous = pendingWakes.get(wakeTargetKey);
  if (!previous) {
    pendingWakes.set(wakeTargetKey, next);
    return;
  }
  const mergedReadyAt = Math.min(previous.readyAt, next.readyAt);
  const mergedNotBeforeAt = Math.max(previous.notBeforeAt, next.notBeforeAt);
  if (next.priority > previous.priority) {
    pendingWakes.set(wakeTargetKey, {
      ...next,
      readyAt: mergedReadyAt,
      notBeforeAt: mergedNotBeforeAt,
    });
    return;
  }
  if (next.priority === previous.priority && next.requestedAt >= previous.requestedAt) {
    pendingWakes.set(wakeTargetKey, {
      ...next,
      readyAt: mergedReadyAt,
      notBeforeAt: mergedNotBeforeAt,
    });
    return;
  }
  pendingWakes.set(wakeTargetKey, {
    ...previous,
    readyAt: mergedReadyAt,
    notBeforeAt: mergedNotBeforeAt,
  });
}

function schedulePendingWakes(fallbackDelayMs?: number) {
  const pendingDelayMs = getNextPendingWakeDelayMs();
  const delay =
    pendingDelayMs ??
    (typeof fallbackDelayMs === "number" && Number.isFinite(fallbackDelayMs)
      ? Math.max(0, fallbackDelayMs)
      : null);
  if (delay === null) {
    return;
  }
  const dueAt = Date.now() + delay;
  if (timer) {
    // If existing timer fires sooner or at the same time, keep it.
    if (typeof timerDueAt === "number" && timerDueAt <= dueAt) {
      return;
    }
    // New request needs to fire sooner — preempt the existing timer.
    clearTimeout(timer);
    timer = null;
    timerDueAt = null;
  }
  timerDueAt = dueAt;
  timer = setTimeout(async () => {
    timer = null;
    timerDueAt = null;
    scheduled = false;
    const active = handler;
    if (!active) {
      return;
    }
    if (running) {
      scheduled = true;
      return;
    }

    const now = Date.now();
    // Build pending batch from wakes whose per-target cooldown has elapsed.
    const pendingBatch: PendingWakeReason[] = [];
    for (const [targetKey, wake] of pendingWakes) {
      if (resolvePendingWakeDueAt(wake) > now) {
        continue;
      }
      if (isBreakerOpen(targetKey)) {
        // A retained wake became due before its breaker cooled down.
        // Push its next probe to the actual remaining cooldown.
        const remaining = getBreakerRemainingMs(targetKey);
        if (remaining !== null) {
          const nextDueAt = now + remaining;
          pendingWakes.set(targetKey, {
            ...wake,
            readyAt: nextDueAt,
            notBeforeAt: nextDueAt,
          });
        }
        continue;
      }
      pendingBatch.push(wake);
    }
    if (pendingBatch.length === 0) {
      if (pendingWakes.size > 0 || scheduled) {
        schedulePendingWakes(scheduled ? 0 : undefined);
      }
      return;
    }
    for (const wake of pendingBatch) {
      pendingWakes.delete(getWakeTargetKey(wake));
    }
    running = true;
    // Track processed targets so the catch block only penalizes
    // targets that were not yet handled when the handler threw.
    const processedTargets = new Set<string>();
    let activeWake: PendingWakeReason | null = null;
    try {
      for (const pendingWake of pendingBatch) {
        const targetKey = getWakeTargetKey(pendingWake);
        const wakeOpts = {
          reason: pendingWake.reason ?? undefined,
          ...(pendingWake.agentId ? { agentId: pendingWake.agentId } : {}),
          ...(pendingWake.sessionKey ? { sessionKey: pendingWake.sessionKey } : {}),
        };
        activeWake = pendingWake;
        const res = await active(wakeOpts);
        activeWake = null;
        processedTargets.add(targetKey);
        if (res.status === "failed") {
          // Defer getBreakerState to the failure path to avoid
          // needlessly creating entries for targets that succeed.
          const breaker = getBreakerState(targetKey);
          breaker.failures += 1;
          const retryReason = resolveRetryWakeReason(pendingWake.reason);
          if (breaker.failures >= MAX_CONSECUTIVE_FAILURES) {
            // Retain the wake so the half-open probe runs after cooldown.
            breaker.trippedAt = Date.now();
            const nextDueAt = Date.now() + BREAKER_COOLDOWN_MS;
            queuePendingWakeReason({
              reason: retryReason,
              readyAt: nextDueAt,
              notBeforeAt: nextDueAt,
              agentId: pendingWake.agentId,
              sessionKey: pendingWake.sessionKey,
            });
            continue;
          }
          const backoffMs = computeRetryBackoffMs(breaker.failures);
          const nextDueAt = Date.now() + backoffMs;
          queuePendingWakeReason({
            reason: retryReason,
            readyAt: nextDueAt,
            notBeforeAt: nextDueAt,
            agentId: pendingWake.agentId,
            sessionKey: pendingWake.sessionKey,
          });
        } else if (res.status === "skipped" && res.reason === "requests-in-flight") {
          // The main lane is busy; retry this wake target soon.
          const nextDueAt = Date.now() + DEFAULT_RETRY_MS;
          queuePendingWakeReason({
            reason: resolveRetryWakeReason(pendingWake.reason),
            readyAt: nextDueAt,
            notBeforeAt: nextDueAt,
            agentId: pendingWake.agentId,
            sessionKey: pendingWake.sessionKey,
          });
        } else {
          // Success or benign skip — evict the breaker entry to bound map size.
          breakerByTarget.delete(targetKey);
        }
      }
    } catch {
      // Error is already logged by the heartbeat runner; only penalize
      // the target that was actively executing when the throw happened.
      const activeTargetKey = activeWake ? getWakeTargetKey(activeWake) : null;
      if (activeWake && activeTargetKey) {
        const breaker = getBreakerState(activeTargetKey);
        breaker.failures += 1;
        const retryReason = resolveRetryWakeReason(activeWake.reason);
        if (breaker.failures >= MAX_CONSECUTIVE_FAILURES) {
          breaker.trippedAt = Date.now();
          const nextDueAt = Date.now() + BREAKER_COOLDOWN_MS;
          queuePendingWakeReason({
            reason: retryReason,
            readyAt: nextDueAt,
            notBeforeAt: nextDueAt,
            agentId: activeWake.agentId,
            sessionKey: activeWake.sessionKey,
          });
        } else {
          const backoffMs = computeRetryBackoffMs(breaker.failures);
          const nextDueAt = Date.now() + backoffMs;
          queuePendingWakeReason({
            reason: retryReason,
            readyAt: nextDueAt,
            notBeforeAt: nextDueAt,
            agentId: activeWake.agentId,
            sessionKey: activeWake.sessionKey,
          });
        }
      }
      for (const pendingWake of pendingBatch) {
        const targetKey = getWakeTargetKey(pendingWake);
        if (processedTargets.has(targetKey)) {
          continue;
        }
        if (targetKey === activeTargetKey) {
          continue;
        }
        queuePendingWakeReason({
          reason: pendingWake.reason,
          readyAt: Date.now(),
          notBeforeAt: Date.now(),
          agentId: pendingWake.agentId,
          sessionKey: pendingWake.sessionKey,
        });
      }
    } finally {
      running = false;
      if (pendingWakes.size > 0 || scheduled) {
        schedulePendingWakes(scheduled ? 0 : undefined);
      }
    }
  }, delay);
  timer.unref?.();
}

/**
 * Register (or clear) the heartbeat wake handler.
 * Returns a disposer function that clears this specific registration.
 * Stale disposers (from previous registrations) are no-ops, preventing
 * a race where an old runner's cleanup clears a newer runner's handler.
 */
export function setHeartbeatWakeHandler(next: HeartbeatWakeHandler | null): () => void {
  handlerGeneration += 1;
  const generation = handlerGeneration;
  handler = next;
  if (next) {
    // New lifecycle starting (e.g. after SIGUSR1 in-process restart).
    // Clear any timer metadata from the previous lifecycle so stale retry
    // cooldowns do not delay a fresh handler.
    if (timer) {
      clearTimeout(timer);
    }
    timer = null;
    timerDueAt = null;
    // Reset module-level execution state that may be stale from interrupted
    // runs in the previous lifecycle. Without this, `running === true` from
    // an interrupted heartbeat blocks all future schedule() attempts, and
    // `scheduled === true` can cause spurious immediate re-runs.
    running = false;
    scheduled = false;
    // Reset the circuit breaker so a fresh lifecycle starts clean.
    breakerByTarget.clear();
    if (pendingWakes.size > 0) {
      const now = Date.now();
      const drainAt = now + DEFAULT_COALESCE_MS;
      for (const [targetKey, wake] of pendingWakes) {
        pendingWakes.set(targetKey, {
          ...wake,
          readyAt: drainAt,
          notBeforeAt: now,
        });
      }
    }
  }
  if (handler && pendingWakes.size > 0) {
    schedulePendingWakes(DEFAULT_COALESCE_MS);
  }
  return () => {
    if (handlerGeneration !== generation) {
      return;
    }
    if (handler !== next) {
      return;
    }
    handlerGeneration += 1;
    handler = null;
  };
}

export function requestHeartbeatNow(opts?: {
  reason?: string;
  coalesceMs?: number;
  agentId?: string;
  sessionKey?: string;
}) {
  const requestedAt = Date.now();
  const coalesceMs = Number.isFinite(opts?.coalesceMs)
    ? Math.max(0, opts?.coalesceMs ?? DEFAULT_COALESCE_MS)
    : DEFAULT_COALESCE_MS;
  queuePendingWakeReason({
    reason: opts?.reason,
    requestedAt,
    readyAt: requestedAt + coalesceMs,
    notBeforeAt: requestedAt,
    agentId: opts?.agentId,
    sessionKey: opts?.sessionKey,
  });
  schedulePendingWakes();
}

export function hasHeartbeatWakeHandler() {
  return handler !== null;
}

export function hasPendingHeartbeatWake() {
  return pendingWakes.size > 0 || Boolean(timer) || scheduled;
}

export function resetHeartbeatWakeStateForTests() {
  if (timer) {
    clearTimeout(timer);
  }
  timer = null;
  timerDueAt = null;
  pendingWakes.clear();
  scheduled = false;
  running = false;
  breakerByTarget.clear();
  handlerGeneration += 1;
  handler = null;
}
