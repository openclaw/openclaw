import type { OpenClawConfig } from "../config/config.js";

/**
 * Returns the dotted config-path prefix for a channel account.
 *
 * When an explicit per-account section exists (e.g. `channels.slack.accounts.work`),
 * the returned path is `"channels.<channelKey>.accounts.<accountId>."`.
 * Otherwise it falls back to the channel root: `"channels.<channelKey>."`.
 *
 * The trailing dot allows callers to append a leaf key directly:
 * `${basePath}dmPolicy` → `"channels.slack.accounts.work.dmPolicy"`.
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
