import { createEmptyPluginRegistry } from "./registry.js";
const REGISTRY_STATE = Symbol.for("openclaw.pluginRegistryState");
const state = (() => {
    const globalState = globalThis;
    if (!globalState[REGISTRY_STATE]) {
        globalState[REGISTRY_STATE] = {
            registry: createEmptyPluginRegistry(),
            key: null,
        };
    }
    return globalState[REGISTRY_STATE];
})();
export function setActivePluginRegistry(registry, cacheKey) {
    state.registry = registry;
    state.key = cacheKey ?? null;
}
export function getActivePluginRegistry() {
    return state.registry;
}
export function requireActivePluginRegistry() {
    if (!state.registry) {
        state.registry = createEmptyPluginRegistry();
    }
    return state.registry;
}
export function getActivePluginRegistryKey() {
    return state.key;
}
