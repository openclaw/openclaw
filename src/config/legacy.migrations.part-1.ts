import {
  formatSlackStreamingBooleanMigrationMessage,
  formatSlackStreamModeMigrationMessage,
  resolveDiscordPreviewStreamMode,
  resolveSlackNativeStreaming,
  resolveSlackStreamingMode,
  resolveTelegramPreviewStreamMode,
} from "./discord-preview-streaming.js";
import {
  ensureRecord,
  getRecord,
  isRecord,
  type LegacyConfigMigration,
  mergeMissing,
} from "./legacy.shared.js";

function migrateBindings(
  raw: Record<string, unknown>,
  changes: string[],
  changeNote: string,
  mutator: (match: Record<string, unknown>) => boolean,
) {
  const bindings = Array.isArray(raw.bindings) ? raw.bindings : null;
  if (!bindings) {
    return;
  }

  let touched = false;
  for (const entry of bindings) {
    if (!isRecord(entry)) {
      continue;
    }
    const match = getRecord(entry.match);
    if (!match) {
      continue;
    }
    if (!mutator(match)) {
      continue;
    }
    entry.match = match;
    touched = true;
  }

  if (touched) {
    raw.bindings = bindings;
    changes.push(changeNote);
  }
}

function ensureDefaultGroupEntry(section: Record<string, unknown>): {
  groups: Record<string, unknown>;
  entry: Record<string, unknown>;
} {
  const groups: Record<string, unknown> = isRecord(section.groups) ? section.groups : {};
  const defaultKey = "*";
  const entry: Record<string, unknown> = isRecord(groups[defaultKey]) ? groups[defaultKey] : {};
  return { groups, entry };
}

function hasOwnKey(target: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(target, key);
}

