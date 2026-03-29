import { getChannelPlugin, listChannelPlugins } from "../channels/plugins/index.js";
import { loadConfig, type OpenClawConfig } from "../config/config.js";
import {
  INTERNAL_MESSAGE_CHANNEL,
  isDeliverableMessageChannel,
  normalizeMessageChannel,
} from "../utils/message-channel.js";

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
  const state = getChannelPlugin(channel)?.auth?.getActionAvailabilityState?.({
    cfg,
    accountId: params.accountId,
    action: "approve",
  });
  if (state) {
    return { ...state, channel, channelLabel };
  }
  if (isDeliverableMessageChannel(channel)) {
    return { kind: "enabled", channel, channelLabel };
  }
  return { kind: "unsupported", channel, channelLabel };
}

export function hasConfiguredExecApprovalDmRoute(cfg: OpenClawConfig): boolean {
  return listChannelPlugins().some(
    (plugin) => plugin.approvals?.delivery?.hasConfiguredDmRoute?.({ cfg }) ?? false,
  );
}
