import { PermissionsBitField, REST, Routes } from "discord.js";
import { PollLayoutType } from "discord-api-types/payloads/v10";
import type { RESTAPIPoll } from "discord-api-types/rest/v10";
import type {
  APIChannel,
  APIGuild,
  APIGuildMember,
  APIGuildScheduledEvent,
  APIMessage,
  APIRole,
  APIVoiceState,
  RESTPostAPIGuildScheduledEventJSONBody,
} from "discord-api-types/v10";

import { chunkText } from "../auto-reply/chunk.js";
import { loadConfig } from "../config/config.js";
import { loadWebMedia, loadWebMediaRaw } from "../web/media.js";
import { normalizeDiscordToken } from "./token.js";

const DISCORD_TEXT_LIMIT = 2000;
const DISCORD_MAX_STICKERS = 3;
const DISCORD_MAX_EMOJI_BYTES = 256 * 1024;
const DISCORD_MAX_STICKER_BYTES = 512 * 1024;
const DISCORD_POLL_MIN_ANSWERS = 2;
const DISCORD_POLL_MAX_ANSWERS = 10;
const DISCORD_POLL_MAX_DURATION_HOURS = 32 * 24;

type DiscordRecipient =
  | {
      kind: "user";
      id: string;
    }
  | {
      kind: "channel";
      id: string;
    };

type DiscordSendOpts = {
  token?: string;
  mediaUrl?: string;
  verbose?: boolean;
  rest?: REST;
  replyTo?: string;
};

export type DiscordSendResult = {
  messageId: string;
  channelId: string;
};

export type DiscordPollInput = {
  question: string;
  answers: string[];
  allowMultiselect?: boolean;
  durationHours?: number;
};

export type DiscordReactOpts = {
  token?: string;
  rest?: REST;
};

export type DiscordReactionUser = {
  id: string;
  username?: string;
  tag?: string;
};

export type DiscordReactionSummary = {
  emoji: { id?: string | null; name?: string | null; raw: string };
  count: number;
  users: DiscordReactionUser[];
};

export type DiscordPermissionsSummary = {
  channelId: string;
  guildId?: string;
  permissions: string[];
  raw: string;
  isDm: boolean;
};

export type DiscordMessageQuery = {
  limit?: number;
  before?: string;
  after?: string;
  around?: string;
};

export type DiscordMessageEdit = {
  content: string;
};

export type DiscordThreadCreate = {
  name: string;
  messageId?: string;
  autoArchiveMinutes?: number;
};

export type DiscordThreadList = {
  guildId: string;
  channelId?: string;
  includeArchived?: boolean;
  before?: string;
  limit?: number;
};

export type DiscordSearchQuery = {
  guildId: string;
  content: string;
  channelIds?: string[];
  authorIds?: string[];
  limit?: number;
};

export type DiscordRoleChange = {
  guildId: string;
  userId: string;
  roleId: string;
};

export type DiscordModerationTarget = {
  guildId: string;
  userId: string;
  reason?: string;
};

export type DiscordTimeoutTarget = DiscordModerationTarget & {
  durationMinutes?: number;
  until?: string;
};

export type DiscordEmojiUpload = {
  guildId: string;
  name: string;
  mediaUrl: string;
  roleIds?: string[];
};

export type DiscordStickerUpload = {
  guildId: string;
  name: string;
  description: string;
  tags: string;
  mediaUrl: string;
};

function resolveToken(explicit?: string) {
  const cfgToken = loadConfig().discord?.token;
  const token = normalizeDiscordToken(
    explicit ?? process.env.DISCORD_BOT_TOKEN ?? cfgToken ?? undefined,
  );
  if (!token) {
    throw new Error(
      "DISCORD_BOT_TOKEN or discord.token is required for Discord sends",
    );
  }
  return token;
}

function normalizeReactionEmoji(raw: string) {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("emoji required");
  }
  const customMatch = trimmed.match(/^<a?:([^:>]+):(\d+)>$/);
  const identifier = customMatch
    ? `${customMatch[1]}:${customMatch[2]}`
    : trimmed.replace(/[\uFE0E\uFE0F]/g, "");
  return encodeURIComponent(identifier);
}

