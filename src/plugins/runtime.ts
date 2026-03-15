import { createEmptyPluginRegistry, type PluginRegistry } from "./registry.js";

const REGISTRY_STATE = Symbol.for("openclaw.pluginRegistryState");

type RegistryState = {
  registry: PluginRegistry | null;
  key: string | null;
  version: number;
};

const state: RegistryState = (() => {
  const globalState = globalThis as typeof globalThis & {
    [REGISTRY_STATE]?: RegistryState;
  };
  if (!globalState[REGISTRY_STATE]) {
    globalState[REGISTRY_STATE] = {
      registry: createEmptyPluginRegistry(),
      key: null,
      version: 0,
    };
  }
  return globalState[REGISTRY_STATE];
})();

export function setActivePluginRegistry(registry: PluginRegistry, cacheKey?: string) {
  // Preserve the httpRoutes reference across registry replacements. Channel plugins
  // (e.g. BlueBubbles) register webhook routes into the active registry's httpRoutes
  // during channel startup. The per-agent plugin loader replaces the registry with a
  // fresh one, but channels are not re-started, so their routes would be lost.
  // By sharing the same httpRoutes array, channel-registered routes survive loader cycles.
  // When a channel is disabled and its provider stops, it calls its own unregister()
  // teardown which removes its entries from this shared array.
  const prevRoutes = state.registry?.httpRoutes;
  if (
    prevRoutes &&
    prevRoutes.length > 0 &&
    (!registry.httpRoutes || registry.httpRoutes.length === 0)
  ) {
    registry = { ...registry, httpRoutes: prevRoutes };
  }
  state.registry = registry;
  state.key = cacheKey ?? null;
  state.version += 1;
}

export function getActivePluginRegistry(): PluginRegistry | null {
  return state.registry;
}

export function requireActivePluginRegistry(): PluginRegistry {
  if (!state.registry) {
    state.registry = createEmptyPluginRegistry();
    state.version += 1;
  }
  return state.registry;
}

export function getActivePluginRegistryKey(): string | null {
  return state.key;
}

export function getActivePluginRegistryVersion(): number {
  return state.version;
}
