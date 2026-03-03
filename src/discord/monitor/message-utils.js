import { StickerFormatType } from "discord-api-types/v10";
import { buildMediaPayload } from "../../channels/plugins/media-payload.js";
import { logVerbose } from "../../globals.js";
import { fetchRemoteMedia } from "../../media/fetch.js";
import { saveMediaBuffer } from "../../media/store.js";
const DISCORD_MEDIA_SSRF_POLICY = {
    allowedHostnames: ["cdn.discordapp.com", "media.discordapp.net"],
    allowRfc2544BenchmarkRange: true,
};
const DISCORD_CHANNEL_INFO_CACHE_TTL_MS = 5 * 60 * 1000;
const DISCORD_CHANNEL_INFO_NEGATIVE_CACHE_TTL_MS = 30 * 1000;
const DISCORD_CHANNEL_INFO_CACHE = new Map();
const DISCORD_STICKER_ASSET_BASE_URL = "https://media.discordapp.net/stickers";
export function __resetDiscordChannelInfoCacheForTest() {
    DISCORD_CHANNEL_INFO_CACHE.clear();
}
function normalizeDiscordChannelId(value) {
    if (typeof value === "string") {
        return value.trim();
    }
    if (typeof value === "number" || typeof value === "bigint") {
        return String(value).trim();
    }
    return "";
}
export function resolveDiscordMessageChannelId(params) {
    const message = params.message;
    return (normalizeDiscordChannelId(message.channelId) ||
        normalizeDiscordChannelId(message.channel_id) ||
        normalizeDiscordChannelId(message.rawData?.channel_id) ||
        normalizeDiscordChannelId(params.eventChannelId));
}
export async function resolveDiscordChannelInfo(client, channelId) {
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
        const payload = {
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
    }
    catch (err) {
        logVerbose(`discord: failed to fetch channel ${channelId}: ${String(err)}`);
        DISCORD_CHANNEL_INFO_CACHE.set(channelId, {
            value: null,
            expiresAt: Date.now() + DISCORD_CHANNEL_INFO_NEGATIVE_CACHE_TTL_MS,
        });
        return null;
    }
}
function normalizeStickerItems(value) {
    if (!Array.isArray(value)) {
        return [];
    }
    return value.filter((entry) => Boolean(entry) &&
        typeof entry === "object" &&
        typeof entry.id === "string" &&
        typeof entry.name === "string");
}
export function resolveDiscordMessageStickers(message) {
    const stickers = message.stickers;
    const normalized = normalizeStickerItems(stickers);
    if (normalized.length > 0) {
        return normalized;
    }
    const rawData = message
        .rawData;
    return normalizeStickerItems(rawData?.sticker_items ?? rawData?.stickers);
}
function resolveDiscordSnapshotStickers(snapshot) {
    return normalizeStickerItems(snapshot.stickers ?? snapshot.sticker_items);
}
export function hasDiscordMessageStickers(message) {
    return resolveDiscordMessageStickers(message).length > 0;
}
export async function resolveMediaList(message, maxBytes, fetchImpl) {
    const out = [];
    await appendResolvedMediaFromAttachments({
        attachments: message.attachments ?? [],
        maxBytes,
        out,
        errorPrefix: "discord: failed to download attachment",
        fetchImpl,
    });
    await appendResolvedMediaFromStickers({
        stickers: resolveDiscordMessageStickers(message),
        maxBytes,
        out,
        errorPrefix: "discord: failed to download sticker",
        fetchImpl,
    });
    return out;
}
export async function resolveForwardedMediaList(message, maxBytes, fetchImpl) {
    const snapshots = resolveDiscordMessageSnapshots(message);
    if (snapshots.length === 0) {
        return [];
    }
    const out = [];
    for (const snapshot of snapshots) {
        await appendResolvedMediaFromAttachments({
            attachments: snapshot.message?.attachments,
            maxBytes,
            out,
            errorPrefix: "discord: failed to download forwarded attachment",
            fetchImpl,
        });
        await appendResolvedMediaFromStickers({
            stickers: snapshot.message ? resolveDiscordSnapshotStickers(snapshot.message) : [],
            maxBytes,
            out,
            errorPrefix: "discord: failed to download forwarded sticker",
            fetchImpl,
        });
    }
    return out;
}
async function appendResolvedMediaFromAttachments(params) {
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
                fetchImpl: params.fetchImpl,
                ssrfPolicy: DISCORD_MEDIA_SSRF_POLICY,
            });
            const saved = await saveMediaBuffer(fetched.buffer, fetched.contentType ?? attachment.content_type, "inbound", params.maxBytes);
            params.out.push({
                path: saved.path,
                contentType: saved.contentType,
                placeholder: inferPlaceholder(attachment),
            });
        }
        catch (err) {
            const id = attachment.id ?? attachment.url;
            logVerbose(`${params.errorPrefix} ${id}: ${String(err)}`);
            // Preserve attachment context even when remote fetch is blocked/fails.
            params.out.push({
                path: attachment.url,
                contentType: attachment.content_type,
                placeholder: inferPlaceholder(attachment),
            });
        }
    }
}
function resolveStickerAssetCandidates(sticker) {
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
function formatStickerError(err) {
    if (err instanceof Error) {
        return err.message;
    }
    if (typeof err === "string") {
        return err;
    }
    try {
        return JSON.stringify(err) ?? "unknown error";
    }
    catch {
        return "unknown error";
    }
}
function inferStickerContentType(sticker) {
    switch (sticker.format_type) {
        case StickerFormatType.GIF:
            return "image/gif";
        case StickerFormatType.APNG:
        case StickerFormatType.Lottie:
        case StickerFormatType.PNG:
            return "image/png";
        default:
            return undefined;
    }
}
async function appendResolvedMediaFromStickers(params) {
    const stickers = params.stickers;
    if (!stickers || stickers.length === 0) {
        return;
    }
    for (const sticker of stickers) {
        const candidates = resolveStickerAssetCandidates(sticker);
        let lastError;
        for (const candidate of candidates) {
            try {
                const fetched = await fetchRemoteMedia({
                    url: candidate.url,
                    filePathHint: candidate.fileName,
                    maxBytes: params.maxBytes,
                    fetchImpl: params.fetchImpl,
                    ssrfPolicy: DISCORD_MEDIA_SSRF_POLICY,
                });
                const saved = await saveMediaBuffer(fetched.buffer, fetched.contentType, "inbound", params.maxBytes);
                params.out.push({
                    path: saved.path,
                    contentType: saved.contentType,
                    placeholder: "<media:sticker>",
                });
                lastError = null;
                break;
            }
            catch (err) {
                lastError = err;
            }
        }
        if (lastError) {
            logVerbose(`${params.errorPrefix} ${sticker.id}: ${formatStickerError(lastError)}`);
            const fallback = candidates[0];
            if (fallback) {
                params.out.push({
                    path: fallback.url,
                    contentType: inferStickerContentType(sticker),
                    placeholder: "<media:sticker>",
                });
            }
        }
    }
}
function inferPlaceholder(attachment) {
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
function isImageAttachment(attachment) {
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
function buildDiscordAttachmentPlaceholder(attachments) {
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
function buildDiscordStickerPlaceholder(stickers) {
    if (!stickers || stickers.length === 0) {
        return "";
    }
    const count = stickers.length;
    const label = count === 1 ? "sticker" : "stickers";
    return `<media:sticker> (${count} ${label})`;
}
function buildDiscordMediaPlaceholder(params) {
    const attachmentText = buildDiscordAttachmentPlaceholder(params.attachments);
    const stickerText = buildDiscordStickerPlaceholder(params.stickers);
    if (attachmentText && stickerText) {
        return `${attachmentText}\n${stickerText}`;
    }
    return attachmentText || stickerText || "";
}
export function resolveDiscordEmbedText(embed) {
    const title = embed?.title?.trim() || "";
    const description = embed?.description?.trim() || "";
    if (title && description) {
        return `${title}\n${description}`;
    }
    return title || description || "";
}
export function resolveDiscordMessageText(message, options) {
    const embedText = resolveDiscordEmbedText(message.embeds?.[0] ??
        null);
    const baseText = message.content?.trim() ||
        buildDiscordMediaPlaceholder({
            attachments: message.attachments ?? undefined,
            stickers: resolveDiscordMessageStickers(message),
        }) ||
        embedText ||
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
function resolveDiscordForwardedMessagesText(message) {
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
        .filter((entry) => Boolean(entry));
    if (forwardedBlocks.length === 0) {
        return "";
    }
    return forwardedBlocks.join("\n\n");
}
function resolveDiscordMessageSnapshots(message) {
    const rawData = message.rawData;
    const snapshots = rawData?.message_snapshots ??
        message.message_snapshots ??
        message.messageSnapshots;
    if (!Array.isArray(snapshots)) {
        return [];
    }
    return snapshots.filter((entry) => Boolean(entry) && typeof entry === "object");
}
function resolveDiscordSnapshotMessageText(snapshot) {
    const content = snapshot.content?.trim() ?? "";
    const attachmentText = buildDiscordMediaPlaceholder({
        attachments: snapshot.attachments ?? undefined,
        stickers: resolveDiscordSnapshotStickers(snapshot),
    });
    const embedText = resolveDiscordEmbedText(snapshot.embeds?.[0]);
    return content || attachmentText || embedText || "";
}
function formatDiscordSnapshotAuthor(author) {
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
export function buildDiscordMediaPayload(mediaList) {
    return buildMediaPayload(mediaList);
}