function parseRecipient(raw: string): DiscordRecipient {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("Recipient is required for Discord sends");
  }
  const mentionMatch = trimmed.match(/^<@!?(\d+)>$/);
  if (mentionMatch) {
    return { kind: "user", id: mentionMatch[1] };
  }
  if (trimmed.startsWith("user:")) {
    return { kind: "user", id: trimmed.slice("user:".length) };
  }
  if (trimmed.startsWith("channel:")) {
    return { kind: "channel", id: trimmed.slice("channel:".length) };
  }
  if (trimmed.startsWith("discord:")) {
    return { kind: "user", id: trimmed.slice("discord:".length) };
  }
  if (trimmed.startsWith("@")) {
    const candidate = trimmed.slice(1);
    if (!/^\d+$/.test(candidate)) {
      throw new Error(
        "Discord DMs require a user id (use user:<id> or a <@id> mention)",
      );
    }
    return { kind: "user", id: candidate };
  }
  return { kind: "channel", id: trimmed };
}

function normalizeStickerIds(raw: string[]) {
  const ids = raw.map((entry) => entry.trim()).filter(Boolean);
  if (ids.length === 0) {
    throw new Error("At least one sticker id is required");
  }
  if (ids.length > DISCORD_MAX_STICKERS) {
    throw new Error("Discord supports up to 3 stickers per message");
  }
  return ids;
}

function normalizeEmojiName(raw: string, label: string) {
  const name = raw.trim();
  if (!name) {
    throw new Error(`${label} is required`);
  }
  return name;
}

function normalizePollInput(input: DiscordPollInput): RESTAPIPoll {
  const question = input.question.trim();
  if (!question) {
    throw new Error("Poll question is required");
  }
  const answers = (input.answers ?? [])
    .map((answer) => answer.trim())
    .filter(Boolean);
  if (answers.length < DISCORD_POLL_MIN_ANSWERS) {
    throw new Error("Polls require at least 2 answers");
  }
  if (answers.length > DISCORD_POLL_MAX_ANSWERS) {
    throw new Error("Polls support up to 10 answers");
  }
  const durationRaw =
    typeof input.durationHours === "number" &&
    Number.isFinite(input.durationHours)
      ? Math.floor(input.durationHours)
      : 24;
  const duration = Math.min(
    Math.max(durationRaw, 1),
    DISCORD_POLL_MAX_DURATION_HOURS,
  );
  return {
    question: { text: question },
    answers: answers.map((answer) => ({ poll_media: { text: answer } })),
    duration,
    allow_multiselect: input.allowMultiselect ?? false,
    layout_type: PollLayoutType.Default,
  };
}

async function resolveChannelId(
  rest: REST,
  recipient: DiscordRecipient,
): Promise<{ channelId: string; dm?: boolean }> {
  if (recipient.kind === "channel") {
    return { channelId: recipient.id };
  }
  const dmChannel = (await rest.post(Routes.userChannels(), {
    body: { recipient_id: recipient.id },
  })) as { id: string };
  if (!dmChannel?.id) {
    throw new Error("Failed to create Discord DM channel");
  }
  return { channelId: dmChannel.id, dm: true };
}

async function sendDiscordText(
  rest: REST,
  channelId: string,
  text: string,
  replyTo?: string,
) {
  if (!text.trim()) {
    throw new Error("Message must be non-empty for Discord sends");
  }
  const messageReference = replyTo
    ? { message_id: replyTo, fail_if_not_exists: false }
    : undefined;
  if (text.length <= DISCORD_TEXT_LIMIT) {
    const res = (await rest.post(Routes.channelMessages(channelId), {
      body: { content: text, message_reference: messageReference },
    })) as { id: string; channel_id: string };
    return res;
  }
  const chunks = chunkText(text, DISCORD_TEXT_LIMIT);
  let last: { id: string; channel_id: string } | null = null;
  let isFirst = true;
  for (const chunk of chunks) {
    last = (await rest.post(Routes.channelMessages(channelId), {
      body: {
        content: chunk,
        message_reference: isFirst ? messageReference : undefined,
      },
    })) as { id: string; channel_id: string };
    isFirst = false;
  }
  if (!last) {
    throw new Error("Discord send failed (empty chunk result)");
  }
  return last;
}

