import type { PluginRecord } from "./registry-types.js";

/**
 * Whether a reload hands this generation's running turns for a plugin to the next
 * generation at a step boundary. The retiring generation's manifest decides: the
 * plugin must declare `reload.turnHandover`. Overlapping generations retain old
 * callable authority until the turn finishes, even when replacement is serialized.
 */
export function pluginHandsOverTurns(
  record: Pick<PluginRecord, "turnHandover" | "generationOverlap"> | undefined,
): boolean {
  return record?.turnHandover === true && record.generationOverlap !== true;
}
