import { ChannelType, Routes } from "discord-api-types/v10";
import { logVerbose } from "../../globals.js";
import { createDiscordRestClient } from "../client.js";
import { sendMessageDiscord, sendWebhookMessageDiscord } from "../send.js";
import { createThreadDiscord } from "../send.messages.js";
import { resolveThreadBindingPersonaFromRecord } from "./thread-bindings.persona.js";
import { BINDINGS_BY_THREAD_ID, REUSABLE_WEBHOOKS_BY_ACCOUNT_CHANNEL, rememberReusableWebhook, toReusableWebhookKey, } from "./thread-bindings.state.js";
import { DISCORD_UNKNOWN_CHANNEL_ERROR_CODE, } from "./thread-bindings.types.js";
function buildThreadTarget(threadId) {
    return `channel:${threadId}`;
}
export function isThreadArchived(raw) {
    if (!raw || typeof raw !== "object") {
        return false;
    }
    const asRecord = raw;
    if (asRecord.archived === true) {
        return true;
    }
    if (asRecord.thread_metadata?.archived === true) {
        return true;
    }
    if (asRecord.threadMetadata?.archived === true) {
        return true;
    }
    return false;
}
function isThreadChannelType(type) {
    return (type === ChannelType.PublicThread ||
        type === ChannelType.PrivateThread ||
        type === ChannelType.AnnouncementThread);
}
export function summarizeDiscordError(err) {
    if (err instanceof Error) {
        return err.message;
    }
    if (typeof err === "string") {
        return err;
    }
    if (typeof err === "number" ||
        typeof err === "boolean" ||
        typeof err === "bigint" ||
        typeof err === "symbol") {
        return String(err);
    }
    return "error";
}
function extractNumericDiscordErrorValue(value) {
    if (typeof value === "number" && Number.isFinite(value)) {
        return Math.trunc(value);
    }
    if (typeof value === "string" && /^\d+$/.test(value.trim())) {
        return Number(value);
    }
    return undefined;
}
function extractDiscordErrorStatus(err) {
    if (!err || typeof err !== "object") {
        return undefined;
    }
    const candidate = err;
    return (extractNumericDiscordErrorValue(candidate.status) ??
        extractNumericDiscordErrorValue(candidate.statusCode) ??
        extractNumericDiscordErrorValue(candidate.response?.status));
}
function extractDiscordErrorCode(err) {
    if (!err || typeof err !== "object") {
        return undefined;
    }
    const candidate = err;
    return (extractNumericDiscordErrorValue(candidate.code) ??
        extractNumericDiscordErrorValue(candidate.rawError?.code) ??
        extractNumericDiscordErrorValue(candidate.body?.code) ??
        extractNumericDiscordErrorValue(candidate.response?.body?.code) ??
        extractNumericDiscordErrorValue(candidate.response?.data?.code));
}
export function isDiscordThreadGoneError(err) {
    const code = extractDiscordErrorCode(err);
    if (code === DISCORD_UNKNOWN_CHANNEL_ERROR_CODE) {
        return true;
    }
    const status = extractDiscordErrorStatus(err);
    // 404: deleted/unknown channel. 403: bot no longer has access.
    return status === 404 || status === 403;
}
export async function maybeSendBindingMessage(params) {
    const text = params.text.trim();
    if (!text) {
        return;
    }
    const record = params.record;
    if (params.preferWebhook !== false && record.webhookId && record.webhookToken) {
        try {
            await sendWebhookMessageDiscord(text, {
                webhookId: record.webhookId,
                webhookToken: record.webhookToken,
                accountId: record.accountId,
                threadId: record.threadId,
                username: resolveThreadBindingPersonaFromRecord(record),
            });
            return;
        }
        catch (err) {
            logVerbose(`discord thread binding webhook send failed: ${summarizeDiscordError(err)}`);
        }
    }
    try {
        await sendMessageDiscord(buildThreadTarget(record.threadId), text, {
            accountId: record.accountId,
        });
    }
    catch (err) {
        logVerbose(`discord thread binding fallback send failed: ${summarizeDiscordError(err)}`);
    }
}
export async function createWebhookForChannel(params) {
    try {
        const rest = createDiscordRestClient({
            accountId: params.accountId,
            token: params.token,
        }).rest;
        const created = (await rest.post(Routes.channelWebhooks(params.channelId), {
            body: {
                name: "OpenClaw Agents",
            },
        }));
        const webhookId = typeof created?.id === "string" ? created.id.trim() : "";
        const webhookToken = typeof created?.token === "string" ? created.token.trim() : "";
        if (!webhookId || !webhookToken) {
            return {};
        }
        return { webhookId, webhookToken };
    }
    catch (err) {
        logVerbose(`discord thread binding webhook create failed for ${params.channelId}: ${summarizeDiscordError(err)}`);
        return {};
    }
}
export function findReusableWebhook(params) {
    const reusableKey = toReusableWebhookKey({
        accountId: params.accountId,
        channelId: params.channelId,
    });
    const cached = REUSABLE_WEBHOOKS_BY_ACCOUNT_CHANNEL.get(reusableKey);
    if (cached) {
        return {
            webhookId: cached.webhookId,
            webhookToken: cached.webhookToken,
        };
    }
    for (const record of BINDINGS_BY_THREAD_ID.values()) {
        if (record.accountId !== params.accountId) {
            continue;
        }
        if (record.channelId !== params.channelId) {
            continue;
        }
        if (!record.webhookId || !record.webhookToken) {
            continue;
        }
        rememberReusableWebhook(record);
        return {
            webhookId: record.webhookId,
            webhookToken: record.webhookToken,
        };
    }
    return {};
}
export async function resolveChannelIdForBinding(params) {
    const explicit = params.channelId?.trim();
    if (explicit) {
        return explicit;
    }
    try {
        const rest = createDiscordRestClient({
            accountId: params.accountId,
            token: params.token,
        }).rest;
        const channel = (await rest.get(Routes.channel(params.threadId)));
        const channelId = typeof channel?.id === "string" ? channel.id.trim() : "";
        const type = channel?.type;
        const parentId = typeof channel?.parent_id === "string"
            ? channel.parent_id.trim()
            : typeof channel?.parentId === "string"
                ? channel.parentId.trim()
                : "";
        // Only thread channels should resolve to their parent channel.
        // Non-thread channels (text/forum/media) must keep their own ID.
        if (parentId && isThreadChannelType(type)) {
            return parentId;
        }
        return channelId || null;
    }
    catch (err) {
        logVerbose(`discord thread binding channel resolve failed for ${params.threadId}: ${summarizeDiscordError(err)}`);
        return null;
    }
}
export async function createThreadForBinding(params) {
    try {
        const created = await createThreadDiscord(params.channelId, {
            name: params.threadName,
            autoArchiveMinutes: 60,
        }, {
            accountId: params.accountId,
            token: params.token,
        });
        const createdId = typeof created?.id === "string" ? created.id.trim() : "";
        return createdId || null;
    }
    catch (err) {
        logVerbose(`discord thread binding auto-thread create failed for ${params.channelId}: ${summarizeDiscordError(err)}`);
        return null;
    }
}
