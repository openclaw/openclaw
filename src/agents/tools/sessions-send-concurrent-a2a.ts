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
  buildAgentToAgentReplyContext,
  isAnnounceSkip,
  isReplySkip,
} from "./sessions-send-helpers.js";

const log = createSubsystemLogger("agents/sessions-send-concurrent");

/**
 * Execute complete A2A flow for a single target.
 *
 * Behavior is identical to sessions_send:
 * 1. Wait for primary run completion (if not fire-and-forget)
 * 2. Ping-pong rounds (if enabled by config)
 * 3. Announce step (if valid target exists)
 *
 * Ping-pong conditions (same as sessions_send):
 * - maxPingPongTurns > 0 (from session.agentToAgent.maxPingPongTurns config)
 * - requesterSessionKey exists
 * - requesterSessionKey !== targetSessionKey
 *
 * Announce conditions (same as sessions_send):
 * - Primary run completed successfully
 * - Reply content exists
 * - Valid announce target exists
 * - Agent did NOT reply ANNOUNCE_SKIP
 *
 * Fire-and-forget mode (timeoutSeconds === 0):
 * - A2A flow runs asynchronously in background
 * - Does not return responses to requester (to avoid duplicates)
 *
 * Wait mode (timeoutSeconds > 0):
 * - A2A flow runs asynchronously in background
 * - Does not return responses to requester (to avoid duplicates)
 *
 * @param params - A2A flow parameters
 * @returns Promise<void> - runs asynchronously, no return value
 */
