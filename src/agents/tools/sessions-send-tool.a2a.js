import crypto from "node:crypto";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { resolveNestedAgentLaneForSession } from "../lanes.js";
import { readLatestAssistantReply, waitForAgentRun } from "../run-wait.js";
import { runAgentStep } from "./agent-step.js";
import { resolveAnnounceTarget } from "./sessions-announce-target.js";
import { buildAgentToAgentAnnounceContext, buildAgentToAgentReplyContext, isAnnounceSkip, isReplySkip, } from "./sessions-send-helpers.js";
const log = createSubsystemLogger("agents/sessions-send");
const defaultSessionsSendA2ADeps = {
    callGateway: async (opts) => {
        const { callGateway } = await import("../../gateway/call.js");
        return callGateway(opts);
    },
};
let sessionsSendA2ADeps = defaultSessionsSendA2ADeps;
export async function runSessionsSendA2AFlow(params) {
    const runContextId = params.waitRunId ?? "unknown";
    try {
        let primaryReply = params.roundOneReply;
        let latestReply = params.roundOneReply;
        if (!primaryReply && params.waitRunId) {
            const wait = await waitForAgentRun({
                runId: params.waitRunId,
                timeoutMs: Math.min(params.announceTimeoutMs, 60_000),
                callGateway: sessionsSendA2ADeps.callGateway,
            });
            if (wait.status === "ok") {
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
        if (params.maxPingPongTurns > 0 &&
            params.requesterSessionKey &&
            params.requesterSessionKey !== params.targetSessionKey) {
            let currentSessionKey = params.requesterSessionKey;
            let nextSessionKey = params.targetSessionKey;
            let incomingMessage = latestReply;
            for (let turn = 1; turn <= params.maxPingPongTurns; turn += 1) {
                const currentRole = currentSessionKey === params.requesterSessionKey ? "requester" : "target";
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
                    lane: resolveNestedAgentLaneForSession(currentSessionKey),
                    sourceSessionKey: nextSessionKey,
                    sourceChannel: nextSessionKey === params.requesterSessionKey ? params.requesterChannel : targetChannel,
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
        const announceReply = await runAgentStep({
            sessionKey: params.targetSessionKey,
            message: "Agent-to-agent announce step.",
            extraSystemPrompt: announcePrompt,
            timeoutMs: params.announceTimeoutMs,
            lane: resolveNestedAgentLaneForSession(params.targetSessionKey),
            sourceSessionKey: params.requesterSessionKey,
            sourceChannel: params.requesterChannel,
            sourceTool: "sessions_send",
        });
        if (announceTarget && announceReply && announceReply.trim() && !isAnnounceSkip(announceReply)) {
            try {
                await sessionsSendA2ADeps.callGateway({
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
            }
            catch (err) {
                log.warn("sessions_send announce delivery failed", {
                    runId: runContextId,
                    channel: announceTarget.channel,
                    to: announceTarget.to,
                    error: formatErrorMessage(err),
                });
            }
        }
    }
    catch (err) {
        log.warn("sessions_send announce flow failed", {
            runId: runContextId,
            error: formatErrorMessage(err),
        });
    }
}
export const __testing = {
    setDepsForTest(overrides) {
        sessionsSendA2ADeps = overrides
            ? {
                ...defaultSessionsSendA2ADeps,
                ...overrides,
            }
            : defaultSessionsSendA2ADeps;
    },
};
