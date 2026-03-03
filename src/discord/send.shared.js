import { Embed, serializePayload, } from "@buape/carbon";
import { PollLayoutType } from "discord-api-types/payloads/v10";
import { Routes } from "discord-api-types/v10";
import { loadConfig } from "../config/config.js";
import { buildOutboundMediaLoadOptions } from "../media/load-options.js";
import { normalizePollDurationHours, normalizePollInput } from "../polls.js";
import { loadWebMedia } from "../web/media.js";
import { resolveDiscordAccount } from "./accounts.js";
import { chunkDiscordTextWithMode } from "./chunk.js";
import { createDiscordClient, resolveDiscordRest } from "./client.js";
import { fetchChannelPermissionsDiscord, isThreadChannelType } from "./send.permissions.js";
import { DiscordSendError } from "./send.types.js";
import { parseDiscordTarget, resolveDiscordTarget } from "./targets.js";
const DISCORD_TEXT_LIMIT = 2000;
const DISCORD_MAX_STICKERS = 3;
const DISCORD_POLL_MAX_ANSWERS = 10;
const DISCORD_POLL_MAX_DURATION_HOURS = 32 * 24;
const DISCORD_MISSING_PERMISSIONS = 50013;
const DISCORD_CANNOT_DM = 50007;
function normalizeReactionEmoji(raw) {
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
function parseRecipient(raw) {
    const target = parseDiscordTarget(raw, {
        ambiguousMessage: `Ambiguous Discord recipient "${raw.trim()}". Use "user:${raw.trim()}" for DMs or "channel:${raw.trim()}" for channel messages.`,
    });
    if (!target) {
        throw new Error("Recipient is required for Discord sends");
    }
    return { kind: target.kind, id: target.id };
}
/**
 * Parse and resolve Discord recipient, including username lookup.
 * This enables sending DMs by username (e.g., "john.doe") by querying
 * the Discord directory to resolve usernames to user IDs.
 *
 * @param raw - The recipient string (username, ID, or known format)
 * @param accountId - Discord account ID to use for directory lookup
 * @returns Parsed DiscordRecipient with resolved user ID if applicable
 */
export async function parseAndResolveRecipient(raw, accountId) {
    const cfg = loadConfig();
    const accountInfo = resolveDiscordAccount({ cfg, accountId });
    // First try to resolve using directory lookup (handles usernames)
    const trimmed = raw.trim();
    const parseOptions = {
        ambiguousMessage: `Ambiguous Discord recipient "${trimmed}". Use "user:${trimmed}" for DMs or "channel:${trimmed}" for channel messages.`,
    };
    const resolved = await resolveDiscordTarget(raw, {
        cfg,
        accountId: accountInfo.accountId,
    }, parseOptions);
    if (resolved) {
        return { kind: resolved.kind, id: resolved.id };
    }
    // Fallback to standard parsing (for channels, etc.)
    const parsed = parseDiscordTarget(raw, parseOptions);
    if (!parsed) {
        throw new Error("Recipient is required for Discord sends");
    }
    return { kind: parsed.kind, id: parsed.id };
}
function normalizeStickerIds(raw) {
    const ids = raw.map((entry) => entry.trim()).filter(Boolean);
    if (ids.length === 0) {
        throw new Error("At least one sticker id is required");
    }
    if (ids.length > DISCORD_MAX_STICKERS) {
        throw new Error("Discord supports up to 3 stickers per message");
    }
    return ids;
}
function normalizeEmojiName(raw, label) {
    const name = raw.trim();
    if (!name) {
        throw new Error(`${label} is required`);
    }
    return name;
}
function normalizeDiscordPollInput(input) {
    const poll = normalizePollInput(input, {
        maxOptions: DISCORD_POLL_MAX_ANSWERS,
    });
    const duration = normalizePollDurationHours(poll.durationHours, {
        defaultHours: 24,
        maxHours: DISCORD_POLL_MAX_DURATION_HOURS,
    });
    return {
        question: { text: poll.question },
        answers: poll.options.map((answer) => ({ poll_media: { text: answer } })),
        duration,
        allow_multiselect: poll.maxSelections > 1,
        layout_type: PollLayoutType.Default,
    };
}
function getDiscordErrorCode(err) {
    if (!err || typeof err !== "object") {
        return undefined;
    }
    const candidate = "code" in err && err.code !== undefined
        ? err.code
        : "rawError" in err && err.rawError && typeof err.rawError === "object"
            ? err.rawError.code
            : undefined;
    if (typeof candidate === "number") {
        return candidate;
    }
    if (typeof candidate === "string" && /^\d+$/.test(candidate)) {
        return Number(candidate);
    }
    return undefined;
}
async function buildDiscordSendError(err, ctx) {
    if (err instanceof DiscordSendError) {
        return err;
    }
    const code = getDiscordErrorCode(err);
    if (code === DISCORD_CANNOT_DM) {
        return new DiscordSendError("discord dm failed: user blocks dms or privacy settings disallow it", { kind: "dm-blocked" });
    }
    if (code !== DISCORD_MISSING_PERMISSIONS) {
        return err;
    }
    let missing = [];
    try {
        const permissions = await fetchChannelPermissionsDiscord(ctx.channelId, {
            rest: ctx.rest,
            token: ctx.token,
        });
        const current = new Set(permissions.permissions);
        const required = ["ViewChannel", "SendMessages"];
        if (isThreadChannelType(permissions.channelType)) {
            required.push("SendMessagesInThreads");
        }
        if (ctx.hasMedia) {
            required.push("AttachFiles");
        }
        missing = required.filter((permission) => !current.has(permission));
    }
    catch {
        /* ignore permission probe errors */
    }
    const missingLabel = missing.length
        ? `missing permissions in channel ${ctx.channelId}: ${missing.join(", ")}`
        : `missing permissions in channel ${ctx.channelId}`;
    return new DiscordSendError(`${missingLabel}. bot might be muted or blocked by role/channel overrides`, {
        kind: "missing-permissions",
        channelId: ctx.channelId,
        missingPermissions: missing,
    });
}
async function resolveChannelId(rest, recipient, request) {
    if (recipient.kind === "channel") {
        return { channelId: recipient.id };
    }
    const dmChannel = (await request(() => rest.post(Routes.userChannels(), {
        body: { recipient_id: recipient.id },
    }), "dm-channel"));
    if (!dmChannel?.id) {
        throw new Error("Failed to create Discord DM channel");
    }
    return { channelId: dmChannel.id, dm: true };
}
export async function resolveDiscordChannelType(rest, channelId) {
    try {
        const channel = (await rest.get(Routes.channel(channelId)));
        return channel?.type;
    }
    catch {
        return undefined;
    }
}
// Discord message flag for silent/suppress notifications
export const SUPPRESS_NOTIFICATIONS_FLAG = 1 << 12;
export function buildDiscordTextChunks(text, opts = {}) {
    if (!text) {
        return [];
    }
    const chunks = chunkDiscordTextWithMode(text, {
        maxChars: opts.maxChars ?? DISCORD_TEXT_LIMIT,
        maxLines: opts.maxLinesPerMessage,
        chunkMode: opts.chunkMode,
    });
    if (!chunks.length && text) {
        chunks.push(text);
    }
    return chunks;
}
function hasV2Components(components) {
    return Boolean(components?.some((component) => "isV2" in component && component.isV2));
}
export function resolveDiscordSendComponents(params) {
    if (!params.components || !params.isFirst) {
        return undefined;
    }
    return typeof params.components === "function"
        ? params.components(params.text)
        : params.components;
}
function normalizeDiscordEmbeds(embeds) {
    if (!embeds?.length) {
        return undefined;
    }
    return embeds.map((embed) => (embed instanceof Embed ? embed : new Embed(embed)));
}
export function resolveDiscordSendEmbeds(params) {
    if (!params.embeds || !params.isFirst) {
        return undefined;
    }
    return normalizeDiscordEmbeds(params.embeds);
}
export function buildDiscordMessagePayload(params) {
    const payload = {};
    const hasV2 = hasV2Components(params.components);
    const trimmed = params.text.trim();
    if (!hasV2 && trimmed) {
        payload.content = params.text;
    }
    if (params.components?.length) {
        payload.components = params.components;
    }
    if (!hasV2 && params.embeds?.length) {
        payload.embeds = params.embeds;
    }
    if (params.flags !== undefined) {
        payload.flags = params.flags;
    }
    if (params.files?.length) {
        payload.files = params.files;
    }
    return payload;
}
export function stripUndefinedFields(value) {
    return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}
export function toDiscordFileBlob(data) {
    if (data instanceof Blob) {
        return data;
    }
    const arrayBuffer = new ArrayBuffer(data.byteLength);
    new Uint8Array(arrayBuffer).set(data);
    return new Blob([arrayBuffer]);
}
async function sendDiscordText(rest, channelId, text, replyTo, request, maxLinesPerMessage, components, embeds, chunkMode, silent) {
    if (!text.trim()) {
        throw new Error("Message must be non-empty for Discord sends");
    }
    const messageReference = replyTo ? { message_id: replyTo, fail_if_not_exists: false } : undefined;
    const flags = silent ? SUPPRESS_NOTIFICATIONS_FLAG : undefined;
    const chunks = buildDiscordTextChunks(text, { maxLinesPerMessage, chunkMode });
    const sendChunk = async (chunk, isFirst) => {
        const chunkComponents = resolveDiscordSendComponents({
            components,
            text: chunk,
            isFirst,
        });
        const chunkEmbeds = resolveDiscordSendEmbeds({ embeds, isFirst });
        const payload = buildDiscordMessagePayload({
            text: chunk,
            components: chunkComponents,
            embeds: chunkEmbeds,
            flags,
        });
        const body = stripUndefinedFields({
            ...serializePayload(payload),
            ...(messageReference ? { message_reference: messageReference } : {}),
        });
        return (await request(() => rest.post(Routes.channelMessages(channelId), {
            body,
        }), "text"));
    };
    if (chunks.length === 1) {
        return await sendChunk(chunks[0], true);
    }
    let last = null;
    for (const [index, chunk] of chunks.entries()) {
        last = await sendChunk(chunk, index === 0);
    }
    if (!last) {
        throw new Error("Discord send failed (empty chunk result)");
    }
    return last;
}
async function sendDiscordMedia(rest, channelId, text, mediaUrl, mediaLocalRoots, replyTo, request, maxLinesPerMessage, components, embeds, chunkMode, silent) {
    const media = await loadWebMedia(mediaUrl, buildOutboundMediaLoadOptions({ mediaLocalRoots }));
    const chunks = text ? buildDiscordTextChunks(text, { maxLinesPerMessage, chunkMode }) : [];
    const caption = chunks[0] ?? "";
    const messageReference = replyTo ? { message_id: replyTo, fail_if_not_exists: false } : undefined;
    const flags = silent ? SUPPRESS_NOTIFICATIONS_FLAG : undefined;
    const fileData = toDiscordFileBlob(media.buffer);
    const captionComponents = resolveDiscordSendComponents({
        components,
        text: caption,
        isFirst: true,
    });
    const captionEmbeds = resolveDiscordSendEmbeds({ embeds, isFirst: true });
    const payload = buildDiscordMessagePayload({
        text: caption,
        components: captionComponents,
        embeds: captionEmbeds,
        flags,
        files: [
            {
                data: fileData,
                name: media.fileName ?? "upload",
            },
        ],
    });
    const res = (await request(() => rest.post(Routes.channelMessages(channelId), {
        body: stripUndefinedFields({
            ...serializePayload(payload),
            ...(messageReference ? { message_reference: messageReference } : {}),
        }),
    }), "media"));
    for (const chunk of chunks.slice(1)) {
        if (!chunk.trim()) {
            continue;
        }
        await sendDiscordText(rest, channelId, chunk, replyTo, request, maxLinesPerMessage, undefined, undefined, chunkMode, silent);
    }
    return res;
}
function buildReactionIdentifier(emoji) {
    if (emoji.id && emoji.name) {
        return `${emoji.name}:${emoji.id}`;
    }
    return emoji.name ?? "";
}
function formatReactionEmoji(emoji) {
    return buildReactionIdentifier(emoji);
}
export { buildDiscordSendError, buildReactionIdentifier, createDiscordClient, formatReactionEmoji, normalizeDiscordPollInput, normalizeEmojiName, normalizeReactionEmoji, normalizeStickerIds, parseRecipient, resolveChannelId, resolveDiscordRest, sendDiscordMedia, sendDiscordText, };
