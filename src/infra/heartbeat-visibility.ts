// Resolves heartbeat visibility toggles across config precedence levels.
import type { ChannelHeartbeatVisibilityConfig } from "../config/types.channels.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveChannelAccountEntry } from "../routing/account-lookup.js";

/** Resolved heartbeat presentation toggles after defaults/channel/account precedence. */
export type ResolvedHeartbeatVisibility = {
  /** Whether successful heartbeat content should be sent as visible chat text. */
  showOk: boolean;
  /** Whether warning/error heartbeat content should be sent as visible chat text. */
  showAlerts: boolean;
  /** Whether heartbeat status should emit indicator events for UI surfaces. */
  useIndicator: boolean;
};

const DEFAULT_VISIBILITY: ResolvedHeartbeatVisibility = {
  showOk: false, // Silent by default
  showAlerts: true, // Show content messages
  useIndicator: true, // Emit indicator events
};

/** Resolves heartbeat visibility for a channel, applying account > channel > defaults precedence. */
export function resolveHeartbeatVisibility(params: {
  cfg: OpenClawConfig;
  channel: string;
  accountId?: string;
}): ResolvedHeartbeatVisibility {
  const { cfg, channel, accountId } = params;

  // Layer 1: Global channel defaults
  const channelDefaults = cfg.channels?.defaults?.heartbeatVisibility;

  // Webchat has no channel/account config branch, so only shared channel defaults apply.
  const channelCfg = (channel === "webchat" ? undefined : cfg.channels?.[channel]) as
    | {
        heartbeatVisibility?: ChannelHeartbeatVisibilityConfig;
        accounts?: Record<string, { heartbeatVisibility?: ChannelHeartbeatVisibilityConfig }>;
      }
    | undefined;
  const perChannel = channelCfg?.heartbeatVisibility;

  // Layer 3: Per-account config (most specific)
  const accountCfg =
    channel !== "webchat" && accountId
      ? resolveChannelAccountEntry(channelCfg?.accounts, accountId, channel, (id) => id)
      : undefined;
  const perAccount = accountCfg?.heartbeatVisibility;

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
