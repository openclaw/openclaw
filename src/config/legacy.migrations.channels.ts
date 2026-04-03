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

function hasLegacyThreadBindingTtlInAnyChannel(value: unknown): boolean {
  const channels = getRecord(value);
  if (!channels) {
    return false;
  }
  return Object.values(channels).some((entry) => {
    const channel = getRecord(entry);
    if (!channel) {
      return false;
    }
    return (
      hasLegacyThreadBindingTtl(channel.threadBindings) ||
      hasLegacyThreadBindingTtlInAccounts(channel.accounts)
    );
  });
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

function hasLegacyAllowAlias(entry: Record<string, unknown>): boolean {
  return hasOwnKey(entry, "allow");
}

function migrateAllowAliasForPath(params: {
  entry: Record<string, unknown>;
  pathPrefix: string;
  changes: string[];
}): boolean {
  if (!hasLegacyAllowAlias(params.entry)) {
    return false;
  }

  const legacyAllow = params.entry.allow;
  const hadEnabled = params.entry.enabled !== undefined;
  if (!hadEnabled) {
    params.entry.enabled = legacyAllow;
  }
  delete params.entry.allow;

  if (hadEnabled) {
    params.changes.push(
      `Removed ${params.pathPrefix}.allow (${params.pathPrefix}.enabled already set).`,
    );
  } else {
    params.changes.push(`Moved ${params.pathPrefix}.allow → ${params.pathPrefix}.enabled.`);
  }
  return true;
}

function hasLegacySlackChannelAllowAlias(value: unknown): boolean {
  const entry = getRecord(value);
  const channels = getRecord(entry?.channels);
  if (!channels) {
    return false;
  }
  return Object.values(channels).some((channel) => hasLegacyAllowAlias(getRecord(channel) ?? {}));
}

function hasLegacyGoogleChatGroupAllowAlias(value: unknown): boolean {
  const entry = getRecord(value);
  const groups = getRecord(entry?.groups);
  if (!groups) {
    return false;
  }
  return Object.values(groups).some((group) => hasLegacyAllowAlias(getRecord(group) ?? {}));
}

function hasLegacyDiscordGuildChannelAllowAlias(value: unknown): boolean {
  const entry = getRecord(value);
  const guilds = getRecord(entry?.guilds);
  if (!guilds) {
    return false;
  }
  return Object.values(guilds).some((guildValue) => {
    const channels = getRecord(getRecord(guildValue)?.channels);
    if (!channels) {
      return false;
    }
    return Object.values(channels).some((channel) => hasLegacyAllowAlias(getRecord(channel) ?? {}));
  });
}

const THREAD_BINDING_RULES: LegacyConfigRule[] = [
  {
    path: ["session", "threadBindings"],
    message:
      "session.threadBindings.ttlHours was renamed to session.threadBindings.idleHours (auto-migrated on load).",
    match: (value) => hasLegacyThreadBindingTtl(value),
  },
  {
    path: ["channels"],
    message:
      "channels.<id>.threadBindings.ttlHours was renamed to channels.<id>.threadBindings.idleHours (auto-migrated on load).",
    match: (value) => hasLegacyThreadBindingTtlInAnyChannel(value),
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

const CHANNEL_ENABLED_ALIAS_RULES: LegacyConfigRule[] = [
  {
    path: ["channels", "slack"],
    message:
      "channels.slack.channels.<id>.allow is legacy; use channels.slack.channels.<id>.enabled instead (auto-migrated on load).",
    match: (value) => hasLegacySlackChannelAllowAlias(value),
  },
  {
    path: ["channels", "slack", "accounts"],
    message:
      "channels.slack.accounts.<id>.channels.<id>.allow is legacy; use channels.slack.accounts.<id>.channels.<id>.enabled instead (auto-migrated on load).",
    match: (value) => hasLegacyStreamingKeysInAccounts(value, hasLegacySlackChannelAllowAlias),
  },
  {
    path: ["channels", "googlechat"],
    message:
      "channels.googlechat.groups.<id>.allow is legacy; use channels.googlechat.groups.<id>.enabled instead (auto-migrated on load).",
    match: (value) => hasLegacyGoogleChatGroupAllowAlias(value),
  },
  {
    path: ["channels", "googlechat", "accounts"],
    message:
      "channels.googlechat.accounts.<id>.groups.<id>.allow is legacy; use channels.googlechat.accounts.<id>.groups.<id>.enabled instead (auto-migrated on load).",
    match: (value) => hasLegacyStreamingKeysInAccounts(value, hasLegacyGoogleChatGroupAllowAlias),
  },
  {
    path: ["channels", "discord"],
    message:
      "channels.discord.guilds.<id>.channels.<id>.allow is legacy; use channels.discord.guilds.<id>.channels.<id>.enabled instead (auto-migrated on load).",
    match: (value) => hasLegacyDiscordGuildChannelAllowAlias(value),
  },
  {
    path: ["channels", "discord", "accounts"],
    message:
      "channels.discord.accounts.<id>.guilds.<id>.channels.<id>.allow is legacy; use channels.discord.accounts.<id>.guilds.<id>.channels.<id>.enabled instead (auto-migrated on load).",
    match: (value) =>
      hasLegacyStreamingKeysInAccounts(value, hasLegacyDiscordGuildChannelAllowAlias),
  },
];

export const LEGACY_CONFIG_MIGRATIONS_CHANNELS: LegacyConfigMigrationSpec[] = [
  defineLegacyConfigMigration({
    id: "thread-bindings.ttlHours->idleHours",
    describe:
      "Move legacy threadBindings.ttlHours keys to threadBindings.idleHours (session + channel configs)",
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
      if (!channels) {
        return;
      }

      for (const [channelId, channelRaw] of Object.entries(channels)) {
        const channel = getRecord(channelRaw);
        if (!channel) {
          continue;
        }
        migrateThreadBindingsTtlHoursForPath({
          owner: channel,
          pathPrefix: `channels.${channelId}`,
          changes,
        });

        const accounts = getRecord(channel.accounts);
        if (accounts) {
          for (const [accountId, accountRaw] of Object.entries(accounts)) {
            const account = getRecord(accountRaw);
            if (!account) {
              continue;
            }
            migrateThreadBindingsTtlHoursForPath({
              owner: account,
              pathPrefix: `channels.${channelId}.accounts.${accountId}`,
              changes,
            });
            accounts[accountId] = account;
          }
          channel.accounts = accounts;
        }
        channels[channelId] = channel;
      }
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
  defineLegacyConfigMigration({
    id: "channels.allow->channels.enabled",
    describe:
      "Normalize legacy nested channel allow toggles to enabled (Slack/Google Chat/Discord)",
    legacyRules: CHANNEL_ENABLED_ALIAS_RULES,
    apply: (raw, changes) => {
      const channels = getRecord(raw.channels);
      if (!channels) {
        return;
      }

      const migrateSlackEntry = (entry: Record<string, unknown>, pathPrefix: string) => {
        const channelEntries = getRecord(entry.channels);
        if (!channelEntries) {
          return;
        }
        for (const [channelId, channelRaw] of Object.entries(channelEntries)) {
          const channel = getRecord(channelRaw);
          if (!channel) {
            continue;
          }
          migrateAllowAliasForPath({
            entry: channel,
            pathPrefix: `${pathPrefix}.channels.${channelId}`,
            changes,
          });
          channelEntries[channelId] = channel;
        }
        entry.channels = channelEntries;
      };

      const migrateGoogleChatEntry = (entry: Record<string, unknown>, pathPrefix: string) => {
        const groups = getRecord(entry.groups);
        if (!groups) {
          return;
        }
        for (const [groupId, groupRaw] of Object.entries(groups)) {
          const group = getRecord(groupRaw);
          if (!group) {
            continue;
          }
          migrateAllowAliasForPath({
            entry: group,
            pathPrefix: `${pathPrefix}.groups.${groupId}`,
            changes,
          });
          groups[groupId] = group;
        }
        entry.groups = groups;
      };

      const migrateDiscordEntry = (entry: Record<string, unknown>, pathPrefix: string) => {
        const guilds = getRecord(entry.guilds);
        if (!guilds) {
          return;
        }
        for (const [guildId, guildRaw] of Object.entries(guilds)) {
          const guild = getRecord(guildRaw);
          if (!guild) {
            continue;
          }
          const channelEntries = getRecord(guild.channels);
          if (!channelEntries) {
            guilds[guildId] = guild;
            continue;
          }
          for (const [channelId, channelRaw] of Object.entries(channelEntries)) {
            const channel = getRecord(channelRaw);
            if (!channel) {
              continue;
            }
            migrateAllowAliasForPath({
              entry: channel,
              pathPrefix: `${pathPrefix}.guilds.${guildId}.channels.${channelId}`,
              changes,
            });
            channelEntries[channelId] = channel;
          }
          guild.channels = channelEntries;
          guilds[guildId] = guild;
        }
        entry.guilds = guilds;
      };

      const migrateProviderAccounts = (
        provider: "slack" | "googlechat" | "discord",
        migrateEntry: (entry: Record<string, unknown>, pathPrefix: string) => void,
      ) => {
        const providerEntry = getRecord(channels[provider]);
        if (!providerEntry) {
          return;
        }
        migrateEntry(providerEntry, `channels.${provider}`);
        const accounts = getRecord(providerEntry.accounts);
        if (!accounts) {
          channels[provider] = providerEntry;
          return;
        }
        for (const [accountId, accountRaw] of Object.entries(accounts)) {
          const account = getRecord(accountRaw);
          if (!account) {
            continue;
          }
          migrateEntry(account, `channels.${provider}.accounts.${accountId}`);
          accounts[accountId] = account;
        }
        providerEntry.accounts = accounts;
        channels[provider] = providerEntry;
      };

      migrateProviderAccounts("slack", migrateSlackEntry);
      migrateProviderAccounts("googlechat", migrateGoogleChatEntry);
      migrateProviderAccounts("discord", migrateDiscordEntry);
      raw.channels = channels;
    },
  }),
];
