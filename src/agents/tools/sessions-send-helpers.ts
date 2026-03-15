import { parseReplyDirectives } from "../../auto-reply/reply/reply-directives.js";
import {
  getChannelPlugin,
  normalizeChannelId as normalizeAnyChannelId,
} from "../../channels/plugins/index.js";
import { normalizeChannelId as normalizeChatChannelId } from "../../channels/registry.js";
import type { OpenClawConfig } from "../../config/config.js";
import { parseAgentSessionKey, resolveAgentIdFromSessionKey } from "../../routing/session-key.js";

const ANNOUNCE_SKIP_TOKEN = "ANNOUNCE_SKIP";
const REPLY_SKIP_TOKEN = "REPLY_SKIP";
const DEFAULT_PING_PONG_TURNS = 5;
const MAX_PING_PONG_TURNS = 5;

export type AnnounceTarget = {
  channel: string;
  to: string;
  accountId?: string;
  threadId?: string; // Forum topic/thread ID
};

export function resolveAnnounceTargetFromKey(sessionKey: string): AnnounceTarget | null {
  const rawParts = sessionKey.split(":").filter(Boolean);
  const parts = rawParts.length >= 3 && rawParts[0] === "agent" ? rawParts.slice(2) : rawParts;
  if (parts.length < 3) {
    return null;
  }
  const [channelRaw, kind, ...rest] = parts;
  if (kind !== "group" && kind !== "channel") {
    return null;
  }

  // Extract topic/thread ID from rest (supports both :topic: and :thread:)
  // Telegram uses :topic:, other platforms use :thread:
  let threadId: string | undefined;
  const restJoined = rest.join(":");
  const topicMatch = restJoined.match(/:topic:(\d+)$/);
  const threadMatch = restJoined.match(/:thread:(\d+)$/);
  const match = topicMatch || threadMatch;

  if (match) {
    threadId = match[1]; // Keep as string to match AgentCommandOpts.threadId
  }

  // Remove :topic:N or :thread:N suffix from ID for target
  const id = match ? restJoined.replace(/:(topic|thread):\d+$/, "") : restJoined.trim();

  if (!id) {
    return null;
  }
  if (!channelRaw) {
    return null;
  }
  const normalizedChannel = normalizeAnyChannelId(channelRaw) ?? normalizeChatChannelId(channelRaw);
  const channel = normalizedChannel ?? channelRaw.toLowerCase();
  const kindTarget = (() => {
    if (!normalizedChannel) {
      return id;
    }
    if (normalizedChannel === "discord" || normalizedChannel === "slack") {
      return `channel:${id}`;
    }
    return kind === "channel" ? `channel:${id}` : `group:${id}`;
  })();
  const normalized = normalizedChannel
    ? getChannelPlugin(normalizedChannel)?.messaging?.normalizeTarget?.(kindTarget)
    : undefined;
  return {
    channel,
    to: normalized ?? kindTarget,
    threadId,
  };
}

function buildAgentSessionLines(params: {
  requesterSessionKey?: string;
  requesterChannel?: string;
  targetSessionKey: string;
  targetChannel?: string;
}): string[] {
  return [
    params.requesterSessionKey
      ? `Agent 1 (requester) session: ${params.requesterSessionKey}.`
      : undefined,
    params.requesterChannel
      ? `Agent 1 (requester) channel: ${params.requesterChannel}.`
      : undefined,
    `Agent 2 (target) session: ${params.targetSessionKey}.`,
    params.targetChannel ? `Agent 2 (target) channel: ${params.targetChannel}.` : undefined,
  ].filter((line): line is string => Boolean(line));
}

export function buildAgentToAgentMessageContext(params: {
  requesterSessionKey?: string;
  requesterChannel?: string;
  targetSessionKey: string;
}) {
  const lines = ["Agent-to-agent message context:", ...buildAgentSessionLines(params)].filter(
    Boolean,
  );
  return lines.join("\n");
}

export function buildAgentToAgentReplyContext(params: {
  requesterSessionKey?: string;
  requesterChannel?: string;
  targetSessionKey: string;
  targetChannel?: string;
  currentRole: "requester" | "target";
  turn: number;
  maxTurns: number;
}) {
  const currentLabel =
    params.currentRole === "requester" ? "Agent 1 (requester)" : "Agent 2 (target)";
  const lines = [
    "Agent-to-agent reply step:",
    `Current agent: ${currentLabel}.`,
    `Turn ${params.turn} of ${params.maxTurns}.`,
    ...buildAgentSessionLines(params),
    `If you want to stop the ping-pong, reply exactly "${REPLY_SKIP_TOKEN}".`,
  ].filter(Boolean);
  return lines.join("\n");
}

