import type { ChannelType, Client, Message } from "@buape/carbon";
import { StickerFormatType, type APIAttachment, type APIStickerItem } from "discord-api-types/v10";
import { buildMediaPayload } from "../../channels/plugins/media-payload.js";
import { logVerbose } from "../../globals.js";
import { fetchRemoteMedia } from "../../media/fetch.js";
import { saveMediaBuffer } from "../../media/store.js";

export type DiscordMediaInfo = {
  path: string;
  contentType?: string;
  placeholder: string;
};

export type DiscordChannelInfo = {
  type: ChannelType;
  name?: string;
  topic?: string;
  parentId?: string;
  ownerId?: string;
};

type DiscordMessageWithChannelId = Message & {
  channel_id?: unknown;
  rawData?: { channel_id?: unknown };
};

type DiscordSnapshotAuthor = {
  id?: string | null;
  username?: string | null;
  discriminator?: string | null;
  global_name?: string | null;
  name?: string | null;
};

type DiscordSnapshotMessage = {
  content?: string | null;
  embeds?: Array<{ description?: string | null; title?: string | null }> | null;
  attachments?: APIAttachment[] | null;
  stickers?: APIStickerItem[] | null;
  sticker_items?: APIStickerItem[] | null;
  author?: DiscordSnapshotAuthor | null;
};

type DiscordMessageSnapshot = {
  message?: DiscordSnapshotMessage | null;
};

const DISCORD_CHANNEL_INFO_CACHE_TTL_MS = 5 * 60 * 1000;
const DISCORD_CHANNEL_INFO_NEGATIVE_CACHE_TTL_MS = 30 * 1000;
const DISCORD_CHANNEL_INFO_CACHE = new Map<
  string,
  { value: DiscordChannelInfo | null; expiresAt: number }
>();
const DISCORD_STICKER_ASSET_BASE_URL = "https://media.discordapp.net/stickers";

export function __resetDiscordChannelInfoCacheForTest() {
  DISCORD_CHANNEL_INFO_CACHE.clear();
}

function normalizeDiscordChannelId(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }
  if (typeof value === "number" || typeof value === "bigint") {
    return String(value).trim();
  }
  return "";
}

export function resolveDiscordMessageChannelId(params: {
  message: Message;
  eventChannelId?: string | number | null;
}): string {
  const message = params.message as DiscordMessageWithChannelId;
  return (
    normalizeDiscordChannelId(message.channelId) ||
    normalizeDiscordChannelId(message.channel_id) ||
    normalizeDiscordChannelId(message.rawData?.channel_id) ||
    normalizeDiscordChannelId(params.eventChannelId)
  );
}

export async function resolveDiscordChannelInfo(
  client: Client,
  channelId: string,
): Promise<DiscordChannelInfo | null> {
  const cached = DISCORD_CHANNEL_INFO_CACHE.get(channelId);
  if (cached) {
    if (cached.expiresAt > Date.now()) {
      return cached.value;
    }
    DISCORD_CHANNEL_INFO_CACHE.delete(channelId);
  }
  try {
    const channel = await client.fetchChannel(channelId);
    if (!channel) {
      DISCORD_CHANNEL_INFO_CACHE.set(channelId, {
        value: null,
        expiresAt: Date.now() + DISCORD_CHANNEL_INFO_NEGATIVE_CACHE_TTL_MS,
      });
      return null;
    }
    const name = "name" in channel ? (channel.name ?? undefined) : undefined;
    const topic = "topic" in channel ? (channel.topic ?? undefined) : undefined;
    const parentId = "parentId" in channel ? (channel.parentId ?? undefined) : undefined;
    const ownerId = "ownerId" in channel ? (channel.ownerId ?? undefined) : undefined;
    const payload: DiscordChannelInfo = {
      type: channel.type,
      name,
      topic,
      parentId,
      ownerId,
    };
    DISCORD_CHANNEL_INFO_CACHE.set(channelId, {
      value: payload,
      expiresAt: Date.now() + DISCORD_CHANNEL_INFO_CACHE_TTL_MS,
    });
    return payload;
  } catch (err) {
    logVerbose(`discord: failed to fetch channel ${channelId}: ${String(err)}`);
    DISCORD_CHANNEL_INFO_CACHE.set(channelId, {
      value: null,
      expiresAt: Date.now() + DISCORD_CHANNEL_INFO_NEGATIVE_CACHE_TTL_MS,
    });
    return null;
  }
}

