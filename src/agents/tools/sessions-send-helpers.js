import { getChannelPlugin, normalizeChannelId as normalizeAnyChannelId, } from "../../channels/plugins/index.js";
import { resolveSessionConversationRef } from "../../channels/plugins/session-conversation.js";
import { normalizeChannelId as normalizeChatChannelId } from "../../channels/registry.js";
import { ANNOUNCE_SKIP_TOKEN, REPLY_SKIP_TOKEN } from "./sessions-send-tokens.js";
export { ANNOUNCE_SKIP_TOKEN, REPLY_SKIP_TOKEN, isAnnounceSkip, isReplySkip, } from "./sessions-send-tokens.js";
const DEFAULT_PING_PONG_TURNS = 5;
const MAX_PING_PONG_TURNS = 5;
export function resolveAnnounceTargetFromKey(sessionKey) {
    const parsed = resolveSessionConversationRef(sessionKey);
    if (!parsed) {
        return null;
    }
    const normalizedChannel = normalizeAnyChannelId(parsed.channel) ?? normalizeChatChannelId(parsed.channel);
    const channel = normalizedChannel ?? parsed.channel;
    const plugin = normalizedChannel ? getChannelPlugin(normalizedChannel) : null;
    const genericTarget = parsed.kind === "channel" ? `channel:${parsed.id}` : `group:${parsed.id}`;
    const normalized = plugin?.messaging?.resolveSessionTarget?.({
        kind: parsed.kind,
        id: parsed.id,
        threadId: parsed.threadId,
    }) ?? plugin?.messaging?.normalizeTarget?.(genericTarget);
    return {
        channel,
        to: normalized ?? (normalizedChannel ? genericTarget : parsed.id),
        threadId: parsed.threadId,
    };
}
function buildAgentSessionLines(params) {
    return [
        params.requesterSessionKey
            ? `Agent 1 (requester) session: ${params.requesterSessionKey}.`
            : undefined,
        params.requesterChannel
            ? `Agent 1 (requester) channel: ${params.requesterChannel}.`
            : undefined,
        `Agent 2 (target) session: ${params.targetSessionKey}.`,
        params.targetChannel ? `Agent 2 (target) channel: ${params.targetChannel}.` : undefined,
    ].filter((line) => Boolean(line));
}
export function buildAgentToAgentMessageContext(params) {
    const lines = ["Agent-to-agent message context:", ...buildAgentSessionLines(params)].filter(Boolean);
    return lines.join("\n");
}
export function buildAgentToAgentReplyContext(params) {
    const currentLabel = params.currentRole === "requester" ? "Agent 1 (requester)" : "Agent 2 (target)";
    const lines = [
        "Agent-to-agent reply step:",
        `Current agent: ${currentLabel}.`,
        `Turn ${params.turn} of ${params.maxTurns}.`,
        ...buildAgentSessionLines(params),
        `If you want to stop the ping-pong, reply exactly "${REPLY_SKIP_TOKEN}".`,
    ].filter(Boolean);
    return lines.join("\n");
}
export function buildAgentToAgentAnnounceContext(params) {
    const lines = [
        "Agent-to-agent announce step:",
        ...buildAgentSessionLines(params),
        `Original request: ${params.originalMessage}`,
        params.roundOneReply
            ? `Round 1 reply: ${params.roundOneReply}`
            : "Round 1 reply: (not available).",
        params.latestReply ? `Latest reply: ${params.latestReply}` : "Latest reply: (not available).",
        `If you want to remain silent, reply exactly "${ANNOUNCE_SKIP_TOKEN}".`,
        "Any other reply will be posted to the target channel.",
        "After this reply, the agent-to-agent conversation is over.",
    ].filter(Boolean);
    return lines.join("\n");
}
export function resolvePingPongTurns(cfg) {
    const raw = cfg?.session?.agentToAgent?.maxPingPongTurns;
    const fallback = DEFAULT_PING_PONG_TURNS;
    if (typeof raw !== "number" || !Number.isFinite(raw)) {
        return fallback;
    }
    const rounded = Math.floor(raw);
    return Math.max(0, Math.min(MAX_PING_PONG_TURNS, rounded));
}
