export type HeartbeatRunResult =
  | { status: "ran"; durationMs: number }
  | { status: "skipped"; reason: string }
  | { status: "failed"; reason: string };

export type HeartbeatWakeHandler = (opts: { reason?: string }) => Promise<HeartbeatRunResult>;

let handler: HeartbeatWakeHandler | null = null;
let pendingReason: string | null = null;
let scheduled = false;
let running = false;
let timer: NodeJS.Timeout | null = null;
let scheduledAtMs: number | null = null;
let scheduledDelayMs: number | null = null;

const DEFAULT_COALESCE_MS = 250;
const DEFAULT_RETRY_MS = 1_000;

function schedule(coalesceMs: number) {
  // If we already have a timer, check if we need to reschedule with a shorter delay
  if (timer && scheduledAtMs !== null && scheduledDelayMs !== null) {
    const elapsedMs = Date.now() - scheduledAtMs;
    const remainingMs = Math.max(0, scheduledDelayMs - elapsedMs);

    // If the new request is more urgent (shorter delay), reschedule
    if (coalesceMs < remainingMs) {
      clearTimeout(timer);
      timer = null;
      scheduledAtMs = null;
      scheduledDelayMs = null;
    } else {
      // Existing timer will fire sooner, keep it
      return;
    }
  }
  scheduledAtMs = Date.now();
  scheduledDelayMs = coalesceMs;
  timer = setTimeout(async () => {
    timer = null;
    scheduledAtMs = null;
    scheduledDelayMs = null;
    scheduled = false;
    const active = handler;
    if (!active) {
      return;
    }
    if (running) {
      scheduled = true;
      schedule(coalesceMs);
      return;
    }

    const reason = pendingReason;
    pendingReason = null;
    running = true;
    try {
      const res = await active({ reason: reason ?? undefined });
      if (res.status === "skipped" && res.reason === "requests-in-flight") {
        // The main lane is busy; retry soon.
        pendingReason = reason ?? "retry";
        schedule(DEFAULT_RETRY_MS);
      }
    } catch {
      // Error is already logged by the heartbeat runner; schedule a retry.
      pendingReason = reason ?? "retry";
      schedule(DEFAULT_RETRY_MS);
    } finally {
      running = false;
      if (pendingReason || scheduled) {
        schedule(coalesceMs);
      }
    }
  }, coalesceMs);
  timer.unref?.();
}

export function setHeartbeatWakeHandler(next: HeartbeatWakeHandler | null) {
  handler = next;
  if (handler && pendingReason) {
    schedule(DEFAULT_COALESCE_MS);
  }
}

export function requestHeartbeatNow(opts?: { reason?: string; coalesceMs?: number }) {
  pendingReason = opts?.reason ?? pendingReason ?? "requested";
  schedule(opts?.coalesceMs ?? DEFAULT_COALESCE_MS);
}

export function hasHeartbeatWakeHandler() {
  return handler !== null;
}

export function hasPendingHeartbeatWake() {
  return pendingReason !== null || Boolean(timer) || scheduled;
}
