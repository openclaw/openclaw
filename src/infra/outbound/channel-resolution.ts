import { getChannelPlugin } from "../../channels/plugins/index.js";
import type { ChannelPlugin } from "../../channels/plugins/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  isDeliverableMessageChannel,
  normalizeMessageChannel,
  type DeliverableMessageChannel,
} from "../../utils/message-channel.js";
import {
  bootstrapOutboundChannelPlugin,
  resetOutboundChannelBootstrapStateForTests,
} from "./channel-bootstrap.runtime.js";

export function resetOutboundChannelResolutionStateForTest(): void {
  resetOutboundChannelBootstrapStateForTests();
}

export function normalizeDeliverableOutboundChannel(
  raw?: string | null,
): DeliverableMessageChannel | undefined {
  const normalized = normalizeMessageChannel(raw);
  if (!normalized || !isDeliverableMessageChannel(normalized)) {
    return undefined;
  }
  return normalized;
}

function maybeBootstrapChannelPlugin(params: {
  channel: DeliverableMessageChannel;
  cfg?: OpenClawConfig;
}): void {
  bootstrapOutboundChannelPlugin(params);
}

export function resolveOutboundChannelPlugin(params: {
  channel: string;
  cfg?: OpenClawConfig;
}): ChannelPlugin | undefined {
  const normalized = normalizeDeliverableOutboundChannel(params.channel);
  if (!normalized) {
    return undefined;
  }

  const resolve = () => getChannelPlugin(normalized);
  const current = resolve();
  if (current) {
    return current;
  }

  maybeBootstrapChannelPlugin({ channel: normalized, cfg: params.cfg });
  return resolve();
}
