import { createPluginRegistry } from "./registry.js";
import type { PluginRuntime } from "./runtime/types.js";

export function createTestPluginRegistry(
  runtime: PluginRuntime = {} as PluginRuntime,
): ReturnType<typeof createPluginRegistry> {
  return createPluginRegistry({
    logger: {
      info() {},
      warn() {},
      error() {},
      debug() {},
    },
    runtime,
    activateGlobalSideEffects: false,
  });
}

export function createRuntimeTestRegistry(runtime: PluginRuntime) {
  const pluginRegistry = createTestPluginRegistry(runtime);
  const createApi: typeof pluginRegistry.createApi = (record, params) => {
    pluginRegistry.registry.plugins.push(record);
    return pluginRegistry.createApi(record, params);
  };
  return { ...pluginRegistry, createApi };
}
