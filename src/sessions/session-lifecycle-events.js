const SESSION_LIFECYCLE_LISTENERS = new Set();
export function onSessionLifecycleEvent(listener) {
    SESSION_LIFECYCLE_LISTENERS.add(listener);
    return () => {
        SESSION_LIFECYCLE_LISTENERS.delete(listener);
    };
}
export function emitSessionLifecycleEvent(event) {
    for (const listener of SESSION_LIFECYCLE_LISTENERS) {
        try {
            listener(event);
        }
        catch {
            // Best-effort, do not propagate listener errors.
        }
    }
}
