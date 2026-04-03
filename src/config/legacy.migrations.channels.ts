import {
  formatSlackStreamingBooleanMigrationMessage,
  formatSlackStreamModeMigrationMessage,
  resolveDiscordPreviewStreamMode,
  resolveSlackNativeStreaming,
  resolveSlackStreamingMode,
  resolveTelegramPreviewStreamMode,
} from "./discord-preview-streaming.js";
import {
  defineLegacyConfigMigration,
  getRecord,
  type LegacyConfigMigrationSpec,
  type LegacyConfigRule,
} from "./legacy.shared.js";

function hasOwnKey(target: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(target, key);
}

function hasLegacyThreadBindingTtl(value: unknown): boolean {
  const threadBindings = getRecord(value);
  return Boolean(threadBindings && hasOwnKey(threadBindings, "ttlHours"));
}

function hasLegacyThreadBindingTtlInAccounts(value: unknown): boolean {
  const accounts = getRecord(value);
  if (!accounts) {
    return false;
  }
  return Object.values(accounts).some((entry) =>
    hasLegacyThreadBindingTtl(getRecord(entry)?.threadBindings),
  );
}

function migrateThreadBindingsTtlHoursForPath(params: {
  owner: Record<string, unknown>;
  pathPrefix: string;
  changes: string[];
}): boolean {
  const threadBindings = getRecord(params.owner.threadBindings);
  if (!threadBindings || !hasOwnKey(threadBindings, "ttlHours")) {
    return false;
  }

  const hadIdleHours = threadBindings.idleHours !== undefined;
  if (!hadIdleHours) {
    threadBindings.idleHours = threadBindings.ttlHours;
  }
  delete threadBindings.ttlHours;
  params.owner.threadBindings = threadBindings;

  if (hadIdleHours) {
    params.changes.push(
      `Removed ${params.pathPrefix}.threadBindings.ttlHours (${params.pathPrefix}.threadBindings.idleHours already set).`,
    );
  } else {
    params.changes.push(
      `Moved ${params.pathPrefix}.threadBindings.ttlHours → ${params.pathPrefix}.threadBindings.idleHours.`,
    );
  }
  return true;
}

function hasLegacyTelegramStreamingKeys(value: unknown): boolean {
  const entry = getRecord(value);
  if (!entry) {
    return false;
  }
  return entry.streamMode !== undefined;
}

function hasLegacyDiscordStreamingKeys(value: unknown): boolean {
  const entry = getRecord(value);
  if (!entry) {
    return false;
  }
  return entry.streamMode !== undefined || typeof entry.streaming === "boolean";
}

function hasLegacySlackStreamingKeys(value: unknown): boolean {
  const entry = getRecord(value);
  if (!entry) {
    return false;
  }
  return entry.streamMode !== undefined || typeof entry.streaming === "boolean";
}

function hasLegacyStreamingKeysInAccounts(
  value: unknown,
  matchEntry: (entry: Record<string, unknown>) => boolean,
): boolean {
  const accounts = getRecord(value);
  if (!accounts) {
    return false;
  }
  return Object.values(accounts).some((entry) => matchEntry(getRecord(entry) ?? {}));
}

const THREAD_BINDING_RULES: LegacyConfigRule[] = [
  {
    path: ["session", "threadBindings"],
    message:
      "session.threadBindings.ttlHours was renamed to session.threadBindings.idleHours (auto-migrated on load).",
    match: (value) => hasLegacyThreadBindingTtl(value),
  },
  {
    path: ["channels", "discord", "threadBindings"],
    message:
      "channels.discord.threadBindings.ttlHours was renamed to channels.discord.threadBindings.idleHours (auto-migrated on load).",
    match: (value) => hasLegacyThreadBindingTtl(value),
  },
  {
    path: ["channels", "discord", "accounts"],
    message:
      "channels.discord.accounts.<id>.threadBindings.ttlHours was renamed to channels.discord.accounts.<id>.threadBindings.idleHours (auto-migrated on load).",
    match: (value) => hasLegacyThreadBindingTtlInAccounts(value),
  },
];

const CHANNEL_STREAMING_RULES: LegacyConfigRule[] = [
  {
    path: ["channels", "telegram"],
    message:
      "channels.telegram.streamMode is legacy; use channels.telegram.streaming instead (auto-migrated on load).",
    match: (value) => hasLegacyTelegramStreamingKeys(value),
  },
  {
    path: ["channels", "telegram", "accounts"],
    message:
      "channels.telegram.accounts.<id>.streamMode is legacy; use channels.telegram.accounts.<id>.streaming instead (auto-migrated on load).",
    match: (value) => hasLegacyStreamingKeysInAccounts(value, hasLegacyTelegramStreamingKeys),
  },
  {
    path: ["channels", "discord"],
    message:
      "channels.discord.streamMode and boolean channels.discord.streaming are legacy; use channels.discord.streaming with enum values instead (auto-migrated on load).",
    match: (value) => hasLegacyDiscordStreamingKeys(value),
  },
  {
    path: ["channels", "discord", "accounts"],
    message:
      "channels.discord.accounts.<id>.streamMode and boolean channels.discord.accounts.<id>.streaming are legacy; use channels.discord.accounts.<id>.streaming with enum values instead (auto-migrated on load).",
    match: (value) => hasLegacyStreamingKeysInAccounts(value, hasLegacyDiscordStreamingKeys),
  },
  {
    path: ["channels", "slack"],
    message:
      "channels.slack.streamMode and boolean channels.slack.streaming are legacy; use channels.slack.streaming with enum values instead (auto-migrated on load).",
    match: (value) => hasLegacySlackStreamingKeys(value),
  },
  {
    path: ["channels", "slack", "accounts"],
    message:
      "channels.slack.accounts.<id>.streamMode and boolean channels.slack.accounts.<id>.streaming are legacy; use channels.slack.accounts.<id>.streaming with enum values instead (auto-migrated on load).",
    match: (value) => hasLegacyStreamingKeysInAccounts(value, hasLegacySlackStreamingKeys),
  },
];

