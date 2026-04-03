import { getChannelPlugin, normalizeChannelId } from "../../channels/plugins/index.js";
import type { ChannelGroupContext } from "../../channels/plugins/types.js";

function resolveRequireMentionForChannel(
  channelId: "discord" | "slack",
  params: ChannelGroupContext,
): boolean | undefined {
  const plugin = getChannelPlugin(channelId);
  return plugin?.groups?.resolveRequireMention?.(params);
}

export { getChannelPlugin, normalizeChannelId };

export function resolveDiscordGroupRequireMention(
  params: ChannelGroupContext,
): boolean | undefined {
  return resolveRequireMentionForChannel("discord", params);
}

export function resolveSlackGroupRequireMention(params: ChannelGroupContext): boolean | undefined {
  return resolveRequireMentionForChannel("slack", params);
}
