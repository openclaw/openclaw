import crypto from "node:crypto";
import type { SessionDeliveryGeneration } from "../../config/sessions/session-delivery-generation.types.js";
import { bindInProcessSessionDeliveryGeneration } from "../../gateway/in-process-session-delivery.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { splitMediaFromOutput } from "../../media/parse.js";
import { stringifyRouteThreadId } from "../../plugin-sdk/channel-route.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { parseAgentSessionKey } from "../../sessions/session-key-utils.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import { isInternalMessageChannel } from "../../utils/message-channel.js";
import {
  type AgentWaitResult,
  isTerminalAgentWaitTimeout,
  waitForAgentRunReply,
} from "../run-wait.js";
import { SUBAGENT_COMPLETION_OUTCOME_INSTRUCTION } from "../subagents/completion/subagent-completion-instructions.js";
import { runAgentStep, type AgentStepSession } from "./agent-step.js";
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
  sessionGeneration?: SessionDeliveryGeneration;
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
      params: bindInProcessSessionDeliveryGeneration(
        {
          to: params.announceTarget.to,
          message,
          ...(mediaUrls?.length ? { mediaUrls } : {}),
          agentId: params.targetAgentId,
          ...(audioAsVoice ? { asVoice: true } : {}),
          channel: params.announceTarget.channel,
          accountId: params.announceTarget.accountId,
          threadId: params.announceTarget.threadId,
          idempotencyKey: params.sessionGeneration
            ? `sessions-send:${params.runContextId}`
            : crypto.randomUUID(),
        },
        params.sessionGeneration,
      ),
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
  requesterSession?: AgentStepSession;
  requesterDeliveryGeneration?: SessionDeliveryGeneration;
  requesterOrigin?: DeliveryContext;
  requesterChannel?: string;
  sourceReplyDelivered?: true;
  roundOneReply?: string;
  waitRunId?: string;
  settledReply?: AgentWaitResult & { replyText?: string };
  replyRunId?: string;
  notifyRequesterOnWaitFailure?: boolean;
}) {
  const runContextId = params.replyRunId ?? params.waitRunId ?? crypto.randomUUID();
  const gatewayCall = params.callGateway ?? callAgentToolGatewayRequest;
  const requesterStepContext = {
    agentId: params.requesterAgentId,
    deliveryContext: params.requesterOrigin,
    expectedSession: params.requesterSession,
    timeoutMs: params.announceTimeoutMs,
    sourceSessionKey: params.targetSessionKey,
    callGateway: gatewayCall,
  };
  try {
    let primaryReply = params.roundOneReply;
    let sourceReplyDelivered = params.sourceReplyDelivered;
    if (!primaryReply && (params.waitRunId || params.settledReply)) {
      const wait =
        params.settledReply ??
        (await waitForAgentRunReply({
          runId: params.waitRunId!,
          timeoutMs: Math.min(params.announceTimeoutMs, 60_000),
          callGateway: gatewayCall,
          untilTerminal: true,
        }));
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
            ...requesterStepContext,
            sessionKey: params.requesterSessionKey,
            message: wait.sourceReplyDelivered
              ? `sessions_send target run for ${params.displayKey} failed${error}. The target's final reply was already delivered to its source conversation. Do not resend; report the run failure.`
              : `sessions_send delivery to ${params.displayKey} failed${error}. The target may not have received the message; retry or report the failure instead of assuming delivery succeeded.`,
            extraSystemPrompt: wait.sourceReplyDelivered
              ? "The target run failed after its final source reply was delivered. Preserve the run error diagnosis. Do not resend the message or the reply."
              : "A previous sessions_send delivery failed after it was accepted. Inspect the accepted operation before retrying, or report the failure. Preserve attributed session-tool delivery; do not replace it with an operator CLI request. Do not assume the target received the message.",
            sourceTool: params.replyMode === "one-way" ? "subagent_announce" : "sessions_send",
            ...(params.replyMode === "one-way" ? { sourceRole: "subagent" as const } : {}),
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
          ...requesterStepContext,
          sessionKey: params.requesterSessionKey,
          message: latestReply,
          extraSystemPrompt: `A child session returned the result of your earlier sessions_send request. ${SUBAGENT_COMPLETION_OUTCOME_INSTRUCTION} This result is delivered once; your response will not be sent back to the child.`,
          sourceAgentId: params.targetAgentId,
          sourceTool: "subagent_announce",
          sourceRole: "subagent",
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
    // Only same-session source delivery proves that the requester already saw the
    // reply. For distinct peers, the receipt can belong to the target's channel.
    if (sameSessionSourceReply && sourceReplyDelivered) {
      return;
    }
    // Control UI sessions are human-facing conversations, not autonomous peers.
    // Deliver the target result to the requester once, but do not feed the
    // requester's human-facing response back into the target session. Preserve
    // any still-owed announcement to a target's external channel below.
    const oneWayInternalRequesterSessionKey =
      params.requesterSessionKey &&
      !sameSessionSourceReply &&
      isInternalMessageChannel(params.requesterChannel)
        ? params.requesterSessionKey
        : undefined;
    if (oneWayInternalRequesterSessionKey) {
      await runAgentStep({
        ...requesterStepContext,
        sessionKey: oneWayInternalRequesterSessionKey,
        message: latestReply,
        extraSystemPrompt: `Another session returned the result of your earlier sessions_send request. ${SUBAGENT_COMPLETION_OUTCOME_INSTRUCTION} This result is delivered once; your response will not be sent back to the target session.`,
        sourceAgentId: params.targetAgentId,
        sourceTool: "sessions_send",
      });
      if (sourceReplyDelivered) {
        return;
      }
    }

    const sourceOrigin = sameSessionSourceReply ? params.requesterOrigin : undefined;
    const sourceTarget =
      sourceOrigin?.channel && sourceOrigin.to && !isInternalMessageChannel(sourceOrigin.channel)
        ? {
            channel: sourceOrigin.channel,
            to: sourceOrigin.to,
            accountId: sourceOrigin.accountId,
            threadId: stringifyRouteThreadId(sourceOrigin.threadId),
          }
        : undefined;
    const resolvedTarget = await resolveAnnounceTarget({
      sessionKey: params.targetSessionKey,
      displayKey: params.displayKey,
      callGateway: gatewayCall,
      agentId: params.targetAgentId,
    });
    // Captured routes survive metadata changes; the delivery owner checks the
    // original session generation immediately before dispatch.
    const announceTarget = sourceTarget ?? resolvedTarget;
    const targetChannel = announceTarget?.channel ?? "unknown";
    if (
      oneWayInternalRequesterSessionKey &&
      (!announceTarget || isInternalMessageChannel(announceTarget.channel))
    ) {
      return;
    }
    const canDirectDeliverSameSessionReply =
      announceTarget &&
      (sourceTarget ||
        !params.requesterChannel ||
        params.requesterChannel === announceTarget.channel);
    if (sameSessionSourceReply && canDirectDeliverSameSessionReply) {
      if (!params.requesterDeliveryGeneration) {
        log.warn(
          "sessions_send reply skipped because its original session generation is unavailable",
          {
            runId: runContextId,
          },
        );
        return;
      }
      await deliverAnnounceReply({
        announceTarget,
        callGateway: gatewayCall,
        message: latestReply,
        runContextId,
        targetAgentId: params.targetAgentId,
        sessionGeneration: params.requesterDeliveryGeneration,
      });
      return;
    }
    if (sameSessionSourceReply && !announceTarget) {
      return;
    }

    if (
      !oneWayInternalRequesterSessionKey &&
      params.maxPingPongTurns > 0 &&
      params.requesterSessionKey &&
      !sameSessionSourceReply
    ) {
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
          ...(current.role === "requester"
            ? {
                deliveryContext: params.requesterOrigin,
                expectedSession: params.requesterSession,
              }
            : {}),
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
