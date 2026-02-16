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

let lastHeartbeat: HeartbeatEventPayload | null = null;
const listeners = new Set<(evt: HeartbeatEventPayload) => void>();

// Prevent unbounded listener growth
const MAX_LISTENERS = 1000;
const LISTENER_WARN_THRESHOLD = 500;

export function emitHeartbeatEvent(evt: Omit<HeartbeatEventPayload, "ts">) {
  const enriched: HeartbeatEventPayload = { ts: Date.now(), ...evt };
  lastHeartbeat = enriched;
  for (const listener of listeners) {
    try {
      listener(enriched);
    } catch (err) {
      // Log listener errors to help debug issues, but don't crash the event system
      console.error(
        "[heartbeat-events] Listener error:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}

export function onHeartbeatEvent(listener: (evt: HeartbeatEventPayload) => void): () => void {
  if (listeners.size >= MAX_LISTENERS) {
    console.error(
      `[heartbeat-events] Max listeners (${MAX_LISTENERS}) reached. Possible memory leak.`,
    );
    // Still add to prevent breaking functionality, but warn
  } else if (listeners.size >= LISTENER_WARN_THRESHOLD) {
    console.warn(
      `[heartbeat-events] High listener count (${listeners.size}/${MAX_LISTENERS}). Consider checking for missing cleanup.`,
    );
  }
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getLastHeartbeatEvent(): HeartbeatEventPayload | null {
  return lastHeartbeat;
}
