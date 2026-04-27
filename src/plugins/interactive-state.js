import { resolveGlobalDedupeCache } from "../infra/dedupe.js";
const PLUGIN_INTERACTIVE_STATE_KEY = Symbol.for("openclaw.pluginInteractiveState");
const PLUGIN_INTERACTIVE_CALLBACK_DEDUPE_KEY = Symbol.for("openclaw.pluginInteractiveCallbackDedupe");
function createInteractiveCallbackDedupe() {
    return resolveGlobalDedupeCache(PLUGIN_INTERACTIVE_CALLBACK_DEDUPE_KEY, {
        ttlMs: 5 * 60_000,
        maxSize: 4096,
    });
}
function createInteractiveState() {
    return {
        interactiveHandlers: new Map(),
        callbackDedupe: createInteractiveCallbackDedupe(),
        inflightCallbackDedupe: new Set(),
    };
}
function hydrateInteractiveState(value) {
    const state = typeof value === "object" && value !== null
        ? value
        : {};
    return {
        interactiveHandlers: state.interactiveHandlers instanceof Map
            ? state.interactiveHandlers
            : new Map(),
        callbackDedupe: createInteractiveCallbackDedupe(),
        inflightCallbackDedupe: state.inflightCallbackDedupe instanceof Set
            ? state.inflightCallbackDedupe
            : new Set(),
    };
}
function getState() {
    const globalStore = globalThis;
    const existing = globalStore[PLUGIN_INTERACTIVE_STATE_KEY];
    if (existing !== undefined) {
        const hydrated = hydrateInteractiveState(existing);
        globalStore[PLUGIN_INTERACTIVE_STATE_KEY] = hydrated;
        return hydrated;
    }
    const created = createInteractiveState();
    globalStore[PLUGIN_INTERACTIVE_STATE_KEY] = created;
    return created;
}
export function getPluginInteractiveHandlersState() {
    return getState().interactiveHandlers;
}
export function getPluginInteractiveCallbackDedupeState() {
    return getState().callbackDedupe;
}
export function claimPluginInteractiveCallbackDedupe(dedupeKey, now = Date.now()) {
    if (!dedupeKey) {
        return true;
    }
    const state = getState();
    if (state.inflightCallbackDedupe.has(dedupeKey) || state.callbackDedupe.peek(dedupeKey, now)) {
        return false;
    }
    state.inflightCallbackDedupe.add(dedupeKey);
    return true;
}
export function commitPluginInteractiveCallbackDedupe(dedupeKey, now = Date.now()) {
    if (!dedupeKey) {
        return;
    }
    const state = getState();
    state.inflightCallbackDedupe.delete(dedupeKey);
    state.callbackDedupe.check(dedupeKey, now);
}
export function releasePluginInteractiveCallbackDedupe(dedupeKey) {
    if (!dedupeKey) {
        return;
    }
    getState().inflightCallbackDedupe.delete(dedupeKey);
}
export function clearPluginInteractiveHandlersState() {
    clearPluginInteractiveHandlerRegistrationsState();
    getPluginInteractiveCallbackDedupeState().clear();
    getState().inflightCallbackDedupe.clear();
}
export function clearPluginInteractiveHandlerRegistrationsState() {
    getPluginInteractiveHandlersState().clear();
}
