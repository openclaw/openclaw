import { parseList } from "../format";
import {
  defaultDiscordActions,
  type DiscordActionForm,
  type DiscordGuildChannelForm,
  type DiscordGuildForm,
} from "../ui-types";
import type { ConnectionsState } from "./connections.types";

export async function saveDiscordConfig(state: ConnectionsState) {
  if (!state.client || !state.connected) return;
  if (state.discordSaving) return;
  state.discordSaving = true;
  state.discordConfigStatus = null;
  try {
    const base = state.configSnapshot?.config ?? {};
    const config = { ...base } as Record<string, unknown>;
    const discord = { ...(config.discord ?? {}) } as Record<string, unknown>;
    const form = state.discordForm;

    if (form.enabled) {
      delete discord.enabled;
    } else {
      discord.enabled = false;
    }

    if (!state.discordTokenLocked) {
      const token = form.token.trim();
      if (token) discord.token = token;
      else delete discord.token;
    }

    const allowFrom = parseList(form.allowFrom);
    const groupChannels = parseList(form.groupChannels);
    const dm = { ...(discord.dm ?? {}) } as Record<string, unknown>;
    if (form.dmEnabled) delete dm.enabled;
    else dm.enabled = false;
    if (allowFrom.length > 0) dm.allowFrom = allowFrom;
    else delete dm.allowFrom;
    if (form.groupEnabled) dm.groupEnabled = true;
    else delete dm.groupEnabled;
    if (groupChannels.length > 0) dm.groupChannels = groupChannels;
    else delete dm.groupChannels;
    if (Object.keys(dm).length > 0) discord.dm = dm;
    else delete discord.dm;

    const mediaMaxMb = Number(form.mediaMaxMb);
    if (Number.isFinite(mediaMaxMb) && mediaMaxMb > 0) {
      discord.mediaMaxMb = mediaMaxMb;
    } else {
      delete discord.mediaMaxMb;
    }

    const historyLimitRaw = form.historyLimit.trim();
    if (historyLimitRaw.length === 0) {
      delete discord.historyLimit;
    } else {
      const historyLimit = Number(historyLimitRaw);
      if (Number.isFinite(historyLimit) && historyLimit >= 0) {
        discord.historyLimit = historyLimit;
      } else {
        delete discord.historyLimit;
      }
    }

    const chunkLimitRaw = form.textChunkLimit.trim();
    if (chunkLimitRaw.length === 0) {
      delete discord.textChunkLimit;
    } else {
      const chunkLimit = Number(chunkLimitRaw);
      if (Number.isFinite(chunkLimit) && chunkLimit > 0) {
        discord.textChunkLimit = chunkLimit;
      } else {
        delete discord.textChunkLimit;
      }
    }

    if (form.replyToMode === "off") {
      delete discord.replyToMode;
    } else {
      discord.replyToMode = form.replyToMode;
    }

    const guildsForm = Array.isArray(form.guilds) ? form.guilds : [];
    const guilds: Record<string, unknown> = {};
    guildsForm.forEach((guild: DiscordGuildForm) => {
      const key = String(guild.key ?? "").trim();
      if (!key) return;
      const entry: Record<string, unknown> = {};
      const slug = String(guild.slug ?? "").trim();
      if (slug) entry.slug = slug;
      if (guild.requireMention) entry.requireMention = true;
      if (
        guild.reactionNotifications === "off" ||
        guild.reactionNotifications === "all" ||
        guild.reactionNotifications === "own" ||
        guild.reactionNotifications === "allowlist"
      ) {
        entry.reactionNotifications = guild.reactionNotifications;
      }
      const users = parseList(guild.users);
      if (users.length > 0) entry.users = users;
      const channels: Record<string, unknown> = {};
      const channelForms = Array.isArray(guild.channels) ? guild.channels : [];
      channelForms.forEach((channel: DiscordGuildChannelForm) => {
        const channelKey = String(channel.key ?? "").trim();
        if (!channelKey) return;
        const channelEntry: Record<string, unknown> = {};
        if (channel.allow === false) channelEntry.allow = false;
        if (channel.requireMention) channelEntry.requireMention = true;
        channels[channelKey] = channelEntry;
      });
      if (Object.keys(channels).length > 0) entry.channels = channels;
      guilds[key] = entry;
    });
    if (Object.keys(guilds).length > 0) discord.guilds = guilds;
    else delete discord.guilds;

    const actions: Partial<DiscordActionForm> = {};
    const applyAction = (key: keyof DiscordActionForm) => {
      const value = form.actions[key];
      if (value !== defaultDiscordActions[key]) actions[key] = value;
    };
    applyAction("reactions");
    applyAction("stickers");
    applyAction("polls");
    applyAction("permissions");
    applyAction("messages");
    applyAction("threads");
    applyAction("pins");
    applyAction("search");
    applyAction("memberInfo");
    applyAction("roleInfo");
    applyAction("channelInfo");
    applyAction("voiceStatus");
    applyAction("events");
    applyAction("roles");
    applyAction("moderation");
    if (Object.keys(actions).length > 0) {
      discord.actions = actions;
    } else {
      delete discord.actions;
    }

    const slash = { ...(discord.slashCommand ?? {}) } as Record<string, unknown>;
    if (form.slashEnabled) {
      slash.enabled = true;
    } else {
      delete slash.enabled;
    }
    if (form.slashName.trim()) slash.name = form.slashName.trim();
    else delete slash.name;
    if (form.slashSessionPrefix.trim())
      slash.sessionPrefix = form.slashSessionPrefix.trim();
    else delete slash.sessionPrefix;
    if (form.slashEphemeral) {
      delete slash.ephemeral;
    } else {
      slash.ephemeral = false;
    }
    if (Object.keys(slash).length > 0) discord.slashCommand = slash;
    else delete discord.slashCommand;

    if (Object.keys(discord).length > 0) {
      config.discord = discord;
    } else {
      delete config.discord;
    }

    const raw = `${JSON.stringify(config, null, 2).trimEnd()}\n`;
    await state.client.request("config.set", { raw });
    state.discordConfigStatus = "Saved. Restart gateway if needed.";
  } catch (err) {
    state.discordConfigStatus = String(err);
  } finally {
    state.discordSaving = false;
  }
}