function normalizeStickerItems(value: unknown): APIStickerItem[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (entry): entry is APIStickerItem =>
      Boolean(entry) &&
      typeof entry === "object" &&
      typeof (entry as { id?: unknown }).id === "string" &&
      typeof (entry as { name?: unknown }).name === "string",
  );
}

export function resolveDiscordMessageStickers(message: Message): APIStickerItem[] {
  const stickers = (message as { stickers?: unknown }).stickers;
  const normalized = normalizeStickerItems(stickers);
  if (normalized.length > 0) {
    return normalized;
  }
  const rawData = (message as { rawData?: { sticker_items?: unknown; stickers?: unknown } })
    .rawData;
  return normalizeStickerItems(rawData?.sticker_items ?? rawData?.stickers);
}

function resolveDiscordSnapshotStickers(snapshot: DiscordSnapshotMessage): APIStickerItem[] {
  return normalizeStickerItems(snapshot.stickers ?? snapshot.sticker_items);
}

export function hasDiscordMessageStickers(message: Message): boolean {
  return resolveDiscordMessageStickers(message).length > 0;
}

export async function resolveMediaList(
  message: Message,
  maxBytes: number,
): Promise<DiscordMediaInfo[]> {
  const out: DiscordMediaInfo[] = [];
  await appendResolvedMediaFromAttachments({
    attachments: message.attachments ?? [],
    maxBytes,
    out,
    errorPrefix: "discord: failed to download attachment",
  });
  await appendResolvedMediaFromStickers({
    stickers: resolveDiscordMessageStickers(message),
    maxBytes,
    out,
    errorPrefix: "discord: failed to download sticker",
  });
  return out;
}

export async function resolveForwardedMediaList(
  message: Message,
  maxBytes: number,
): Promise<DiscordMediaInfo[]> {
  const snapshots = resolveDiscordMessageSnapshots(message);
  if (snapshots.length === 0) {
    return [];
  }
  const out: DiscordMediaInfo[] = [];
  for (const snapshot of snapshots) {
    await appendResolvedMediaFromAttachments({
      attachments: snapshot.message?.attachments,
      maxBytes,
      out,
      errorPrefix: "discord: failed to download forwarded attachment",
    });
    await appendResolvedMediaFromStickers({
      stickers: snapshot.message ? resolveDiscordSnapshotStickers(snapshot.message) : [],
      maxBytes,
      out,
      errorPrefix: "discord: failed to download forwarded sticker",
    });
  }
  return out;
}

async function appendResolvedMediaFromAttachments(params: {
  attachments?: APIAttachment[] | null;
  maxBytes: number;
  out: DiscordMediaInfo[];
  errorPrefix: string;
}) {
  const attachments = params.attachments;
  if (!attachments || attachments.length === 0) {
    return;
  }
  for (const attachment of attachments) {
    try {
      const fetched = await fetchRemoteMedia({
        url: attachment.url,
        filePathHint: attachment.filename ?? attachment.url,
        maxBytes: params.maxBytes,
      });
      const saved = await saveMediaBuffer(
        fetched.buffer,
        fetched.contentType ?? attachment.content_type,
        "inbound",
        params.maxBytes,
      );
      params.out.push({
        path: saved.path,
        contentType: saved.contentType,
        placeholder: inferPlaceholder(attachment),
      });
    } catch (err) {
      const id = attachment.id ?? attachment.url;
      logVerbose(`${params.errorPrefix} ${id}: ${String(err)}`);
    }
  }
}

type DiscordStickerAssetCandidate = {
  url: string;
  fileName: string;
};