export function buildAgentToAgentAnnounceContext(params: {
  requesterSessionKey?: string;
  requesterChannel?: string;
  targetSessionKey: string;
  targetChannel?: string;
  originalMessage: string;
  roundOneReply?: string;
  latestReply?: string;
}) {
  const sameAgentRoomMove = isSameAgentRoomMove({
    requesterSessionKey: params.requesterSessionKey,
    targetSessionKey: params.targetSessionKey,
  });
  const lines = [
    "Agent-to-agent announce step:",
    ...buildAgentSessionLines(params),
    `Original request: ${params.originalMessage}`,
    params.roundOneReply
      ? `Round 1 reply: ${params.roundOneReply}`
      : "Round 1 reply: (not available).",
    params.latestReply ? `Latest reply: ${params.latestReply}` : "Latest reply: (not available).",
    sameAgentRoomMove
      ? `Same-agent room move: if the original request asked you to say or post something in the target session, output the visible text to post there. Do not reply exactly "${ANNOUNCE_SKIP_TOKEN}" unless the request is purely meta or diagnostic.`
      : undefined,
    `If you want to remain silent, reply exactly "${ANNOUNCE_SKIP_TOKEN}".`,
    "Any other reply will be posted to the target channel.",
    "After this reply, the agent-to-agent conversation is over.",
  ].filter(Boolean);
  return lines.join("\n");
}

export function isAnnounceSkip(text?: string) {
  return (text ?? "").trim() === ANNOUNCE_SKIP_TOKEN;
}

export function isReplySkip(text?: string) {
  return (text ?? "").trim() === REPLY_SKIP_TOKEN;
}

function isTelegramTopicSessionKey(sessionKey?: string): boolean {
  return Boolean(
    sessionKey && sessionKey.includes(":telegram:group:") && sessionKey.includes(":topic:"),
  );
}

function isSameAgentRoomMove(params: {
  requesterSessionKey?: string;
  targetSessionKey: string;
}): boolean {
  if (
    !parseAgentSessionKey(params.requesterSessionKey) ||
    !parseAgentSessionKey(params.targetSessionKey)
  ) {
    return false;
  }
  const requesterAgentId = params.requesterSessionKey
    ? resolveAgentIdFromSessionKey(params.requesterSessionKey)
    : undefined;
  const targetAgentId = resolveAgentIdFromSessionKey(params.targetSessionKey);
  return Boolean(
    requesterAgentId &&
    targetAgentId &&
    requesterAgentId === targetAgentId &&
    params.requesterSessionKey &&
    params.requesterSessionKey !== params.targetSessionKey,
  );
}

function cleanAgentToAgentVisibleText(text?: string): string {
  const parsedReply = parseReplyDirectives(text ?? "");
  return typeof parsedReply.text === "string" ? parsedReply.text.trim() : "";
}

export function shouldSuppressAgentToAgentPingPong(params: {
  requesterSessionKey?: string;
  targetSessionKey: string;
}): boolean {
  return (
    isSameAgentRoomMove(params) ||
    (isTelegramTopicSessionKey(params.requesterSessionKey) &&
      isTelegramTopicSessionKey(params.targetSessionKey))
  );
}

export function resolveAgentToAgentAnnounceFallback(params: {
  requesterSessionKey?: string;
  targetSessionKey: string;
  roundOneReply?: string;
  latestReply?: string;
  originalMessage: string;
}): string | undefined {
  const sameAgentRoomMove = isSameAgentRoomMove(params);
  const visibleTelegramTopicHandoff =
    isTelegramTopicSessionKey(params.requesterSessionKey) &&
    isTelegramTopicSessionKey(params.targetSessionKey) &&
    /\bvisib(?:le|ly)\b/i.test(params.originalMessage);
  if (!sameAgentRoomMove && !visibleTelegramTopicHandoff) {
    return undefined;
  }

  const replyCandidates = sameAgentRoomMove
    ? [params.roundOneReply, params.latestReply]
    : [params.latestReply, params.roundOneReply];
  for (const candidateReply of replyCandidates) {
    if (!candidateReply || isReplySkip(candidateReply) || isAnnounceSkip(candidateReply)) {
      continue;
    }
    const cleanedText = cleanAgentToAgentVisibleText(candidateReply);
    if (cleanedText) {
      return cleanedText;
    }
  }
  return undefined;
}

export function resolvePingPongTurns(cfg?: OpenClawConfig) {
  const raw = cfg?.session?.agentToAgent?.maxPingPongTurns;
  const fallback = DEFAULT_PING_PONG_TURNS;
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return fallback;
  }
  const rounded = Math.floor(raw);
  return Math.max(0, Math.min(MAX_PING_PONG_TURNS, rounded));
}
