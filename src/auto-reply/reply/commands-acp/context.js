import { DISCORD_THREAD_BINDING_CHANNEL } from "../../../channels/thread-bindings-policy.js";
import { resolveConversationIdFromTargets } from "../../../infra/outbound/conversation-id.js";
function normalizeString(value) {
    if (typeof value === "string") {
        return value.trim();
    }
    if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
        return `${value}`.trim();
    }
    return "";
}
export function resolveAcpCommandChannel(params) {
    const raw = params.ctx.OriginatingChannel ??
        params.command.channel ??
        params.ctx.Surface ??
        params.ctx.Provider;
    return normalizeString(raw).toLowerCase();
}
export function resolveAcpCommandAccountId(params) {
    const accountId = normalizeString(params.ctx.AccountId);
    return accountId || "default";
}
export function resolveAcpCommandThreadId(params) {
    const threadId = params.ctx.MessageThreadId != null ? normalizeString(String(params.ctx.MessageThreadId)) : "";
    return threadId || undefined;
}
export function resolveAcpCommandConversationId(params) {
    return resolveConversationIdFromTargets({
        threadId: params.ctx.MessageThreadId,
        targets: [params.ctx.OriginatingTo, params.command.to, params.ctx.To],
    });
}
export function isAcpCommandDiscordChannel(params) {
    return resolveAcpCommandChannel(params) === DISCORD_THREAD_BINDING_CHANNEL;
}
export function resolveAcpCommandBindingContext(params) {
    return {
        channel: resolveAcpCommandChannel(params),
        accountId: resolveAcpCommandAccountId(params),
        threadId: resolveAcpCommandThreadId(params),
        conversationId: resolveAcpCommandConversationId(params),
    };
}