async function sendDiscordMedia(
  rest: REST,
  channelId: string,
  text: string,
  mediaUrl: string,
  replyTo?: string,
) {
  const media = await loadWebMedia(mediaUrl);
  const caption =
    text.length > DISCORD_TEXT_LIMIT ? text.slice(0, DISCORD_TEXT_LIMIT) : text;
  const messageReference = replyTo
    ? { message_id: replyTo, fail_if_not_exists: false }
    : undefined;
  const res = (await rest.post(Routes.channelMessages(channelId), {
    body: {
      content: caption || undefined,
      message_reference: messageReference,
    },
    files: [
      {
        data: media.buffer,
        name: media.fileName ?? "upload",
      },
    ],
  })) as { id: string; channel_id: string };
  if (text.length > DISCORD_TEXT_LIMIT) {
    const remaining = text.slice(DISCORD_TEXT_LIMIT).trim();
    if (remaining) {
      await sendDiscordText(rest, channelId, remaining);
    }
  }
  return res;
}

function buildReactionIdentifier(emoji: {
  id?: string | null;
  name?: string | null;
}) {
  if (emoji.id && emoji.name) {
    return `${emoji.name}:${emoji.id}`;
  }
  return emoji.name ?? "";
}

function formatReactionEmoji(emoji: {
  id?: string | null;
  name?: string | null;
}) {
  return buildReactionIdentifier(emoji);
}

async function fetchBotUserId(rest: REST) {
  const me = (await rest.get(Routes.user("@me"))) as { id?: string };
  if (!me?.id) {
    throw new Error("Failed to resolve bot user id");
  }
  return me.id;
}

export async function sendMessageDiscord(
  to: string,
  text: string,
  opts: DiscordSendOpts = {},
): Promise<DiscordSendResult> {
  const token = resolveToken(opts.token);
  const rest = opts.rest ?? new REST({ version: "10" }).setToken(token);
  const recipient = parseRecipient(to);
  const { channelId } = await resolveChannelId(rest, recipient);
  let result:
    | { id: string; channel_id: string }
    | { id: string | null; channel_id: string };

  if (opts.mediaUrl) {
    result = await sendDiscordMedia(
      rest,
      channelId,
      text,
      opts.mediaUrl,
      opts.replyTo,
    );
  } else {
    result = await sendDiscordText(rest, channelId, text, opts.replyTo);
  }

  return {
    messageId: result.id ? String(result.id) : "unknown",
    channelId: String(result.channel_id ?? channelId),
  };
}

export async function sendStickerDiscord(
  to: string,
  stickerIds: string[],
  opts: DiscordSendOpts & { content?: string } = {},
): Promise<DiscordSendResult> {
  const token = resolveToken(opts.token);
  const rest = opts.rest ?? new REST({ version: "10" }).setToken(token);
  const recipient = parseRecipient(to);
  const { channelId } = await resolveChannelId(rest, recipient);
  const content = opts.content?.trim();
  const stickers = normalizeStickerIds(stickerIds);
  const res = (await rest.post(Routes.channelMessages(channelId), {
    body: {
      content: content || undefined,
      sticker_ids: stickers,
    },
  })) as { id: string; channel_id: string };
  return {
    messageId: res.id ? String(res.id) : "unknown",
    channelId: String(res.channel_id ?? channelId),
  };
}

export async function sendPollDiscord(
  to: string,
  poll: DiscordPollInput,
  opts: DiscordSendOpts & { content?: string } = {},
): Promise<DiscordSendResult> {
  const token = resolveToken(opts.token);
  const rest = opts.rest ?? new REST({ version: "10" }).setToken(token);
  const recipient = parseRecipient(to);
  const { channelId } = await resolveChannelId(rest, recipient);
  const content = opts.content?.trim();
  const payload = normalizePollInput(poll);
  const res = (await rest.post(Routes.channelMessages(channelId), {
    body: {
      content: content || undefined,
      poll: payload,
    },
  })) as { id: string; channel_id: string };
  return {
    messageId: res.id ? String(res.id) : "unknown",
    channelId: String(res.channel_id ?? channelId),
  };
}

