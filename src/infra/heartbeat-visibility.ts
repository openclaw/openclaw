import type { ClawdbotConfig } from "../config/config.js";
import type { ChannelHeartbeatVisibilityConfig } from "../config/types.channels.js";
import type { DeliverableMessageChannel } from "../utils/message-channel.js";

export type ResolvedHeartbeatVisibility = {
  showOk: boolean;
  showAlerts: boolean;
  useIndicator: boolean;
};

const DEFAULT_VISIBILITY: ResolvedHeartbeatVisibility = {
  showOk: false, // Silent by default
  showAlerts: true, // Show content messages
  useIndicator: true, // Emit indicator events
};

export function resolveHeartbeatVisibility(params: {
  cfg: ClawdbotConfig;
  channel: DeliverableMessageChannel;
  accountId?: string;
}): ResolvedHeartbeatVisibility {
  const { cfg, channel, accountId } = params;

  // Layer 1: Global channel defaults
  const channelDefaults = cfg.channels?.defaults?.heartbeat;

  // Layer 2: Per-channel config (at channel root level)
  const channelCfg = cfg.channels?.[channel] as
    | {
        heartbeat?: ChannelHeartbeatVisibilityConfig;
        accounts?: Record<string, { heartbeat?: ChannelHeartbeatVisibilityConfig }>;
      }
    | undefined;
  const perChannel = channelCfg?.heartbeat;

  // Layer 3: Per-account config (most specific)
  const accountCfg = accountId ? channelCfg?.accounts?.[accountId] : undefined;
  const perAccount = accountCfg?.heartbeat;

  // Precedence: per-account > per-channel > channel-defaults > global defaults
  return {
    showOk:
      perAccount?.showOk ??
      perChannel?.showOk ??
      channelDefaults?.showOk ??
      DEFAULT_VISIBILITY.showOk,
    showAlerts:
      perAccount?.showAlerts ??
      perChannel?.showAlerts ??
      channelDefaults?.showAlerts ??
      DEFAULT_VISIBILITY.showAlerts,
    useIndicator:
      perAccount?.useIndicator ??
      perChannel?.useIndicator ??
      channelDefaults?.useIndicator ??
      DEFAULT_VISIBILITY.useIndicator,
  };
}
