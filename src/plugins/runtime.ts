import { createEmptyPluginRegistry, type PluginRegistry } from "./registry.js";

const REGISTRY_STATE = Symbol.for("openclaw.pluginRegistryState");

type RegistryState = {
  registry: PluginRegistry | null;
  key: string | null;
  version: number;
};

// Global pool to track all registries (fixes ESM/CJS module separation issue)
const REGISTRY_POOL: Map<string, PluginRegistry> | null = null;

function getRegistryPool(): Map<string, PluginRegistry> {
  const globalState = globalThis as typeof globalThis & {
    __openclaw_registry_pool?: Map<string, PluginRegistry>;
  };
  if (!globalState.__openclaw_registry_pool) {
    globalState.__openclaw_registry_pool = new Map();
  }
  return globalState.__openclaw_registry_pool;
}

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
  // Track in global pool for cross-module access
  const pool = getRegistryPool();
  const poolKey = cacheKey ?? "default";
  pool.set(poolKey, registry);
  // Also track by object identity for debugging
  pool.set(`oid:${registry}`, registry);
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

// Get all registries from the global pool (for aggregating httpRoutes across modules)
export function getAllRegistries(): PluginRegistry[] {
  return Array.from(getRegistryPool().values());
}

export function getActivePluginRegistryKey(): string | null {
  return state.key;
}

export function getActivePluginRegistryVersion(): number {
  return state.version;
}
