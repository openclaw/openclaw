import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { ChannelId } from "../channels/plugins/index.js";

/** Channel/plugin identifiers whose config changes should trigger a channel reload. */
export type ChannelPluginReloadTarget = {
  channelId: ChannelId;
  pluginId?: string | null;
  aliases?: readonly string[] | null;
};

function addNormalizedTarget(targets: Set<string>, value: string | null | undefined): void {
  const normalized = normalizeOptionalString(value);
  if (normalized) {
    targets.add(normalized);
  }
}

/** Returns every config id that may represent the same channel plugin entry. */
export function listChannelPluginConfigTargetIds(
  target: ChannelPluginReloadTarget,
): ReadonlySet<string> {
  const targets = new Set<string>();
  addNormalizedTarget(targets, target.channelId);
  addNormalizedTarget(targets, target.pluginId);
  for (const alias of target.aliases ?? []) {
    addNormalizedTarget(targets, alias);
  }
  return targets;
}

/** Checks whether changed config paths touch any plugin entry/install target or child path. */
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
