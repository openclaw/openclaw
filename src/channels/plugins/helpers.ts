import type { OpenClawConfig } from "../../config/config.js";
import type { ChannelPlugin } from "./types.js";
import { formatCliCommand } from "../../cli/command-format.js";
import { DEFAULT_ACCOUNT_ID } from "../../routing/session-key.js";

// Channel docking helper: use this when selecting the default account for a plugin.
export function resolveChannelDefaultAccountId<ResolvedAccount>(params: {
  plugin: ChannelPlugin<ResolvedAccount>;
  cfg: OpenClawConfig;
  accountIds?: string[];
}): string {
  let accountIds: string[];
  try {
    accountIds = params.accountIds ?? params.plugin.config.listAccountIds(params.cfg);
  } catch {
    accountIds = [DEFAULT_ACCOUNT_ID];
  }
  try {
    return params.plugin.config.defaultAccountId?.(params.cfg) ?? accountIds[0] ?? DEFAULT_ACCOUNT_ID;
  } catch {
    return accountIds[0] ?? DEFAULT_ACCOUNT_ID;
  }
}

export function formatPairingApproveHint(channelId: string): string {
  const listCmd = formatCliCommand(`openclaw pairing list ${channelId}`);
  const approveCmd = formatCliCommand(`openclaw pairing approve ${channelId} <code>`);
  return `Approve via: ${listCmd} / ${approveCmd}`;
}
