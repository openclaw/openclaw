import type { OpenClawConfig } from "../config/config.js";
import type { ChannelId } from "../channels/plugins/types.js";

export type TelegramErrorPolicy = "always" | "once" | "silent";

interface ErrorCooldownEntry {
  lastErrorTime: number;
  errorMessage?: string;
}

// In-memory store: key is chatId (or groupId), value is cooldown entry
const errorCooldownStore = new Map<string, ErrorCooldownEntry>();

/**
 * Default cooldown: 4 hours (14400000ms)
 */
const DEFAULT_ERROR_COOLDOWN_MS = 14400000;

interface TelegramGroupConfig {
  errorPolicy?: TelegramErrorPolicy;
  errorCooldownMs?: number;
}

interface TelegramAccountConfig {
  errorPolicy?: TelegramErrorPolicy;
  errorCooldownMs?: number;
  groups?: Record<string, TelegramGroupConfig>;
}

export function resolveTelegramErrorPolicy(params: {
  cfg: OpenClawConfig;
  channel: ChannelId;
  accountId?: string | null;
  chatId?: string | number | null;
  isGroup?: boolean;
}): {
  policy: TelegramErrorPolicy;
  cooldownMs: number;
} {
  const { cfg, channel, accountId, chatId, isGroup = false } = params;

  const channelConfig = cfg.channels?.[channel] as TelegramAccountConfig | undefined;

  if (!channelConfig) {
    return { policy: "always", cooldownMs: DEFAULT_ERROR_COOLDOWN_MS };
  }

  // Check group-specific config first (if in a group and chatId is available)
  if (isGroup && chatId) {
    const chatIdStr = String(chatId);
    const groupConfig = channelConfig.groups?.[chatIdStr];
    if (groupConfig?.errorPolicy) {
      return {
        policy: groupConfig.errorPolicy,
        cooldownMs: groupConfig.errorCooldownMs ?? DEFAULT_ERROR_COOLDOWN_MS,
      };
    }
  }

  // Fall back to channel-level config
  const policy = channelConfig.errorPolicy ?? "always";
  const cooldownMs = channelConfig.errorCooldownMs ?? DEFAULT_ERROR_COOLDOWN_MS;

  return { policy, cooldownMs };
}

export function shouldSuppressTelegramError(params: {
  chatId: string | number;
  cooldownMs: number;
  errorMessage?: string;
}): boolean {
  const { chatId, cooldownMs, errorMessage } = params;
  const chatIdStr = String(chatId);
  const now = Date.now();

  const entry = errorCooldownStore.get(chatIdStr);

  if (!entry) {
    // First error - record it and don't suppress
    errorCooldownStore.set(chatIdStr, {
      lastErrorTime: now,
      errorMessage,
    });
    return false;
  }

  // Check if we're still within cooldown period
  if (now - entry.lastErrorTime < cooldownMs) {
    // Within cooldown - suppress this error
    return true;
  }

  // Cooldown expired - record new error and don't suppress
  errorCooldownStore.set(chatIdStr, {
    lastErrorTime: now,
    errorMessage,
  });
  return false;
}

export function isSilentErrorPolicy(policy: TelegramErrorPolicy): boolean {
  return policy === "silent";
}
