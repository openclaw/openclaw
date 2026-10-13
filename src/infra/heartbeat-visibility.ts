import type { ChannelHeartbeatVisibilityConfig } from "../config/types.channels.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveChannelAccountEntry } from "../routing/account-lookup.js";

/** Resolved heartbeat presentation toggles after defaults/channel/account precedence. */
export type ResolvedHeartbeatVisibility = Required<ChannelHeartbeatVisibilityConfig>;

const DEFAULT_VISIBILITY: ResolvedHeartbeatVisibility = {
  showOk: false,
  showAlerts: true,
  useIndicator: true,
};

/** Resolves heartbeat visibility for a channel, applying account > channel > defaults precedence. */
export function resolveHeartbeatVisibility(params: {
  cfg: OpenClawConfig;
  channel: string;
  accountId?: string;
}): ResolvedHeartbeatVisibility {
  const { cfg, channel, accountId } = params;

  const channelDefaults = cfg.channels?.defaults?.heartbeatVisibility;

  // Webchat has no channel/account config branch, so only shared channel defaults apply.
  const channelCfg = (channel === "webchat" ? undefined : cfg.channels?.[channel]) as
    | {
        heartbeatVisibility?: ChannelHeartbeatVisibilityConfig;
        accounts?: Record<string, { heartbeatVisibility?: ChannelHeartbeatVisibilityConfig }>;
      }
    | undefined;
  const perChannel = channelCfg?.heartbeatVisibility;

  const accountCfg =
    channel !== "webchat" && accountId
      ? resolveChannelAccountEntry(channelCfg?.accounts, accountId, channel, (id) => id)
      : undefined;
  const perAccount = accountCfg?.heartbeatVisibility;
  const resolve = (key: keyof ResolvedHeartbeatVisibility) =>
    perAccount?.[key] ?? perChannel?.[key] ?? channelDefaults?.[key] ?? DEFAULT_VISIBILITY[key];

  return {
    showOk: resolve("showOk"),
    showAlerts: resolve("showAlerts"),
    useIndicator: resolve("useIndicator"),
  };
}
