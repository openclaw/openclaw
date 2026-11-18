/** Exact registry projection helpers for plugin command runtimes. */
import type { PluginRegistry } from "./registry-types.js";

export function listRegisteredPluginCommands(registry: PluginRegistry) {
  return registry.commands.map((entry) => ({
    ...entry.command,
    pluginId: entry.pluginId,
    pluginName: entry.pluginName,
    pluginRoot: entry.rootDir,
    trustedOwnerStatusExposure: entry.trustedOwnerStatusExposure,
  }));
}
