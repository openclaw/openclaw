import type { ChannelId } from "../channels/plugins/channel-id.types.js";
import { resolveChannelMessagingConfig } from "../channels/plugins/messaging-config.js";
import { normalizeAccountId } from "../routing/session-key.js";
import { resolveMergedAccountConfig } from "./channel-account-config.js";
import type { CommonChannelGroupConfig } from "./types.channel-messaging-common.js";
import type { OpenClawConfig } from "./types.openclaw.js";

export type ChannelGroupConfig = Pick<
  CommonChannelGroupConfig,
  "requireMention" | "tools" | "toolsBySender"
> & {
  requireMentionInBotThreads?: boolean;
  ingest?: boolean;
};

export type ChannelGroups = Record<string, ChannelGroupConfig>;

export function resolveChannelGroups(
  cfg: OpenClawConfig,
  channel: ChannelId,
  accountId?: string | null,
): ChannelGroups | undefined {
  const normalizedAccountId = normalizeAccountId(accountId);
  const channelConfig:
    | {
        accounts?: Record<string, { groups?: ChannelGroups }>;
        groups?: ChannelGroups;
      }
    | undefined = cfg.channels?.[channel];
  if (!channelConfig) {
    return undefined;
  }
  const resolved = resolveChannelMessagingConfig(cfg, channel, accountId);
  if (resolved) {
    // Preserve the shared group contract for single-account empty maps.
    return resolved.groups &&
      Object.keys(resolved.groups).length === 0 &&
      Object.keys(channelConfig.accounts ?? {}).length <= 1
      ? channelConfig.groups
      : resolved.groups;
  }
  // Single-account empty maps inherit; in multi-account setups they opt out.
  return resolveMergedAccountConfig({
    channelConfig,
    channelId: channel,
    accounts: channelConfig.accounts,
    accountId: normalizedAccountId,
    inheritEmptyKeys:
      Object.keys(channelConfig.accounts ?? {}).length > 1 ? {} : { groups: "object" },
  }).groups;
}