function escapeControlForLog(value: string): string {
  return value.replace(/\r/g, "\\r").replace(/\n/g, "\\n").replace(/\t/g, "\\t");
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

function normalizeLegacyAllowFromList(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const normalized = value
    .map((entry) => {
      if (typeof entry === "string" || typeof entry === "number") {
        return String(entry).trim();
      }
      return "";
    })
    .filter(Boolean);
  return [...new Set(normalized)];
}

function isNumericKey(value: string): boolean {
  return /^\d+$/.test(value.trim());
}

function resolveDiscordModelOverrideTargetKey(params: {
  guildKey: string;
  channelKey: string;
  accountId?: string;
}): string {
  const guildKey = params.guildKey.trim();
  const channelKey = params.channelKey.trim();
  const scopedOrFallback = isNumericKey(guildKey) ? `${guildKey}:${channelKey}` : channelKey;
  return params.accountId ? `${params.accountId}:${scopedOrFallback}` : scopedOrFallback;
}

function migrateDiscordGuildChannelLegacyConfigWriteKeys(params: {
  raw: Record<string, unknown>;
  owner: Record<string, unknown>;
  pathPrefix: string;
  changes: string[];
  accountId?: string;
}) {
  const guilds = getRecord(params.owner.guilds);
  if (!guilds) {
    return;
  }

  let discordModelByChannel: Record<string, unknown> | null = null;
  const ensureDiscordModelByChannel = () => {
    if (discordModelByChannel) {
      return discordModelByChannel;
    }
    const channels = ensureRecord(params.raw, "channels");
    const modelByChannel = ensureRecord(channels, "modelByChannel");
    discordModelByChannel = ensureRecord(modelByChannel, "discord");
    return discordModelByChannel;
  };

  for (const [guildId, guildRaw] of Object.entries(guilds)) {
    const guild = getRecord(guildRaw);
    if (!guild) {
      continue;
    }
    const channels = getRecord(guild.channels);
    if (!channels) {
      continue;
    }

    for (const [channelId, channelRaw] of Object.entries(channels)) {
      const channel = getRecord(channelRaw);
      if (!channel) {
        continue;
      }
      const pathPrefix = `${params.pathPrefix}.guilds.${guildId}.channels.${channelId}`;

      if (hasOwnKey(channel, "allowFrom")) {
        const allowFrom = normalizeLegacyAllowFromList(channel.allowFrom);
        if (channel.users === undefined && allowFrom && allowFrom.length > 0) {
          channel.users = allowFrom;
          params.changes.push(`Moved ${pathPrefix}.allowFrom → ${pathPrefix}.users.`);
        } else if (channel.users !== undefined) {
          params.changes.push(`Removed ${pathPrefix}.allowFrom (${pathPrefix}.users already set).`);
        } else {
          params.changes.push(`Removed ${pathPrefix}.allowFrom (invalid value).`);
        }
        delete channel.allowFrom;
      }

      if (hasOwnKey(channel, "groupPolicy")) {
        const groupPolicy =
          typeof channel.groupPolicy === "string" ? channel.groupPolicy.trim().toLowerCase() : "";
        const mappedAllow =
          groupPolicy === "disabled"
            ? false
            : groupPolicy === "open" || groupPolicy === "allowlist"
              ? true
              : undefined;
        if (channel.allow === undefined && mappedAllow !== undefined) {
          channel.allow = mappedAllow;
          params.changes.push(
            `Mapped ${pathPrefix}.groupPolicy="${groupPolicy}" → ${pathPrefix}.allow=${String(mappedAllow)}.`,
          );
        } else if (channel.allow !== undefined) {
          params.changes.push(
            `Removed ${pathPrefix}.groupPolicy (${pathPrefix}.allow already set).`,
          );
        } else {
          params.changes.push(`Removed ${pathPrefix}.groupPolicy (invalid value).`);
        }
        delete channel.groupPolicy;
      }

      if (hasOwnKey(channel, "model")) {
        const model = typeof channel.model === "string" ? channel.model.trim() : "";
        if (model) {
          const modelByChannel = ensureDiscordModelByChannel();
          const targetKey = resolveDiscordModelOverrideTargetKey({
            guildKey: guildId,
            channelKey: channelId,
            accountId: params.accountId,
          });
          const existingTarget =
            typeof modelByChannel[targetKey] === "string"
              ? String(modelByChannel[targetKey]).trim()
              : "";
          const existingUnscoped =
            typeof modelByChannel[channelId] === "string"
              ? String(modelByChannel[channelId]).trim()
              : "";
          if (!existingTarget && !existingUnscoped) {
            modelByChannel[targetKey] = model;
            params.changes.push(
              `Moved ${pathPrefix}.model → channels.modelByChannel.discord.${targetKey}.`,
            );
          } else if (existingTarget) {
            params.changes.push(
              `Removed ${pathPrefix}.model (channels.modelByChannel.discord.${targetKey} already set).`,
            );
          } else {
            params.changes.push(
              `Removed ${pathPrefix}.model (channels.modelByChannel.discord.${channelId} already set).`,
            );
          }
        } else {
          params.changes.push(`Removed ${pathPrefix}.model (invalid value).`);
        }
        delete channel.model;
      }

      channels[channelId] = channel;
    }

    guild.channels = channels;
    guilds[guildId] = guild;
  }

  params.owner.guilds = guilds;
}

export const LEGACY_CONFIG_MIGRATIONS_PART_1: LegacyConfigMigration[] = [
  {
    id: "bindings.match.provider->bindings.match.channel",
    describe: "Move bindings[].match.provider to bindings[].match.channel",
    apply: (raw, changes) => {
      migrateBindings(
        raw,
        changes,
        "Moved bindings[].match.provider → bindings[].match.channel.",
        (match) => {
          if (typeof match.channel === "string" && match.channel.trim()) {
            return false;
          }
          const provider = typeof match.provider === "string" ? match.provider.trim() : "";
          if (!provider) {
            return false;
          }
          match.channel = provider;
          delete match.provider;
          return true;
        },
      );
    },
  },
  {
    id: "bindings.match.accountID->bindings.match.accountId",
    describe: "Move bindings[].match.accountID to bindings[].match.accountId",
    apply: (raw, changes) => {
      migrateBindings(
        raw,
        changes,
        "Moved bindings[].match.accountID → bindings[].match.accountId.",
        (match) => {
          if (match.accountId !== undefined) {
            return false;
          }
          const accountID =
            typeof match.accountID === "string" ? match.accountID.trim() : match.accountID;
          if (!accountID) {
            return false;
          }
          match.accountId = accountID;
          delete match.accountID;
          return true;
        },
      );
    },
  },
  {
    id: "session.sendPolicy.rules.match.provider->match.channel",
    describe: "Move session.sendPolicy.rules[].match.provider to match.channel",
    apply: (raw, changes) => {
      const session = getRecord(raw.session);
      if (!session) {
        return;
      }
      const sendPolicy = getRecord(session.sendPolicy);
      if (!sendPolicy) {
        return;
      }
      const rules = Array.isArray(sendPolicy.rules) ? sendPolicy.rules : null;
      if (!rules) {
        return;
      }

      let touched = false;
      for (const rule of rules) {
        if (!isRecord(rule)) {
          continue;
        }
        const match = getRecord(rule.match);
        if (!match) {
          continue;
        }
        if (typeof match.channel === "string" && match.channel.trim()) {
          continue;
        }
        const provider = typeof match.provider === "string" ? match.provider.trim() : "";
        if (!provider) {
          continue;
        }
        match.channel = provider;
        delete match.provider;
        rule.match = match;
        touched = true;
      }

      if (touched) {
        sendPolicy.rules = rules;
        session.sendPolicy = sendPolicy;
        raw.session = session;
        changes.push("Moved session.sendPolicy.rules[].match.provider → match.channel.");
      }
    },
  },
  {
    id: "messages.queue.byProvider->byChannel",
    describe: "Move messages.queue.byProvider to messages.queue.byChannel",
    apply: (raw, changes) => {
      const messages = getRecord(raw.messages);
      if (!messages) {
        return;
      }
      const queue = getRecord(messages.queue);
      if (!queue) {
        return;
      }
      if (queue.byProvider === undefined) {
        return;
      }
      if (queue.byChannel === undefined) {
        queue.byChannel = queue.byProvider;
        changes.push("Moved messages.queue.byProvider → messages.queue.byChannel.");
      } else {
        changes.push("Removed messages.queue.byProvider (messages.queue.byChannel already set).");
      }
      delete queue.byProvider;
      messages.queue = queue;
      raw.messages = messages;
    },
  },
  {
    id: "providers->channels",
    describe: "Move provider config sections to channels.*",
    apply: (raw, changes) => {
      const legacyKeys = [
        "whatsapp",
        "telegram",
        "discord",
        "slack",
        "signal",
        "imessage",
        "msteams",
      ];
      const legacyEntries = legacyKeys.filter((key) => isRecord(raw[key]));
      if (legacyEntries.length === 0) {
        return;
      }

      const channels = ensureRecord(raw, "channels");
      for (const key of legacyEntries) {
        const legacy = getRecord(raw[key]);
        if (!legacy) {
          continue;
        }
        const channelEntry = ensureRecord(channels, key);
        const hadEntries = Object.keys(channelEntry).length > 0;
        mergeMissing(channelEntry, legacy);
        channels[key] = channelEntry;
        delete raw[key];
        changes.push(
          hadEntries ? `Merged ${key} → channels.${key}.` : `Moved ${key} → channels.${key}.`,
        );
      }
      raw.channels = channels;
    },
  },
  {
    id: "thread-bindings.ttlHours->idleHours",
    describe:
      "Move legacy threadBindings.ttlHours keys to threadBindings.idleHours (session + channels.discord)",
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
  },
  {
    id: "channels.discord.guild-channel-config-write-keys",
    describe:
      "Migrate legacy Discord guild channel config-write keys (allowFrom/groupPolicy/model)",
    apply: (raw, changes) => {
      const channels = getRecord(raw.channels);
      const discord = getRecord(channels?.discord);
      if (!channels || !discord) {
        return;
      }

      migrateDiscordGuildChannelLegacyConfigWriteKeys({
        raw,
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
          migrateDiscordGuildChannelLegacyConfigWriteKeys({
            raw,
            owner: account,
            pathPrefix: `channels.discord.accounts.${accountId}`,
            changes,
            accountId,
          });
          accounts[accountId] = account;
        }
        discord.accounts = accounts;
      }

      channels.discord = discord;
      raw.channels = channels;
    },
  },
  {
    id: "channels.streaming-keys->channels.streaming",
    describe:
      "Normalize legacy streaming keys to channels.<provider>.streaming (Telegram/Discord/Slack)",
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
  },
  {
    id: "routing.allowFrom->channels.whatsapp.allowFrom",
    describe: "Move routing.allowFrom to channels.whatsapp.allowFrom",
    apply: (raw, changes) => {
      const routing = raw.routing;
      if (!routing || typeof routing !== "object") {
        return;
      }
      const allowFrom = (routing as Record<string, unknown>).allowFrom;
      if (allowFrom === undefined) {
        return;
      }

      const channels = getRecord(raw.channels);
      const whatsapp = channels ? getRecord(channels.whatsapp) : null;
      if (!whatsapp) {
        delete (routing as Record<string, unknown>).allowFrom;
        if (Object.keys(routing as Record<string, unknown>).length === 0) {
          delete raw.routing;
        }
        changes.push("Removed routing.allowFrom (channels.whatsapp not configured).");
        return;
      }

      if (whatsapp.allowFrom === undefined) {
        whatsapp.allowFrom = allowFrom;
        changes.push("Moved routing.allowFrom → channels.whatsapp.allowFrom.");
      } else {
        changes.push("Removed routing.allowFrom (channels.whatsapp.allowFrom already set).");
      }

      delete (routing as Record<string, unknown>).allowFrom;
      if (Object.keys(routing as Record<string, unknown>).length === 0) {
        delete raw.routing;
      }
      channels!.whatsapp = whatsapp;
      raw.channels = channels!;
    },
  },
  {
    id: "routing.groupChat.requireMention->groups.*.requireMention",
    describe: "Move routing.groupChat.requireMention to channels.whatsapp/telegram/imessage groups",
    apply: (raw, changes) => {
      const routing = raw.routing;
      if (!routing || typeof routing !== "object") {
        return;
      }
      const groupChat =
        (routing as Record<string, unknown>).groupChat &&
        typeof (routing as Record<string, unknown>).groupChat === "object"
          ? ((routing as Record<string, unknown>).groupChat as Record<string, unknown>)
          : null;
      if (!groupChat) {
        return;
      }
      const requireMention = groupChat.requireMention;
      if (requireMention === undefined) {
        return;
      }

      const channels = ensureRecord(raw, "channels");
      const applyTo = (
        key: "whatsapp" | "telegram" | "imessage",
        options?: { requireExisting?: boolean },
      ) => {
        if (options?.requireExisting && !isRecord(channels[key])) {
          return;
        }
        const section =
          channels[key] && typeof channels[key] === "object"
            ? (channels[key] as Record<string, unknown>)
            : {};
        const { groups, entry } = ensureDefaultGroupEntry(section);
        const defaultKey = "*";
        if (entry.requireMention === undefined) {
          entry.requireMention = requireMention;
          groups[defaultKey] = entry;
          section.groups = groups;
          channels[key] = section;
          changes.push(
            `Moved routing.groupChat.requireMention → channels.${key}.groups."*".requireMention.`,
          );
        } else {
          changes.push(
            `Removed routing.groupChat.requireMention (channels.${key}.groups."*" already set).`,
          );
        }
      };

      applyTo("whatsapp", { requireExisting: true });
      applyTo("telegram");
      applyTo("imessage");

      delete groupChat.requireMention;
      if (Object.keys(groupChat).length === 0) {
        delete (routing as Record<string, unknown>).groupChat;
      }
      if (Object.keys(routing as Record<string, unknown>).length === 0) {
        delete raw.routing;
      }
      raw.channels = channels;
    },
  },
  {
    id: "gateway.token->gateway.auth.token",
    describe: "Move gateway.token to gateway.auth.token",
    apply: (raw, changes) => {
      const gateway = raw.gateway;
      if (!gateway || typeof gateway !== "object") {
        return;
      }
      const token = (gateway as Record<string, unknown>).token;
      if (token === undefined) {
        return;
      }

      const gatewayObj = gateway as Record<string, unknown>;
      const auth =
        gatewayObj.auth && typeof gatewayObj.auth === "object"
          ? (gatewayObj.auth as Record<string, unknown>)
          : {};
      if (auth.token === undefined) {
        auth.token = token;
        if (!auth.mode) {
          auth.mode = "token";
        }
        changes.push("Moved gateway.token → gateway.auth.token.");
      } else {
        changes.push("Removed gateway.token (gateway.auth.token already set).");
      }
      delete gatewayObj.token;
      if (Object.keys(auth).length > 0) {
        gatewayObj.auth = auth;
      }
      raw.gateway = gatewayObj;
    },
  },
  {
    id: "gateway.bind.host-alias->bind-mode",
    describe: "Normalize gateway.bind host aliases to supported bind modes",
    apply: (raw, changes) => {
      const gateway = getRecord(raw.gateway);
      if (!gateway) {
        return;
      }
      const bindRaw = gateway.bind;
      if (typeof bindRaw !== "string") {
        return;
      }

      const normalized = bindRaw.trim().toLowerCase();
      let mapped: "lan" | "loopback" | undefined;
      if (
        normalized === "0.0.0.0" ||
        normalized === "::" ||
        normalized === "[::]" ||
        normalized === "*"
      ) {
        mapped = "lan";
      } else if (
        normalized === "127.0.0.1" ||
        normalized === "localhost" ||
        normalized === "::1" ||
        normalized === "[::1]"
      ) {
        mapped = "loopback";
      }

      if (!mapped || normalized === mapped) {
        return;
      }

      gateway.bind = mapped;
      raw.gateway = gateway;
      changes.push(`Normalized gateway.bind "${escapeControlForLog(bindRaw)}" → "${mapped}".`);
    },
  },
  {
    id: "telegram.requireMention->channels.telegram.groups.*.requireMention",
    describe: "Move telegram.requireMention to channels.telegram.groups.*.requireMention",
    apply: (raw, changes) => {
      const channels = ensureRecord(raw, "channels");
      const telegram = channels.telegram;
      if (!telegram || typeof telegram !== "object") {
        return;
      }
      const requireMention = (telegram as Record<string, unknown>).requireMention;
      if (requireMention === undefined) {
        return;
      }

      const { groups, entry } = ensureDefaultGroupEntry(telegram as Record<string, unknown>);
      const defaultKey = "*";

      if (entry.requireMention === undefined) {
        entry.requireMention = requireMention;
        groups[defaultKey] = entry;
        (telegram as Record<string, unknown>).groups = groups;
        changes.push(
          'Moved telegram.requireMention → channels.telegram.groups."*".requireMention.',
        );
      } else {
        changes.push('Removed telegram.requireMention (channels.telegram.groups."*" already set).');
      }

      delete (telegram as Record<string, unknown>).requireMention;
      channels.telegram = telegram as Record<string, unknown>;
      raw.channels = channels;
    },
  },
];
