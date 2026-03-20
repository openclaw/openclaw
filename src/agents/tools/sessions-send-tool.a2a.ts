import crypto from "node:crypto";
import { callGateway } from "../../gateway/call.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import type { GatewayMessageChannel } from "../../utils/message-channel.js";
import { withTimeout } from "../../utils/with-timeout.js";
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
  const runContextId = params.waitRunId ?? crypto.randomUUID();
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
      // Hook chain preserves turn delivery order without blocking the loop.
      const hookRunner = getGlobalHookRunner();
      const hasA2ATurnHooks = hookRunner?.hasHooks("agent_to_agent_turn") ?? false;
      const resolvedTargetChannel = targetChannel === "unknown" ? undefined : targetChannel;
      const perTurnTimeout = Math.min(params.announceTimeoutMs, 30_000);
      const hookCtx = {
        requesterSessionKey: params.requesterSessionKey,
        targetSessionKey: params.targetSessionKey,
      };
      const deliveryTarget = announceTarget
        ? {
            to: announceTarget.to,
            accountId: announceTarget.accountId,
            channel: announceTarget.channel,
            threadId: announceTarget.threadId,
          }
        : undefined;
      let hookChain: Promise<void> = Promise.resolve();

      // Emit turn=0 for the initial target reply (before ping-pong starts).
      if (hasA2ATurnHooks && latestReply) {
        const event = {
          flowId: runContextId,
          turn: 0,
          maxTurns: params.maxPingPongTurns,
          speakerSessionKey: params.targetSessionKey,
          listenerSessionKey: params.requesterSessionKey,
          speakerRole: "target" as const,
          reply: latestReply,
          requesterChannel: params.requesterChannel,
          targetChannel: resolvedTargetChannel,
          deliveryTarget,
        };
        hookChain = hookChain.then(() =>
          withTimeout(hookRunner!.runAgentToAgentTurn(event, hookCtx), perTurnTimeout).catch(
            () => {},
          ),
        );
      }

      for (let turn = 1; turn <= params.maxPingPongTurns; turn += 1) {
        const currentRole: "requester" | "target" =
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

        // Emit hook so channel plugins can forward A2A turns to users.
        if (hasA2ATurnHooks) {
          const event = {
            flowId: runContextId,
            turn,
            maxTurns: params.maxPingPongTurns,
            speakerSessionKey: currentSessionKey,
            listenerSessionKey: nextSessionKey,
            speakerRole: currentRole,
            reply: replyText,
            requesterChannel: params.requesterChannel,
            targetChannel: resolvedTargetChannel,
            deliveryTarget,
          };
          hookChain = hookChain.then(() =>
            withTimeout(hookRunner!.runAgentToAgentTurn(event, hookCtx), perTurnTimeout).catch(
              () => {},
            ),
          );
        }

        incomingMessage = replyText;
        const swap = currentSessionKey;
        currentSessionKey = nextSessionKey;
        nextSessionKey = swap;
      }
      // Wait for queued turn hooks before announce so users see intermediate
      // turns before the final conclusion.
      // Bound the wait so a slow plugin cannot stall the announce step.
      await withTimeout(hookChain, perTurnTimeout).catch(() => {});
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
      message: "Agent-to-agent announce step.",
      extraSystemPrompt: announcePrompt,
      timeoutMs: params.announceTimeoutMs,
      lane: AGENT_LANE_NESTED,
      sourceSessionKey: params.requesterSessionKey,
      sourceChannel: params.requesterChannel,
      sourceTool: "sessions_send",
    });
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
  } catch (err) {
    log.warn("sessions_send announce flow failed", {
      runId: runContextId,
      error: formatErrorMessage(err),
    });
  }
}
