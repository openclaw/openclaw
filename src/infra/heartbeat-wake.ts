export type HeartbeatRunResult =
  | { status: "ran"; durationMs: number }
  | { status: "skipped"; reason: string }
  | { status: "failed"; reason: string };

export type HeartbeatWakeHandler = (opts: { reason?: string }) => Promise<HeartbeatRunResult>;

type WakeTimerKind = "normal" | "retry";
type PendingWakeReason = {
  reason: string;
  priority: number;
  requestedAt: number;
};

let handler: HeartbeatWakeHandler | null = null;
let handlerGeneration = 0;
let pendingWake: PendingWakeReason | null = null;
let scheduled = false;
let running = false;
let timer: NodeJS.Timeout | null = null;
let timerDueAt: number | null = null;
let timerKind: WakeTimerKind | null = null;

const DEFAULT_COALESCE_MS = 250;
const DEFAULT_RETRY_MS = 1_000;
const HOOK_REASON_PREFIX = "hook:";
const REASON_PRIORITY = {
  RETRY: 0,
  INTERVAL: 1,
  DEFAULT: 2,
  ACTION: 3,
} as const;

function isActionWakeReason(reason: string): boolean {
  return reason === "manual" || reason === "exec-event" || reason.startsWith(HOOK_REASON_PREFIX);
}

function resolveReasonPriority(reason: string): number {
  if (reason === "retry") {
    return REASON_PRIORITY.RETRY;
  }
  if (reason === "interval") {
    return REASON_PRIORITY.INTERVAL;
  }
  if (isActionWakeReason(reason)) {
    return REASON_PRIORITY.ACTION;
  }
  return REASON_PRIORITY.DEFAULT;
}

function normalizeWakeReason(reason?: string): string {
  if (typeof reason !== "string") {
    return "requested";
  }
  const trimmed = reason.trim();
  return trimmed.length > 0 ? trimmed : "requested";
}

function queuePendingWakeReason(reason?: string, requestedAt = Date.now()) {
  const normalizedReason = normalizeWakeReason(reason);
  const next: PendingWakeReason = {
    reason: normalizedReason,
    priority: resolveReasonPriority(normalizedReason),
    requestedAt,
  };
  if (!pendingWake) {
    pendingWake = next;
    return;
  }
  if (next.priority > pendingWake.priority) {
    pendingWake = next;
    return;
  }
  if (next.priority === pendingWake.priority && next.requestedAt >= pendingWake.requestedAt) {
    pendingWake = next;
  }
}

function schedule(coalesceMs: number, kind: WakeTimerKind = "normal") {
  const delay = Number.isFinite(coalesceMs) ? Math.max(0, coalesceMs) : DEFAULT_COALESCE_MS;
  const dueAt = Date.now() + delay;
  if (timer) {
    // Keep retry cooldown as a hard minimum delay. This prevents the
    // finally-path reschedule (often delay=0) from collapsing backoff.
    if (timerKind === "retry") {
      return;
    }
    // If existing timer fires sooner or at the same time, keep it.
    if (typeof timerDueAt === "number" && timerDueAt <= dueAt) {
      return;
    }
    // New request needs to fire sooner — preempt the existing timer.
    clearTimeout(timer);
    timer = null;
    timerDueAt = null;
    timerKind = null;
  }
  timerDueAt = dueAt;
  timerKind = kind;
  timer = setTimeout(async () => {
    timer = null;
    timerDueAt = null;
    timerKind = null;
    scheduled = false;
    const active = handler;
    if (!active) {
      return;
    }
    if (running) {
      scheduled = true;
      schedule(delay, kind);
      return;
    }

    const reason = pendingWake?.reason;
    pendingWake = null;
    running = true;
    try {
      const res = await active({ reason: reason ?? undefined });
      if (res.status === "skipped" && res.reason === "requests-in-flight") {
        // The main lane is busy; retry soon.
        queuePendingWakeReason(reason ?? "retry");
        schedule(DEFAULT_RETRY_MS, "retry");
      }
    } catch {
      // Error is already logged by the heartbeat runner; schedule a retry.
      queuePendingWakeReason(reason ?? "retry");
      schedule(DEFAULT_RETRY_MS, "retry");
    } finally {
      running = false;
      if (pendingWake || scheduled) {
        schedule(delay, "normal");
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
  if (handler && pendingWake) {
    schedule(DEFAULT_COALESCE_MS, "normal");
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

export function requestHeartbeatNow(opts?: { reason?: string; coalesceMs?: number }) {
  queuePendingWakeReason(opts?.reason);
  schedule(opts?.coalesceMs ?? DEFAULT_COALESCE_MS, "normal");
}

export function hasHeartbeatWakeHandler() {
  return handler !== null;
}

export function hasPendingHeartbeatWake() {
  return pendingWake !== null || Boolean(timer) || scheduled;
}
