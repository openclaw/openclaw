/**
 * Resolve whether outbound delivery is suppressed for a channel/account.
 *
 * Resolution order (first defined value wins):
 *   1. Account-level:  channels.<channel>.accounts.<accountId>.suppressOutbound
 *   2. Channel-level:  channels.<channel>.suppressOutbound
 */

import type { OpenClawConfig } from "../../config/config.js";
import { resolveAccountEntry } from "../../routing/account-lookup.js";

type ProviderConfig = {
  suppressOutbound?: boolean;
  accounts?: Record<string, { suppressOutbound?: boolean } | undefined>;
};

/** Returns `true` when outbound delivery should be suppressed. */
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
    const accountSuppressed = resolveAccountEntry(
      providerConfig.accounts,
      params.accountId,
    )?.suppressOutbound;
    if (typeof accountSuppressed === "boolean") {
      return accountSuppressed;
    }
  }

  return providerConfig.suppressOutbound === true;
}
