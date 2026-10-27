import type { PluginRegistry } from "./registry-types.js";

/**
 * Whether a reload hands this generation's running turns for a plugin to the next
 * generation at a step boundary. The retiring generation's manifest decides: the
 * plugin must declare `reload.turnHandover`.
 */
export function pluginHandsOverTurns(
  registries: readonly PluginRegistry[],
  pluginId: string,
): boolean {
  return registries.some((registry) =>
    registry.plugins.some((record) => record.id === pluginId && record.turnHandover === true),
  );
}
