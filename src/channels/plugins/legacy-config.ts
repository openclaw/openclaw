import type { LegacyConfigRule } from "../../config/legacy.shared.js";
import { getBootstrapChannelPlugin } from "./bootstrap-registry.js";
import type { ChannelId } from "./types.js";

function collectConfiguredChannelIds(raw: unknown): ChannelId[] {
  if (!raw || typeof raw !== "object") {
    return [];
  }
  const channels = (raw as { channels?: unknown }).channels;
  if (!channels || typeof channels !== "object" || Array.isArray(channels)) {
    return [];
  }
  return Object.keys(channels)
    .filter((channelId) => channelId !== "defaults")
    .map((channelId) => channelId as ChannelId);
}

export function collectChannelLegacyConfigRules(raw?: unknown): LegacyConfigRule[] {
  const rules: LegacyConfigRule[] = [];
  for (const channelId of collectConfiguredChannelIds(raw)) {
    const plugin = getBootstrapChannelPlugin(channelId);
    if (!plugin) {
      continue;
    }
    rules.push(...(plugin.doctor?.legacyConfigRules ?? []));
  }
  return rules;
}
