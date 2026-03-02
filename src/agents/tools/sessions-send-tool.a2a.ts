import crypto from "node:crypto";
import { callGateway } from "../../gateway/call.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { emit } from "../../infra/events/bus.js";
import { EVENT_TYPES } from "../../infra/events/schemas.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { GatewayMessageChannel } from "../../utils/message-channel.js";
import { A2AConcurrencyError, getA2AConcurrencyGate } from "../a2a-concurrency.js";
import { AGENT_LANE_NESTED } from "../lanes.js";
import { classifyMessageIntent, resolveEffectivePingPongTurns } from "./a2a-intent-classifier.js";
import { readLatestAssistantReply, runAgentStep } from "./agent-step.js";
import { resolveAnnounceTarget } from "./sessions-announce-target.js";
import {
  buildAgentToAgentAnnounceContext,
  buildAgentToAgentReplyContext,
  isAnnounceSkip,
  isReplySkip,
} from "./sessions-send-helpers.js";

const log = createSubsystemLogger("agents/sessions-send");

const PING_PONG_TURN_TIMEOUT_MS = 120_000;

/** Emit an event with required CoordinationEvent fields filled in. */
function emitA2A(type: string, data: Record<string, unknown>): void {
  emit({ type, agentId: "", ts: Date.now(), data });
}

/** Strip directive tokens like [[reply_to_current]] from a reply string. */
function sanitizeDirectiveTokens(text: string): string {
  return text.replace(/\[\[.*?\]\]\n?/g, "").trim();
}

/** Extract agent name from session key like "agent:requester:main" -> "requester" */
function extractAgentName(sessionKey?: string): string {
  if (!sessionKey) {
    return "unknown";
  }
  const parts = sessionKey.split(":");
  if (parts[0] === "agent" && parts.length >= 2 && parts[1]) {
    return parts[1];
  }
  return sessionKey;
}

