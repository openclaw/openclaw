export type GatewaySessionEndReason =
  | "new"
  | "reset"
  | "idle"
  | "daily"
  | "compaction"
  | "deleted"
  | "shutdown"
  | "restart"
  | "unknown";

export type GatewaySessionEndedEvent = {
  sessionKey: string;
  reason: GatewaySessionEndReason;
};

type GatewaySessionEndedListener = (event: GatewaySessionEndedEvent) => void;
const listeners = new Set<GatewaySessionEndedListener>();

export function onGatewaySessionEnded(listener: GatewaySessionEndedListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function emitGatewaySessionEnded(event: GatewaySessionEndedEvent): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      // Session teardown must continue when an observer is already shutting down.
    }
  }
}
