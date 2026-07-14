/**
 * sessions_send helper logic.
 *
 * Resolves announcement targets, channel/session routing metadata, and ping-pong guard prompt text.
 */
import { randomUUID } from "node:crypto";
import { finiteSecondsToTimerSafeMilliseconds } from "@openclaw/normalization-core/number-coercion";
import {
  getChannelPlugin,
  normalizeChannelId as normalizeAnyChannelId,
} from "../../channels/plugins/index.js";
import { resolveSessionConversationRef } from "../../channels/plugins/session-conversation.js";
import { normalizeChannelId as normalizeChatChannelId } from "../../channels/registry.js";
import { parseSessionThreadInfo } from "../../config/sessions/thread-info.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveAgentIdFromSessionKey, toAgentStoreSessionKey } from "../../routing/session-key.js";
import { ANNOUNCE_SKIP_TOKEN, REPLY_SKIP_TOKEN } from "./sessions-send-tokens.js";
export {
  isAnnounceSkip,
  isNonDeliverableSessionsReply,
  isReplySkip,
} from "./sessions-send-tokens.js";

const DEFAULT_AGENTNG_PONG_TURNS = 5;
const MAX_PING_PONG_TURNS = 20;

export type AnnounceTarget = {
  channel: string;
  to: string;
  accountId?: string;
  threadId?: string; // Forum topic/thread ID
};

type SessionsSendTargetError = {
  runId: string;
  status: "error";
  error: string;
  sessionKey: string;
};

/** Converts the public timeout into bounded run and announcement budgets. */
export function resolveSessionsSendTimeouts(timeoutSeconds: number): {
  timeoutMs: number;
  announceTimeoutMs: number;
} {
  const timeoutMs =
    finiteSecondsToTimerSafeMilliseconds(timeoutSeconds, { floorSeconds: true }) ?? 0;
  return { timeoutMs, announceTimeoutMs: timeoutSeconds === 0 ? 30_000 : timeoutMs };
}

/** Resolves canonical self-target state and target errors shared by send orchestration. */
export function resolveSessionsSendTargetContext(params: {
  requesterSessionKey?: string;
  resolvedKey: string;
  displayKey: string;
  unresolvedDisplayKey: string;
  mainKey: string;
  timeoutSeconds: number;
}): {
  requesterSessionKey?: string;
  sameSessionA2A: boolean;
  errorResult?: SessionsSendTargetError;
} {
  const canonicalTargetKey = params.requesterSessionKey
    ? toAgentStoreSessionKey({
        agentId: resolveAgentIdFromSessionKey(params.requesterSessionKey),
        requestKey: params.resolvedKey,
        mainKey: params.mainKey,
      })
    : params.resolvedKey;
  const base = {
    ...(params.requesterSessionKey ? { requesterSessionKey: params.requesterSessionKey } : {}),
    sameSessionA2A: params.requesterSessionKey === canonicalTargetKey,
  };
  if (parseSessionThreadInfo(params.resolvedKey).threadId) {
    return {
      ...base,
      errorResult: {
        runId: randomUUID(),
        status: "error",
        error:
          "sessions_send cannot target a thread session for inter-agent coordination. Use the parent channel session key instead.",
        sessionKey: params.unresolvedDisplayKey,
      },
    };
  }
  if (params.timeoutSeconds > 0 && base.sameSessionA2A) {
    return {
      ...base,
      errorResult: {
        runId: randomUUID(),
        status: "error",
        error:
          "sessions_send cannot synchronously target the current session. Return the reply directly, or use timeoutSeconds=0 for fire-and-forget delivery.",
        sessionKey: params.displayKey,
      },
    };
  }
  return base;
}

/** Resolves a session key into the channel target used for source-reply announcements. */
export function resolveAnnounceTargetFromKey(sessionKey: string): AnnounceTarget | null {
  const parsed = resolveSessionConversationRef(sessionKey);
  if (!parsed) {
    return null;
  }
  const normalizedChannel =
    normalizeAnyChannelId(parsed.channel) ?? normalizeChatChannelId(parsed.channel);
  const channel = normalizedChannel ?? parsed.channel;
  const plugin = normalizedChannel ? getChannelPlugin(normalizedChannel) : null;
  const genericTarget = parsed.kind === "channel" ? `channel:${parsed.id}` : `group:${parsed.id}`;
  // Prefer plugin-owned target normalization so channel-specific IDs and topics survive routing.
  const normalized =
    plugin?.messaging?.resolveSessionTarget?.({
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

function buildAgentSessionLines(params: {
  requesterSessionKey?: string;
  requesterChannel?: string;
  targetSessionKey: string;
  targetChannel?: string;
}): string[] {
  return [
    // Session keys are high-cardinality (thread/run ids), so concrete values churn the
    // system prompt and break provider prompt-cache reuse across A2A turns. Channels are
    // low-cardinality and inform reply formatting, so they stay concrete.
    params.requesterSessionKey ? "Agent 1 (requester) session: <REQUESTER_SESSION>." : undefined,
    params.requesterChannel
      ? `Agent 1 (requester) channel: ${params.requesterChannel}.`
      : undefined,
    "Agent 2 (target) session: <TARGET_SESSION>.",
    params.targetChannel ? `Agent 2 (target) channel: ${params.targetChannel}.` : undefined,
  ].filter((line): line is string => Boolean(line));
}

/** Builds the initial prompt context for a sessions_send agent-to-agent request. */
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

/** Builds the bounded ping-pong reply prompt for the current A2A participant. */
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

/** Builds the final announce prompt that decides whether to post back to the target channel. */
export function buildAgentToAgentAnnounceContext(params: {
  requesterSessionKey?: string;
  requesterChannel?: string;
  targetSessionKey: string;
  targetChannel?: string;
  originalMessage: string;
  roundOneReply?: string;
  latestReply?: string;
}) {
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

/** Resolves the configured A2A ping-pong turn limit with a hard runtime cap. */
export function resolvePingPongTurns(cfg?: OpenClawConfig) {
  const raw = cfg?.session?.agentToAgent?.maxPingPongTurns;
  const fallback = DEFAULT_AGENTNG_PONG_TURNS;
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return fallback;
  }
  const rounded = Math.floor(raw);
  return Math.max(0, Math.min(MAX_PING_PONG_TURNS, rounded));
}
