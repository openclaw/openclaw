export function notifyListeners(listeners, event, onError) {
    for (const listener of listeners) {
        try {
            listener(event);
        }
        catch (error) {
            onError?.(error);
        }
    }
}
export function registerListener(listeners, listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
}
