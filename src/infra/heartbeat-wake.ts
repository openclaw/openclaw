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

type WakeTimerKind = "normal" | "retry";
type PendingWakeReason = {
  reason: string;
  priority: number;
  requestedAt: number;
  agentId?: string;
  sessionKey?: string;
};

// Shared state via globalThis to prevent bundler code-splitting from creating
// duplicate module instances with separate handler variables.  When rolldown
// (or any other bundler) splits this module into several output chunks, each
// chunk gets its own copy of module-level `let` bindings.  That means
// `setHeartbeatWakeHandler` in chunk A sets a handler that
// `requestHeartbeatNow` in chunk B can never see.  Storing the mutable state
// on globalThis ensures every chunk reads and writes the same object.
const SHARED_KEY = "__openclaw_heartbeat_wake__" as const;
type SharedWakeState = {
  heartbeatsEnabled: boolean;
  handler: HeartbeatWakeHandler | null;
  handlerGeneration: number;
  pendingWakes: Map<string, PendingWakeReason>;
  scheduled: boolean;
  running: boolean;
  timer: NodeJS.Timeout | null;
  timerDueAt: number | null;
  timerKind: WakeTimerKind | null;
};
const _s: SharedWakeState = ((globalThis as Record<string, unknown>)[SHARED_KEY] ??= {
  heartbeatsEnabled: true,
  handler: null,
  handlerGeneration: 0,
  pendingWakes: new Map<string, PendingWakeReason>(),
  scheduled: false,
  running: false,
  timer: null,
  timerDueAt: null,
  timerKind: null,
}) as SharedWakeState;

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

function normalizeWakeReason(reason?: string): string {
  return normalizeHeartbeatWakeReason(reason);
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

function queuePendingWakeReason(params?: {
  reason?: string;
  requestedAt?: number;
  agentId?: string;
  sessionKey?: string;
}) {
  const requestedAt = params?.requestedAt ?? Date.now();
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
    agentId: normalizedAgentId,
    sessionKey: normalizedSessionKey,
  };
  const previous = _s.pendingWakes.get(wakeTargetKey);
  if (!previous) {
    _s.pendingWakes.set(wakeTargetKey, next);
    return;
  }
  if (next.priority > previous.priority) {
    _s.pendingWakes.set(wakeTargetKey, next);
    return;
  }
  if (next.priority === previous.priority && next.requestedAt >= previous.requestedAt) {
    _s.pendingWakes.set(wakeTargetKey, next);
  }
}

function schedule(coalesceMs: number, kind: WakeTimerKind = "normal") {
  const delay = Number.isFinite(coalesceMs) ? Math.max(0, coalesceMs) : DEFAULT_COALESCE_MS;
  const dueAt = Date.now() + delay;
  if (_s.timer) {
    // Keep retry cooldown as a hard minimum delay. This prevents the
    // finally-path reschedule (often delay=0) from collapsing backoff.
    if (_s.timerKind === "retry") {
      return;
    }
    // If existing timer fires sooner or at the same time, keep it.
    if (typeof _s.timerDueAt === "number" && _s.timerDueAt <= dueAt) {
      return;
    }
    // New request needs to fire sooner — preempt the existing timer.
    clearTimeout(_s.timer);
    _s.timer = null;
    _s.timerDueAt = null;
    _s.timerKind = null;
  }
  _s.timerDueAt = dueAt;
  _s.timerKind = kind;
  _s.timer = setTimeout(async () => {
    _s.timer = null;
    _s.timerDueAt = null;
    _s.timerKind = null;
    _s.scheduled = false;
    const active = _s.handler;
    if (!active) {
      return;
    }
    if (_s.running) {
      _s.scheduled = true;
      schedule(delay, kind);
      return;
    }

    const pendingBatch = Array.from(_s.pendingWakes.values());
    _s.pendingWakes.clear();
    _s.running = true;
    try {
      for (const pendingWake of pendingBatch) {
        const wakeOpts = {
          reason: pendingWake.reason ?? undefined,
          ...(pendingWake.agentId ? { agentId: pendingWake.agentId } : {}),
          ...(pendingWake.sessionKey ? { sessionKey: pendingWake.sessionKey } : {}),
        };
        const res = await active(wakeOpts);
        if (res.status === "skipped" && res.reason === "requests-in-flight") {
          // The main lane is busy; retry this wake target soon.
          queuePendingWakeReason({
            reason: pendingWake.reason ?? "retry",
            agentId: pendingWake.agentId,
            sessionKey: pendingWake.sessionKey,
          });
          schedule(DEFAULT_RETRY_MS, "retry");
        }
      }
    } catch {
      // Error is already logged by the heartbeat runner; schedule a retry.
      for (const pendingWake of pendingBatch) {
        queuePendingWakeReason({
          reason: pendingWake.reason ?? "retry",
          agentId: pendingWake.agentId,
          sessionKey: pendingWake.sessionKey,
        });
      }
      schedule(DEFAULT_RETRY_MS, "retry");
    } finally {
      _s.running = false;
      if (_s.pendingWakes.size > 0 || _s.scheduled) {
        schedule(delay, "normal");
      }
    }
  }, delay);
  _s.timer.unref?.();
}

