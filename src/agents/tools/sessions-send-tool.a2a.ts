import crypto from "node:crypto";
import { callGateway } from "../../gateway/call.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { GatewayMessageChannel } from "../../utils/message-channel.js";
import { AGENT_LANE_NESTED } from "../lanes.js";
import { readLatestAssistantReply, runAgentStep } from "./agent-step.js";
import { resolveAnnounceTarget } from "./sessions-announce-target.js";
import {
  buildAgentToAgentAnnounceContext,
  buildAgentToAgentRelayText,
  buildAgentToAgentReplyContext,
  isAnnounceSkip,
  isReplySkip,
  type AnnounceTarget,
  type RelayPolicy,
} from "./sessions-send-helpers.js";

const log = createSubsystemLogger("agents/sessions-send");

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
  relayPolicy?: RelayPolicy;
  sourceRelayTarget?: AnnounceTarget | null;
  targetRelayTarget?: AnnounceTarget | null;
  requesterAgentId?: string;
  targetAgentId?: string;
}) {
  const runContextId = params.waitRunId ?? "unknown";
  const relayTargets = (() => {
    if (params.relayPolicy?.enabled !== true) {
      return [] as AnnounceTarget[];
    }
    if (params.relayPolicy.mode === "dual-channel") {
      return [params.sourceRelayTarget, params.targetRelayTarget].filter(
        Boolean,
      ) as AnnounceTarget[];
    }
    return [params.targetRelayTarget].filter(Boolean) as AnnounceTarget[];
  })();
  const relayTurn = async (fromAgent: string, toAgent: string, text: string) => {
    if (!text.trim() || relayTargets.length === 0) {
      return;
    }
    const relayText = buildAgentToAgentRelayText({
      handoffId: runContextId,
      fromAgent,
      toAgent,
      text,
    });
    await Promise.all(
      relayTargets.map((target, index) =>
        callGateway({
          method: "send",
          params: {
            to: target.to,
            message: relayText,
            channel: target.channel,
            accountId: target.accountId,
            threadId: target.threadId,
            idempotencyKey: `${runContextId}:relay:${fromAgent}:${toAgent}:${index}`,
          },
          timeoutMs: 10_000,
        }).catch((err) => {
          log.warn("sessions_send relay delivery failed", {
            runId: runContextId,
            channel: target.channel,
            to: target.to,
            error: formatErrorMessage(err),
          });
        }),
      ),
    );
  };
  try {
    let primaryReply = params.roundOneReply;
    let latestReply = params.roundOneReply;
    if (!primaryReply && params.waitRunId) {
      const waitMs = Math.min(params.announceTimeoutMs, 60_000);
      const wait = await callGateway<{ status: string }>({
        method: "agent.wait",
        params: {
          runId: params.waitRunId,
          timeoutMs: waitMs,
        },
        timeoutMs: waitMs + 2000,
      });
      if (wait?.status === "ok") {
        primaryReply = await readLatestAssistantReply({
          sessionKey: params.targetSessionKey,
        });
        latestReply = primaryReply;
      }
    }
    if (!latestReply) {
      return;
    }

    if (params.relayPolicy?.enabled === true) {
      await relayTurn(
        params.requesterAgentId ?? "requester",
        params.targetAgentId ?? "target",
        params.message,
      );
      if (params.relayPolicy.mirrorTurns === "round1" || params.relayPolicy.mirrorTurns === "all") {
        await relayTurn(
          params.targetAgentId ?? "target",
          params.requesterAgentId ?? "requester",
          latestReply,
        );
      }
    }

    const announceTarget =
      params.targetRelayTarget ??
      (await resolveAnnounceTarget({
        sessionKey: params.targetSessionKey,
        displayKey: params.displayKey,
      }));
    const targetChannel = announceTarget?.channel ?? "unknown";

    if (
      params.maxPingPongTurns > 0 &&
      params.requesterSessionKey &&
      params.requesterSessionKey !== params.targetSessionKey
    ) {
      let currentSessionKey = params.requesterSessionKey;
      let nextSessionKey = params.targetSessionKey;
      let incomingMessage = latestReply;
      for (let turn = 1; turn <= params.maxPingPongTurns; turn += 1) {
        const currentRole =
          currentSessionKey === params.requesterSessionKey ? "requester" : "target";
        const replyPrompt = buildAgentToAgentReplyContext({
          requesterSessionKey: params.requesterSessionKey,
          requesterChannel: params.requesterChannel,
          targetSessionKey: params.displayKey,
          targetChannel,
          currentRole,
          turn,
          maxTurns: params.maxPingPongTurns,
        });
        const replyText = await runAgentStep({
          sessionKey: currentSessionKey,
          message: incomingMessage,
          extraSystemPrompt: replyPrompt,
          timeoutMs: params.announceTimeoutMs,
          lane: AGENT_LANE_NESTED,
          sourceSessionKey: nextSessionKey,
          sourceChannel:
            nextSessionKey === params.requesterSessionKey ? params.requesterChannel : targetChannel,
          sourceTool: "sessions_send",
        });
        if (!replyText || isReplySkip(replyText)) {
          break;
        }
        latestReply = replyText;
        if (params.relayPolicy?.enabled === true && params.relayPolicy.mirrorTurns === "all") {
          const fromAgent =
            currentRole === "requester"
              ? (params.requesterAgentId ?? "requester")
              : (params.targetAgentId ?? "target");
          const toAgent =
            currentRole === "requester"
              ? (params.targetAgentId ?? "target")
              : (params.requesterAgentId ?? "requester");
          await relayTurn(fromAgent, toAgent, replyText);
        }
        incomingMessage = replyText;
        const swap = currentSessionKey;
        currentSessionKey = nextSessionKey;
        nextSessionKey = swap;
      }
    }

    const suppressAnnounceForRelay =
      params.relayPolicy?.enabled === true && params.relayPolicy.mode === "dual-channel";
    if (!suppressAnnounceForRelay) {
      const announcePrompt = buildAgentToAgentAnnounceContext({
        requesterSessionKey: params.requesterSessionKey,
        requesterChannel: params.requesterChannel,
        targetSessionKey: params.displayKey,
        targetChannel,
        originalMessage: params.message,
        roundOneReply: primaryReply,
        latestReply,
      });
      const announceReply = await runAgentStep({
        sessionKey: params.targetSessionKey,
        message: "Agent-to-agent announce step.",
        extraSystemPrompt: announcePrompt,
        timeoutMs: params.announceTimeoutMs,
        lane: AGENT_LANE_NESTED,
        sourceSessionKey: params.requesterSessionKey,
        sourceChannel: params.requesterChannel,
        sourceTool: "sessions_send",
      });
      if (
        announceTarget &&
        announceReply &&
        announceReply.trim() &&
        !isAnnounceSkip(announceReply)
      ) {
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
    }
  } catch (err) {
    log.warn("sessions_send announce flow failed", {
      runId: runContextId,
      error: formatErrorMessage(err),
    });
  }
}
