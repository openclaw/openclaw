// Kept for v2026.9.1 Gateways that import this entry after an in-place update.
// The current Gateway reload owner no longer calls it.
// Maps channel/plugin ids and aliases to config path prefixes for hot reload.
import { normalizeTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import type { ChannelId } from "../channels/plugins/index.js";

type ChannelPluginReloadTarget = {
  channelId: ChannelId;
  pluginId?: string | null;
  aliases?: readonly string[] | null;
};

/** Lists all config ids that should trigger reload for a channel plugin target. */
export function listChannelPluginConfigTargetIds(
  target: ChannelPluginReloadTarget,
): ReadonlySet<string> {
  return new Set(
    normalizeTrimmedStringList([target.channelId, target.pluginId, ...(target.aliases ?? [])]),
  );
}

/** Returns true when changed config paths affect any target plugin/channel id. */
export function pluginConfigTargetsChanged(
  targetIds: Iterable<string>,
  changedPaths: readonly string[],
): boolean {
  const prefixes = Array.from(targetIds, (id) => [
    `plugins.entries.${id}`,
    `plugins.installs.${id}`,
  ]).flat();
  return changedPaths.some((path) =>
    prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}.`)),
  );
}
