import { loadConfig } from "../config/config.js";
import { logVerbose } from "../globals.js";
import { resolveSlackAccount } from "./accounts.js";
import { buildSlackBlocksFallbackText } from "./blocks-fallback.js";
import { validateSlackBlocksArray } from "./blocks-input.js";
import { createSlackWebClient } from "./client.js";
import { resolveSlackMedia } from "./monitor/media.js";
import { sendMessageSlack } from "./send.js";
import { resolveSlackBotToken } from "./token.js";
function resolveToken(explicit, accountId) {
    const cfg = loadConfig();
    const account = resolveSlackAccount({ cfg, accountId });
    const token = resolveSlackBotToken(explicit ?? account.botToken ?? undefined);
    if (!token) {
        logVerbose(`slack actions: missing bot token for account=${account.accountId} explicit=${Boolean(explicit)} source=${account.botTokenSource ?? "unknown"}`);
        throw new Error("SLACK_BOT_TOKEN or channels.slack.botToken is required for Slack actions");
    }
    return token;
}
function normalizeEmoji(raw) {
    const trimmed = raw.trim();
    if (!trimmed) {
        throw new Error("Emoji is required for Slack reactions");
    }
    return trimmed.replace(/^:+|:+$/g, "");
}
async function getClient(opts = {}) {
    const token = resolveToken(opts.token, opts.accountId);
    return opts.client ?? createSlackWebClient(token);
}
async function resolveBotUserId(client) {
    const auth = await client.auth.test();
    if (!auth?.user_id) {
        throw new Error("Failed to resolve Slack bot user id");
    }
    return auth.user_id;
}
export async function reactSlackMessage(channelId, messageId, emoji, opts = {}) {
    const client = await getClient(opts);
    await client.reactions.add({
        channel: channelId,
        timestamp: messageId,
        name: normalizeEmoji(emoji),
    });
}
export async function removeSlackReaction(channelId, messageId, emoji, opts = {}) {
    const client = await getClient(opts);
    await client.reactions.remove({
        channel: channelId,
        timestamp: messageId,
        name: normalizeEmoji(emoji),
    });
}
export async function removeOwnSlackReactions(channelId, messageId, opts = {}) {
    const client = await getClient(opts);
    const userId = await resolveBotUserId(client);
    const reactions = await listSlackReactions(channelId, messageId, { client });
    const toRemove = new Set();
    for (const reaction of reactions ?? []) {
        const name = reaction?.name;
        if (!name) {
            continue;
        }
        const users = reaction?.users ?? [];
        if (users.includes(userId)) {
            toRemove.add(name);
        }
    }
    if (toRemove.size === 0) {
        return [];
    }
    await Promise.all(Array.from(toRemove, (name) => client.reactions.remove({
        channel: channelId,
        timestamp: messageId,
        name,
    })));
    return Array.from(toRemove);
}
export async function listSlackReactions(channelId, messageId, opts = {}) {
    const client = await getClient(opts);
    const result = await client.reactions.get({
        channel: channelId,
        timestamp: messageId,
        full: true,
    });
    const message = result.message;
    return message?.reactions ?? [];
}
export async function sendSlackMessage(to, content, opts = {}) {
    return await sendMessageSlack(to, content, {
        accountId: opts.accountId,
        token: opts.token,
        mediaUrl: opts.mediaUrl,
        client: opts.client,
        threadTs: opts.threadTs,
        blocks: opts.blocks,
    });
}
export async function editSlackMessage(channelId, messageId, content, opts = {}) {
    const client = await getClient(opts);
    const blocks = opts.blocks == null ? undefined : validateSlackBlocksArray(opts.blocks);
    const trimmedContent = content.trim();
    await client.chat.update({
        channel: channelId,
        ts: messageId,
        text: trimmedContent || (blocks ? buildSlackBlocksFallbackText(blocks) : " "),
        ...(blocks ? { blocks } : {}),
    });
}
export async function deleteSlackMessage(channelId, messageId, opts = {}) {
    const client = await getClient(opts);
    await client.chat.delete({
        channel: channelId,
        ts: messageId,
    });
}
export async function readSlackMessages(channelId, opts = {}) {
    const client = await getClient(opts);
    // Use conversations.replies for thread messages, conversations.history for channel messages.
    if (opts.threadId) {
        const result = await client.conversations.replies({
            channel: channelId,
            ts: opts.threadId,
            limit: opts.limit,
            latest: opts.before,
            oldest: opts.after,
        });
        return {
            // conversations.replies includes the parent message; drop it for replies-only reads.
            messages: (result.messages ?? []).filter((message) => message?.ts !== opts.threadId),
            hasMore: Boolean(result.has_more),
        };
    }
    const result = await client.conversations.history({
        channel: channelId,
        limit: opts.limit,
        latest: opts.before,
        oldest: opts.after,
    });
    return {
        messages: (result.messages ?? []),
        hasMore: Boolean(result.has_more),
    };
}
export async function getSlackMemberInfo(userId, opts = {}) {
    const client = await getClient(opts);
    return await client.users.info({ user: userId });
}
export async function listSlackEmojis(opts = {}) {
    const client = await getClient(opts);
    return await client.emoji.list();
}
export async function pinSlackMessage(channelId, messageId, opts = {}) {
    const client = await getClient(opts);
    await client.pins.add({ channel: channelId, timestamp: messageId });
}
export async function unpinSlackMessage(channelId, messageId, opts = {}) {
    const client = await getClient(opts);
    await client.pins.remove({ channel: channelId, timestamp: messageId });
}
export async function listSlackPins(channelId, opts = {}) {
    const client = await getClient(opts);
    const result = await client.pins.list({ channel: channelId });
    return (result.items ?? []);
}
function normalizeSlackScopeValue(value) {
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
}
function collectSlackDirectShareChannelIds(file) {
    const ids = new Set();
    for (const group of [file.channels, file.groups, file.ims]) {
        if (!Array.isArray(group)) {
            continue;
        }
        for (const entry of group) {
            if (typeof entry !== "string") {
                continue;
            }
            const normalized = normalizeSlackScopeValue(entry);
            if (normalized) {
                ids.add(normalized);
            }
        }
    }
    return ids;
}
function collectSlackShareMaps(file) {
    if (!file.shares || typeof file.shares !== "object" || Array.isArray(file.shares)) {
        return [];
    }
    const shares = file.shares;
    return [shares.public, shares.private].filter((value) => Boolean(value) && typeof value === "object" && !Array.isArray(value));
}
function collectSlackSharedChannelIds(file) {
    const ids = new Set();
    for (const shareMap of collectSlackShareMaps(file)) {
        for (const channelId of Object.keys(shareMap)) {
            const normalized = normalizeSlackScopeValue(channelId);
            if (normalized) {
                ids.add(normalized);
            }
        }
    }
    return ids;
}
function collectSlackThreadShares(file, channelId) {
    const matches = [];
    for (const shareMap of collectSlackShareMaps(file)) {
        const rawEntries = shareMap[channelId];
        if (!Array.isArray(rawEntries)) {
            continue;
        }
        for (const rawEntry of rawEntries) {
            if (!rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) {
                continue;
            }
            const entry = rawEntry;
            const ts = typeof entry.ts === "string" ? normalizeSlackScopeValue(entry.ts) : undefined;
            const threadTs = typeof entry.thread_ts === "string" ? normalizeSlackScopeValue(entry.thread_ts) : undefined;
            matches.push({ channelId, ts, threadTs });
        }
    }
    return matches;
}
function hasSlackScopeMismatch(params) {
    const channelId = normalizeSlackScopeValue(params.channelId);
    if (!channelId) {
        return false;
    }
    const threadId = normalizeSlackScopeValue(params.threadId);
    const directIds = collectSlackDirectShareChannelIds(params.file);
    const sharedIds = collectSlackSharedChannelIds(params.file);
    const hasChannelEvidence = directIds.size > 0 || sharedIds.size > 0;
    const inChannel = directIds.has(channelId) || sharedIds.has(channelId);
    if (hasChannelEvidence && !inChannel) {
        return true;
    }
    if (!threadId) {
        return false;
    }
    const threadShares = collectSlackThreadShares(params.file, channelId);
    if (threadShares.length === 0) {
        return false;
    }
    const threadEvidence = threadShares.filter((entry) => entry.threadTs || entry.ts);
    if (threadEvidence.length === 0) {
        return false;
    }
    return !threadEvidence.some((entry) => entry.threadTs === threadId || entry.ts === threadId);
}
/**
 * Downloads a Slack file by ID and saves it to the local media store.
 * Fetches a fresh download URL via files.info to avoid using stale private URLs.
 * Returns null when the file cannot be found or downloaded.
 */
export async function downloadSlackFile(fileId, opts) {
    const token = resolveToken(opts.token, opts.accountId);
    const client = await getClient(opts);
    // Fetch fresh file metadata (includes a current url_private_download).
    const info = await client.files.info({ file: fileId });
    const file = info.file;
    if (!file?.url_private_download && !file?.url_private) {
        return null;
    }
    if (hasSlackScopeMismatch({ file, channelId: opts.channelId, threadId: opts.threadId })) {
        return null;
    }
    const results = await resolveSlackMedia({
        files: [
            {
                id: file.id,
                name: file.name,
                mimetype: file.mimetype,
                url_private: file.url_private,
                url_private_download: file.url_private_download,
            },
        ],
        token,
        maxBytes: opts.maxBytes,
    });
    return results?.[0] ?? null;
}
