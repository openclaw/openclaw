import { getChannelPlugin } from "../../channels/plugins/index.js";
import type { ChannelOutboundTargetMode, ChannelPlugin } from "../../channels/plugins/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import { getActivePluginRegistry } from "../../plugins/runtime.js";
import type { GatewayMessageChannel } from "../../utils/message-channel.js";
import {
  isDeliverableMessageChannel,
  normalizeMessageChannel,
} from "../../utils/message-channel.js";
import {
  resolveOutboundTargetWithPlugin,
  type OutboundTargetResolution,
} from "./targets-resolve-shared.js";

function resolveLoadedOutboundChannelPlugin(channel: string): ChannelPlugin | undefined {
  const normalized = normalizeMessageChannel(channel);
  if (!normalized || !isDeliverableMessageChannel(normalized)) {
    return undefined;
  }

  const current = getChannelPlugin(normalized);
  if (current) {
    return current;
  }

  const activeRegistry = getActivePluginRegistry();
  if (!activeRegistry) {
    return undefined;
  }
  for (const entry of activeRegistry.channels) {
    const plugin = entry?.plugin;
    if (plugin?.id === normalized) {
      return plugin;
    }
  }
  return undefined;
}

export function tryResolveLoadedOutboundTarget(params: {
  channel: GatewayMessageChannel;
  to?: string;
  allowFrom?: string[];
  cfg?: OpenClawConfig;
  accountId?: string | null;
  mode?: ChannelOutboundTargetMode;
}): OutboundTargetResolution | undefined {
  return resolveOutboundTargetWithPlugin({
    plugin: resolveLoadedOutboundChannelPlugin(params.channel),
    target: params,
  });
}
