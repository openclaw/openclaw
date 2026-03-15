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
  const prev = state.registry;
  // Merge dynamically registered plugin HTTP routes (e.g. BlueBubbles webhook)
  // so they survive registry replacements from late loadOpenClawPlugins() calls.
  if (prev && prev !== registry && prev.httpRoutes?.length) {
    const newPaths = new Set((registry.httpRoutes ?? []).map((r) => `${r.path}::${r.match}`));
    const missing = prev.httpRoutes.filter((r) => !newPaths.has(`${r.path}::${r.match}`));
    if (missing.length > 0) {
      registry.httpRoutes = [...missing, ...(registry.httpRoutes ?? [])];
    }
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
