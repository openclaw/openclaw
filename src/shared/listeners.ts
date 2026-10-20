/** Notifies every registered listener while isolating individual listener failures. */
export function notifyListeners<T>(
  listeners: Iterable<(event: T) => void>,
  event: T,
  onError?: (error: unknown) => void,
): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch (error) {
      onError?.(error);
    }
  }
}

/** Registers a listener in a Set and returns an idempotent unsubscribe handle. */
export function registerListener<T>(
  listeners: Set<(event: T) => void>,
  listener: (event: T) => void,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Synchronous owner changes preserve live Set iteration and propagate listener errors. */
export function createChangeListeners() {
  const listeners = new Set<() => void>();
  return {
    subscribe: (listener: () => void) => registerListener(listeners, listener),
    publish: () => {
      for (const listener of listeners) {
        listener();
      }
    },
    clear: () => listeners.clear(),
  };
}
