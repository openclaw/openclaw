/**
 * sessions_send agent-to-agent reply flow.
 *
 * Runs bounded ping-pong delivery, waits for target replies, and suppresses control-token messages.
 */
import crypto from "node:crypto";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { splitMediaFromOutput } from "../../media/parse.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { parseAgentSessionKey } from "../../sessions/session-key-utils.js";
import {
  type AgentWaitResult,
  isTerminalAgentWaitTimeout,
  waitForAgentRunReply,
} from "../run-wait.js";
import { SUBAGENT_COMPLETION_OUTCOME_INSTRUCTION } from "../subagents/completion/subagent-completion-instructions.js";
import { runAgentStep } from "./agent-step.js";
import {
  callAgentToolGatewayRequest,
  type AgentToolGatewayRequestCaller,
} from "./in-process-gateway.js";
import { resolveAnnounceTarget } from "./sessions-announce-target.js";
import {
  type AnnounceTarget,
  buildAgentToAgentAnnounceContext,
  buildAgentToAgentReplyContext,
  isNonDeliverableSessionsReply,
} from "./sessions-send-helpers.js";

const log = createSubsystemLogger("agents/sessions-send");

function sameOwnedSession(params: {
  leftKey: string | undefined;
  leftAgentId: string | undefined;
  rightKey: string;
  rightAgentId: string | undefined;
}): boolean {
  if (!params.leftKey || params.leftKey !== params.rightKey) {
    return false;
  }
  const leftAgentId = params.leftAgentId ?? parseAgentSessionKey(params.leftKey)?.agentId;
  const rightAgentId = params.rightAgentId ?? parseAgentSessionKey(params.rightKey)?.agentId;
  return Boolean(
    leftAgentId && rightAgentId && normalizeAgentId(leftAgentId) === normalizeAgentId(rightAgentId),
  );
}
function isDeliveryFailureWait(wait: AgentWaitResult): boolean {
  return (
    (wait.status === "error" && !wait.retryableTransportError) || isTerminalAgentWaitTimeout(wait)
  );
}

async function deliverAnnounceReply(params: {
  announceTarget: AnnounceTarget;
  callGateway: AgentToolGatewayRequestCaller;
  message: string;
  runContextId: string;
  targetAgentId: string;
}) {
  // Gateway sends need the selected owner for text routing and media roots;
  // carry the admitted target instead of relying on an implicit default.
  const { text: message, mediaUrls, audioAsVoice } = splitMediaFromOutput(params.message.trim());
  if (!message && !mediaUrls?.length) {
    return;
  }
  try {
    await params.callGateway({
      method: "send",
      params: {
        to: params.announceTarget.to,
        message,
        ...(mediaUrls?.length ? { mediaUrls } : {}),
        agentId: params.targetAgentId,
        ...(audioAsVoice ? { asVoice: true } : {}),
        channel: params.announceTarget.channel,
        accountId: params.announceTarget.accountId,
        threadId: params.announceTarget.threadId,
        idempotencyKey: crypto.randomUUID(),
      },
      timeoutMs: 10_000,
    });
  } catch (err) {
    log.warn("sessions_send announce delivery failed", {
      runId: params.runContextId,
      channel: params.announceTarget.channel,
      to: params.announceTarget.to,
      error: formatErrorMessage(err),
    });
  }
}