export async function reactMessageDiscord(
  channelId: string,
  messageId: string,
  emoji: string,
  opts: DiscordReactOpts = {},
) {
  const token = resolveToken(opts.token);
  const rest = opts.rest ?? new REST({ version: "10" }).setToken(token);
  const encoded = normalizeReactionEmoji(emoji);
  await rest.put(
    Routes.channelMessageOwnReaction(channelId, messageId, encoded),
  );
  return { ok: true };
}

export async function fetchReactionsDiscord(
  channelId: string,
  messageId: string,
  opts: DiscordReactOpts & { limit?: number } = {},
): Promise<DiscordReactionSummary[]> {
  const token = resolveToken(opts.token);
  const rest = opts.rest ?? new REST({ version: "10" }).setToken(token);
  const message = (await rest.get(
    Routes.channelMessage(channelId, messageId),
  )) as {
    reactions?: Array<{
      count: number;
      emoji: { id?: string | null; name?: string | null };
    }>;
  };
  const reactions = message.reactions ?? [];
  if (reactions.length === 0) return [];
  const limit =
    typeof opts.limit === "number" && Number.isFinite(opts.limit)
      ? Math.min(Math.max(Math.floor(opts.limit), 1), 100)
      : 100;

  const summaries: DiscordReactionSummary[] = [];
  for (const reaction of reactions) {
    const identifier = buildReactionIdentifier(reaction.emoji);
    if (!identifier) continue;
    const encoded = encodeURIComponent(identifier);
    const users = (await rest.get(
      Routes.channelMessageReaction(channelId, messageId, encoded),
      { query: new URLSearchParams({ limit: String(limit) }) },
    )) as Array<{ id: string; username?: string; discriminator?: string }>;
    summaries.push({
      emoji: {
        id: reaction.emoji.id ?? null,
        name: reaction.emoji.name ?? null,
        raw: formatReactionEmoji(reaction.emoji),
      },
      count: reaction.count,
      users: users.map((user) => ({
        id: user.id,
        username: user.username,
        tag:
          user.username && user.discriminator
            ? `${user.username}#${user.discriminator}`
            : user.username,
      })),
    });
  }
  return summaries;
}

export async function fetchChannelPermissionsDiscord(
  channelId: string,
  opts: DiscordReactOpts = {},
): Promise<DiscordPermissionsSummary> {
  const token = resolveToken(opts.token);
  const rest = opts.rest ?? new REST({ version: "10" }).setToken(token);
  const channel = (await rest.get(Routes.channel(channelId))) as APIChannel;
  const guildId = "guild_id" in channel ? channel.guild_id : undefined;
  if (!guildId) {
    return {
      channelId,
      permissions: [],
      raw: "0",
      isDm: true,
    };
  }

  const botId = await fetchBotUserId(rest);
  const [guild, member] = await Promise.all([
    rest.get(Routes.guild(guildId)) as Promise<APIGuild>,
    rest.get(Routes.guildMember(guildId, botId)) as Promise<APIGuildMember>,
  ]);

  const rolesById = new Map<string, APIRole>(
    (guild.roles ?? []).map((role) => [role.id, role]),
  );
  const base = new PermissionsBitField();
  const everyoneRole = rolesById.get(guildId);
  if (everyoneRole?.permissions) {
    base.add(BigInt(everyoneRole.permissions));
  }
  for (const roleId of member.roles ?? []) {
    const role = rolesById.get(roleId);
    if (role?.permissions) {
      base.add(BigInt(role.permissions));
    }
  }

  const permissions = new PermissionsBitField(base);
  const overwrites =
    "permission_overwrites" in channel
      ? (channel.permission_overwrites ?? [])
      : [];
  for (const overwrite of overwrites) {
    if (overwrite.id === guildId) {
      permissions.remove(BigInt(overwrite.deny ?? "0"));
      permissions.add(BigInt(overwrite.allow ?? "0"));
    }
  }
  for (const overwrite of overwrites) {
    if (member.roles?.includes(overwrite.id)) {
      permissions.remove(BigInt(overwrite.deny ?? "0"));
      permissions.add(BigInt(overwrite.allow ?? "0"));
    }
  }
  for (const overwrite of overwrites) {
    if (overwrite.id === botId) {
      permissions.remove(BigInt(overwrite.deny ?? "0"));
      permissions.add(BigInt(overwrite.allow ?? "0"));
    }
  }

  return {
    channelId,
    guildId,
    permissions: permissions.toArray(),
    raw: permissions.bitfield.toString(),
    isDm: false,
  };
}