function resolveStickerAssetCandidates(sticker: APIStickerItem): DiscordStickerAssetCandidate[] {
  const baseName = sticker.name?.trim() || `sticker-${sticker.id}`;
  switch (sticker.format_type) {
    case StickerFormatType.GIF:
      return [
        {
          url: `${DISCORD_STICKER_ASSET_BASE_URL}/${sticker.id}.gif`,
          fileName: `${baseName}.gif`,
        },
      ];
    case StickerFormatType.Lottie:
      return [
        {
          url: `${DISCORD_STICKER_ASSET_BASE_URL}/${sticker.id}.png?size=160`,
          fileName: `${baseName}.png`,
        },
        {
          url: `${DISCORD_STICKER_ASSET_BASE_URL}/${sticker.id}.json`,
          fileName: `${baseName}.json`,
        },
      ];
    case StickerFormatType.APNG:
    case StickerFormatType.PNG:
    default:
      return [
        {
          url: `${DISCORD_STICKER_ASSET_BASE_URL}/${sticker.id}.png`,
          fileName: `${baseName}.png`,
        },
      ];
  }
}

function formatStickerError(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === "string") {
    return err;
  }
  try {
    return JSON.stringify(err) ?? "unknown error";
  } catch {
    return "unknown error";
  }
}

async function appendResolvedMediaFromStickers(params: {
  stickers?: APIStickerItem[] | null;
  maxBytes: number;
  out: DiscordMediaInfo[];
  errorPrefix: string;
}) {
  const stickers = params.stickers;
  if (!stickers || stickers.length === 0) {
    return;
  }
  for (const sticker of stickers) {
    const candidates = resolveStickerAssetCandidates(sticker);
    let lastError: unknown;
    for (const candidate of candidates) {
      try {
        const fetched = await fetchRemoteMedia({
          url: candidate.url,
          filePathHint: candidate.fileName,
          maxBytes: params.maxBytes,
        });
        const saved = await saveMediaBuffer(
          fetched.buffer,
          fetched.contentType,
          "inbound",
          params.maxBytes,
        );
        params.out.push({
          path: saved.path,
          contentType: saved.contentType,
          placeholder: "<media:sticker>",
        });
        lastError = null;
        break;
      } catch (err) {
        lastError = err;
      }
    }
    if (lastError) {
      logVerbose(`${params.errorPrefix} ${sticker.id}: ${formatStickerError(lastError)}`);
    }
  }
}

function inferPlaceholder(attachment: APIAttachment): string {
  const mime = attachment.content_type ?? "";
  if (mime.startsWith("image/")) {
    return "<media:image>";
  }
  if (mime.startsWith("video/")) {
    return "<media:video>";
  }
  if (mime.startsWith("audio/")) {
    return "<media:audio>";
  }
  return "<media:document>";
}

function isImageAttachment(attachment: APIAttachment): boolean {
  const mime = attachment.content_type ?? "";
  if (mime.startsWith("image/")) {
    return true;
  }
  const name = attachment.filename?.toLowerCase() ?? "";
  if (!name) {
    return false;
  }
  return /\.(avif|bmp|gif|heic|heif|jpe?g|png|tiff?|webp)$/.test(name);
}

function buildDiscordAttachmentPlaceholder(attachments?: APIAttachment[]): string {
  if (!attachments || attachments.length === 0) {
    return "";
  }
  const count = attachments.length;
  const allImages = attachments.every(isImageAttachment);
  const label = allImages ? "image" : "file";
  const suffix = count === 1 ? label : `${label}s`;
  const tag = allImages ? "<media:image>" : "<media:document>";
  return `${tag} (${count} ${suffix})`;
}

function buildDiscordStickerPlaceholder(stickers?: APIStickerItem[]): string {
  if (!stickers || stickers.length === 0) {
    return "";
  }
  const count = stickers.length;
  const label = count === 1 ? "sticker" : "stickers";
  return `<media:sticker> (${count} ${label})`;
}

