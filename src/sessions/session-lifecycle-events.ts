/**
 * In-process session lifecycle notification consumed by Gateway websocket
 * fanout. Payloads stay small because listeners reload the session row when
 * they need a full snapshot.
 */
export type SessionLifecycleEvent = {
  sessionKey: string;
  reason: string;
  parentSessionKey?: string;
  label?: string;
  displayName?: string;
};

type SessionLifecycleListener = (event: SessionLifecycleEvent) => void;

const SESSION_LIFECYCLE_LISTENERS = new Set<SessionLifecycleListener>();

/**
 * Registers a lifecycle listener and returns its unsubscribe function. The bus
 * is process-local, so callers must unsubscribe during runtime teardown/tests.
 */
export function onSessionLifecycleEvent(listener: SessionLifecycleListener): () => void {
  SESSION_LIFECYCLE_LISTENERS.add(listener);
  return () => {
    SESSION_LIFECYCLE_LISTENERS.delete(listener);
  };
}

/**
 * Emits a lifecycle event to all current listeners. Listener failures are
 * isolated so one broken subscriber cannot prevent Gateway websocket fanout or
 * other lifecycle consumers from seeing the event.
 */
export function emitSessionLifecycleEvent(event: SessionLifecycleEvent): void {
  for (const listener of SESSION_LIFECYCLE_LISTENERS) {
    try {
      listener(event);
    } catch {
      // Best-effort, do not propagate listener errors.
    }
  }
}
