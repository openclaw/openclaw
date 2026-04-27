import { formatDiagnosticTraceparent, } from "./diagnostic-trace-context.js";
import { isBlockedObjectKey } from "./prototype-keys.js";
const MAX_ASYNC_DIAGNOSTIC_EVENTS = 10_000;
const DIAGNOSTIC_EVENTS_STATE_KEY = Symbol.for("openclaw.diagnosticEvents.state.v1");
const dispatchedTrustedDiagnosticMetadata = new WeakSet();
const ASYNC_DIAGNOSTIC_EVENT_TYPES = new Set([
    "tool.execution.started",
    "tool.execution.completed",
    "tool.execution.error",
    "exec.process.completed",
    "message.delivery.started",
    "message.delivery.completed",
    "message.delivery.error",
    "model.call.started",
    "model.call.completed",
    "model.call.error",
    "context.assembled",
    "log.record",
]);
function createDiagnosticEventsState() {
    return {
        marker: DIAGNOSTIC_EVENTS_STATE_KEY,
        enabled: true,
        seq: 0,
        listeners: new Set(),
        dispatchDepth: 0,
        asyncQueue: [],
        asyncDrainScheduled: false,
    };
}
function isDiagnosticEventsState(value) {
    if (!value || typeof value !== "object") {
        return false;
    }
    const candidate = value;
    return (candidate.marker === DIAGNOSTIC_EVENTS_STATE_KEY &&
        typeof candidate.enabled === "boolean" &&
        typeof candidate.seq === "number" &&
        candidate.listeners instanceof Set &&
        typeof candidate.dispatchDepth === "number" &&
        Array.isArray(candidate.asyncQueue) &&
        typeof candidate.asyncDrainScheduled === "boolean");
}
function getDiagnosticEventsState() {
    const globalRecord = globalThis;
    const existing = globalRecord[DIAGNOSTIC_EVENTS_STATE_KEY];
    if (isDiagnosticEventsState(existing)) {
        return existing;
    }
    const state = createDiagnosticEventsState();
    Object.defineProperty(globalThis, DIAGNOSTIC_EVENTS_STATE_KEY, {
        configurable: true,
        enumerable: false,
        value: state,
        writable: false,
    });
    return state;
}
export function isDiagnosticsEnabled(config) {
    return config?.diagnostics?.enabled !== false;
}
export function setDiagnosticsEnabledForProcess(enabled) {
    getDiagnosticEventsState().enabled = enabled;
}
export function areDiagnosticsEnabledForProcess() {
    return getDiagnosticEventsState().enabled;
}
function dispatchDiagnosticEvent(state, enriched, metadata) {
    if (state.dispatchDepth > 100) {
        console.error(`[diagnostic-events] recursion guard tripped at depth=${state.dispatchDepth}, dropping type=${enriched.type}`);
        return;
    }
    state.dispatchDepth += 1;
    try {
        for (const listener of state.listeners) {
            try {
                listener(cloneDiagnosticEventForListener(enriched), createDiagnosticMetadataForListener(metadata));
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
    }
    finally {
        state.dispatchDepth -= 1;
    }
}
function createDiagnosticMetadataForListener(metadata) {
    const listenerMetadata = Object.freeze({ ...metadata });
    if (listenerMetadata.trusted) {
        dispatchedTrustedDiagnosticMetadata.add(listenerMetadata);
    }
    return listenerMetadata;
}
function cloneDiagnosticEventForListener(event) {
    return deepFreezeDiagnosticValue(structuredClone(event));
}
function deepFreezeDiagnosticValue(value, seen = new WeakSet()) {
    if (!value || typeof value !== "object") {
        return value;
    }
    if (seen.has(value)) {
        return value;
    }
    seen.add(value);
    if (Array.isArray(value)) {
        for (const item of value) {
            deepFreezeDiagnosticValue(item, seen);
        }
        return Object.freeze(value);
    }
    for (const nested of Object.values(value)) {
        deepFreezeDiagnosticValue(nested, seen);
    }
    return Object.freeze(value);
}
function scheduleAsyncDiagnosticDrain(state) {
    if (state.asyncDrainScheduled) {
        return;
    }
    state.asyncDrainScheduled = true;
    setImmediate(() => {
        state.asyncDrainScheduled = false;
        const batch = state.asyncQueue.splice(0);
        for (const entry of batch) {
            dispatchDiagnosticEvent(state, entry.event, entry.metadata);
        }
        if (state.asyncQueue.length > 0) {
            scheduleAsyncDiagnosticDrain(state);
        }
    });
}
function enrichDiagnosticEvent(state, event) {
    const enriched = {};
    for (const [key, value] of Object.entries(event)) {
        if (isBlockedObjectKey(key)) {
            continue;
        }
        enriched[key] = value;
    }
    state.seq += 1;
    enriched.seq = state.seq;
    enriched.ts = Date.now();
    return enriched;
}
function emitDiagnosticEventWithTrust(event, trusted) {
    const state = getDiagnosticEventsState();
    if (!state.enabled) {
        return;
    }
    const enriched = enrichDiagnosticEvent(state, event);
    const metadata = { trusted };
    if (ASYNC_DIAGNOSTIC_EVENT_TYPES.has(enriched.type)) {
        if (state.asyncQueue.length >= MAX_ASYNC_DIAGNOSTIC_EVENTS) {
            return;
        }
        state.asyncQueue.push({ event: enriched, metadata });
        scheduleAsyncDiagnosticDrain(state);
        return;
    }
    dispatchDiagnosticEvent(state, enriched, metadata);
}
export function emitDiagnosticEvent(event) {
    emitDiagnosticEventWithTrust(event, false);
}
export function emitTrustedDiagnosticEvent(event) {
    emitDiagnosticEventWithTrust(event, true);
}
export function onInternalDiagnosticEvent(listener) {
    const state = getDiagnosticEventsState();
    state.listeners.add(listener);
    return () => {
        state.listeners.delete(listener);
    };
}
export function onDiagnosticEvent(listener) {
    return onInternalDiagnosticEvent((event, metadata) => {
        if (metadata.trusted || event.type === "log.record") {
            return;
        }
        listener(event);
    });
}
export function formatDiagnosticTraceparentForPropagation(event, metadata) {
    if (!metadata.trusted || !dispatchedTrustedDiagnosticMetadata.has(metadata)) {
        return undefined;
    }
    return formatDiagnosticTraceparent(event.trace);
}
export function resetDiagnosticEventsForTest() {
    const state = getDiagnosticEventsState();
    state.enabled = true;
    state.seq = 0;
    state.listeners.clear();
    state.dispatchDepth = 0;
    state.asyncQueue = [];
    state.asyncDrainScheduled = false;
}
