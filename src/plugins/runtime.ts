import { createEmptyPluginRegistry } from "./registry-empty.js";
import type { PluginRegistry } from "./registry.js";

const REGISTRY_STATE = Symbol.for("openclaw.pluginRegistryState");

type RegistryState = {
  registry: PluginRegistry | null;
  httpRouteRegistry: PluginRegistry | null;
  httpRouteRegistryPinned: boolean;
  channelRegistry: PluginRegistry | null;
  channelRegistryPinned: boolean;
  key: string | null;
  version: number;
};

const state: RegistryState = (() => {
  const globalState = globalThis as typeof globalThis & {
    [REGISTRY_STATE]?: RegistryState;
  };
  if (!globalState[REGISTRY_STATE]) {
    globalState[REGISTRY_STATE] = {
      registry: null,
      httpRouteRegistry: null,
      httpRouteRegistryPinned: false,
      channelRegistry: null,
      channelRegistryPinned: false,
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
  if (!state.channelRegistryPinned) {
    state.channelRegistry = registry;
  }
  state.key = cacheKey ?? null;
  state.version += 1;
}

export function getActivePluginRegistry(): PluginRegistry | null {
  return state.registry;
}

export function requireActivePluginRegistry(): PluginRegistry {
  if (!state.registry) {
    state.registry = createEmptyPluginRegistry();
    if (!state.httpRouteRegistryPinned) {
      state.httpRouteRegistry = state.registry;
    }
    if (!state.channelRegistryPinned) {
      state.channelRegistry = state.registry;
    }
    state.version += 1;
  }
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

/** Pin the channel registry so that subsequent `setActivePluginRegistry` calls
 *  do not replace the channel snapshot used by `getChannelPlugin`. Call at
 *  gateway startup after the initial plugin load so that config-schema reads
 *  and other non-primary registry loads cannot evict channel plugins. */
export function pinActivePluginChannelRegistry(registry: PluginRegistry) {
  state.channelRegistry = registry;
  state.channelRegistryPinned = true;
}

export function releasePinnedPluginChannelRegistry(registry?: PluginRegistry) {
  if (registry && state.channelRegistry !== registry) {
    return;
  }
  state.channelRegistryPinned = false;
  state.channelRegistry = state.registry;
}

/** Return the registry that should be used for channel plugin resolution.
 *  When pinned, this returns the startup registry regardless of subsequent
 *  `setActivePluginRegistry` calls. */
export function getActivePluginChannelRegistry(): PluginRegistry | null {
  return state.channelRegistry ?? state.registry;
}

export function requireActivePluginChannelRegistry(): PluginRegistry {
  const existing = getActivePluginChannelRegistry();
  if (existing) {
    return existing;
  }
  const created = requireActivePluginRegistry();
  state.channelRegistry = created;
  return created;
}

export function getActivePluginRegistryKey(): string | null {
  return state.key;
}

export function getActivePluginRegistryVersion(): number {
  return state.version;
}

export function resetPluginRuntimeStateForTest(): void {
  state.registry = null;
  state.httpRouteRegistry = null;
  state.httpRouteRegistryPinned = false;
  state.channelRegistry = null;
  state.channelRegistryPinned = false;
  state.key = null;
  state.version += 1;
}
