export type HeartbeatEventPayload = {
  ts: number;
  status: "sent" | "ok-empty" | "ok-token" | "skipped" | "failed";
  to?: string;
  preview?: string;
  durationMs?: number;
  hasMedia?: boolean;
  reason?: string;
};

let lastHeartbeat: HeartbeatEventPayload | null = null;
const listeners = new Set<(evt: HeartbeatEventPayload) => void>();

export function emitHeartbeatEvent(evt: Omit<HeartbeatEventPayload, "ts">) {
  const enriched: HeartbeatEventPayload = { ts: Date.now(), ...evt };
  lastHeartbeat = enriched;
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
