export type SessionLifecycleEvent = {
  /** Canonical session key whose lifecycle changed. */
  sessionKey: string;
  /** Caller-defined lifecycle reason delivered to subscribed Gateway runtimes. */
  reason: string;
  /** Parent session key for child/subagent lifecycle updates. */
  parentSessionKey?: string;
  /** Optional user-facing session label to include with change events. */
  label?: string;
  /** Optional display name to include with change events. */
  displayName?: string;
};

type SessionLifecycleListener = (event: SessionLifecycleEvent) => void;

const SESSION_LIFECYCLE_LISTENERS = new Set<SessionLifecycleListener>();

/** Subscribe to in-process session lifecycle notifications. */
export function onSessionLifecycleEvent(listener: SessionLifecycleListener): () => void {
  SESSION_LIFECYCLE_LISTENERS.add(listener);
  return () => {
    SESSION_LIFECYCLE_LISTENERS.delete(listener);
  };
}

/** Broadcast a session lifecycle notification to current in-process listeners. */
export function emitSessionLifecycleEvent(event: SessionLifecycleEvent): void {
  for (const listener of SESSION_LIFECYCLE_LISTENERS) {
    try {
      listener(event);
    } catch {
      // Best-effort, do not propagate listener errors.
    }
  }
}
