import type { PluginRegistry } from "./registry-types.js";

/**
 * Whether a reload hands this generation's running turns for a plugin to the next
 * generation at a step boundary. The plugin must declare `reload.turnHandover`. A
 * plugin that registers a context engine waits for whole turns instead, because the
 * run entry holds the engine's logical-turn custody outside the step boundary.
 */
export function pluginHandsOverTurns(
  registries: readonly PluginRegistry[],
  pluginId: string,
): boolean {
  return registries.some(
    (registry) =>
      registry.plugins.some((record) => record.id === pluginId && record.turnHandover === true) &&
      ![...registry.contextEngines.values()].some((entry) => entry.owner === `plugin:${pluginId}`),
  );
}
