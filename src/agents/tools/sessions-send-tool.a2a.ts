/**
 * sessions_send agent-to-agent reply flow.
 *
 * Runs bounded ping-pong delivery, waits for target replies, and suppresses control-token messages.
 */
import crypto from "node:crypto";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../../packages/gateway-protocol/src/client-info.js";
import { mintAgentRuntimeIdentityToken } from "../../gateway/agent-runtime-identity-token.js";
import type { CallGatewayOptions } from "../../gateway/call.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { TurnAuthoritySnapshot } from "../../plugins/authorization-policy.types.js";
import { rebindTurnAuthoritySnapshot } from "../../plugins/turn-authority.js";
import {
  normalizeAgentId,
  normalizeOptionalAgentId,
  parseAgentSessionKey,
} from "../../routing/session-key.js";
import type { GatewayMessageChannel } from "../../utils/message-channel.js";
import {
  type AgentWaitResult,
  type AssistantReplySnapshot,
  hasUpdatedAssistantReplySnapshot,
  isRecoverableAgentWaitError,
  readLatestAssistantReplySnapshot,
  waitForAgentRun,
} from "../run-wait.js";
import { runAgentStep } from "./agent-step.js";
import { resolveAnnounceTarget } from "./sessions-announce-target.js";
import {
  type AnnounceTarget,
  buildAgentToAgentAnnounceContext,
  buildAgentToAgentReplyContext,
  isAnnounceSkip,
  isNonDeliverableSessionsReply,
  isReplySkip,
  isSameSessionsSendEndpoint,
  resolveSessionsSendNestedLane,
} from "./sessions-send-helpers.js";

const log = createSubsystemLogger("agents/sessions-send");

type GatewayCaller = <T = unknown>(opts: CallGatewayOptions) => Promise<T>;

const defaultSessionsSendA2ADeps = {
  callGateway: async <T = unknown>(opts: CallGatewayOptions): Promise<T> => {
    const { callGateway } = await import("../../gateway/call.js");
    return callGateway<T>(opts);
  },
};

let sessionsSendA2ADeps: {
  callGateway: GatewayCaller;
} = defaultSessionsSendA2ADeps;

function isDeliveryFailureWait(wait: AgentWaitResult): boolean {
  return (
    (wait.status === "error" && !isRecoverableAgentWaitError(wait.error)) ||
    (wait.status === "timeout" && wait.pendingError === true)
  );
}

