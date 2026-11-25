import { adaptLegacyMemoryProvider } from "./memory-provider-adapter.js";
import type { MemoryPluginRuntime, MemoryProviderRuntime } from "./registry-contribution-types.js";

/**
 * Presents a file-shaped memory runtime as a backend provider runtime. Opening goes through
 * the same legacy adapter the host uses when such a plugin owns the memory slot, so hit
 * authorization, references, and read limits are identical in both roles.
 */
export function createLegacyBackendProviderRuntime(
  pluginId: string,
  runtime: MemoryPluginRuntime,
): MemoryProviderRuntime {
  return {
    open: (params) => adaptLegacyMemoryProvider(runtime, pluginId, params),
    ...(runtime.prepareReload ? { prepareReload: runtime.prepareReload.bind(runtime) } : {}),
    ...(runtime.closeMemorySearchManager
      ? { closeMemorySearchManager: runtime.closeMemorySearchManager.bind(runtime) }
      : {}),
    ...(runtime.closeAllMemorySearchManagers
      ? { closeAllMemorySearchManagers: runtime.closeAllMemorySearchManagers.bind(runtime) }
      : {}),
  };
}
