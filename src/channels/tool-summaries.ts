import type { OpenClawConfig } from "../config/config.js";
import type { VerboseLevel } from "../auto-reply/thinking.js";

/**
 * Resolves the channel-specific toolSummaries config and maps it to VerboseLevel.
 * The toolSummaries config controls tool result acknowledgment messages.
 *
 * @param cfg - The OpenClaw config object
 * @param channel - The channel identifier (e.g., "telegram", "slack")
 * @param accountId - Optional account ID for multi-account setups
 * @returns The VerboseLevel derived from toolSummaries config, or undefined if not set
 */
export function resolveChannelToolSummaries(params: {
  cfg: OpenClawConfig;
  channel?: string;
  accountId?: string;
}): VerboseLevel | undefined {
  const { cfg, channel, accountId } = params;

  if (!channel) {
    return undefined;
  }

  const normalizedChannel = channel.trim().toLowerCase();

  // Currently only Telegram supports toolSummaries config
  if (normalizedChannel !== "telegram") {
    return undefined;
  }

  const telegramConfig = cfg.channels?.telegram;
  if (!telegramConfig) {
    return undefined;
  }

  // Check account-specific config first
  if (accountId && telegramConfig.accounts?.[accountId]?.toolSummaries) {
    return telegramConfig.accounts[accountId].toolSummaries;
  }

  // Fall back to base telegram config
  if (telegramConfig.toolSummaries) {
    return telegramConfig.toolSummaries;
  }

  return undefined;
}
