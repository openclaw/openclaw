import { resolveChannelDefaultAccountId } from "../channels/plugins/helpers.js";
import type { ChannelPlugin } from "../channels/plugins/types.js";
import type { OpenClawConfig } from "../config/config.js";

export type ChannelDefaultAccountContext = {
  accountIds: string[];
  defaultAccountId: string;
  account: unknown;
  enabled: boolean;
  configured: boolean;
};

export async function resolveDefaultChannelAccountContext(
  plugin: ChannelPlugin,
  cfg: OpenClawConfig,
): Promise<ChannelDefaultAccountContext> {
  const accountIds = plugin.config.listAccountIds(cfg);
  const defaultAccountId = resolveChannelDefaultAccountId({
    plugin,
    cfg,
    accountIds,
  });
  const account = plugin.config.resolveAccount(cfg, defaultAccountId);
  const enabled = plugin.config.isEnabled ? plugin.config.isEnabled(account, cfg) : true;
  const configured = plugin.config.isConfigured
    ? await plugin.config.isConfigured(account, cfg)
    : true;
  return { accountIds, defaultAccountId, account, enabled, configured };
}