/**
 * Register (or clear) the heartbeat wake handler.
 * Returns a disposer function that clears this specific registration.
 * Stale disposers (from previous registrations) are no-ops, preventing
 * a race where an old runner's cleanup clears a newer runner's handler.
 */
export function setHeartbeatWakeHandler(next: HeartbeatWakeHandler | null): () => void {
  _s.handlerGeneration += 1;
  const generation = _s.handlerGeneration;
  _s.handler = next;
  if (next) {
    // New lifecycle starting (e.g. after SIGUSR1 in-process restart).
    // Clear any timer metadata from the previous lifecycle so stale retry
    // cooldowns do not delay a fresh handler.
    if (_s.timer) {
      clearTimeout(_s.timer);
    }
    _s.timer = null;
    _s.timerDueAt = null;
    _s.timerKind = null;
    // Reset execution state that may be stale from interrupted runs in the
    // previous lifecycle. Without this, `running === true` from an
    // interrupted heartbeat blocks all future schedule() attempts, and
    // `scheduled === true` can cause spurious immediate re-runs.
    _s.running = false;
    _s.scheduled = false;
  }
  if (_s.handler && _s.pendingWakes.size > 0) {
    schedule(DEFAULT_COALESCE_MS, "normal");
  }
  return () => {
    if (_s.handlerGeneration !== generation) {
      return;
    }
    if (_s.handler !== next) {
      return;
    }
    _s.handlerGeneration += 1;
    _s.handler = null;
  };
}

export function requestHeartbeatNow(opts?: {
  reason?: string;
  coalesceMs?: number;
  agentId?: string;
  sessionKey?: string;
}) {
  queuePendingWakeReason({
    reason: opts?.reason,
    agentId: opts?.agentId,
    sessionKey: opts?.sessionKey,
  });
  schedule(opts?.coalesceMs ?? DEFAULT_COALESCE_MS, "normal");
}

export function hasHeartbeatWakeHandler() {
  return _s.handler !== null;
}

export function setHeartbeatsEnabled(enabled: boolean) {
  _s.heartbeatsEnabled = enabled;
}

export function areHeartbeatsEnabled(): boolean {
  return _s.heartbeatsEnabled;
}

export function hasPendingHeartbeatWake() {
  return _s.pendingWakes.size > 0 || Boolean(_s.timer) || _s.scheduled;
}

export function resetHeartbeatWakeStateForTests() {
  if (_s.timer) {
    clearTimeout(_s.timer);
  }
  _s.heartbeatsEnabled = true;
  _s.timer = null;
  _s.timerDueAt = null;
  _s.timerKind = null;
  _s.pendingWakes.clear();
  _s.scheduled = false;
  _s.running = false;
  _s.handlerGeneration += 1;
  _s.handler = null;
}
