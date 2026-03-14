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

// The gateway's HTTP request handler captures a registry object by reference at
// creation time. When the build system duplicates the registry singleton across
// chunk boundaries, `requireActivePluginRegistry()` in a plugin-sdk chunk may
// return a different object than the one the handler captured. This dedicated
// global ensures `registerPluginHttpRoute` always targets the gateway's registry.
const GATEWAY_REGISTRY = Symbol.for("openclaw.gatewayPluginRegistry");

export function setGatewayPluginRegistry(registry: PluginRegistry): void {
  (globalThis as Record<symbol, unknown>)[GATEWAY_REGISTRY] = registry;
}

export function getGatewayPluginRegistry(): PluginRegistry | null {
  return ((globalThis as Record<symbol, unknown>)[GATEWAY_REGISTRY] as PluginRegistry) ?? null;
}
