// Runtime store exports expose plugin runtime type contracts without loading runtime code.
import { getPluginRegistryForContext } from "../plugins/runtime/gateway-request-scope.js";
import {
  getNamedPluginRuntimeStoreSlot,
  getScopedPluginRuntimeStoreSlot,
} from "./runtime-store-registry.js";
export type { PluginRuntime } from "../plugins/runtime/types.js";
type PluginRuntimeStoreKeyOptions = {
  /** Explicit global registry key for shared runtime slots. */
  key: string;
  /** Error thrown by getRuntime before setRuntime initializes this slot. */
  errorMessage: string;
};
type PluginRuntimeStorePluginOptions = {
  /** Plugin id used to derive a stable cross-module runtime slot key. */
  pluginId: string;
  /** Error thrown by getRuntime before setRuntime initializes this slot. */
  errorMessage: string;
};
type PluginRuntimeStoreOptions = PluginRuntimeStoreKeyOptions | PluginRuntimeStorePluginOptions;

function pluginRuntimeStoreKeyForPluginId(pluginId: string): string {
  const normalizedPluginId = pluginId.trim();
  if (!normalizedPluginId) {
    throw new Error("createPluginRuntimeStore: pluginId must not be empty");
  }
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

/**
 * Create an owner-local runtime slot that throws when accessed before initialization.
 *
 * String keys create isolated module-local stores; option objects create global
 * named slots so duplicate SDK module instances share the same plugin runtime.
 * Plugin-id slots follow the current registration/request/active registry; explicit
 * keys retain process-local ownership.
 */
export function createPluginRuntimeStore<T>(errorMessage: string): {
  setRuntime: (next: T) => void;
  clearRuntime: () => void;
  tryGetRuntime: () => T | null;
  getRuntime: () => T;
};
/** Share a runtime within its plugin registry, or process-wide for an explicit key. */
export function createPluginRuntimeStore<T>(options: PluginRuntimeStoreOptions): {
  setRuntime: (next: T) => void;
  clearRuntime: () => void;
  tryGetRuntime: () => T | null;
  getRuntime: () => T;
};
/** Implementation overload accepting either legacy error-message strings or structured options. */
export function createPluginRuntimeStore<T>(options: string | PluginRuntimeStoreOptions): {
  setRuntime: (next: T) => void;
  clearRuntime: () => void;
  tryGetRuntime: () => T | null;
  getRuntime: () => T;
} {
  const resolved = resolvePluginRuntimeStoreOptions(options);
  const namedSlot =
    typeof options === "string" ? undefined : getNamedPluginRuntimeStoreSlot(resolved.key);
  const standaloneSlot = namedSlot ?? { runtime: null };
  const resolveSlot = () => {
    const registry =
      typeof options !== "string" && "pluginId" in options ? getPluginRegistryForContext() : null;
    return registry && namedSlot
      ? getScopedPluginRuntimeStoreSlot(namedSlot, registry)
      : standaloneSlot;
  };

  return {
    setRuntime(next: T) {
      resolveSlot().runtime = next;
      // Standalone CLI callbacks have no registry scope. Preserve their existing
      // last-registration slot; owned calls never fall back to this value.
      standaloneSlot.runtime = next;
    },
    clearRuntime() {
      resolveSlot().runtime = null;
      standaloneSlot.runtime = null;
    },
    tryGetRuntime() {
      return (resolveSlot().runtime as T | null) ?? null;
    },
    getRuntime() {
      const slot = resolveSlot();
      if (slot.runtime === null) {
        throw new Error(resolved.errorMessage);
      }
      return slot.runtime as T;
    },
  };
}
