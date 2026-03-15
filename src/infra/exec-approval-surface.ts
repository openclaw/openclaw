import { loadConfig, type OpenClawConfig } from "../config/config.js";
import { listEnabledDiscordAccounts } from "../discord/accounts.js";
import { isDiscordExecApprovalClientEnabled } from "../discord/exec-approvals.js";
import { listEnabledTelegramAccounts } from "../telegram/accounts.js";
import { isTelegramExecApprovalClientEnabled } from "../telegram/exec-approvals.js";
import { INTERNAL_MESSAGE_CHANNEL, normalizeMessageChannel } from "../utils/message-channel.js";

export type ExecApprovalInitiatingSurfaceState =
  | { kind: "enabled"; channel: string | undefined; channelLabel: string }
  | { kind: "disabled"; channel: string; channelLabel: string }
  | { kind: "unsupported"; channel: string; channelLabel: string };

function labelForChannel(channel?: string): string {
  switch (channel) {
    case "discord":
      return "Discord";
    case "telegram":
      return "Telegram";
    case "tui":
      return "terminal UI";
    case INTERNAL_MESSAGE_CHANNEL:
      return "Web UI";
    default:
      return channel ? channel[0]?.toUpperCase() + channel.slice(1) : "this platform";
  }
}

export function resolveExecApprovalInitiatingSurfaceState(params: {
  channel?: string | null;
  accountId?: string | null;
  cfg?: OpenClawConfig;
}): ExecApprovalInitiatingSurfaceState {
  const channel = normalizeMessageChannel(params.channel);
  const channelLabel = labelForChannel(channel);
  if (!channel || channel === INTERNAL_MESSAGE_CHANNEL || channel === "tui") {
    return { kind: "enabled", channel, channelLabel };
  }

  const cfg = params.cfg ?? loadConfig();
  if (channel === "telegram") {
    return isTelegramExecApprovalClientEnabled({ cfg, accountId: params.accountId })
      ? { kind: "enabled", channel, channelLabel }
      : { kind: "disabled", channel, channelLabel };
  }
  if (channel === "discord") {
    return isDiscordExecApprovalClientEnabled({ cfg, accountId: params.accountId })
      ? { kind: "enabled", channel, channelLabel }
      : { kind: "disabled", channel, channelLabel };
  }
  return { kind: "unsupported", channel, channelLabel };
}

function hasExecApprovalDmRoute(
  accounts: Array<{
    config: {
      execApprovals?: {
        enabled?: boolean;
        approvers?: unknown[];
        target?: string;
      };
    };
  }>,
): boolean {
  for (const account of accounts) {
    const execApprovals = account.config.execApprovals;
    if (!execApprovals?.enabled || (execApprovals.approvers?.length ?? 0) === 0) {
      continue;
    }
    const target = execApprovals.target ?? "dm";
    if (target === "dm" || target === "both") {
      return true;
    }
  }
  return false;
}

export function hasConfiguredExecApprovalDmRoute(cfg: OpenClawConfig): boolean {
  return (
    hasExecApprovalDmRoute(listEnabledDiscordAccounts(cfg)) ||
    hasExecApprovalDmRoute(listEnabledTelegramAccounts(cfg))
  );
}
