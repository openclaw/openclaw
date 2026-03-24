import { getChannelPlugin } from "../../channels/plugins/index.js";
import type { ChannelId, ChannelStructuredComponents } from "../../channels/plugins/types.js";
import type { OpenClawConfig } from "../../config/config.js";

export type CrossContextComponentsBuilder = (message: string) => ChannelStructuredComponents;

export type CrossContextComponentsFactory = (params: {
  originLabel: string;
  message: string;
  cfg: OpenClawConfig;
  accountId?: string | null;
}) => ChannelStructuredComponents;

export type ChannelMessageAdapter = {
  supportsComponentsV2: boolean;
  buildCrossContextComponents?: CrossContextComponentsFactory;
};

const DEFAULT_ADAPTER: ChannelMessageAdapter = {
  supportsComponentsV2: false,
};

/**
 * Resolve whether components v2 is enabled for the given channel, respecting
 * account-level `useComponentsV2` overrides (account takes precedence over
 * base channel config). Returns `true` when the field is absent (default).
 */
function resolveUseComponentsV2(
  cfg: OpenClawConfig | undefined,
  channel: ChannelId,
  accountId?: string | null,
): boolean {
  if (!cfg) {
    return true;
  }
  const channelCfg = cfg.channels?.[channel as string] as
    | { useComponentsV2?: boolean; accounts?: Record<string, { useComponentsV2?: boolean }> }
    | undefined;
  if (!channelCfg) {
    return true;
  }
  // Account-level override takes precedence
  if (accountId) {
    const accountCfg = channelCfg.accounts?.[accountId];
    if (accountCfg && typeof accountCfg.useComponentsV2 === "boolean") {
      return accountCfg.useComponentsV2;
    }
  }
  // Fall back to base channel-level config
  if (typeof channelCfg.useComponentsV2 === "boolean") {
    return channelCfg.useComponentsV2;
  }
  return true;
}

export function getChannelMessageAdapter(
  channel: ChannelId,
  cfg?: OpenClawConfig,
  accountId?: string | null,
): ChannelMessageAdapter {
  const adapter = getChannelPlugin(channel)?.messaging?.buildCrossContextComponents;
  if (adapter) {
    if (!resolveUseComponentsV2(cfg, channel, accountId)) {
      return DEFAULT_ADAPTER;
    }
    return {
      supportsComponentsV2: true,
      buildCrossContextComponents: adapter,
    };
  }
  return DEFAULT_ADAPTER;
}
