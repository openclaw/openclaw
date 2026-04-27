import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { notifyListeners, registerListener } from "../shared/listeners.js";
export function resolveIndicatorType(status) {
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
    throw new Error("Unsupported heartbeat status");
}
const HEARTBEAT_EVENT_STATE_KEY = Symbol.for("openclaw.heartbeatEvents.state");
const state = resolveGlobalSingleton(HEARTBEAT_EVENT_STATE_KEY, () => ({
    lastHeartbeat: null,
    listeners: new Set(),
}));
export function emitHeartbeatEvent(evt) {
    const enriched = { ts: Date.now(), ...evt };
    state.lastHeartbeat = enriched;
    notifyListeners(state.listeners, enriched);
}
export function onHeartbeatEvent(listener) {
    return registerListener(state.listeners, listener);
}
export function getLastHeartbeatEvent() {
    return state.lastHeartbeat;
}
export function resetHeartbeatEventsForTest() {
    state.lastHeartbeat = null;
    state.listeners.clear();
}
