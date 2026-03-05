import { formatCliCommand } from "../../cli/command-format.js";
import type { OpenClawConfig } from "../../config/config.js";
import { DEFAULT_ACCOUNT_ID } from "../../routing/session-key.js";
import type { ChannelPlugin } from "./types.js";

// Channel docking helper: use this when selecting the default account for a plugin.
export function resolveChannelDefaultAccountId<ResolvedAccount>(params: {
  plugin: ChannelPlugin<ResolvedAccount>;
  cfg: OpenClawConfig;
  accountIds?: string[];
}): string {
  const accountIds = params.accountIds ?? params.plugin.config.listAccountIds(params.cfg);
  const configuredDefaultRaw = params.plugin.config.defaultAccountId?.(params.cfg);
  const configuredDefault = configuredDefaultRaw?.trim() ? configuredDefaultRaw.trim() : null;
  if (accountIds.length > 0) {
    if (configuredDefault && accountIds.includes(configuredDefault)) {
      return configuredDefault;
    }
    return accountIds[0];
  }
  return configuredDefault ?? DEFAULT_ACCOUNT_ID;
}

export function formatPairingApproveHint(channelId: string): string {
  const listCmd = formatCliCommand(`openclaw pairing list ${channelId}`);
  const approveCmd = formatCliCommand(`openclaw pairing approve ${channelId} <code>`);
  return `Approve via: ${listCmd} / ${approveCmd}`;
}