export const LEGACY_CONFIG_MIGRATIONS_CHANNELS: LegacyConfigMigrationSpec[] = [
  defineLegacyConfigMigration({
    id: "thread-bindings.ttlHours->idleHours",
    describe:
      "Move legacy threadBindings.ttlHours keys to threadBindings.idleHours (session + channels.discord)",
    legacyRules: THREAD_BINDING_RULES,
    apply: (raw, changes) => {
      const session = getRecord(raw.session);
      if (session) {
        migrateThreadBindingsTtlHoursForPath({
          owner: session,
          pathPrefix: "session",
          changes,
        });
        raw.session = session;
      }

      const channels = getRecord(raw.channels);
      const discord = getRecord(channels?.discord);
      if (!channels || !discord) {
        return;
      }

      migrateThreadBindingsTtlHoursForPath({
        owner: discord,
        pathPrefix: "channels.discord",
        changes,
      });

      const accounts = getRecord(discord.accounts);
      if (accounts) {
        for (const [accountId, accountRaw] of Object.entries(accounts)) {
          const account = getRecord(accountRaw);
          if (!account) {
            continue;
          }
          migrateThreadBindingsTtlHoursForPath({
            owner: account,
            pathPrefix: `channels.discord.accounts.${accountId}`,
            changes,
          });
          accounts[accountId] = account;
        }
        discord.accounts = accounts;
      }

      channels.discord = discord;
      raw.channels = channels;
    },
  }),
  defineLegacyConfigMigration({
    id: "channels.streaming-keys->channels.streaming",
    describe:
      "Normalize legacy streaming keys to channels.<provider>.streaming (Telegram/Discord/Slack)",
    legacyRules: CHANNEL_STREAMING_RULES,
    apply: (raw, changes) => {
      const channels = getRecord(raw.channels);
      if (!channels) {
        return;
      }

      const migrateProviderEntry = (params: {
        provider: "telegram" | "discord" | "slack";
        entry: Record<string, unknown>;
        pathPrefix: string;
      }) => {
        const migrateCommonStreamingMode = (
          resolveMode: (entry: Record<string, unknown>) => string,
        ) => {
          const hasLegacyStreamMode = params.entry.streamMode !== undefined;
          const legacyStreaming = params.entry.streaming;
          if (!hasLegacyStreamMode && typeof legacyStreaming !== "boolean") {
            return false;
          }
          const resolved = resolveMode(params.entry);
          params.entry.streaming = resolved;
          if (hasLegacyStreamMode) {
            delete params.entry.streamMode;
            changes.push(
              `Moved ${params.pathPrefix}.streamMode → ${params.pathPrefix}.streaming (${resolved}).`,
            );
          }
          if (typeof legacyStreaming === "boolean") {
            changes.push(`Normalized ${params.pathPrefix}.streaming boolean → enum (${resolved}).`);
          }
          return true;
        };

        const hasLegacyStreamMode = params.entry.streamMode !== undefined;
        const legacyStreaming = params.entry.streaming;
        const legacyNativeStreaming = params.entry.nativeStreaming;

        if (params.provider === "telegram") {
          migrateCommonStreamingMode(resolveTelegramPreviewStreamMode);
          return;
        }

        if (params.provider === "discord") {
          migrateCommonStreamingMode(resolveDiscordPreviewStreamMode);
          return;
        }

        if (!hasLegacyStreamMode && typeof legacyStreaming !== "boolean") {
          return;
        }
        const resolvedStreaming = resolveSlackStreamingMode(params.entry);
        const resolvedNativeStreaming = resolveSlackNativeStreaming(params.entry);
        params.entry.streaming = resolvedStreaming;
        params.entry.nativeStreaming = resolvedNativeStreaming;
        if (hasLegacyStreamMode) {
          delete params.entry.streamMode;
          changes.push(formatSlackStreamModeMigrationMessage(params.pathPrefix, resolvedStreaming));
        }
        if (typeof legacyStreaming === "boolean") {
          changes.push(
            formatSlackStreamingBooleanMigrationMessage(params.pathPrefix, resolvedNativeStreaming),
          );
        } else if (typeof legacyNativeStreaming !== "boolean" && hasLegacyStreamMode) {
          changes.push(`Set ${params.pathPrefix}.nativeStreaming → ${resolvedNativeStreaming}.`);
        }
      };

      const migrateProvider = (provider: "telegram" | "discord" | "slack") => {
        const providerEntry = getRecord(channels[provider]);
        if (!providerEntry) {
          return;
        }
        migrateProviderEntry({
          provider,
          entry: providerEntry,
          pathPrefix: `channels.${provider}`,
        });
        const accounts = getRecord(providerEntry.accounts);
        if (!accounts) {
          return;
        }
        for (const [accountId, accountValue] of Object.entries(accounts)) {
          const account = getRecord(accountValue);
          if (!account) {
            continue;
          }
          migrateProviderEntry({
            provider,
            entry: account,
            pathPrefix: `channels.${provider}.accounts.${accountId}`,
          });
        }
      };

      migrateProvider("telegram");
      migrateProvider("discord");
      migrateProvider("slack");
    },
  }),
];
