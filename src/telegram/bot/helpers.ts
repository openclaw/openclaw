import type { Chat, Message, MessageOrigin, User } from "@grammyjs/types";
import { formatLocationText, type NormalizedLocation } from "../../channels/location.js";
import { resolveTelegramPreviewStreamMode } from "../../config/discord-preview-streaming.js";
import type { TelegramGroupConfig, TelegramTopicConfig } from "../../config/types.js";
import { readChannelAllowFromStore } from "../../pairing/pairing-store.js";
import { normalizeAccountId } from "../../routing/session-key.js";
import { firstDefined, normalizeAllowFrom, type NormalizedAllowFrom } from "../bot-access.js";
import type { TelegramStreamMode } from "./types.js";

const TELEGRAM_GENERAL_TOPIC_ID = 1;

export type TelegramThreadSpec = {
  id?: number;
  scope: "dm" | "forum" | "none";
};

export async function resolveTelegramGroupAllowFromContext(params: {
  chatId: string | number;
  accountId?: string;
  isForum?: boolean;
  messageThreadId?: number | null;
  groupAllowFrom?: Array<string | number>;
  resolveTelegramGroupConfig: (
    chatId: string | number,
    messageThreadId?: number,
  ) => { groupConfig?: TelegramGroupConfig; topicConfig?: TelegramTopicConfig };
}): Promise<{
  resolvedThreadId?: number;
  storeAllowFrom: string[];
  groupConfig?: TelegramGroupConfig;
  topicConfig?: TelegramTopicConfig;
  groupAllowOverride?: Array<string | number>;
  effectiveGroupAllow: NormalizedAllowFrom;
  hasGroupAllowOverride: boolean;
}> {
  const accountId = normalizeAccountId(params.accountId);
  const resolvedThreadId = resolveTelegramForumThreadId({
    isForum: params.isForum,
    messageThreadId: params.messageThreadId,
  });
  const storeAllowFrom = await readChannelAllowFromStore("telegram", process.env, accountId).catch(
    () => [],
  );
  const { groupConfig, topicConfig } = params.resolveTelegramGroupConfig(
    params.chatId,
    resolvedThreadId,
  );
  const groupAllowOverride = firstDefined(topicConfig?.allowFrom, groupConfig?.allowFrom);
  // Group sender access must remain explicit (groupAllowFrom/per-group allowFrom only).
  // DM pairing store entries are not a group authorization source.
  const effectiveGroupAllow = normalizeAllowFrom(groupAllowOverride ?? params.groupAllowFrom);
  const hasGroupAllowOverride = typeof groupAllowOverride !== "undefined";
  return {
    resolvedThreadId,
    storeAllowFrom,
    groupConfig,
    topicConfig,
    groupAllowOverride,
    effectiveGroupAllow,
    hasGroupAllowOverride,
  };
}

/**
 * Resolve the thread ID for Telegram forum topics.
 * For non-forum groups, returns undefined even if messageThreadId is present
 * (reply threads in regular groups should not create separate sessions).
 * For forum groups, returns the topic ID (or General topic ID=1 if unspecified).
 */
export function resolveTelegramForumThreadId(params: {
  isForum?: boolean;
  messageThreadId?: number | null;
}) {
  // Non-forum groups: ignore message_thread_id (reply threads are not real topics)
  if (!params.isForum) {
    return undefined;
  }
  // Forum groups: use the topic ID, defaulting to General topic
  if (params.messageThreadId == null) {
    return TELEGRAM_GENERAL_TOPIC_ID;
  }
  return params.messageThreadId;
}

export function resolveTelegramThreadSpec(params: {
  isGroup: boolean;
  isForum?: boolean;
  messageThreadId?: number | null;
}): TelegramThreadSpec {
  if (params.isGroup) {
    const id = resolveTelegramForumThreadId({
      isForum: params.isForum,
      messageThreadId: params.messageThreadId,
    });
    return {
      id,
      scope: params.isForum ? "forum" : "none",
    };
  }
  if (params.messageThreadId == null) {
    return { scope: "dm" };
  }
  return {
    id: params.messageThreadId,
    scope: "dm",
  };
}

