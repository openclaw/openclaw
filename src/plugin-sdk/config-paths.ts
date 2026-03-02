import type { OpenClawConfig } from "../config/config.js";

/**
 * Canonical config base path resolver for channel account contexts.
 * USE THIS in resolveDmPolicy handlers — do not inline the account-path check.
 * Returns a trailing-dot path like "channels.telegram." or "channels.telegram.accounts.main.".
 */
export function resolveChannelAccountConfigBasePath(params: {
  cfg: OpenClawConfig;
  channelKey: string;
  accountId: string;
}): string {
  const channels = params.cfg.channels as unknown as Record<string, unknown> | undefined;
  const channelSection = channels?.[params.channelKey] as Record<string, unknown> | undefined;
  const accounts = channelSection?.accounts as Record<string, unknown> | undefined;
  const useAccountPath = Boolean(accounts?.[params.accountId]);
  return useAccountPath
    ? `channels.${params.channelKey}.accounts.${params.accountId}.`
    : `channels.${params.channelKey}.`;
}
