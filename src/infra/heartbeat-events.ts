export type HeartbeatIndicatorType = "ok" | "alert" | "error";

export type HeartbeatEventPayload = {
  ts: number;
  status: "sent" | "ok-empty" | "ok-token" | "skipped" | "failed";
  to?: string;
  accountId?: string;
  preview?: string;
  durationMs?: number;
  hasMedia?: boolean;
  reason?: string;
  /** The channel this heartbeat was sent to. */
  channel?: string;
  /** Whether the message was silently suppressed (showOk: false). */
  silent?: boolean;
  /** Indicator type for UI status display. */
  indicatorType?: HeartbeatIndicatorType;
};

export function resolveIndicatorType(
  status: HeartbeatEventPayload["status"],
): HeartbeatIndicatorType | undefined {
  switch (status) {
    case "ok-empty":
    case "ok-token":
      return "ok";
    case "sent":
      return "alert";
    case "failed":
      return "error";
    case "skipped":
      return undefined;
  }
}

// ── Event history ────────────────────────────────────────────────────────────

/** Maximum number of heartbeat events retained in memory. */
export const HEARTBEAT_HISTORY_MAX = 50;

let lastHeartbeat: HeartbeatEventPayload | null = null;
const heartbeatHistory: HeartbeatEventPayload[] = [];
const listeners = new Set<(evt: HeartbeatEventPayload) => void>();

export function emitHeartbeatEvent(evt: Omit<HeartbeatEventPayload, "ts">) {
  const enriched: HeartbeatEventPayload = { ts: Date.now(), ...evt };
  lastHeartbeat = enriched;
  heartbeatHistory.push(enriched);
  if (heartbeatHistory.length > HEARTBEAT_HISTORY_MAX) {
    heartbeatHistory.shift();
  }
  for (const listener of listeners) {
    try {
      listener(enriched);
    } catch {
      /* ignore */
    }
  }
}

export function onHeartbeatEvent(listener: (evt: HeartbeatEventPayload) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getLastHeartbeatEvent(): HeartbeatEventPayload | null {
  return lastHeartbeat;
}

/**
 * Return recent heartbeat events, newest last.
 *
 * @param limit - If provided, return only the last `limit` events.
 *                Omit or pass `undefined` to get the full history.
 */
export function getHeartbeatEventHistory(limit?: number): readonly HeartbeatEventPayload[] {
  if (limit == null || limit >= heartbeatHistory.length) {
    return heartbeatHistory.slice();
  }
  if (limit <= 0) {
    return [];
  }
  return heartbeatHistory.slice(-limit);
}

/**
 * Clear all recorded heartbeat history and reset the last-event pointer.
 * Intended for testing; production code should rarely need this.
 */
export function clearHeartbeatEventHistory(): void {
  heartbeatHistory.length = 0;
  lastHeartbeat = null;
}
