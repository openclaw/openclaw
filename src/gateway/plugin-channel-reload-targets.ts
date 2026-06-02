import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { ChannelId } from "../channels/plugins/index.js";

export type ChannelPluginReloadTarget = {
  /** Channel id whose runtime should restart when its plugin config changes. */
  channelId: ChannelId;
  /** Owning plugin id, when it differs from the channel id. */
  pluginId?: string | null;
  /** Historical or manifest aliases that can still appear in config paths. */
  aliases?: readonly string[] | null;
};

function addNormalizedTarget(targets: Set<string>, value: string | null | undefined): void {
  const normalized = normalizeOptionalString(value);
  if (normalized) {
    targets.add(normalized);
  }
}

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

/** Checks config change paths against plugin entry/install prefixes for target ids. */
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
