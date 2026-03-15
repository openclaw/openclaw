import crypto from "node:crypto";
import { callGateway } from "../../gateway/call.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  type GatewayMessageChannel,
  INTERNAL_MESSAGE_CHANNEL,
} from "../../utils/message-channel.js";
import { AGENT_LANE_NESTED } from "../lanes.js";
import { readLatestAssistantReply, runAgentStep } from "./agent-step.js";
import { resolveAnnounceTarget } from "./sessions-announce-target.js";
import {
  buildAgentToAgentAnnounceContext,
  buildAgentToAgentReplyContext,
  isAnnounceSkip,
  isReplySkip,
} from "./sessions-send-helpers.js";

const log = createSubsystemLogger("agents/sessions-send");

async function notifyRequesterDeliveryFailure(params: {
  requesterSessionKey?: string;
  requesterChannel?: GatewayMessageChannel;
  targetSessionKey: string;
  targetDisplayKey: string;
  runId: string;
  status: string;
  error?: string;
}) {
  if (!params.requesterSessionKey || params.requesterSessionKey === params.targetSessionKey) {
    return;
  }

  const statusText = params.status.trim() || "error";
  const errorText = params.error?.trim();
  const message = [
    `sessions_send delivery failed for ${params.targetDisplayKey}.`,
    `runId: ${params.runId}`,
    `status: ${statusText}`,
    errorText ? `error: ${errorText}` : undefined,
    "The target session did not produce a reply. Retry or escalate.",
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");

  try {
    await callGateway({
      method: "agent",
      params: {
        message,
        sessionKey: params.requesterSessionKey,
        idempotencyKey: crypto.randomUUID(),
        deliver: false,
        channel: INTERNAL_MESSAGE_CHANNEL,
        lane: AGENT_LANE_NESTED,
        extraSystemPrompt:
          "System notice: sessions_send delivery failed before a reply was available. Return a concise internal status update that includes the target session, run id, status, and error.",
        inputProvenance: {
          kind: "inter_session",
          sourceSessionKey: params.targetSessionKey,
          sourceChannel: params.requesterChannel,
          sourceTool: "sessions_send",
        },
      },
      timeoutMs: 10_000,
    });
  } catch (err) {
    log.warn("sessions_send failure notice delivery failed", {
      runId: params.runId,
      requesterSessionKey: params.requesterSessionKey,
      error: formatErrorMessage(err),
    });
  }
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
}) {
  const runContextId = params.waitRunId ?? "unknown";
  try {
    let primaryReply = params.roundOneReply;
    let latestReply = params.roundOneReply;
    if (!primaryReply && params.waitRunId) {
      const waitMs = Math.min(params.announceTimeoutMs, 60_000);
      let waitStatus: string | undefined;
      let waitError: string | undefined;
      try {
        const wait = await callGateway<{ status?: string; error?: string }>({
          method: "agent.wait",
          params: {
            runId: params.waitRunId,
            timeoutMs: waitMs,
          },
          timeoutMs: waitMs + 2000,
        });
        waitStatus = typeof wait?.status === "string" ? wait.status : undefined;
        waitError = typeof wait?.error === "string" ? wait.error : undefined;
      } catch (err) {
        waitStatus = "error";
        waitError = formatErrorMessage(err);
      }

      if (waitStatus === "ok") {
        primaryReply = await readLatestAssistantReply({
          sessionKey: params.targetSessionKey,
        });
        latestReply = primaryReply;
      } else {
        const statusText = waitStatus ?? "error";
        const errorText = waitError ?? "agent.wait did not return ok";
        log.warn("sessions_send target delivery did not produce an announceable reply", {
          runId: runContextId,
          status: statusText,
          error: errorText,
        });
        await notifyRequesterDeliveryFailure({
          requesterSessionKey: params.requesterSessionKey,
          requesterChannel: params.requesterChannel,
          targetSessionKey: params.targetSessionKey,
          targetDisplayKey: params.displayKey,
          runId: runContextId,
          status: statusText,
          error: errorText,
        });
        return;
      }
    }
    if (!latestReply) {
      await notifyRequesterDeliveryFailure({
        requesterSessionKey: params.requesterSessionKey,
        requesterChannel: params.requesterChannel,
        targetSessionKey: params.targetSessionKey,
        targetDisplayKey: params.displayKey,
        runId: runContextId,
        status: "error",
        error: "target session produced no assistant reply",
      });
      return;
    }

    const announceTarget = await resolveAnnounceTarget({
      sessionKey: params.targetSessionKey,
      displayKey: params.displayKey,
    });
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
        incomingMessage = replyText;
        const swap = currentSessionKey;
        currentSessionKey = nextSessionKey;
        nextSessionKey = swap;
      }
    }

    const announcePrompt = buildAgentToAgentAnnounceContext({
      requesterSessionKey: params.requesterSessionKey,
      requesterChannel: params.requesterChannel,
      targetSessionKey: params.displayKey,
      targetChannel,
      originalMessage: params.message,
      roundOneReply: primaryReply,
      latestReply,
    });

    let announceReply: string | undefined;
    try {
      announceReply = await runAgentStep({
        sessionKey: params.targetSessionKey,
        message: "Agent-to-agent announce step.",
        extraSystemPrompt: announcePrompt,
        timeoutMs: params.announceTimeoutMs,
        lane: AGENT_LANE_NESTED,
        sourceSessionKey: params.requesterSessionKey,
        sourceChannel: params.requesterChannel,
        sourceTool: "sessions_send",
      });
    } catch (err) {
      log.warn("sessions_send announce generation failed", {
        runId: runContextId,
        sessionKey: params.targetSessionKey,
        error: formatErrorMessage(err),
      });
    }

    const trimmedAnnounceReply = announceReply?.trim() ?? "";
    const fallbackReply = latestReply?.trim() ?? "";
    const outboundReply = isAnnounceSkip(trimmedAnnounceReply)
      ? ""
      : trimmedAnnounceReply ||
        (fallbackReply && !isReplySkip(fallbackReply) && !isAnnounceSkip(fallbackReply)
          ? fallbackReply
          : "");

    if (announceTarget && outboundReply) {
      try {
        await callGateway({
          method: "send",
          params: {
            to: announceTarget.to,
            message: outboundReply,
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
  } catch (err) {
    log.warn("sessions_send announce flow failed", {
      runId: runContextId,
      error: formatErrorMessage(err),
    });
  }
}