export async function runSessionsSendA2AFlow(params: {
  callGateway?: AgentToolGatewayRequestCaller;
  targetSessionKey: string;
  targetAgentId: string;
  displayKey: string;
  message: string;
  announceTimeoutMs: number;
  maxPingPongTurns: number;
  replyMode?: "peer" | "one-way";
  requesterSessionKey?: string;
  requesterAgentId?: string;
  requesterChannel?: string;
  sourceReplyDelivered?: true;
  roundOneReply?: string;
  waitRunId?: string;
  notifyRequesterOnWaitFailure?: boolean;
}) {
  const runContextId = params.waitRunId ?? "unknown";
  const gatewayCall = params.callGateway ?? callAgentToolGatewayRequest;
  try {
    let primaryReply = params.roundOneReply;
    let sourceReplyDelivered = params.sourceReplyDelivered;
    if (!primaryReply && params.waitRunId) {
      const wait = await waitForAgentRunReply({
        runId: params.waitRunId,
        timeoutMs: Math.min(params.announceTimeoutMs, 60_000),
        callGateway: gatewayCall,
        untilTerminal: true,
      });
      if (wait.status === "ok") {
        primaryReply = wait.replyText;
        sourceReplyDelivered = wait.sourceReplyDelivered;
      } else {
        if (
          params.notifyRequesterOnWaitFailure === true &&
          params.requesterSessionKey &&
          isDeliveryFailureWait(wait)
        ) {
          const error =
            typeof wait.error === "string" && wait.error.trim() ? `: ${wait.error.trim()}` : "";
          await runAgentStep({
            agentId: params.requesterAgentId,
            sessionKey: params.requesterSessionKey,
            message: wait.sourceReplyDelivered
              ? `sessions_send target run for ${params.displayKey} failed${error}. The target's final reply was already delivered to its source conversation. Do not resend; report the run failure.`
              : `sessions_send delivery to ${params.displayKey} failed${error}. The target may not have received the message; retry or report the failure instead of assuming delivery succeeded.`,
            extraSystemPrompt: wait.sourceReplyDelivered
              ? "The target run failed after its final source reply was delivered. Preserve the run error diagnosis. Do not resend the message or the reply."
              : "A previous sessions_send delivery failed after it was accepted. Inspect the accepted operation before retrying, or report the failure. Preserve attributed session-tool delivery; do not replace it with an operator CLI request. Do not assume the target received the message.",
            timeoutMs: params.announceTimeoutMs,
            sourceSessionKey: params.targetSessionKey,
            sourceTool: params.replyMode === "one-way" ? "subagent_announce" : "sessions_send",
            ...(params.replyMode === "one-way" ? { sourceRole: "subagent" as const } : {}),
            callGateway: gatewayCall,
          });
        }
        return;
      }
    }
    let latestReply = primaryReply;
    if (!latestReply || isNonDeliverableSessionsReply(latestReply)) {
      return;
    }

    if (params.replyMode === "one-way") {
      if (params.requesterSessionKey) {
        await runAgentStep({
          agentId: params.requesterAgentId,
          sessionKey: params.requesterSessionKey,
          message: latestReply,
          extraSystemPrompt: `A child session returned the result of your earlier sessions_send request. ${SUBAGENT_COMPLETION_OUTCOME_INSTRUCTION} This result is delivered once; your response will not be sent back to the child.`,
          timeoutMs: params.announceTimeoutMs,
          sourceAgentId: params.targetAgentId,
          sourceSessionKey: params.targetSessionKey,
          sourceTool: "subagent_announce",
          sourceRole: "subagent",
          callGateway: gatewayCall,
        });
      }
      return;
    }

    // A same-session send is a human-facing source-channel reply, not a true
    // agent-to-agent announcement. Asking the same session to decide whether to
    // announce can re-run the same prompt and duplicate source-reply side effects.
    const sameSessionSourceReply = sameOwnedSession({
      leftKey: params.requesterSessionKey,
      leftAgentId: params.requesterAgentId,
      rightKey: params.targetSessionKey,
      rightAgentId: params.targetAgentId,
    });
    if (sameSessionSourceReply && sourceReplyDelivered) {
      return;
    }
    const announceTarget = await resolveAnnounceTarget({
      sessionKey: params.targetSessionKey,
      displayKey: params.displayKey,
      callGateway: gatewayCall,
      agentId: params.targetAgentId,
    });
    const targetChannel = announceTarget?.channel ?? "unknown";
    const canDirectDeliverSameSessionReply =
      announceTarget &&
      (!params.requesterChannel || params.requesterChannel === announceTarget.channel);
    if (sameSessionSourceReply && canDirectDeliverSameSessionReply) {
      await deliverAnnounceReply({
        announceTarget,
        callGateway: gatewayCall,
        message: latestReply,
        runContextId,
        targetAgentId: params.targetAgentId,
      });
      return;
    }
    if (sameSessionSourceReply && !announceTarget) {
      return;
    }

    if (params.maxPingPongTurns > 0 && params.requesterSessionKey && !sameSessionSourceReply) {
      const requester = {
        sessionKey: params.requesterSessionKey,
        agentId: params.requesterAgentId,
        channel: params.requesterChannel,
        role: "requester" as const,
      };
      const target = {
        sessionKey: params.targetSessionKey,
        agentId: params.targetAgentId,
        channel: targetChannel,
        role: "target" as const,
      };
      for (let turn = 1; turn <= params.maxPingPongTurns; turn += 1) {
        const current = turn % 2 === 1 ? requester : target;
        const source = turn % 2 === 1 ? target : requester;
        const replyPrompt = buildAgentToAgentReplyContext({
          requesterSessionKey: params.requesterSessionKey,
          requesterChannel: params.requesterChannel,
          targetSessionKey: params.displayKey,
          targetChannel,
          currentRole: current.role,
          turn,
          maxTurns: params.maxPingPongTurns,
        });
        const replyText = await runAgentStep({
          agentId: current.agentId,
          sessionKey: current.sessionKey,
          message: latestReply,
          extraSystemPrompt: replyPrompt,
          timeoutMs: params.announceTimeoutMs,
          sourceAgentId: source.agentId,
          sourceSessionKey: source.sessionKey,
          sourceChannel: source.channel,
          sourceTool: "sessions_send",
          callGateway: gatewayCall,
        });
        if (!replyText || isNonDeliverableSessionsReply(replyText)) {
          break;
        }
        latestReply = replyText;
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
    const announceReply = await runAgentStep({
      agentId: params.targetAgentId,
      sessionKey: params.targetSessionKey,
      message: "Agent-to-agent announce step.",
      extraSystemPrompt: announcePrompt,
      timeoutMs: params.announceTimeoutMs,
      transcriptMessage: "",
      sourceSessionKey: params.requesterSessionKey,
      sourceChannel: params.requesterChannel,
      sourceTool: "sessions_send",
      callGateway: gatewayCall,
    });
    if (
      announceTarget &&
      announceReply &&
      announceReply.trim() &&
      !isNonDeliverableSessionsReply(announceReply)
    ) {
      await deliverAnnounceReply({
        announceTarget,
        callGateway: gatewayCall,
        message: announceReply,
        runContextId,
        targetAgentId: params.targetAgentId,
      });
    }
  } catch (err) {
    log.warn("sessions_send announce flow failed", {
      runId: runContextId,
      error: formatErrorMessage(err),
    });
  }
}