async function deliverAnnounceReply(params: {
  announceTarget: AnnounceTarget;
  message: string;
  runContextId: string;
  targetSessionKey: string;
  targetAgentId: string;
  turnAuthority?: TurnAuthoritySnapshot;
}) {
  const message = params.message.trim();
  if (!message) {
    return;
  }
  try {
    const targetAgentId = normalizeAgentId(params.targetAgentId);
    // The target composes the announce, but its effect still belongs to the source turn.
    // Preserve that principal/source route or Gateway transport auth would widen it to operator.
    const turnAuthority = rebindTurnAuthoritySnapshot(params.turnAuthority, {
      agentId: targetAgentId,
      sessionKey: params.targetSessionKey,
      trigger: "sessions_send",
    });
    if (!turnAuthority) {
      throw new Error("sessions_send announce delivery requires trusted turn authority");
    }
    const agentRuntimeIdentityToken = await mintAgentRuntimeIdentityToken({
      agentId: targetAgentId,
      sessionKey: params.targetSessionKey,
      gatewayMethods: ["send"],
      messageActionContext: {
        expiresAtMs: Date.now() + 60_000,
        turnAuthority,
      },
    });
    await sessionsSendA2ADeps.callGateway({
      method: "send",
      params: {
        to: params.announceTarget.to,
        message,
        channel: params.announceTarget.channel,
        accountId: params.announceTarget.accountId,
        threadId: params.announceTarget.threadId,
        agentId: targetAgentId,
        sessionKey: params.targetSessionKey,
        idempotencyKey: crypto.randomUUID(),
      },
      timeoutMs: 10_000,
      clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
      clientDisplayName: "agent",
      mode: GATEWAY_CLIENT_MODES.BACKEND,
      scopes: ["operator.write"],
      requireLocalBackendSharedAuth: true,
      agentRuntimeIdentityToken,
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
  targetSessionKey: string;
  targetAgentId?: string;
  displayKey: string;
  message: string;
  announceTimeoutMs: number;
  maxPingPongTurns: number;
  requesterSessionKey?: string;
  requesterAgentId?: string;
  requesterChannel?: GatewayMessageChannel;
  requesterSourceRoute?: AnnounceTarget;
  baseline?: AssistantReplySnapshot;
  roundOneReply?: string;
  waitRunId?: string;
  notifyRequesterOnWaitFailure?: boolean;
  turnAuthority?: TurnAuthoritySnapshot;
}) {
  const runContextId = params.waitRunId ?? "unknown";
  try {
    const targetSessionAgentId = parseAgentSessionKey(params.targetSessionKey)?.agentId;
    const explicitTargetAgentId = normalizeOptionalAgentId(params.targetAgentId);
    if (!targetSessionAgentId && !explicitTargetAgentId) {
      throw new Error("sessions_send unscoped target requires an explicit target agent");
    }
    const targetAgentId = explicitTargetAgentId ?? normalizeAgentId(targetSessionAgentId);
    if (targetSessionAgentId && normalizeAgentId(targetSessionAgentId) !== targetAgentId) {
      throw new Error("sessions_send target agent does not match its session");
    }
    const requesterSessionAgentId = parseAgentSessionKey(params.requesterSessionKey)?.agentId;
    const explicitRequesterAgentId = normalizeOptionalAgentId(params.requesterAgentId);
    if (params.requesterSessionKey && !requesterSessionAgentId && !explicitRequesterAgentId) {
      throw new Error("sessions_send unscoped requester requires an explicit requester agent");
    }
    const authorityRequesterAgentId = params.turnAuthority?.authorization.agentId
      ? normalizeAgentId(params.turnAuthority.authorization.agentId)
      : undefined;
    const requesterAgentId =
      explicitRequesterAgentId ??
      authorityRequesterAgentId ??
      normalizeAgentId(requesterSessionAgentId);
    if (
      (authorityRequesterAgentId && authorityRequesterAgentId !== requesterAgentId) ||
      (requesterSessionAgentId && normalizeAgentId(requesterSessionAgentId) !== requesterAgentId)
    ) {
      throw new Error("sessions_send requester agent does not match its authority and session");
    }
    let primaryReply = params.roundOneReply;
    let latestReply = params.roundOneReply;
    if (!primaryReply && params.waitRunId) {
      const wait = await waitForAgentRun({
        runId: params.waitRunId,
        timeoutMs: Math.min(params.announceTimeoutMs, 60_000),
        callGateway: sessionsSendA2ADeps.callGateway,
      });
      if (wait.status === "ok") {
        // A missing pre-run snapshot means freshness is unknowable. Never turn
        // an older assistant message into a new cross-session reply.
        if (params.baseline === undefined) {
          return;
        }
        const latestSnapshot = await readLatestAssistantReplySnapshot({
          sessionKey: params.targetSessionKey,
          agentId: targetAgentId,
          stopAtTranscriptArtifact: true,
          attributableToRunId: params.waitRunId,
          callGateway: sessionsSendA2ADeps.callGateway,
        });
        primaryReply = hasUpdatedAssistantReplySnapshot(latestSnapshot, params.baseline)
          ? latestSnapshot.text
          : undefined;
        latestReply = primaryReply;
      } else {
        if (
          params.notifyRequesterOnWaitFailure === true &&
          params.requesterSessionKey &&
          isDeliveryFailureWait(wait)
        ) {
          const error =
            typeof wait.error === "string" && wait.error.trim() ? `: ${wait.error.trim()}` : "";
          await runAgentStep({
            sessionKey: params.requesterSessionKey,
            message:
              `sessions_send delivery to ${params.displayKey} failed${error}. ` +
              "The target may not have received the message; retry or report the failure instead of assuming delivery succeeded.",
            extraSystemPrompt:
              "A previous sessions_send delivery failed after it was accepted. Decide whether to retry, use another route, or report the failure. Do not assume the target received the message.",
            timeoutMs: params.announceTimeoutMs,
            lane: resolveSessionsSendNestedLane(params.requesterSessionKey, requesterAgentId),
            sourceSessionKey: params.targetSessionKey,
            sourceTool: "sessions_send",
            turnAuthority: params.turnAuthority,
            targetAgentId: requesterAgentId,
          });
        }
        return;
      }
    }
    if (!latestReply) {
      return;
    }
    if (isNonDeliverableSessionsReply(latestReply)) {
      return;
    }

    // A same-session send is a human-facing source-channel reply, not a true
    // agent-to-agent announcement. Asking the same session to decide whether to
    // announce can re-run the same prompt and duplicate source-reply side effects.
    const sameSessionSourceReply =
      params.requesterSessionKey &&
      isSameSessionsSendEndpoint({
        leftSessionKey: params.requesterSessionKey,
        leftAgentId: requesterAgentId,
        rightSessionKey: params.targetSessionKey,
        rightAgentId: targetAgentId,
      });
    if (sameSessionSourceReply && params.requesterSourceRoute) {
      if (params.waitRunId && !params.roundOneReply && params.baseline === undefined) {
        return;
      }
      await deliverAnnounceReply({
        // Session delivery metadata can move while the nested run is active.
        // Use only the immutable host-issued route of the calling turn.
        announceTarget: params.requesterSourceRoute,
        message: latestReply,
        runContextId,
        targetSessionKey: params.targetSessionKey,
        targetAgentId,
        turnAuthority: params.turnAuthority,
      });
      return;
    }
    if (sameSessionSourceReply) {
      return;
    }

    const announceTarget = await resolveAnnounceTarget({
      sessionKey: params.targetSessionKey,
      displayKey: params.displayKey,
      targetAgentId,
    });
    const targetChannel = announceTarget?.channel ?? "unknown";

    if (params.maxPingPongTurns > 0 && params.requesterSessionKey && !sameSessionSourceReply) {
      let currentIsRequester = true;
      let incomingMessage = latestReply;
      for (let turn = 1; turn <= params.maxPingPongTurns; turn += 1) {
        const currentSessionKey = currentIsRequester
          ? params.requesterSessionKey
          : params.targetSessionKey;
        const nextSessionKey = currentIsRequester
          ? params.targetSessionKey
          : params.requesterSessionKey;
        const currentRole = currentIsRequester ? "requester" : "target";
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
          targetAgentId: currentIsRequester ? requesterAgentId : targetAgentId,
          message: incomingMessage,
          extraSystemPrompt: replyPrompt,
          timeoutMs: params.announceTimeoutMs,
          lane: resolveSessionsSendNestedLane(
            currentSessionKey,
            currentIsRequester ? requesterAgentId : targetAgentId,
          ),
          sourceSessionKey: nextSessionKey,
          sourceChannel: currentIsRequester ? targetChannel : params.requesterChannel,
          sourceTool: "sessions_send",
          turnAuthority: params.turnAuthority,
        });
        if (!replyText || isReplySkip(replyText) || isNonDeliverableSessionsReply(replyText)) {
          break;
        }
        latestReply = replyText;
        incomingMessage = replyText;
        currentIsRequester = !currentIsRequester;
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
      sessionKey: params.targetSessionKey,
      targetAgentId,
      message: "Agent-to-agent announce step.",
      extraSystemPrompt: announcePrompt,
      timeoutMs: params.announceTimeoutMs,
      lane: resolveSessionsSendNestedLane(params.targetSessionKey, targetAgentId),
      transcriptMessage: "",
      sourceSessionKey: params.requesterSessionKey,
      sourceChannel: params.requesterChannel,
      sourceTool: "sessions_send",
      turnAuthority: params.turnAuthority,
    });
    if (
      announceTarget &&
      announceReply &&
      announceReply.trim() &&
      !isAnnounceSkip(announceReply) &&
      !isNonDeliverableSessionsReply(announceReply)
    ) {
      await deliverAnnounceReply({
        announceTarget,
        message: announceReply,
        runContextId,
        targetSessionKey: params.targetSessionKey,
        targetAgentId,
        turnAuthority: params.turnAuthority,
      });
    }
  } catch (err) {
    log.warn("sessions_send announce flow failed", {
      runId: runContextId,
      error: formatErrorMessage(err),
    });
  }
}

const testing = {
  setDepsForTest(overrides?: Partial<{ callGateway: GatewayCaller }>) {
    sessionsSendA2ADeps = overrides
      ? {
          ...defaultSessionsSendA2ADeps,
          ...overrides,
        }
      : defaultSessionsSendA2ADeps;
  },
};

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.sessionsSendA2ATestApi")] = {
    testing,
  };
}
