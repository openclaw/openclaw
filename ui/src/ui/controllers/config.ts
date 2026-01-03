import type { GatewayBrowserClient } from "../gateway";
import type { ConfigSnapshot } from "../types";
import {
  defaultDiscordActions,
  type DiscordActionForm,
  type DiscordForm,
  type DiscordGuildChannelForm,
  type DiscordGuildForm,
  type IMessageForm,
  type SignalForm,
  type TelegramForm,
} from "../ui-types";

export type ConfigState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  configLoading: boolean;
  configRaw: string;
  configValid: boolean | null;
  configIssues: unknown[];
  configSaving: boolean;
  configSnapshot: ConfigSnapshot | null;
  lastError: string | null;
  telegramForm: TelegramForm;
  discordForm: DiscordForm;
  signalForm: SignalForm;
  imessageForm: IMessageForm;
  telegramConfigStatus: string | null;
  discordConfigStatus: string | null;
  signalConfigStatus: string | null;
  imessageConfigStatus: string | null;
};

export async function loadConfig(state: ConfigState) {
  if (!state.client || !state.connected) return;
  state.configLoading = true;
  state.lastError = null;
  try {
    const res = (await state.client.request("config.get", {})) as ConfigSnapshot;
    applyConfigSnapshot(state, res);
  } catch (err) {
    state.lastError = String(err);
  } finally {
    state.configLoading = false;
  }
}

