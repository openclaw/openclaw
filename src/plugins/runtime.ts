import { createEmptyPluginRegistry } from "./registry-empty.js";
import type { PluginRegistry } from "./registry.js";

export type CapabilityFilter<T extends string> = (cap: string) => cap is T;

export type PluginProviderEntry = {
  id: string;
  routingCapabilities?: string[];
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
    // Guard against object-shaped capabilities (e.g., { providerFamily: "openai" })
    const caps = p.routingCapabilities;
    const capabilitiesArray = Array.isArray(caps) ? caps : [];
    const hasCapability = capabilitiesArray.some(capabilityFilter);
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
  httpRouteRegistry: PluginRegistry | null;
  httpRouteRegistryPinned: boolean;
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
      httpRouteRegistry: null,
      httpRouteRegistryPinned: false,
      key: null,
      version: 0,
    };
  }
  return globalState[REGISTRY_STATE];
})();

export function setActivePluginRegistry(registry: PluginRegistry, cacheKey?: string) {
  state.registry = registry;
  if (!state.httpRouteRegistryPinned) {
    state.httpRouteRegistry = registry;
  }
  state.key = cacheKey ?? null;
  state.version += 1;
}

export function requireActivePluginRegistry(): PluginRegistry {
  if (!state.registry) {
    state.registry = createEmptyPluginRegistry();
    if (!state.httpRouteRegistryPinned) {
      state.httpRouteRegistry = state.registry;
    }
    state.version += 1;
  }
  return state.registry;
}

export function getActivePluginRegistry(): PluginRegistry | null {
  return state.registry;
}

export function pinActivePluginHttpRouteRegistry(registry: PluginRegistry) {
  state.httpRouteRegistry = registry;
  state.httpRouteRegistryPinned = true;
}

export function releasePinnedPluginHttpRouteRegistry(registry?: PluginRegistry) {
  if (registry && state.httpRouteRegistry !== registry) {
    return;
  }
  state.httpRouteRegistryPinned = false;
  state.httpRouteRegistry = state.registry;
}

export function getActivePluginHttpRouteRegistry(): PluginRegistry | null {
  return state.httpRouteRegistry ?? state.registry;
}

export function requireActivePluginHttpRouteRegistry(): PluginRegistry {
  const existing = getActivePluginHttpRouteRegistry();
  if (existing) {
    return existing;
  }
  const created = requireActivePluginRegistry();
  state.httpRouteRegistry = created;
  return created;
}

export function resolveActivePluginHttpRouteRegistry(fallback: PluginRegistry): PluginRegistry {
  const routeRegistry = getActivePluginHttpRouteRegistry();
  if (!routeRegistry) {
    return fallback;
  }
  const routeCount = routeRegistry.httpRoutes?.length ?? 0;
  const fallbackRouteCount = fallback.httpRoutes?.length ?? 0;
  if (routeCount === 0 && fallbackRouteCount > 0) {
    return fallback;
  }
  return routeRegistry;
}

export function getActivePluginRegistryKey(): string | null {
  return state.key;
}

export function getActivePluginRegistryVersion(): number {
  return state.version;
}

export function resetPluginRuntimeStateForTest(): void {
  const emptyRegistry = createEmptyPluginRegistry();
  state.registry = emptyRegistry;
  state.httpRouteRegistry = emptyRegistry;
  state.httpRouteRegistryPinned = false;
  state.key = null;
  state.version += 1;
}
