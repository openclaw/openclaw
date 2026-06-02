export type { PluginRuntime } from "../plugins/runtime/types.js";

const pluginRuntimeStoreRegistryKey = Symbol.for("openclaw.plugin-sdk.runtime-store-registry");

type PluginRuntimeStoreRegistry = Map<string, { runtime: unknown }>;

/** Store options for a process-shared runtime slot with a caller-defined key. */
type PluginRuntimeStoreKeyOptions = {
  /** Explicit shared slot key for advanced runtimes that are not keyed by plugin id. */
  key: string;
  /** Error thrown by `getRuntime` before the host binds the runtime. */
  errorMessage: string;
};

/** Store options for the common plugin-scoped runtime slot. */
type PluginRuntimeStorePluginOptions = {
  /** Plugin id used to share the runtime slot across duplicate module instances. */
  pluginId: string;
  /** Error thrown by `getRuntime` before the host binds the runtime. */
  errorMessage: string;
};

/** Runtime store configuration accepted by the public SDK helper. */
type PluginRuntimeStoreOptions = PluginRuntimeStoreKeyOptions | PluginRuntimeStorePluginOptions;

function getPluginRuntimeStoreRegistry(): PluginRuntimeStoreRegistry {
  const globalRecord = globalThis as typeof globalThis & {
    [pluginRuntimeStoreRegistryKey]?: PluginRuntimeStoreRegistry;
  };
  // Runtime modules can be imported through both source and generated facade paths; Symbol.for
  // keeps plugin-id stores shared across those duplicate module instances in one process.
  globalRecord[pluginRuntimeStoreRegistryKey] ??= new Map();
  return globalRecord[pluginRuntimeStoreRegistryKey];
}

function pluginRuntimeStoreKeyForPluginId(pluginId: string): string {
  const normalizedPluginId = pluginId.trim();
  if (!normalizedPluginId) {
    throw new Error("createPluginRuntimeStore: pluginId must not be empty");
  }
  // Prefix plugin-derived keys so a plugin id cannot collide with a custom
  // process-wide slot used by an advanced runtime facade.
  return `plugin-runtime:${normalizedPluginId}`;
}

function resolvePluginRuntimeStoreOptions(
  options: string | PluginRuntimeStoreOptions,
): PluginRuntimeStoreKeyOptions {
  if (typeof options === "string") {
    return { key: options, errorMessage: options };
  }
  if ("pluginId" in options) {
    return {
      key: pluginRuntimeStoreKeyForPluginId(options.pluginId),
      errorMessage: options.errorMessage,
    };
  }
  return options;
}

/** Create a tiny mutable runtime slot with strict access when the runtime has not been initialized. */
export function createPluginRuntimeStore<T>(errorMessage: string): {
  /** Bind or replace the current runtime instance. */
  setRuntime: (next: T) => void;
  /** Clear the runtime slot during tests or plugin teardown. */
  clearRuntime: () => void;
  /** Return null when no runtime is bound instead of throwing. */
  tryGetRuntime: () => T | null;
  /** Return the bound runtime or throw the configured initialization error. */
  getRuntime: () => T;
};
export function createPluginRuntimeStore<T>(options: PluginRuntimeStoreOptions): {
  /** Bind or replace the current runtime instance. */
  setRuntime: (next: T) => void;
  /** Clear the runtime slot during tests or plugin teardown. */
  clearRuntime: () => void;
  /** Return null when no runtime is bound instead of throwing. */
  tryGetRuntime: () => T | null;
  /** Return the bound runtime or throw the configured initialization error. */
  getRuntime: () => T;
};
export function createPluginRuntimeStore<T>(options: string | PluginRuntimeStoreOptions): {
  setRuntime: (next: T) => void;
  clearRuntime: () => void;
  tryGetRuntime: () => T | null;
  getRuntime: () => T;
} {
  const resolved = resolvePluginRuntimeStoreOptions(options);
  const slot =
    typeof options === "string"
      ? { runtime: null }
      : (() => {
          // Object slots live in the global registry so source imports and
          // generated facade imports bind the same plugin runtime instance.
          const registry = getPluginRuntimeStoreRegistry();
          let existingSlot = registry.get(resolved.key);
          if (!existingSlot) {
            existingSlot = { runtime: null };
            registry.set(resolved.key, existingSlot);
          }
          return existingSlot;
        })();

  return {
    setRuntime(next: T) {
      slot.runtime = next;
    },
    clearRuntime() {
      slot.runtime = null;
    },
    tryGetRuntime() {
      return (slot.runtime as T | null) ?? null;
    },
    getRuntime() {
      if (slot.runtime === null) {
        throw new Error(resolved.errorMessage);
      }
      return slot.runtime as T;
    },
  };
}