export async function readMessagesDiscord(
  channelId: string,
  query: DiscordMessageQuery = {},
  opts: DiscordReactOpts = {},
): Promise<APIMessage[]> {
  const token = resolveToken(opts.token);
  const rest = opts.rest ?? new REST({ version: "10" }).setToken(token);
  const limit =
    typeof query.limit === "number" && Number.isFinite(query.limit)
      ? Math.min(Math.max(Math.floor(query.limit), 1), 100)
      : undefined;
  const params = new URLSearchParams();
  if (limit) params.set("limit", String(limit));
  if (query.before) params.set("before", query.before);
  if (query.after) params.set("after", query.after);
  if (query.around) params.set("around", query.around);
  return (await rest.get(Routes.channelMessages(channelId), {
    query: params,
  })) as APIMessage[];
}

export async function editMessageDiscord(
  channelId: string,
  messageId: string,
  payload: DiscordMessageEdit,
  opts: DiscordReactOpts = {},
): Promise<APIMessage> {
  const token = resolveToken(opts.token);
  const rest = opts.rest ?? new REST({ version: "10" }).setToken(token);
  return (await rest.patch(Routes.channelMessage(channelId, messageId), {
    body: { content: payload.content },
  })) as APIMessage;
}

export async function deleteMessageDiscord(
  channelId: string,
  messageId: string,
  opts: DiscordReactOpts = {},
) {
  const token = resolveToken(opts.token);
  const rest = opts.rest ?? new REST({ version: "10" }).setToken(token);
  await rest.delete(Routes.channelMessage(channelId, messageId));
  return { ok: true };
}

export async function pinMessageDiscord(
  channelId: string,
  messageId: string,
  opts: DiscordReactOpts = {},
) {
  const token = resolveToken(opts.token);
  const rest = opts.rest ?? new REST({ version: "10" }).setToken(token);
  await rest.put(Routes.channelPin(channelId, messageId));
  return { ok: true };
}

export async function unpinMessageDiscord(
  channelId: string,
  messageId: string,
  opts: DiscordReactOpts = {},
) {
  const token = resolveToken(opts.token);
  const rest = opts.rest ?? new REST({ version: "10" }).setToken(token);
  await rest.delete(Routes.channelPin(channelId, messageId));
  return { ok: true };
}

export async function listPinsDiscord(
  channelId: string,
  opts: DiscordReactOpts = {},
): Promise<APIMessage[]> {
  const token = resolveToken(opts.token);
  const rest = opts.rest ?? new REST({ version: "10" }).setToken(token);
  return (await rest.get(Routes.channelPins(channelId))) as APIMessage[];
}

export async function createThreadDiscord(
  channelId: string,
  payload: DiscordThreadCreate,
  opts: DiscordReactOpts = {},
) {
  const token = resolveToken(opts.token);
  const rest = opts.rest ?? new REST({ version: "10" }).setToken(token);
  const body: Record<string, unknown> = { name: payload.name };
  if (payload.autoArchiveMinutes) {
    body.auto_archive_duration = payload.autoArchiveMinutes;
  }
  const route = Routes.threads(channelId, payload.messageId);
  return await rest.post(route, { body });
}

export async function listThreadsDiscord(
  payload: DiscordThreadList,
  opts: DiscordReactOpts = {},
) {
  const token = resolveToken(opts.token);
  const rest = opts.rest ?? new REST({ version: "10" }).setToken(token);
  if (payload.includeArchived) {
    if (!payload.channelId) {
      throw new Error("channelId required to list archived threads");
    }
    const params = new URLSearchParams();
    if (payload.before) params.set("before", payload.before);
    if (payload.limit) params.set("limit", String(payload.limit));
    return await rest.get(Routes.channelThreads(payload.channelId, "public"), {
      query: params,
    });
  }
  return await rest.get(Routes.guildActiveThreads(payload.guildId));
}

