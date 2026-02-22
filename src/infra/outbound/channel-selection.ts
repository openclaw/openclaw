import { listChannelPlugins } from "../../channels/plugins/index.js";
import type { ChannelPlugin } from "../../channels/plugins/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  listDeliverableMessageChannels,
  type DeliverableMessageChannel,
  normalizeMessageChannel,
} from "../../utils/message-channel.js";

export type MessageChannelId = DeliverableMessageChannel;

const getMessageChannels = () => listDeliverableMessageChannels();

function isKnownChannel(value: string): boolean {
  return getMessageChannels().includes(value as MessageChannelId);
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
}): Promise<{ channel: MessageChannelId; configured: MessageChannelId[] }> {
  const normalized = normalizeMessageChannel(params.channel);
  if (normalized) {
    if (!isKnownChannel(normalized)) {
      throw new Error(`Unknown channel: ${String(normalized)}`);
    }
    return {
      channel: normalized as MessageChannelId,
      configured: await listConfiguredMessageChannels(params.cfg),
    };
  }

  const configured = await listConfiguredMessageChannels(params.cfg);
  if (configured.length === 1) {
    return { channel: configured[0], configured };
  }
  if (configured.length === 0) {
    throw new Error("Channel is required (no configured channels detected).");
  }
  throw new Error(
    `Channel is required when multiple channels are configured: ${configured.join(", ")}`,
  );
}

/**
 * List enabled account IDs for a channel.
 * An account is considered enabled if it exists and has `enabled !== false`.
 * Returns null if the plugin is not found (can't determine enabled accounts).
 */
export function listEnabledAccountIds(params: {
  cfg: OpenClawConfig;
  channel: MessageChannelId;
}): string[] | null {
  const plugin = listChannelPlugins().find((p) => p.id === params.channel);
  if (!plugin) {
    // Plugin not found, can't determine enabled accounts
    return null;
  }

  const accountIds = plugin.config.listAccountIds(params.cfg);
  return accountIds.filter((accountId) => {
    const account = plugin.config.resolveAccount(params.cfg, accountId);
    return plugin.config.isEnabled
      ? plugin.config.isEnabled(account, params.cfg)
      : isAccountEnabled(account);
  });
}

/**
 * Resolve account ID for a channel, auto-selecting if only one is enabled.
 *
 * Behavior:
 * 1. If accountId is provided, use it as-is
 * 2. If plugin not found, fall back to defaultAccountId or "default" (backwards compat)
 * 3. If "default" account is enabled, use "default"
 * 4. If exactly one account is enabled, use that account
 * 5. If multiple accounts are enabled, require explicit accountId
 * 6. If no accounts are enabled, throw an error
 */
export function resolveMessageAccountSelection(params: {
  cfg: OpenClawConfig;
  channel: MessageChannelId;
  accountId?: string | null;
  defaultAccountId?: string;
}): string {
  // If explicit accountId provided, use it
  if (params.accountId) {
    return params.accountId;
  }

  const defaultId = params.defaultAccountId ?? "default";

  const enabledAccounts = listEnabledAccountIds({
    cfg: params.cfg,
    channel: params.channel,
  });

  // If plugin not found (null), fall back to old behavior
  if (enabledAccounts === null) {
    return defaultId;
  }

  if (enabledAccounts.length === 0) {
    throw new Error(
      `No enabled accounts for channel ${params.channel}. Check your channel configuration.`,
    );
  }

  // If default account is enabled, prefer it
  if (enabledAccounts.includes(defaultId)) {
    return defaultId;
  }

  // If exactly one account is enabled, use it
  if (enabledAccounts.length === 1) {
    return enabledAccounts[0];
  }

  // Multiple enabled accounts, require explicit selection
  throw new Error(
    `Multiple accounts enabled for ${params.channel}: ${enabledAccounts.join(", ")}. ` +
      `Please specify accountId explicitly.`,
  );
}
