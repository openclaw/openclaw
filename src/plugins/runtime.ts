import { createEmptyPluginRegistry, type PluginRegistry } from "./registry.js";

export type CapabilityFilter<T extends string> = (cap: string) => cap is T;

export type PluginProviderEntry = {
  id: string;
  capabilities?: string[];
  [key: string]: unknown;
};

export type ProviderMapper<T> = (provider: PluginProviderEntry) => T | undefined;

export function getPluginProvidersByCapability<T extends { id: string }>(
  capabilityFilter: CapabilityFilter<string>,
  mapper: ProviderMapper<T>,
): Record<string, T> {
  const registry = getActivePluginRegistry();
  if (!registry) {
    return {};
  }

  const providers: Record<string, T> = {};
  for (const entry of registry.providers) {
    const p = entry.provider;
    const hasCapability = p.capabilities?.some(capabilityFilter) ?? false;
    if (!hasCapability) {
      continue;
    }
    const mapped = mapper(p);
    if (mapped) {
      providers[mapped.id] = mapped;
    }
  }
  return providers;
}

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