export async function runSessionsSendA2AFlow(params: {
  targetSessionKey: string;
  displayKey: string;
  message: string;
  announceTimeoutMs: number;
  maxPingPongTurns: number;
  requesterSessionKey?: string;
  requesterChannel?: GatewayMessageChannel;
  roundOneReply?: string;
  waitRunId?: string;
  conversationId?: string;
  taskId?: string;
  workSessionId?: string;
  parentConversationId?: string;
  depth?: number;
  hop?: number;
  skipPingPong?: boolean;
  startTurn?: number;
  payloadType?: string;
  payloadJson?: string;
  topicId?: string;
  signal?: AbortSignal;
  onTurnComplete?: (turn: number) => Promise<void>;
}): Promise<void> {
  const runContextId = params.waitRunId ?? "unknown";
  const conversationId = params.conversationId ?? crypto.randomUUID();
  const fromAgent = extractAgentName(params.requesterSessionKey);
  const toAgent = extractAgentName(params.targetSessionKey);

  // Emit A2A_SEND event at start
  emitA2A(EVENT_TYPES.A2A_SEND, {
    fromAgent,
    toAgent,
    conversationId,
    message: params.message,
    sessionKey: params.targetSessionKey,
  });

  // Concurrency gate
  const gate = getA2AConcurrencyGate();
  const flowId = conversationId;
  const agentId = params.targetSessionKey;

  if (gate) {
    try {
      await gate.acquire(agentId, flowId);
    } catch (err) {
      if (err instanceof A2AConcurrencyError) {
        emitA2A(EVENT_TYPES.A2A_RESPONSE, {
          fromAgent: toAgent,
          toAgent: fromAgent,
          conversationId,
          outcome: "blocked",
          message: `Concurrency limit exceeded: ${err.message}`,
        });
        emitA2A(EVENT_TYPES.A2A_COMPLETE, {
          fromAgent,
          toAgent,
          conversationId,
          concurrencyBlocked: true,
        });
        return;
      }
      throw err;
    }
  }

  try {
    let primaryReply = params.roundOneReply;
    let latestReply = params.roundOneReply;

    if (!primaryReply && params.waitRunId) {
      const waitMs = Math.min(params.announceTimeoutMs, 60_000);
      let waitResult: { status: string; error?: string } | undefined;
      try {
        waitResult = await callGateway<{ status: string; error?: string }>({
          method: "agent.wait",
          params: {
            runId: params.waitRunId,
            timeoutMs: waitMs,
          },
          timeoutMs: waitMs + 2000,
        });
      } catch {
        waitResult = undefined;
      }

      if (waitResult?.status === "ok") {
        primaryReply = await readLatestAssistantReply({
          sessionKey: params.targetSessionKey,
        });
        latestReply = primaryReply;
      } else {
        // timeout or error path
        const outcomeMessage =
          waitResult?.status === "error" && waitResult.error
            ? `오류: ${waitResult.error}`
            : "메시지가 전달되었으나 응답을 수신하지 못했습니다";

        emitA2A(EVENT_TYPES.A2A_RESPONSE, {
          fromAgent: toAgent,
          toAgent: fromAgent,
          conversationId,
          outcome: "no_reply",
          message: outcomeMessage,
        });
        emitA2A(EVENT_TYPES.A2A_COMPLETE, {
          fromAgent,
          toAgent,
          conversationId,
        });
        return;
      }
    }

    // Determine effective ping-pong turns (skipPingPong + auto-detect signals)
    const intent = classifyMessageIntent(params.message);
    const effectiveTurns = resolveEffectivePingPongTurns({
      configMaxTurns: params.maxPingPongTurns,
      classifiedIntent: intent,
      explicitSkipPingPong: params.skipPingPong === true,
    });

    const announceTarget = await resolveAnnounceTarget({
      sessionKey: params.targetSessionKey,
      displayKey: params.displayKey,
    });
    const targetChannel = announceTarget?.channel ?? "unknown";

    // Emit initial A2A_RESPONSE for the round-one reply
    const sanitizedInitialReply = primaryReply ? sanitizeDirectiveTokens(primaryReply) : "";
    emitA2A(EVENT_TYPES.A2A_RESPONSE, {
      fromAgent: toAgent,
      toAgent: fromAgent,
      conversationId,
      message: sanitizedInitialReply,
      replyPreview: sanitizedInitialReply.slice(0, 200),
      turn: 0,
    });

    // Ping-pong loop
    let terminationReason: string | undefined;
    let actualTurns = 0;

    if (
      effectiveTurns > 0 &&
      params.requesterSessionKey &&
      params.requesterSessionKey !== params.targetSessionKey
    ) {
      let currentSessionKey = params.requesterSessionKey;
      let nextSessionKey = params.targetSessionKey;
      let incomingMessage = latestReply ?? params.message;

      for (let turn = 1; turn <= effectiveTurns; turn += 1) {
        const currentRole =
          currentSessionKey === params.requesterSessionKey ? "requester" : "target";
        const replyPrompt = buildAgentToAgentReplyContext({
          requesterSessionKey: params.requesterSessionKey,
          requesterChannel: params.requesterChannel,
          targetSessionKey: params.displayKey,
          targetChannel,
          currentRole,
          turn,
          maxTurns: effectiveTurns,
        });
        const stepResult = await runAgentStep({
          sessionKey: currentSessionKey,
          message: incomingMessage,
          extraSystemPrompt: replyPrompt,
          timeoutMs: PING_PONG_TURN_TIMEOUT_MS,
          lane: AGENT_LANE_NESTED,
          sourceSessionKey: nextSessionKey,
          sourceChannel:
            nextSessionKey === params.requesterSessionKey ? params.requesterChannel : targetChannel,
          sourceTool: "sessions_send",
        });

        if (!stepResult.ok) {
          terminationReason = stepResult.error?.code === "timeout" ? "turn_timeout" : "agent_error";
          break;
        }

        if (!stepResult.reply) {
          terminationReason = "empty_reply";
          break;
        }

        if (isReplySkip(stepResult.reply)) {
          terminationReason = "explicit_skip";
          break;
        }

        actualTurns = turn;
        latestReply = stepResult.reply;
        incomingMessage = stepResult.reply;

        emitA2A(EVENT_TYPES.A2A_RESPONSE, {
          fromAgent: currentRole === "requester" ? fromAgent : toAgent,
          toAgent: currentRole === "requester" ? toAgent : fromAgent,
          conversationId,
          message: stepResult.reply,
          replyPreview: stepResult.reply.slice(0, 200),
          turn,
        });

        const swap = currentSessionKey;
        currentSessionKey = nextSessionKey;
        nextSessionKey = swap;
      }
    }

    // Announce step
    const announcePrompt = buildAgentToAgentAnnounceContext({
      requesterSessionKey: params.requesterSessionKey,
      requesterChannel: params.requesterChannel,
      targetSessionKey: params.displayKey,
      targetChannel,
      originalMessage: params.message,
      roundOneReply: primaryReply,
      latestReply,
    });
    const announceStepResult = await runAgentStep({
      sessionKey: params.targetSessionKey,
      message: "Agent-to-agent announce step.",
      extraSystemPrompt: announcePrompt,
      timeoutMs: params.announceTimeoutMs,
      lane: AGENT_LANE_NESTED,
      sourceSessionKey: params.requesterSessionKey,
      sourceChannel: params.requesterChannel,
      sourceTool: "sessions_send",
    });

    const announceReply = announceStepResult.reply;
    if (announceTarget && announceReply && announceReply.trim() && !isAnnounceSkip(announceReply)) {
      try {
        await callGateway({
          method: "send",
          params: {
            to: announceTarget.to,
            message: announceReply.trim(),
            channel: announceTarget.channel,
            accountId: announceTarget.accountId,
            idempotencyKey: crypto.randomUUID(),
          },
          timeoutMs: 10_000,
        });
      } catch (err) {
        log.warn("sessions_send announce delivery failed", {
          runId: runContextId,
          channel: announceTarget.channel,
          to: announceTarget.to,
          error: formatErrorMessage(err),
        });
      }
    }

    emitA2A(EVENT_TYPES.A2A_COMPLETE, {
      fromAgent,
      toAgent,
      conversationId,
      actualTurns,
      terminationReason,
    });
  } catch (err) {
    log.warn("sessions_send announce flow failed", {
      runId: runContextId,
      error: formatErrorMessage(err),
    });
  } finally {
    if (gate) {
      gate.release(agentId, flowId);
    }
  }
}
