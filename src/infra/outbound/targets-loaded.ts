import { getLoadedChannelPlugin } from "../../channels/plugins/index.js";
import type { ChannelOutboundTargetMode, ChannelPlugin } from "../../channels/plugins/types.js";
import type { OpenClawConfig } from "../../config/config.js";
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

  return getLoadedChannelPlugin(normalized);
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
