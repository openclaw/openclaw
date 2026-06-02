const COMMON_SINGLE_ACCOUNT_PROMOTION_KEYS = [
  "name",
  "token",
  "tokenFile",
  "botToken",
  "appToken",
  "account",
  "signalNumber",
  "authDir",
  "cliPath",
  "dbPath",
  "httpUrl",
  "httpHost",
  "httpPort",
  "webhookPath",
  "webhookUrl",
  "webhookSecret",
  "service",
  "region",
  "homeserver",
  "userId",
  "accessToken",
  "password",
  "deviceName",
  "url",
  "code",
  "dmPolicy",
  "allowFrom",
  "groupPolicy",
  "groupAllowFrom",
  "defaultTo",
] as const;

const SETUP_SINGLE_ACCOUNT_PROMOTION_KEYS = [
  ...COMMON_SINGLE_ACCOUNT_PROMOTION_KEYS,
  "streaming",
  "deviceId",
  "avatarUrl",
  "initialSyncLimit",
  "encryption",
  "allowlistOnly",
  "allowBots",
  "blockStreaming",
  "replyToMode",
  "threadReplies",
  "textChunkLimit",
  "chunkMode",
  "responsePrefix",
  "ackReaction",
  "ackReactionScope",
  "reactionNotifications",
  "threadBindings",
  "startupVerification",
  "startupVerificationCooldownHours",
  "mediaMaxMb",
  "autoJoin",
  "autoJoinAllowlist",
  "dm",
  "groups",
  "rooms",
  "actions",
] as const;

const commonSingleAccountPromotionKeys = new Set<string>(COMMON_SINGLE_ACCOUNT_PROMOTION_KEYS);
const setupSingleAccountPromotionKeys = new Set<string>(SETUP_SINGLE_ACCOUNT_PROMOTION_KEYS);

/** Returns whether a root config key is safe for generic single-account migration. */
export function isCommonSingleAccountPromotionKey(key: string): boolean {
  return commonSingleAccountPromotionKeys.has(key);
}

/** Returns whether setup-owned account patching should treat a key as account-scoped. */
export function isSetupSingleAccountPromotionKey(key: string): boolean {
  return setupSingleAccountPromotionKeys.has(key);
}

/** Collects defined root config entries that may need promotion into an account section. */
export function collectSingleAccountPromotionEntries(channel: Record<string, unknown>): {
  entries: string[];
  hasNamedAccounts: boolean;
} {
  const hasNamedAccounts = Object.keys((channel.accounts as Record<string, unknown>) ?? {}).some(
    Boolean,
  );
  const entries = Object.entries(channel)
    // Undefined root values should not create account fields during migration.
    .filter(
      ([key, value]) =>
        key !== "accounts" && key !== "defaultAccount" && key !== "enabled" && value !== undefined,
    )
    .map(([key]) => key);
  return { entries, hasNamedAccounts };
}
