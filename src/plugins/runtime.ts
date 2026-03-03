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