export async function searchMessagesDiscord(
  query: DiscordSearchQuery,
  opts: DiscordReactOpts = {},
) {
  const token = resolveToken(opts.token);
  const rest = opts.rest ?? new REST({ version: "10" }).setToken(token);
  const params = new URLSearchParams();
  params.set("content", query.content);
  if (query.channelIds?.length) {
    for (const channelId of query.channelIds) {
      params.append("channel_id", channelId);
    }
  }
  if (query.authorIds?.length) {
    for (const authorId of query.authorIds) {
      params.append("author_id", authorId);
    }
  }
  if (query.limit) {
    const limit = Math.min(Math.max(Math.floor(query.limit), 1), 25);
    params.set("limit", String(limit));
  }
  return await rest.get(`/guilds/${query.guildId}/messages/search`, {
    query: params,
  });
}

export async function listGuildEmojisDiscord(
  guildId: string,
  opts: DiscordReactOpts = {},
) {
  const token = resolveToken(opts.token);
  const rest = opts.rest ?? new REST({ version: "10" }).setToken(token);
  return await rest.get(Routes.guildEmojis(guildId));
}

export async function uploadEmojiDiscord(
  payload: DiscordEmojiUpload,
  opts: DiscordReactOpts = {},
) {
  const token = resolveToken(opts.token);
  const rest = opts.rest ?? new REST({ version: "10" }).setToken(token);
  const media = await loadWebMediaRaw(
    payload.mediaUrl,
    DISCORD_MAX_EMOJI_BYTES,
  );
  const contentType = media.contentType?.toLowerCase();
  if (
    !contentType ||
    !["image/png", "image/jpeg", "image/jpg", "image/gif"].includes(contentType)
  ) {
    throw new Error("Discord emoji uploads require a PNG, JPG, or GIF image");
  }
  const image = `data:${contentType};base64,${media.buffer.toString("base64")}`;
  const roleIds = (payload.roleIds ?? [])
    .map((id) => id.trim())
    .filter(Boolean);
  return await rest.post(Routes.guildEmojis(payload.guildId), {
    body: {
      name: normalizeEmojiName(payload.name, "Emoji name"),
      image,
      roles: roleIds.length ? roleIds : undefined,
    },
  });
}

export async function uploadStickerDiscord(
  payload: DiscordStickerUpload,
  opts: DiscordReactOpts = {},
) {
  const token = resolveToken(opts.token);
  const rest = opts.rest ?? new REST({ version: "10" }).setToken(token);
  const media = await loadWebMediaRaw(
    payload.mediaUrl,
    DISCORD_MAX_STICKER_BYTES,
  );
  const contentType = media.contentType?.toLowerCase();
  if (
    !contentType ||
    !["image/png", "image/apng", "application/json"].includes(contentType)
  ) {
    throw new Error(
      "Discord sticker uploads require a PNG, APNG, or Lottie JSON file",
    );
  }
  return await rest.post(Routes.guildStickers(payload.guildId), {
    body: {
      name: normalizeEmojiName(payload.name, "Sticker name"),
      description: normalizeEmojiName(
        payload.description,
        "Sticker description",
      ),
      tags: normalizeEmojiName(payload.tags, "Sticker tags"),
    },
    files: [
      {
        data: media.buffer,
        name: media.fileName ?? "sticker",
        contentType,
      },
    ],
  });
}

export async function fetchMemberInfoDiscord(
  guildId: string,
  userId: string,
  opts: DiscordReactOpts = {},
): Promise<APIGuildMember> {
  const token = resolveToken(opts.token);
  const rest = opts.rest ?? new REST({ version: "10" }).setToken(token);
  return (await rest.get(
    Routes.guildMember(guildId, userId),
  )) as APIGuildMember;
}

export async function fetchRoleInfoDiscord(
  guildId: string,
  opts: DiscordReactOpts = {},
): Promise<APIRole[]> {
  const token = resolveToken(opts.token);
  const rest = opts.rest ?? new REST({ version: "10" }).setToken(token);
  return (await rest.get(Routes.guildRoles(guildId))) as APIRole[];
}

export async function addRoleDiscord(
  payload: DiscordRoleChange,
  opts: DiscordReactOpts = {},
) {
  const token = resolveToken(opts.token);
  const rest = opts.rest ?? new REST({ version: "10" }).setToken(token);
  await rest.put(
    Routes.guildMemberRole(payload.guildId, payload.userId, payload.roleId),
  );
  return { ok: true };
}

