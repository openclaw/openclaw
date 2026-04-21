import { getChannelPlugin, getLoadedChannelPlugin } from "../../channels/plugins/index.js";
import { resolveCurrentChannelTargetFromMessaging } from "../../channels/plugins/target-parsing.js";
import type { ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getActivePluginRegistry } from "../../plugins/runtime.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
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

function resolveDirectFromActiveRegistry(
  channel: DeliverableMessageChannel,
): ChannelPlugin | undefined {
  const activeRegistry = getActivePluginRegistry();
  if (!activeRegistry) {
    return undefined;
  }
  for (const entry of activeRegistry.channels) {
    const plugin = entry?.plugin;
    if (plugin?.id === channel) {
      return plugin;
    }
  }
  return undefined;
}

function resolveOutboundChannelMessaging(params: {
  channel?: string | null;
  cfg?: OpenClawConfig;
}) {
  const normalized = normalizeOptionalString(params.channel);
  if (!normalized) {
    return undefined;
  }
  return resolveOutboundChannelPlugin({
    channel: normalized,
    cfg: params.cfg,
  })?.messaging;
}

function resolveOutboundChannelAdapter(params: { channel?: string | null; cfg?: OpenClawConfig }) {
  const normalized = normalizeOptionalString(params.channel);
  if (!normalized) {
    return undefined;
  }
  return resolveOutboundChannelPlugin({
    channel: normalized,
    cfg: params.cfg,
  })?.outbound;
}

export function resolveOutboundChannelPlugin(params: {
  channel: string;
  cfg?: OpenClawConfig;
}): ChannelPlugin | undefined {
  const normalized = normalizeDeliverableOutboundChannel(params.channel);
  if (!normalized) {
    return undefined;
  }

  const resolveLoaded = () => getLoadedChannelPlugin(normalized);
  const resolve = () => getChannelPlugin(normalized);
  const current = resolveLoaded();
  if (current) {
    return current;
  }
  const directCurrent = resolveDirectFromActiveRegistry(normalized);
  if (directCurrent) {
    return directCurrent;
  }

  maybeBootstrapChannelPlugin({ channel: normalized, cfg: params.cfg });
  return resolveLoaded() ?? resolveDirectFromActiveRegistry(normalized) ?? resolve();
}

export function shouldOutboundChannelPreferFinalAssistantVisibleText(params: {
  channel?: string | null;
  cfg?: OpenClawConfig;
}): boolean {
  const normalized = normalizeOptionalString(params.channel);
  if (!normalized) {
    return false;
  }
  const outbound = resolveOutboundChannelAdapter(params);
  return (
    outbound?.shouldPreferFinalAssistantVisibleText?.() ??
    outbound?.preferFinalAssistantVisibleText === true
  );
}

export function resolveOutboundCurrentChannelTarget(params: {
  channel?: string | null;
  to?: string | null;
  threadId?: string | number | null;
  cfg?: OpenClawConfig;
}): string | undefined {
  const rawTarget = normalizeOptionalString(params.to);
  if (!rawTarget) {
    return undefined;
  }
  if (params.threadId == null) {
    return rawTarget;
  }

  const normalizedChannel = normalizeOptionalString(params.channel);
  if (!normalizedChannel) {
    return rawTarget;
  }
  return (
    resolveCurrentChannelTargetFromMessaging({
      rawTarget,
      threadId: params.threadId,
      messaging: resolveOutboundChannelMessaging({
        channel: normalizedChannel,
        cfg: params.cfg,
      }),
    }) ?? rawTarget
  );
}
