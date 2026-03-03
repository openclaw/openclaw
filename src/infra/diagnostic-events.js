function getDiagnosticEventsState() {
    const globalStore = globalThis;
    if (!globalStore.__openclawDiagnosticEventsState) {
        globalStore.__openclawDiagnosticEventsState = {
            seq: 0,
            listeners: new Set(),
            dispatchDepth: 0,
        };
    }
    return globalStore.__openclawDiagnosticEventsState;
}
export function isDiagnosticsEnabled(config) {
    return config?.diagnostics?.enabled === true;
}
export function emitDiagnosticEvent(event) {
    const state = getDiagnosticEventsState();
    if (state.dispatchDepth > 100) {
        console.error(`[diagnostic-events] recursion guard tripped at depth=${state.dispatchDepth}, dropping type=${event.type}`);
        return;
    }
    const enriched = {
        ...event,
        seq: (state.seq += 1),
        ts: Date.now(),
    };
    state.dispatchDepth += 1;
    for (const listener of state.listeners) {
        try {
            listener(enriched);
        }
        catch (err) {
            const errorMessage = err instanceof Error
                ? (err.stack ?? err.message)
                : typeof err === "string"
                    ? err
                    : String(err);
            console.error(`[diagnostic-events] listener error type=${enriched.type} seq=${enriched.seq}: ${errorMessage}`);
            // Ignore listener failures.
        }
    }
    state.dispatchDepth -= 1;
}
export function onDiagnosticEvent(listener) {
    const state = getDiagnosticEventsState();
    state.listeners.add(listener);
    return () => {
        state.listeners.delete(listener);
    };
}
export function resetDiagnosticEventsForTest() {
    const state = getDiagnosticEventsState();
    state.seq = 0;
    state.listeners.clear();
    state.dispatchDepth = 0;
}