export function applyConfigSnapshot(state: ConfigState, snapshot: ConfigSnapshot) {
  state.configSnapshot = snapshot;
  if (typeof snapshot.raw === "string") {
    state.configRaw = snapshot.raw;
  } else if (snapshot.config && typeof snapshot.config === "object") {
    state.configRaw = `${JSON.stringify(snapshot.config, null, 2).trimEnd()}\n`;
  }
  state.configValid = typeof snapshot.valid === "boolean" ? snapshot.valid : null;
  state.configIssues = Array.isArray(snapshot.issues) ? snapshot.issues : [];

  const config = snapshot.config ?? {};
  const telegram = (config.telegram ?? {}) as Record<string, unknown>;
  const discord = (config.discord ?? {}) as Record<string, unknown>;
  const signal = (config.signal ?? {}) as Record<string, unknown>;
  const imessage = (config.imessage ?? {}) as Record<string, unknown>;
  const toList = (value: unknown) =>
    Array.isArray(value)
      ? value
          .map((v) => String(v ?? "").trim())
          .filter((v) => v.length > 0)
          .join(", ")
      : "";
  const telegramGroups =
    telegram.groups && typeof telegram.groups === "object"
      ? (telegram.groups as Record<string, unknown>)
      : {};
  const telegramDefaultGroup =
    telegramGroups["*"] && typeof telegramGroups["*"] === "object"
      ? (telegramGroups["*"] as Record<string, unknown>)
      : {};
  const allowFrom = Array.isArray(telegram.allowFrom)
    ? toList(telegram.allowFrom)
    : typeof telegram.allowFrom === "string"
      ? telegram.allowFrom
      : "";

  state.telegramForm = {
    token: typeof telegram.botToken === "string" ? telegram.botToken : "",
    requireMention:
      typeof telegramDefaultGroup.requireMention === "boolean"
        ? telegramDefaultGroup.requireMention
        : true,
    allowFrom,
    proxy: typeof telegram.proxy === "string" ? telegram.proxy : "",
    webhookUrl: typeof telegram.webhookUrl === "string" ? telegram.webhookUrl : "",
    webhookSecret:
      typeof telegram.webhookSecret === "string" ? telegram.webhookSecret : "",
    webhookPath: typeof telegram.webhookPath === "string" ? telegram.webhookPath : "",
  };

  const discordDm = (discord.dm ?? {}) as Record<string, unknown>;
  const slash = (discord.slashCommand ?? {}) as Record<string, unknown>;
  const discordActions = (discord.actions ?? {}) as Record<string, unknown>;
  const discordGuilds = discord.guilds;
  const readAction = (key: keyof DiscordActionForm) =>
    typeof discordActions[key] === "boolean"
      ? (discordActions[key] as boolean)
      : defaultDiscordActions[key];
  state.discordForm = {
    enabled: typeof discord.enabled === "boolean" ? discord.enabled : true,
    token: typeof discord.token === "string" ? discord.token : "",
    dmEnabled: typeof discordDm.enabled === "boolean" ? discordDm.enabled : true,
    allowFrom: toList(discordDm.allowFrom),
    groupEnabled:
      typeof discordDm.groupEnabled === "boolean" ? discordDm.groupEnabled : false,
    groupChannels: toList(discordDm.groupChannels),
    mediaMaxMb:
      typeof discord.mediaMaxMb === "number" ? String(discord.mediaMaxMb) : "",
    historyLimit:
      typeof discord.historyLimit === "number" ? String(discord.historyLimit) : "",
    textChunkLimit:
      typeof discord.textChunkLimit === "number"
        ? String(discord.textChunkLimit)
        : "",
    replyToMode:
      discord.replyToMode === "first" || discord.replyToMode === "all"
        ? discord.replyToMode
        : "off",
    guilds: Array.isArray(discordGuilds)
      ? []
      : typeof discordGuilds === "object" && discordGuilds
        ? Object.entries(discordGuilds as Record<string, unknown>).map(
            ([key, value]): DiscordGuildForm => {
              const entry =
                value && typeof value === "object"
                  ? (value as Record<string, unknown>)
                  : {};
              const channelsRaw =
                entry.channels && typeof entry.channels === "object"
                  ? (entry.channels as Record<string, unknown>)
                  : {};
              const channels = Object.entries(channelsRaw).map(
                ([channelKey, channelValue]): DiscordGuildChannelForm => {
                  const channel =
                    channelValue && typeof channelValue === "object"
                      ? (channelValue as Record<string, unknown>)
                      : {};
                  return {
                    key: channelKey,
                    allow:
                      typeof channel.allow === "boolean" ? channel.allow : true,
                    requireMention:
                      typeof channel.requireMention === "boolean"
                        ? channel.requireMention
                        : false,
                  };
                },
              );
              return {
                key,
                slug: typeof entry.slug === "string" ? entry.slug : "",
                requireMention:
                  typeof entry.requireMention === "boolean"
                    ? entry.requireMention
                    : false,
                users: toList(entry.users),
                channels,
              };
            },
          )
        : [],
    actions: {
      reactions: readAction("reactions"),
      stickers: readAction("stickers"),
      polls: readAction("polls"),
      permissions: readAction("permissions"),
      messages: readAction("messages"),
      threads: readAction("threads"),
      pins: readAction("pins"),
      search: readAction("search"),
      memberInfo: readAction("memberInfo"),
      roleInfo: readAction("roleInfo"),
      channelInfo: readAction("channelInfo"),
      voiceStatus: readAction("voiceStatus"),
      events: readAction("events"),
      roles: readAction("roles"),
      moderation: readAction("moderation"),
    },
    slashEnabled: typeof slash.enabled === "boolean" ? slash.enabled : false,
    slashName: typeof slash.name === "string" ? slash.name : "",
    slashSessionPrefix:
      typeof slash.sessionPrefix === "string" ? slash.sessionPrefix : "",
    slashEphemeral:
      typeof slash.ephemeral === "boolean" ? slash.ephemeral : true,
  };

  state.signalForm = {
    enabled: typeof signal.enabled === "boolean" ? signal.enabled : true,
    account: typeof signal.account === "string" ? signal.account : "",
    httpUrl: typeof signal.httpUrl === "string" ? signal.httpUrl : "",
    httpHost: typeof signal.httpHost === "string" ? signal.httpHost : "",
    httpPort: typeof signal.httpPort === "number" ? String(signal.httpPort) : "",
    cliPath: typeof signal.cliPath === "string" ? signal.cliPath : "",
    autoStart: typeof signal.autoStart === "boolean" ? signal.autoStart : true,
    receiveMode:
      signal.receiveMode === "on-start" || signal.receiveMode === "manual"
        ? signal.receiveMode
        : "",
    ignoreAttachments:
      typeof signal.ignoreAttachments === "boolean" ? signal.ignoreAttachments : false,
    ignoreStories:
      typeof signal.ignoreStories === "boolean" ? signal.ignoreStories : false,
    sendReadReceipts:
      typeof signal.sendReadReceipts === "boolean" ? signal.sendReadReceipts : false,
    allowFrom: toList(signal.allowFrom),
    mediaMaxMb:
      typeof signal.mediaMaxMb === "number" ? String(signal.mediaMaxMb) : "",
  };

  state.imessageForm = {
    enabled: typeof imessage.enabled === "boolean" ? imessage.enabled : true,
    cliPath: typeof imessage.cliPath === "string" ? imessage.cliPath : "",
    dbPath: typeof imessage.dbPath === "string" ? imessage.dbPath : "",
    service:
      imessage.service === "imessage" ||
      imessage.service === "sms" ||
      imessage.service === "auto"
        ? imessage.service
        : "auto",
    region: typeof imessage.region === "string" ? imessage.region : "",
    allowFrom: toList(imessage.allowFrom),
    includeAttachments:
      typeof imessage.includeAttachments === "boolean"
        ? imessage.includeAttachments
        : false,
    mediaMaxMb:
      typeof imessage.mediaMaxMb === "number" ? String(imessage.mediaMaxMb) : "",
  };

  const configInvalid = snapshot.valid === false ? "Config invalid." : null;
  state.telegramConfigStatus = configInvalid;
  state.discordConfigStatus = configInvalid;
  state.signalConfigStatus = configInvalid;
  state.imessageConfigStatus = configInvalid;
}

export async function saveConfig(state: ConfigState) {
  if (!state.client || !state.connected) return;
  state.configSaving = true;
  state.lastError = null;
  try {
    await state.client.request("config.set", { raw: state.configRaw });
    await loadConfig(state);
  } catch (err) {
    state.lastError = String(err);
  } finally {
    state.configSaving = false;
  }
}
