import { createEmptyPluginRegistry, type PluginRegistry } from "./registry.js";

const REGISTRY_STATE = Symbol.for("openclaw.pluginRegistryState");

type RegistryState = {
  registry: PluginRegistry | null;
  key: string | null;
};

const state: RegistryState = (() => {
  const globalState = globalThis as typeof globalThis & {
    [REGISTRY_STATE]?: RegistryState;
  };
  if (!globalState[REGISTRY_STATE]) {
    globalState[REGISTRY_STATE] = {
      registry: createEmptyPluginRegistry(),
      key: null,
    };
  }
  return globalState[REGISTRY_STATE];
})();

export function setActivePluginRegistry(registry: PluginRegistry, cacheKey?: string) {
  const prev = state.registry;
  // Carry forward any HTTP routes registered on the outgoing registry so
  // they are not silently lost when a new registry is activated (e.g. by
  // config validation or periodic plugin reloads).  Routes are copied
  // individually rather than sharing the array reference so that a later
  // unregister call (which splices from the old array) does not remove the
  // route from the new registry.
  if (prev && prev !== registry && prev.httpRoutes) {
    const target = registry.httpRoutes ?? [];
    for (const route of prev.httpRoutes) {
      if (!target.some((r) => r.path === route.path)) {
        target.push(route);
      }
    }
    registry.httpRoutes = target;
  }
  state.registry = registry;
  state.key = cacheKey ?? null;
}

export function getActivePluginRegistry(): PluginRegistry | null {
  return state.registry;
}

export function requireActivePluginRegistry(): PluginRegistry {
  if (!state.registry) {
    state.registry = createEmptyPluginRegistry();
  }
  return state.registry;
}

export function getActivePluginRegistryKey(): string | null {
  return state.key;
}
