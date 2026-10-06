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
import { resolveSessionsSendReplyTarget } from "./sessions-delivery-target.js";
import type { SessionDeliveryTarget } from "./sessions-send-helpers.js";
import { isNonDeliverableSessionsReply } from "./sessions-send-tokens.js";

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

async function deliverSourceReply(params: {
  deliveryTarget: SessionDeliveryTarget;
  callGateway: AgentToolGatewayRequestCaller;
  message: string;
  runId: string;
  targetAgentId: string;
  sessionGeneration: SessionDeliveryGeneration;
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
          to: params.deliveryTarget.to,
          message,
          ...(mediaUrls?.length ? { mediaUrls } : {}),
          agentId: params.targetAgentId,
          ...(audioAsVoice ? { asVoice: true } : {}),
          channel: params.deliveryTarget.channel,
          accountId: params.deliveryTarget.accountId,
          threadId: params.deliveryTarget.threadId,
          idempotencyKey: `sessions-send:${params.runId}`,
        },
        params.sessionGeneration,
      ),
      timeoutMs: 10_000,
    });
  } catch (err) {
    log.warn("sessions_send source reply delivery failed", {
      runId: params.runId,
      channel: params.deliveryTarget.channel,
      to: params.deliveryTarget.to,
      error: formatErrorMessage(err),
    });
  }
}

export async function runSessionsSendA2AFlow(params: {
  callGateway?: AgentToolGatewayRequestCaller;
  targetSessionKey: string;
  targetAgentId: string;
  displayKey: string;
  runId: string;
  replyTimeoutMs: number;
  replyMode?: "peer" | "one-way";
  requesterSessionKey?: string;
  requesterAgentId?: string;
  requesterSession?: AgentStepSession;
  requesterDeliveryGeneration?: SessionDeliveryGeneration;
  requesterOrigin?: DeliveryContext;
  requesterChannel?: string;
  reply?: AgentWaitResult & { replyText?: string };
  notifyRequesterOnWaitFailure?: boolean;
  deliverRequesterReply?: (
    reply: Pick<Parameters<typeof runAgentStep>[0], "message" | "extraSystemPrompt">,
  ) => Promise<void>;
}) {
  const gatewayCall = params.callGateway ?? callAgentToolGatewayRequest;
  const requesterStepContext = {
    agentId: params.requesterAgentId,
    deliveryContext: params.requesterOrigin,
    expectedSession: params.requesterSession,
    timeoutMs: params.replyTimeoutMs,
    sourceSessionKey: params.targetSessionKey,
    callGateway: gatewayCall,
  };
  const deliverRequesterReply = params.deliverRequesterReply ?? runAgentStep;
  try {
    const wait =
      params.reply ??
      (await waitForAgentRunReply({
        runId: params.runId,
        timeoutMs: Math.min(params.replyTimeoutMs, 60_000),
        callGateway: gatewayCall,
        untilTerminal: true,
      }));
    if (wait.status !== "ok") {
      if (
        params.notifyRequesterOnWaitFailure === true &&
        params.requesterSessionKey &&
        isDeliveryFailureWait(wait)
      ) {
        const error =
          typeof wait.error === "string" && wait.error.trim() ? `: ${wait.error.trim()}` : "";
        await deliverRequesterReply({
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
    const reply = wait.replyText;
    if (!reply?.trim() || isNonDeliverableSessionsReply(reply)) {
      return;
    }

    // Self-sends deliver the original output under its captured session generation.
    const sameSessionSourceReply = sameOwnedSession({
      leftKey: params.requesterSessionKey,
      leftAgentId: params.requesterAgentId,
      rightKey: params.targetSessionKey,
      rightAgentId: params.targetAgentId,
    });
    if (sameSessionSourceReply) {
      if (wait.sourceReplyDelivered) {
        return;
      }
      const sourceOrigin = params.requesterOrigin;
      const sourceTarget =
        sourceOrigin?.channel && sourceOrigin.to && !isInternalMessageChannel(sourceOrigin.channel)
          ? {
              channel: sourceOrigin.channel,
              to: sourceOrigin.to,
              accountId: sourceOrigin.accountId,
              threadId: stringifyRouteThreadId(sourceOrigin.threadId),
            }
          : undefined;
      const resolvedTarget = sourceTarget
        ? undefined
        : await resolveSessionsSendReplyTarget({
            sessionKey: params.targetSessionKey,
            displayKey: params.displayKey,
            callGateway: gatewayCall,
            agentId: params.targetAgentId,
          });
      // Captured routes survive metadata changes; the delivery owner checks the
      // original session generation immediately before dispatch.
      const deliveryTarget = sourceTarget ?? resolvedTarget;
      const canDeliverSourceReply =
        deliveryTarget &&
        (sourceTarget ||
          !params.requesterChannel ||
          params.requesterChannel === deliveryTarget.channel);
      if (canDeliverSourceReply) {
        if (!params.requesterDeliveryGeneration) {
          log.warn(
            "sessions_send reply skipped because its original session generation is unavailable",
            {
              runId: params.runId,
            },
          );
          return;
        }
        await deliverSourceReply({
          deliveryTarget,
          callGateway: gatewayCall,
          message: reply,
          runId: params.runId,
          targetAgentId: params.targetAgentId,
          sessionGeneration: params.requesterDeliveryGeneration,
        });
      }
      return;
    }

    if (params.requesterSessionKey) {
      const child = params.replyMode === "one-way";
      await deliverRequesterReply({
        ...requesterStepContext,
        sessionKey: params.requesterSessionKey,
        message: reply,
        extraSystemPrompt: `${child ? "A child session" : "Another session"} returned the result of your earlier sessions_send request. ${SUBAGENT_COMPLETION_OUTCOME_INSTRUCTION} This result is delivered once; your response will not be sent back to the ${child ? "child" : "target session"}.`,
        sourceAgentId: params.targetAgentId,
        sourceTool: child ? "subagent_announce" : "sessions_send",
        ...(child ? { sourceRole: "subagent" as const } : {}),
      });
    }
  } catch (err) {
    if (params.deliverRequesterReply) {
      throw err;
    }
    log.warn("sessions_send reply flow failed", {
      runId: params.runId,
      error: formatErrorMessage(err),
    });
  }
}