/**
 * Build thread params for Telegram API calls (messages, media).
 *
 * IMPORTANT: Thread IDs behave differently based on chat type:
 * - DMs (private chats): Include message_thread_id when present (DM topics)
 * - Forum topics: Skip thread_id=1 (General topic), include others
 * - Regular groups: Thread IDs are ignored by Telegram
 *
 * General forum topic (id=1) must be treated like a regular supergroup send:
 * Telegram rejects sendMessage/sendMedia with message_thread_id=1 ("thread not found").
 *
 * @param thread - Thread specification with ID and scope
 * @returns API params object or undefined if thread_id should be omitted
 */
export function buildTelegramThreadParams(thread?: TelegramThreadSpec | null) {
  if (thread?.id == null) {
    return undefined;
  }
  const normalized = Math.trunc(thread.id);

  if (thread.scope === "dm") {
    return normalized > 0 ? { message_thread_id: normalized } : undefined;
  }

  // Telegram rejects message_thread_id=1 for General forum topic
  if (normalized === TELEGRAM_GENERAL_TOPIC_ID) {
    return undefined;
  }

  return { message_thread_id: normalized };
}

/**
 * Build thread params for typing indicators (sendChatAction).
 * Empirically, General topic (id=1) needs message_thread_id for typing to appear.
 */
export function buildTypingThreadParams(messageThreadId?: number) {
  if (messageThreadId == null) {
    return undefined;
  }
  return { message_thread_id: Math.trunc(messageThreadId) };
}

export function resolveTelegramStreamMode(telegramCfg?: {
  streaming?: unknown;
  streamMode?: unknown;
}): TelegramStreamMode {
  return resolveTelegramPreviewStreamMode(telegramCfg);
}

export function buildTelegramGroupPeerId(chatId: number | string, messageThreadId?: number) {
  return messageThreadId != null ? `${chatId}:topic:${messageThreadId}` : String(chatId);
}

export function buildTelegramGroupFrom(chatId: number | string, messageThreadId?: number) {
  return `telegram:group:${buildTelegramGroupPeerId(chatId, messageThreadId)}`;
}

/**
 * Build parentPeer for forum topic binding inheritance.
 * When a message comes from a forum topic, the peer ID includes the topic suffix
 * (e.g., `-1001234567890:topic:99`). To allow bindings configured for the base
 * group ID to match, we provide the parent group as `parentPeer` so the routing
 * layer can fall back to it when the exact peer doesn't match.
 */
export function buildTelegramParentPeer(params: {
  isGroup: boolean;
  resolvedThreadId?: number;
  chatId: number | string;
}): { kind: "group"; id: string } | undefined {
  if (!params.isGroup || params.resolvedThreadId == null) {
    return undefined;
  }
  return { kind: "group", id: String(params.chatId) };
}

