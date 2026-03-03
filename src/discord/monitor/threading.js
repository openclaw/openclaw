import { ChannelType } from "@buape/carbon";
import { Routes } from "discord-api-types/v10";
import { createReplyReferencePlanner } from "../../auto-reply/reply/reply-reference.js";
import { logVerbose } from "../../globals.js";
import { buildAgentSessionKey } from "../../routing/resolve-route.js";
import { truncateUtf16Safe } from "../../utils.js";
import { resolveDiscordChannelInfo, resolveDiscordEmbedText, resolveDiscordMessageChannelId, } from "./message-utils.js";
// Cache configuration: 5 minute TTL (thread starters rarely change), max 500 entries
const DISCORD_THREAD_STARTER_CACHE_TTL_MS = 5 * 60 * 1000;
const DISCORD_THREAD_STARTER_CACHE_MAX = 500;
const DISCORD_THREAD_STARTER_CACHE = new Map();
export function __resetDiscordThreadStarterCacheForTest() {
    DISCORD_THREAD_STARTER_CACHE.clear();
}
// Get cached entry with TTL check, refresh LRU position on hit
function getCachedThreadStarter(key, now) {
    const entry = DISCORD_THREAD_STARTER_CACHE.get(key);
    if (!entry) {
        return undefined;
    }
    // Check TTL expiry
    if (now - entry.updatedAt > DISCORD_THREAD_STARTER_CACHE_TTL_MS) {
        DISCORD_THREAD_STARTER_CACHE.delete(key);
        return undefined;
    }
    // Refresh LRU position by re-inserting (Map maintains insertion order)
    DISCORD_THREAD_STARTER_CACHE.delete(key);
    DISCORD_THREAD_STARTER_CACHE.set(key, { ...entry, updatedAt: now });
    return entry.value;
}
// Set cached entry with LRU eviction when max size exceeded
function setCachedThreadStarter(key, value, now) {
    // Remove existing entry first (to update LRU position)
    DISCORD_THREAD_STARTER_CACHE.delete(key);
    DISCORD_THREAD_STARTER_CACHE.set(key, { value, updatedAt: now });
    // Evict oldest entries (first in Map) when over max size
    while (DISCORD_THREAD_STARTER_CACHE.size > DISCORD_THREAD_STARTER_CACHE_MAX) {
        const iter = DISCORD_THREAD_STARTER_CACHE.keys().next();
        if (iter.done) {
            break;
        }
        DISCORD_THREAD_STARTER_CACHE.delete(iter.value);
    }
}
function isDiscordThreadType(type) {
    return (type === ChannelType.PublicThread ||
        type === ChannelType.PrivateThread ||
        type === ChannelType.AnnouncementThread);
}
export function resolveDiscordThreadChannel(params) {
    if (!params.isGuildMessage) {
        return null;
    }
    const { message, channelInfo } = params;
    const channel = "channel" in message ? message.channel : undefined;
    const isThreadChannel = channel &&
        typeof channel === "object" &&
        "isThread" in channel &&
        typeof channel.isThread === "function" &&
        channel.isThread();
    if (isThreadChannel) {
        return channel;
    }
    if (!isDiscordThreadType(channelInfo?.type)) {
        return null;
    }
    const messageChannelId = params.messageChannelId ||
        resolveDiscordMessageChannelId({
            message,
        });
    if (!messageChannelId) {
        return null;
    }
    return {
        id: messageChannelId,
        name: channelInfo?.name ?? undefined,
        parentId: channelInfo?.parentId ?? undefined,
        parent: undefined,
        ownerId: channelInfo?.ownerId ?? undefined,
    };
}
export async function resolveDiscordThreadParentInfo(params) {
    const { threadChannel, channelInfo, client } = params;
    let parentId = threadChannel.parentId ?? threadChannel.parent?.id ?? channelInfo?.parentId ?? undefined;
    if (!parentId && threadChannel.id) {
        const threadInfo = await resolveDiscordChannelInfo(client, threadChannel.id);
        parentId = threadInfo?.parentId ?? undefined;
    }
    if (!parentId) {
        return {};
    }
    let parentName = threadChannel.parent?.name;
    const parentInfo = await resolveDiscordChannelInfo(client, parentId);
    parentName = parentName ?? parentInfo?.name;
    const parentType = parentInfo?.type;
    return { id: parentId, name: parentName, type: parentType };
}
export async function resolveDiscordThreadStarter(params) {
    const cacheKey = params.channel.id;
    const now = Date.now();
    const cached = getCachedThreadStarter(cacheKey, now);
    if (cached) {
        return cached;
    }
    try {
        const parentType = params.parentType;
        const isForumParent = parentType === ChannelType.GuildForum || parentType === ChannelType.GuildMedia;
        const messageChannelId = isForumParent ? params.channel.id : params.parentId;
        if (!messageChannelId) {
            return null;
        }
        const starter = (await params.client.rest.get(Routes.channelMessage(messageChannelId, params.channel.id)));
        if (!starter) {
            return null;
        }
        const content = starter.content?.trim() ?? "";
        const embedText = resolveDiscordEmbedText(starter.embeds?.[0]);
        const text = content || embedText;
        if (!text) {
            return null;
        }
        const author = starter.member?.nick ??
            starter.member?.displayName ??
            (starter.author
                ? starter.author.discriminator && starter.author.discriminator !== "0"
                    ? `${starter.author.username ?? "Unknown"}#${starter.author.discriminator}`
                    : (starter.author.username ?? starter.author.id ?? "Unknown")
                : "Unknown");
        const timestamp = params.resolveTimestampMs(starter.timestamp);
        const payload = {
            text,
            author,
            timestamp: timestamp ?? undefined,
        };
        setCachedThreadStarter(cacheKey, payload, Date.now());
        return payload;
    }
    catch {
        return null;
    }
}
export function resolveDiscordReplyTarget(opts) {
    if (opts.replyToMode === "off") {
        return undefined;
    }
    const replyToId = opts.replyToId?.trim();
    if (!replyToId) {
        return undefined;
    }
    if (opts.replyToMode === "all") {
        return replyToId;
    }
    return opts.hasReplied ? undefined : replyToId;
}
export function sanitizeDiscordThreadName(rawName, fallbackId) {
    const cleanedName = rawName
        .replace(/<@!?\d+>/g, "") // user mentions
        .replace(/<@&\d+>/g, "") // role mentions
        .replace(/<#\d+>/g, "") // channel mentions
        .replace(/\s+/g, " ")
        .trim();
    const baseSource = cleanedName || `Thread ${fallbackId}`;
    const base = truncateUtf16Safe(baseSource, 80);
    return truncateUtf16Safe(base, 100) || `Thread ${fallbackId}`;
}
export function resolveDiscordAutoThreadContext(params) {
    const createdThreadId = String(params.createdThreadId ?? "").trim();
    if (!createdThreadId) {
        return null;
    }
    const messageChannelId = params.messageChannelId.trim();
    if (!messageChannelId) {
        return null;
    }
    const threadSessionKey = buildAgentSessionKey({
        agentId: params.agentId,
        channel: params.channel,
        peer: { kind: "channel", id: createdThreadId },
    });
    const parentSessionKey = buildAgentSessionKey({
        agentId: params.agentId,
        channel: params.channel,
        peer: { kind: "channel", id: messageChannelId },
    });
    return {
        createdThreadId,
        From: `${params.channel}:channel:${createdThreadId}`,
        To: `channel:${createdThreadId}`,
        OriginatingTo: `channel:${createdThreadId}`,
        SessionKey: threadSessionKey,
        ParentSessionKey: parentSessionKey,
    };
}
export async function resolveDiscordAutoThreadReplyPlan(params) {
    const messageChannelId = (params.messageChannelId ||
        resolveDiscordMessageChannelId({
            message: params.message,
        })).trim();
    // Prefer the resolved thread channel ID when available so replies stay in-thread.
    const targetChannelId = params.threadChannel?.id ?? (messageChannelId || "unknown");
    const originalReplyTarget = `channel:${targetChannelId}`;
    const createdThreadId = await maybeCreateDiscordAutoThread({
        client: params.client,
        message: params.message,
        messageChannelId: messageChannelId || undefined,
        isGuildMessage: params.isGuildMessage,
        channelConfig: params.channelConfig,
        threadChannel: params.threadChannel,
        channelType: params.channelType,
        baseText: params.baseText,
        combinedBody: params.combinedBody,
    });
    const deliveryPlan = resolveDiscordReplyDeliveryPlan({
        replyTarget: originalReplyTarget,
        replyToMode: params.replyToMode,
        messageId: params.message.id,
        threadChannel: params.threadChannel,
        createdThreadId,
    });
    const autoThreadContext = params.isGuildMessage
        ? resolveDiscordAutoThreadContext({
            agentId: params.agentId,
            channel: params.channel,
            messageChannelId,
            createdThreadId,
        })
        : null;
    return { ...deliveryPlan, createdThreadId, autoThreadContext };
}
export async function maybeCreateDiscordAutoThread(params) {
    if (!params.isGuildMessage) {
        return undefined;
    }
    if (!params.channelConfig?.autoThread) {
        return undefined;
    }
    if (params.threadChannel) {
        return undefined;
    }
    // Avoid creating threads in channels that don't support it or are already forums
    if (params.channelType === ChannelType.GuildForum ||
        params.channelType === ChannelType.GuildMedia ||
        params.channelType === ChannelType.GuildVoice ||
        params.channelType === ChannelType.GuildStageVoice) {
        return undefined;
    }
    const messageChannelId = (params.messageChannelId ||
        resolveDiscordMessageChannelId({
            message: params.message,
        })).trim();
    if (!messageChannelId) {
        return undefined;
    }
    try {
        const threadName = sanitizeDiscordThreadName(params.baseText || params.combinedBody || "Thread", params.message.id);
        const created = (await params.client.rest.post(`${Routes.channelMessage(messageChannelId, params.message.id)}/threads`, {
            body: {
                name: threadName,
                auto_archive_duration: 60,
            },
        }));
        const createdId = created?.id ? String(created.id) : "";
        return createdId || undefined;
    }
    catch (err) {
        logVerbose(`discord: autoThread creation failed for ${messageChannelId}/${params.message.id}: ${String(err)}`);
        // Race condition: another agent may have already created a thread on this
        // message. Re-fetch the message to check for an existing thread.
        try {
            const msg = (await params.client.rest.get(Routes.channelMessage(messageChannelId, params.message.id)));
            const existingThreadId = msg?.thread?.id ? String(msg.thread.id) : "";
            if (existingThreadId) {
                logVerbose(`discord: autoThread reusing existing thread ${existingThreadId} on ${messageChannelId}/${params.message.id}`);
                return existingThreadId;
            }
        }
        catch {
            // If the refetch also fails, fall through to return undefined.
        }
        return undefined;
    }
}
export function resolveDiscordReplyDeliveryPlan(params) {
    const originalReplyTarget = params.replyTarget;
    let deliverTarget = originalReplyTarget;
    let replyTarget = originalReplyTarget;
    // When a new thread was created, route to the new thread.
    if (params.createdThreadId) {
        deliverTarget = `channel:${params.createdThreadId}`;
        replyTarget = deliverTarget;
    }
    const allowReference = deliverTarget === originalReplyTarget;
    const replyReference = createReplyReferencePlanner({
        replyToMode: allowReference ? params.replyToMode : "off",
        existingId: params.threadChannel ? params.messageId : undefined,
        startId: params.messageId,
        allowReference,
    });
    return { deliverTarget, replyTarget, replyReference };
}