export async function removeRoleDiscord(
  payload: DiscordRoleChange,
  opts: DiscordReactOpts = {},
) {
  const token = resolveToken(opts.token);
  const rest = opts.rest ?? new REST({ version: "10" }).setToken(token);
  await rest.delete(
    Routes.guildMemberRole(payload.guildId, payload.userId, payload.roleId),
  );
  return { ok: true };
}

export async function fetchChannelInfoDiscord(
  channelId: string,
  opts: DiscordReactOpts = {},
): Promise<APIChannel> {
  const token = resolveToken(opts.token);
  const rest = opts.rest ?? new REST({ version: "10" }).setToken(token);
  return (await rest.get(Routes.channel(channelId))) as APIChannel;
}

export async function listGuildChannelsDiscord(
  guildId: string,
  opts: DiscordReactOpts = {},
): Promise<APIChannel[]> {
  const token = resolveToken(opts.token);
  const rest = opts.rest ?? new REST({ version: "10" }).setToken(token);
  return (await rest.get(Routes.guildChannels(guildId))) as APIChannel[];
}

export async function fetchVoiceStatusDiscord(
  guildId: string,
  userId: string,
  opts: DiscordReactOpts = {},
): Promise<APIVoiceState> {
  const token = resolveToken(opts.token);
  const rest = opts.rest ?? new REST({ version: "10" }).setToken(token);
  return (await rest.get(
    Routes.guildVoiceState(guildId, userId),
  )) as APIVoiceState;
}

export async function listScheduledEventsDiscord(
  guildId: string,
  opts: DiscordReactOpts = {},
): Promise<APIGuildScheduledEvent[]> {
  const token = resolveToken(opts.token);
  const rest = opts.rest ?? new REST({ version: "10" }).setToken(token);
  return (await rest.get(
    Routes.guildScheduledEvents(guildId),
  )) as APIGuildScheduledEvent[];
}

export async function createScheduledEventDiscord(
  guildId: string,
  payload: RESTPostAPIGuildScheduledEventJSONBody,
  opts: DiscordReactOpts = {},
): Promise<APIGuildScheduledEvent> {
  const token = resolveToken(opts.token);
  const rest = opts.rest ?? new REST({ version: "10" }).setToken(token);
  return (await rest.post(Routes.guildScheduledEvents(guildId), {
    body: payload,
  })) as APIGuildScheduledEvent;
}

export async function timeoutMemberDiscord(
  payload: DiscordTimeoutTarget,
  opts: DiscordReactOpts = {},
): Promise<APIGuildMember> {
  const token = resolveToken(opts.token);
  const rest = opts.rest ?? new REST({ version: "10" }).setToken(token);
  let until = payload.until;
  if (!until && payload.durationMinutes) {
    const ms = payload.durationMinutes * 60 * 1000;
    until = new Date(Date.now() + ms).toISOString();
  }
  return (await rest.patch(
    Routes.guildMember(payload.guildId, payload.userId),
    {
      body: { communication_disabled_until: until ?? null },
      reason: payload.reason,
    },
  )) as APIGuildMember;
}

export async function kickMemberDiscord(
  payload: DiscordModerationTarget,
  opts: DiscordReactOpts = {},
) {
  const token = resolveToken(opts.token);
  const rest = opts.rest ?? new REST({ version: "10" }).setToken(token);
  await rest.delete(Routes.guildMember(payload.guildId, payload.userId), {
    reason: payload.reason,
  });
  return { ok: true };
}

export async function banMemberDiscord(
  payload: DiscordModerationTarget & { deleteMessageDays?: number },
  opts: DiscordReactOpts = {},
) {
  const token = resolveToken(opts.token);
  const rest = opts.rest ?? new REST({ version: "10" }).setToken(token);
  const deleteMessageDays =
    typeof payload.deleteMessageDays === "number" &&
    Number.isFinite(payload.deleteMessageDays)
      ? Math.min(Math.max(Math.floor(payload.deleteMessageDays), 0), 7)
      : undefined;
  await rest.put(Routes.guildBan(payload.guildId, payload.userId), {
    body:
      deleteMessageDays !== undefined
        ? { delete_message_days: deleteMessageDays }
        : undefined,
    reason: payload.reason,
  });
  return { ok: true };
}