export async function runConcurrentA2AFlowForTarget(params: {
  targetSessionKey: string;
  displayKey: string;
  originalMessage: string;
  requesterSessionKey?: string;
  requesterChannel?: GatewayMessageChannel;
  primaryTimeoutMs: number;
  announceTimeoutMs: number;
  maxPingPongTurns: number;
  isFireAndForget: boolean;
  roundOneReply?: string;
  waitRunId?: string;
}): Promise<void> {
  const runContextId = crypto.randomUUID();

  try {
    let primaryReply = params.roundOneReply;
    let latestReply = params.roundOneReply;

    // ========== Phase 1: Wait for primary run completion (if not fire-and-forget) ==========
    if (!primaryReply && params.waitRunId) {
      log.debug("Concurrent A2A: waiting for primary run", {
        runId: runContextId,
        sessionKey: params.targetSessionKey,
        waitRunId: params.waitRunId,
      });

      const waitMs = Math.min(params.announceTimeoutMs, 60_000);
      const wait = await callGateway<{ status?: string; error?: string }>({
        method: "agent.wait",
        params: {
          runId: params.waitRunId,
          timeoutMs: waitMs,
        },
        timeoutMs: waitMs + 2000,
      });

      const waitStatus = typeof wait?.status === "string" ? wait.status : undefined;
      const waitError = typeof wait?.error === "string" ? wait.error : undefined;

      if (waitStatus === "timeout") {
        log.warn("Concurrent A2A: primary run timed out", {
          runId: runContextId,
          error: waitError,
        });
        return;
      }

      if (waitStatus === "error") {
        log.warn("Concurrent A2A: primary run error", {
          runId: runContextId,
          error: waitError,
        });
        return;
      }

      // Read primary run reply
      primaryReply = await readLatestAssistantReply({
        sessionKey: params.targetSessionKey,
      });
      latestReply = primaryReply;

      if (!latestReply) {
        log.warn("Concurrent A2A: no primary reply", {
          runId: runContextId,
        });
        return;
      }

      log.debug("Concurrent A2A: primary run completed", {
        runId: runContextId,
        replyLength: latestReply.length,
      });
    }

    if (!latestReply) {
      log.debug("Concurrent A2A: no reply available", {
        runId: runContextId,
      });
      return;
    }

    // ========== Phase 2: Ping-pong reply loop (same conditions as sessions_send) ==========
    const announceTarget = await resolveAnnounceTarget({
      sessionKey: params.targetSessionKey,
      displayKey: params.displayKey,
    });
    const targetChannel = announceTarget?.channel ?? "unknown";

    // Ping-pong conditions (identical to sessions_send):
    // 1. maxPingPongTurns > 0
    // 2. requesterSessionKey exists
    // 3. requesterSessionKey !== targetSessionKey
    if (
      params.maxPingPongTurns > 0 &&
      params.requesterSessionKey &&
      params.requesterSessionKey !== params.targetSessionKey
    ) {
      log.debug("Concurrent A2A: starting ping-pong", {
        runId: runContextId,
        maxTurns: params.maxPingPongTurns,
      });

      let currentSessionKey = params.requesterSessionKey;
      let nextSessionKey = params.targetSessionKey;
      let incomingMessage = latestReply;

      for (let turn = 1; turn <= params.maxPingPongTurns; turn += 1) {
        const currentRole =
          currentSessionKey === params.requesterSessionKey ? "requester" : "target";

        // Build ping-pong prompt context
        const replyPrompt = buildAgentToAgentReplyContext({
          requesterSessionKey: params.requesterSessionKey,
          requesterChannel: params.requesterChannel,
          targetSessionKey: params.displayKey,
          targetChannel,
          currentRole,
          turn,
          maxTurns: params.maxPingPongTurns,
        });

        // Execute ping-pong reply
        const replyText = await runAgentStep({
          sessionKey: currentSessionKey,
          message: incomingMessage,
          extraSystemPrompt: replyPrompt,
          timeoutMs: params.announceTimeoutMs,
          lane: AGENT_LANE_NESTED,
          sourceSessionKey: nextSessionKey,
          sourceChannel:
            nextSessionKey === params.requesterSessionKey ? params.requesterChannel : targetChannel,
          sourceTool: "sessions_send_concurrent",
        });

        // Check if should stop ping-pong
        if (!replyText || isReplySkip(replyText)) {
          log.debug("Concurrent A2A: ping-pong stopped", {
            runId: runContextId,
            turn,
            reason: replyText ? "REPLY_SKIP" : "no reply",
          });
          break;
        }

        latestReply = replyText;
        incomingMessage = replyText;

        // Swap session keys for next turn
        const swap = currentSessionKey;
        currentSessionKey = nextSessionKey;
        nextSessionKey = swap;

        log.debug("Concurrent A2A: ping-pong turn completed", {
          runId: runContextId,
          turn,
          replyLength: replyText.length,
        });
      }
    }

    // ========== Phase 3: Announce step (same behavior as sessions_send) ==========
    // Announce conditions (identical to sessions_send):
    // - Valid announce target exists
    // - Agent did NOT reply ANNOUNCE_SKIP
    // - Announce reply is sent to external channel only (not returned to requester)
    if (announceTarget) {
      log.debug("Concurrent A2A: starting announce step", {
        runId: runContextId,
      });

      // Build announce prompt context
      const announcePrompt = buildAgentToAgentAnnounceContext({
        requesterSessionKey: params.requesterSessionKey,
        requesterChannel: params.requesterChannel,
        targetSessionKey: params.displayKey,
        targetChannel,
        originalMessage: params.originalMessage,
        roundOneReply: primaryReply,
        latestReply,
      });

      // Execute announce step
      const announceReply = await runAgentStep({
        sessionKey: params.targetSessionKey,
        message: "Agent-to-agent announce step.",
        extraSystemPrompt: announcePrompt,
        timeoutMs: params.announceTimeoutMs,
        lane: AGENT_LANE_NESTED,
        sourceSessionKey: params.requesterSessionKey,
        sourceChannel: params.requesterChannel,
        sourceTool: "sessions_send_concurrent",
      });

      // Check if agent wants to skip announce
      if (!announceReply || !announceReply.trim() || isAnnounceSkip(announceReply)) {
        log.debug("Concurrent A2A: announce skipped", {
          runId: runContextId,
          reason: announceReply?.trim() === "ANNOUNCE_SKIP" ? "ANNOUNCE_SKIP" : "no reply",
        });
        return;
      }

      // Send to external chat channel
      try {
        await callGateway({
          method: "send",
          params: {
            to: announceTarget.to,
            message: announceReply.trim(),
            channel: announceTarget.channel,
            accountId: announceTarget.accountId,
            threadId: announceTarget.threadId,
            idempotencyKey: crypto.randomUUID(),
          },
          timeoutMs: 10_000,
        });

        log.debug("Concurrent A2A: announce delivered", {
          runId: runContextId,
          channel: announceTarget.channel,
          to: announceTarget.to,
        });

        return;
      } catch (err) {
        const errorMsg = formatErrorMessage(err);
        log.warn("Concurrent A2A: announce delivery failed", {
          runId: runContextId,
          error: errorMsg,
        });
        return;
      }
    } else {
      log.debug("Concurrent A2A: announce skipped (no target)", {
        runId: runContextId,
      });
      return;
    }
  } catch (err) {
    const errorMsg = formatErrorMessage(err);
    log.warn("Concurrent A2A: execution failed", {
      runId: runContextId,
      error: errorMsg,
    });
  }
}