export function buildSenderName(msg: Message) {
  const name =
    [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(" ").trim() ||
    msg.from?.username;
  return name || undefined;
}

export function resolveTelegramMediaPlaceholder(
  msg:
    | Pick<Message, "photo" | "video" | "video_note" | "audio" | "voice" | "document" | "sticker">
    | undefined
    | null,
): string | undefined {
  if (!msg) {
    return undefined;
  }
  if (msg.photo) {
    return "<media:image>";
  }
  if (msg.video || msg.video_note) {
    return "<media:video>";
  }
  if (msg.audio || msg.voice) {
    return "<media:audio>";
  }
  if (msg.document) {
    return "<media:document>";
  }
  if (msg.sticker) {
    return "<media:sticker>";
  }
  return undefined;
}

export function buildSenderLabel(msg: Message, senderId?: number | string) {
  const name = buildSenderName(msg);
  const username = msg.from?.username ? `@${msg.from.username}` : undefined;
  let label = name;
  if (name && username) {
    label = `${name} (${username})`;
  } else if (!name && username) {
    label = username;
  }
  const normalizedSenderId =
    senderId != null && `${senderId}`.trim() ? `${senderId}`.trim() : undefined;
  const fallbackId = normalizedSenderId ?? (msg.from?.id != null ? String(msg.from.id) : undefined);
  const idPart = fallbackId ? `id:${fallbackId}` : undefined;
  if (label && idPart) {
    return `${label} ${idPart}`;
  }
  if (label) {
    return label;
  }
  return idPart ?? "id:unknown";
}

export function buildGroupLabel(msg: Message, chatId: number | string, messageThreadId?: number) {
  const title = msg.chat?.title;
  const topicSuffix = messageThreadId != null ? ` topic:${messageThreadId}` : "";
  if (title) {
    return `${title} id:${chatId}${topicSuffix}`;
  }
  return `group:${chatId}${topicSuffix}`;
}

export function hasBotMention(msg: Message, botUsername: string) {
  const text = (msg.text ?? msg.caption ?? "").toLowerCase();
  if (text.includes(`@${botUsername}`)) {
    return true;
  }
  const entities = msg.entities ?? msg.caption_entities ?? [];
  for (const ent of entities) {
    if (ent.type !== "mention") {
      continue;
    }
    const slice = (msg.text ?? msg.caption ?? "").slice(ent.offset, ent.offset + ent.length);
    if (slice.toLowerCase() === `@${botUsername}`) {
      return true;
    }
  }
  return false;
}

type TelegramTextLinkEntity = {
  type: string;
  offset: number;
  length: number;
  url?: string;
};

export function expandTextLinks(text: string, entities?: TelegramTextLinkEntity[] | null): string {
  if (!text || !entities?.length) {
    return text;
  }

  const textLinks = entities
    .filter(
      (entity): entity is TelegramTextLinkEntity & { url: string } =>
        entity.type === "text_link" && Boolean(entity.url),
    )
    .toSorted((a, b) => b.offset - a.offset);

  if (textLinks.length === 0) {
    return text;
  }

  let result = text;
  for (const entity of textLinks) {
    const linkText = text.slice(entity.offset, entity.offset + entity.length);
    const markdown = `[${linkText}](${entity.url})`;
    result =
      result.slice(0, entity.offset) + markdown + result.slice(entity.offset + entity.length);
  }
  return result;
}

export function resolveTelegramReplyId(raw?: string): number | undefined {
  if (!raw) {
    return undefined;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }
  return parsed;
}

export type TelegramReplyTarget = {
  id?: string;
  sender: string;
  body: string;
  kind: "reply" | "quote";
  /** Forward context if the reply target was itself a forwarded message (issue #9619). */
  forwardedFrom?: TelegramForwardedContext;
};

export function describeReplyTarget(msg: Message): TelegramReplyTarget | null {
  const reply = msg.reply_to_message;
  const externalReply = (msg as Message & { external_reply?: Message }).external_reply;
  const quoteText =
    msg.quote?.text ??
    (externalReply as (Message & { quote?: { text?: string } }) | undefined)?.quote?.text;
  let body = "";
  let kind: TelegramReplyTarget["kind"] = "reply";

  if (typeof quoteText === "string") {
    body = quoteText.trim();
    if (body) {
      kind = "quote";
    }
  }

  const replyLike = reply ?? externalReply;
  if (!body && replyLike) {
    const replyBody = (replyLike.text ?? replyLike.caption ?? "").trim();
    body = replyBody;
    if (!body) {
      body = resolveTelegramMediaPlaceholder(replyLike) ?? "";
      if (!body) {
        const locationData = extractTelegramLocation(replyLike);
        if (locationData) {
          body = formatLocationText(locationData);
        }
      }
    }
  }
  if (!body) {
    return null;
  }
  const sender = replyLike ? buildSenderName(replyLike) : undefined;
  const senderLabel = sender ?? "unknown sender";

  // Extract forward context from the resolved reply target (reply_to_message or external_reply).
  const forwardedFrom = replyLike?.forward_origin
    ? (resolveForwardOrigin(replyLike.forward_origin) ?? undefined)
    : undefined;

  return {
    id: replyLike?.message_id ? String(replyLike.message_id) : undefined,
    sender: senderLabel,
    body,
    kind,
    forwardedFrom,
  };
}

export type TelegramForwardedContext = {
  from: string;
  date?: number;
  fromType: string;
  fromId?: string;
  fromUsername?: string;
  fromTitle?: string;
  fromSignature?: string;
  /** Original chat type from forward_from_chat (e.g. "channel", "supergroup", "group"). */
  fromChatType?: Chat["type"];
  /** Original message ID in the source chat (channel forwards). */
  fromMessageId?: number;
};

function normalizeForwardedUserLabel(user: User) {
  const name = [user.first_name, user.last_name].filter(Boolean).join(" ").trim();
  const username = user.username?.trim() || undefined;
  const id = String(user.id);
  const display =
    (name && username
      ? `${name} (@${username})`
      : name || (username ? `@${username}` : undefined)) || `user:${id}`;
  return { display, name: name || undefined, username, id };
}

function normalizeForwardedChatLabel(chat: Chat, fallbackKind: "chat" | "channel") {
  const title = chat.title?.trim() || undefined;
  const username = chat.username?.trim() || undefined;
  const id = String(chat.id);
  const display = title || (username ? `@${username}` : undefined) || `${fallbackKind}:${id}`;
  return { display, title, username, id };
}

function buildForwardedContextFromUser(params: {
  user: User;
  date?: number;
  type: string;
}): TelegramForwardedContext | null {
  const { display, name, username, id } = normalizeForwardedUserLabel(params.user);
  if (!display) {
    return null;
  }
  return {
    from: display,
    date: params.date,
    fromType: params.type,
    fromId: id,
    fromUsername: username,
    fromTitle: name,
  };
}

function buildForwardedContextFromHiddenName(params: {
  name?: string;
  date?: number;
  type: string;
}): TelegramForwardedContext | null {
  const trimmed = params.name?.trim();
  if (!trimmed) {
    return null;
  }
  return {
    from: trimmed,
    date: params.date,
    fromType: params.type,
    fromTitle: trimmed,
  };
}

function buildForwardedContextFromChat(params: {
  chat: Chat;
  date?: number;
  type: string;
  signature?: string;
  messageId?: number;
}): TelegramForwardedContext | null {
  const fallbackKind = params.type === "channel" ? "channel" : "chat";
  const { display, title, username, id } = normalizeForwardedChatLabel(params.chat, fallbackKind);
  if (!display) {
    return null;
  }
  const signature = params.signature?.trim() || undefined;
  const from = signature ? `${display} (${signature})` : display;
  const chatType = (params.chat.type?.trim() || undefined) as Chat["type"] | undefined;
  return {
    from,
    date: params.date,
    fromType: params.type,
    fromId: id,
    fromUsername: username,
    fromTitle: title,
    fromSignature: signature,
    fromChatType: chatType,
    fromMessageId: params.messageId,
  };
}

function resolveForwardOrigin(origin: MessageOrigin): TelegramForwardedContext | null {
  switch (origin.type) {
    case "user":
      return buildForwardedContextFromUser({
        user: origin.sender_user,
        date: origin.date,
        type: "user",
      });
    case "hidden_user":
      return buildForwardedContextFromHiddenName({
        name: origin.sender_user_name,
        date: origin.date,
        type: "hidden_user",
      });
    case "chat":
      return buildForwardedContextFromChat({
        chat: origin.sender_chat,
        date: origin.date,
        type: "chat",
        signature: origin.author_signature,
      });
    case "channel":
      return buildForwardedContextFromChat({
        chat: origin.chat,
        date: origin.date,
        type: "channel",
        signature: origin.author_signature,
        messageId: origin.message_id,
      });
    default:
      // Exhaustiveness guard: if Grammy adds a new MessageOrigin variant,
      // TypeScript will flag this assignment as an error.
      origin satisfies never;
      return null;
  }
}

/** Extract forwarded message origin info from Telegram message. */
export function normalizeForwardedContext(msg: Message): TelegramForwardedContext | null {
  if (!msg.forward_origin) {
    return null;
  }
  return resolveForwardOrigin(msg.forward_origin);
}

export function extractTelegramLocation(msg: Message): NormalizedLocation | null {
  const { venue, location } = msg;

  if (venue) {
    return {
      latitude: venue.location.latitude,
      longitude: venue.location.longitude,
      accuracy: venue.location.horizontal_accuracy,
      name: venue.title,
      address: venue.address,
      source: "place",
      isLive: false,
    };
  }

  if (location) {
    const isLive = typeof location.live_period === "number" && location.live_period > 0;
    return {
      latitude: location.latitude,
      longitude: location.longitude,
      accuracy: location.horizontal_accuracy,
      source: isLive ? "live" : "pin",
      isLive,
    };
  }

  return null;
}
