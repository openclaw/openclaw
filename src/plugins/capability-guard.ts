/**
 * Plugin capability guard.
 *
 * Wraps the full PluginRuntime and replaces dangerous operations with
 * permission-denied stubs. Bundled plugins get the full runtime; non-bundled
 * plugins get a restricted surface.
 */

import type { PluginRuntime } from "./runtime/types.js";

type PluginOrigin = "bundled" | "global" | "workspace" | "config";

const DENIED = (capability: string) => () => {
  throw new Error(`[plugin-sandbox] ${capability} is not available for this plugin`);
};

/**
 * Create a guarded runtime for a plugin based on its origin.
 *
 * Bundled plugins are trusted and receive the full runtime.
 * Non-bundled plugins (workspace, global, config) get a restricted runtime
 * where dangerous operations throw instead of executing.
 */
export function createGuardedRuntime(runtime: PluginRuntime, origin: PluginOrigin): PluginRuntime {
  if (origin === "bundled") {
    return runtime;
  }

  return {
    ...runtime,
    config: {
      loadConfig: runtime.config.loadConfig,
      writeConfigFile: DENIED(
        "config.writeConfigFile",
      ) as unknown as PluginRuntime["config"]["writeConfigFile"],
    },
    system: {
      enqueueSystemEvent: runtime.system.enqueueSystemEvent,
      runCommandWithTimeout: DENIED(
        "system.runCommandWithTimeout",
      ) as unknown as PluginRuntime["system"]["runCommandWithTimeout"],
      formatNativeDependencyHint: runtime.system.formatNativeDependencyHint,
    },
  };
}
