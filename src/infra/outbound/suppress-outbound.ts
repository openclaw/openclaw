/**
 * Listen-only mode: resolve whether outbound delivery is suppressed for a
 * given channel/account combination.
 *
 * Resolution order (first defined value wins):
 *   1. Account-level:  channels.<channel>.accounts.<accountId>.suppressOutbound
 *   2. Channel-level:  channels.<channel>.suppressOutbound
 */

import type { OpenClawConfig } from "../../config/config.js";

type ProviderConfig = {
  suppressOutbound?: boolean;
  accounts?: Record<string, { suppressOutbound?: boolean } | undefined>;
};

/** Returns `true` when outbound should be suppressed (listen-only mode). */
export function isOutboundSuppressed(params: {
  cfg: OpenClawConfig;
  channel: string;
  accountId?: string | null;
}): boolean {
  const channelsConfig = params.cfg.channels as
    | Record<string, ProviderConfig | undefined>
    | undefined;
  const providerConfig = channelsConfig?.[params.channel];
  if (!providerConfig) {
    return false;
  }

  // Account-level override takes precedence.
  if (params.accountId) {
    const accountSuppressed = providerConfig.accounts?.[params.accountId]?.suppressOutbound;
    if (typeof accountSuppressed === "boolean") {
      return accountSuppressed;
    }
  }

  return providerConfig.suppressOutbound === true;
}
