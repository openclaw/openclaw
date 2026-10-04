import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeChatChannelId } from "../channels/ids.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

export {
  normalizePluginConfigList,
  normalizePluginsConfigWithResolverCore,
  type NormalizedPluginsConfig,
  type NormalizePluginId,
} from "./config-normalization-core.js";

/**
 * Enables an owner for any enabled channel; disables it only when all channels are off.
 * Unspecified channels leave the plugin's own activation policy in control.
 */
export function resolveChannelConfigEnablement(
  cfg: OpenClawConfig | undefined,
  pluginId: string,
  channelIds: readonly string[] = [],
): boolean | undefined {
  const channels = cfg?.channels as Record<string, unknown> | undefined;
  if (!channels) {
    return undefined;
  }
  // Declared ownership is authoritative; infer from the plugin id only when absent.
  const candidateIds = channelIds.length
    ? channelIds.map((channelId) => normalizeChatChannelId(channelId) ?? channelId)
    : [normalizeChatChannelId(pluginId)];
  const enablement = candidateIds.map((channelId) => {
    const entry = channelId ? channels[channelId] : undefined;
    return isRecord(entry) ? entry.enabled : undefined;
  });
  if (enablement.includes(true)) {
    return true;
  }
  return enablement.every((enabled) => enabled === false) ? false : undefined;
}
