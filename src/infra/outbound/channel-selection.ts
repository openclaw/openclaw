import { listChannelPlugins } from "../../channels/plugins/index.js";
import type { ChannelPlugin } from "../../channels/plugins/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  listDeliverableMessageChannels,
  type DeliverableMessageChannel,
  isDeliverableMessageChannel,
  normalizeMessageChannel,
} from "../../utils/message-channel.js";

export type MessageChannelId = DeliverableMessageChannel;
export type MessageChannelSelectionSource =
  | "explicit"
  | "tool-context-fallback"
  | "single-configured";

const getMessageChannels = () => listDeliverableMessageChannels();

function isKnownChannel(value: string): boolean {
  return getMessageChannels().includes(value as MessageChannelId);
}

function resolveKnownChannel(value?: string | null): MessageChannelId | undefined {
  const normalized = normalizeMessageChannel(value);
  if (!normalized) {
    return undefined;
  }
  if (isDeliverableMessageChannel(normalized) && isKnownChannel(normalized)) {
    return normalized as MessageChannelId;
  }

  const trimmed = value?.trim();
  const separator = trimmed?.indexOf(":") ?? -1;
  if (separator <= 0) {
    return undefined;
  }
  const prefixed = normalizeMessageChannel(trimmed?.slice(0, separator));
  if (!prefixed) {
    return undefined;
  }
  if (!isDeliverableMessageChannel(prefixed)) {
    return undefined;
  }
  if (!isKnownChannel(prefixed)) {
    return undefined;
  }
  return prefixed as MessageChannelId;
}

function isAccountEnabled(account: unknown): boolean {
  if (!account || typeof account !== "object") {
    return true;
  }
  const enabled = (account as { enabled?: boolean }).enabled;
  return enabled !== false;
}

async function isPluginConfigured(plugin: ChannelPlugin, cfg: OpenClawConfig): Promise<boolean> {
  const accountIds = plugin.config.listAccountIds(cfg);
  if (accountIds.length === 0) {
    return false;
  }

  for (const accountId of accountIds) {
    const account = plugin.config.resolveAccount(cfg, accountId);
    const enabled = plugin.config.isEnabled
      ? plugin.config.isEnabled(account, cfg)
      : isAccountEnabled(account);
    if (!enabled) {
      continue;
    }
    if (!plugin.config.isConfigured) {
      return true;
    }
    const configured = await plugin.config.isConfigured(account, cfg);
    if (configured) {
      return true;
    }
  }

  return false;
}

export async function listConfiguredMessageChannels(
  cfg: OpenClawConfig,
): Promise<MessageChannelId[]> {
  const channels: MessageChannelId[] = [];
  for (const plugin of listChannelPlugins()) {
    if (!isKnownChannel(plugin.id)) {
      continue;
    }
    if (await isPluginConfigured(plugin, cfg)) {
      channels.push(plugin.id);
    }
  }
  return channels;
}

export async function resolveMessageChannelSelection(params: {
  cfg: OpenClawConfig;
  channel?: string | null;
  fallbackChannel?: string | null;
}): Promise<{
  channel: MessageChannelId;
  configured: MessageChannelId[];
  source: MessageChannelSelectionSource;
}> {
  const normalized = normalizeMessageChannel(params.channel);
  if (normalized) {
    const explicit = resolveKnownChannel(params.channel);
    if (!explicit) {
      const fallback = resolveKnownChannel(params.fallbackChannel);
      if (fallback) {
        return {
          channel: fallback,
          configured: await listConfiguredMessageChannels(params.cfg),
          source: "tool-context-fallback",
        };
      }
      throw new Error(`Unknown channel: ${String(normalized)}`);
    }
    return {
      channel: explicit,
      configured: await listConfiguredMessageChannels(params.cfg),
      source: "explicit",
    };
  }

  const fallback = resolveKnownChannel(params.fallbackChannel);
  if (fallback) {
    return {
      channel: fallback,
      configured: await listConfiguredMessageChannels(params.cfg),
      source: "tool-context-fallback",
    };
  }

  const configured = await listConfiguredMessageChannels(params.cfg);
  if (configured.length === 1) {
    return { channel: configured[0], configured, source: "single-configured" };
  }
  if (configured.length === 0) {
    throw new Error("Channel is required (no configured channels detected).");
  }
  throw new Error(
    `Channel is required when multiple channels are configured: ${configured.join(", ")}`,
  );
}