function buildDiscordMediaPlaceholder(params: {
  attachments?: APIAttachment[];
  stickers?: APIStickerItem[];
}): string {
  const attachmentText = buildDiscordAttachmentPlaceholder(params.attachments);
  const stickerText = buildDiscordStickerPlaceholder(params.stickers);
  if (attachmentText && stickerText) {
    return `${attachmentText}\n${stickerText}`;
  }
  return attachmentText || stickerText || "";
}

export function resolveDiscordMessageText(
  message: Message,
  options?: { fallbackText?: string; includeForwarded?: boolean },
): string {
  const baseText =
    message.content?.trim() ||
    buildDiscordMediaPlaceholder({
      attachments: message.attachments ?? undefined,
      stickers: resolveDiscordMessageStickers(message),
    }) ||
    message.embeds?.[0]?.description ||
    options?.fallbackText?.trim() ||
    "";
  if (!options?.includeForwarded) {
    return baseText;
  }
  const forwardedText = resolveDiscordForwardedMessagesText(message);
  if (!forwardedText) {
    return baseText;
  }
  if (!baseText) {
    return forwardedText;
  }
  return `${baseText}\n${forwardedText}`;
}

function resolveDiscordForwardedMessagesText(message: Message): string {
  const snapshots = resolveDiscordMessageSnapshots(message);
  if (snapshots.length === 0) {
    return "";
  }
  const forwardedBlocks = snapshots
    .map((snapshot) => {
      const snapshotMessage = snapshot.message;
      if (!snapshotMessage) {
        return null;
      }
      const text = resolveDiscordSnapshotMessageText(snapshotMessage);
      if (!text) {
        return null;
      }
      const authorLabel = formatDiscordSnapshotAuthor(snapshotMessage.author);
      const heading = authorLabel
        ? `[Forwarded message from ${authorLabel}]`
        : "[Forwarded message]";
      return `${heading}\n${text}`;
    })
    .filter((entry): entry is string => Boolean(entry));
  if (forwardedBlocks.length === 0) {
    return "";
  }
  return forwardedBlocks.join("\n\n");
}

function resolveDiscordMessageSnapshots(message: Message): DiscordMessageSnapshot[] {
  const rawData = (message as { rawData?: { message_snapshots?: unknown } }).rawData;
  const snapshots =
    rawData?.message_snapshots ??
    (message as { message_snapshots?: unknown }).message_snapshots ??
    (message as { messageSnapshots?: unknown }).messageSnapshots;
  if (!Array.isArray(snapshots)) {
    return [];
  }
  return snapshots.filter(
    (entry): entry is DiscordMessageSnapshot => Boolean(entry) && typeof entry === "object",
  );
}

function resolveDiscordSnapshotMessageText(snapshot: DiscordSnapshotMessage): string {
  const content = snapshot.content?.trim() ?? "";
  const attachmentText = buildDiscordMediaPlaceholder({
    attachments: snapshot.attachments ?? undefined,
    stickers: resolveDiscordSnapshotStickers(snapshot),
  });
  const embed = snapshot.embeds?.[0];
  const embedText = embed?.description?.trim() || embed?.title?.trim() || "";
  return content || attachmentText || embedText || "";
}

function formatDiscordSnapshotAuthor(
  author: DiscordSnapshotAuthor | null | undefined,
): string | undefined {
  if (!author) {
    return undefined;
  }
  const globalName = author.global_name ?? undefined;
  const username = author.username ?? undefined;
  const name = author.name ?? undefined;
  const discriminator = author.discriminator ?? undefined;
  const base = globalName || username || name;
  if (username && discriminator && discriminator !== "0") {
    return `@${username}#${discriminator}`;
  }
  if (base) {
    return `@${base}`;
  }
  if (author.id) {
    return `@${author.id}`;
  }
  return undefined;
}

export function buildDiscordMediaPayload(
  mediaList: Array<{ path: string; contentType?: string }>,
): {
  MediaPath?: string;
  MediaType?: string;
  MediaUrl?: string;
  MediaPaths?: string[];
  MediaUrls?: string[];
  MediaTypes?: string[];
} {
  return buildMediaPayload(mediaList);
}
