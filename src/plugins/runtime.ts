import { createEmptyPluginRegistry } from "./registry-empty.js";
import type { PluginRegistry } from "./registry.js";

const REGISTRY_STATE = Symbol.for("openclaw.pluginRegistryState");

type RegistrySurfaceState = {
  registry: PluginRegistry | null;
  pinned: boolean;
  version: number;
};

type RegistryState = {
  activeRegistry: PluginRegistry | null;
  activeVersion: number;
  httpRoute: RegistrySurfaceState;
  channel: RegistrySurfaceState;
  key: string | null;
  keyParts: {
    pluginInputKey: string;
    scopeKey: string;
    setupOnlyKey: string;
    startupChannelMode: string;
    runtimeSubagentMode: string;
    pluginSdkResolution: string;
    gatewayMethodsKey: string;
  } | null;
};

const state: RegistryState = (() => {
  const globalState = globalThis as typeof globalThis & {
    [REGISTRY_STATE]?: RegistryState;
  };
  if (!globalState[REGISTRY_STATE]) {
    globalState[REGISTRY_STATE] = {
      activeRegistry: null,
      activeVersion: 0,
      httpRoute: {
        registry: null,
        pinned: false,
        version: 0,
      },
      channel: {
        registry: null,
        pinned: false,
        version: 0,
      },
      key: null,
      keyParts: null,
    };
  }
  return globalState[REGISTRY_STATE];
})();

function installSurfaceRegistry(
  surface: RegistrySurfaceState,
  registry: PluginRegistry | null,
  pinned: boolean,
) {
  if (surface.registry === registry && surface.pinned === pinned) {
    return;
  }
  surface.registry = registry;
  surface.pinned = pinned;
  surface.version += 1;
}

function syncTrackedSurface(
  surface: RegistrySurfaceState,
  registry: PluginRegistry | null,
  refreshVersion = false,
) {
  if (surface.pinned) {
    return;
  }
  if (surface.registry === registry && !surface.pinned) {
    if (refreshVersion) {
      surface.version += 1;
    }
    return;
  }
  installSurfaceRegistry(surface, registry, false);
}

export function setActivePluginRegistry(
  registry: PluginRegistry,
  cacheKey?: string,
  cacheKeyParts?: RegistryState["keyParts"],
) {
  state.activeRegistry = registry;
  state.activeVersion += 1;
  syncTrackedSurface(state.httpRoute, registry, true);
  syncTrackedSurface(state.channel, registry, true);
  state.key = cacheKey ?? null;
  state.keyParts = cacheKeyParts ?? null;
}

export function getActivePluginRegistry(): PluginRegistry | null {
  return state.activeRegistry;
}

export function requireActivePluginRegistry(): PluginRegistry {
  if (!state.activeRegistry) {
    state.activeRegistry = createEmptyPluginRegistry();
    state.activeVersion += 1;
    syncTrackedSurface(state.httpRoute, state.activeRegistry);
    syncTrackedSurface(state.channel, state.activeRegistry);
  }
  return state.activeRegistry;
}

export function pinActivePluginHttpRouteRegistry(registry: PluginRegistry) {
  installSurfaceRegistry(state.httpRoute, registry, true);
}

export function releasePinnedPluginHttpRouteRegistry(registry?: PluginRegistry) {
  if (registry && state.httpRoute.registry !== registry) {
    return;
  }
  installSurfaceRegistry(state.httpRoute, state.activeRegistry, false);
}

export function getActivePluginHttpRouteRegistry(): PluginRegistry | null {
  return state.httpRoute.registry ?? state.activeRegistry;
}

export function getActivePluginHttpRouteRegistryVersion(): number {
  return state.httpRoute.registry ? state.httpRoute.version : state.activeVersion;
}

export function requireActivePluginHttpRouteRegistry(): PluginRegistry {
  const existing = getActivePluginHttpRouteRegistry();
  if (existing) {
    return existing;
  }
  const created = requireActivePluginRegistry();
  installSurfaceRegistry(state.httpRoute, created, false);
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
  installSurfaceRegistry(state.channel, registry, true);
}

export function releasePinnedPluginChannelRegistry(registry?: PluginRegistry) {
  if (registry && state.channel.registry !== registry) {
    return;
  }
  installSurfaceRegistry(state.channel, state.activeRegistry, false);
}

/** Return the registry that should be used for channel plugin resolution.
 *  When pinned, this returns the startup registry regardless of subsequent
 *  `setActivePluginRegistry` calls. */
export function getActivePluginChannelRegistry(): PluginRegistry | null {
  return state.channel.registry ?? state.activeRegistry;
}

export function getActivePluginChannelRegistryVersion(): number {
  return state.channel.registry ? state.channel.version : state.activeVersion;
}

export function requireActivePluginChannelRegistry(): PluginRegistry {
  const existing = getActivePluginChannelRegistry();
  if (existing) {
    return existing;
  }
  const created = requireActivePluginRegistry();
  installSurfaceRegistry(state.channel, created, false);
  return created;
}

export function getActivePluginRegistryKey(): string | null {
  return state.key;
}

export function getActivePluginRegistryKeyParts(): RegistryState["keyParts"] {
  return state.keyParts;
}

export function getActivePluginRegistryVersion(): number {
  return state.activeVersion;
}

export function resetPluginRuntimeStateForTest(): void {
  state.activeRegistry = null;
  state.activeVersion += 1;
  installSurfaceRegistry(state.httpRoute, null, false);
  installSurfaceRegistry(state.channel, null, false);
  state.key = null;
  state.keyParts = null;
}
