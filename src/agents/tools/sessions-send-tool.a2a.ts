import crypto from "node:crypto";
import { callGateway } from "../../gateway/call.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { GatewayMessageChannel } from "../../utils/message-channel.js";
import { isExecutionGraphRuntimeV0Enabled } from "../execution-graph/feature-flag-v0.js";
import { runExecutionGraphV0 } from "../execution-graph/runtime-v0.js";
import { FileExecutionGraphStateStoreV0 } from "../execution-graph/state-store-v0.js";
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

export const SESSIONS_SEND_A2A_GRAPH_ID_V0 = "sessions_send_a2a_announce_v0";
const SESSIONS_SEND_A2A_PLAN_VERSION_V0 = "sessions-send-a2a/graph-v0";

type SessionsSendA2AParams = {
  targetSessionKey: string;
  displayKey: string;
  message: string;
  announceTimeoutMs: number;
  maxPingPongTurns: number;
  requesterSessionKey?: string;
  requesterChannel?: GatewayMessageChannel;
  roundOneReply?: string;
  waitRunId?: string;
};

type ResolveRoundOneReplyOutput = {
  primaryReply?: string;
  latestReply?: string;
};

type ResolveAnnounceTargetOutput = {
  targetChannel: string;
  announceTarget?: {
    channel: string;
    to: string;
    accountId?: string;
  };
};

type PingPongOutput = {
  latestReply?: string;
  turns: number;
};

type BuildAnnounceReplyOutput = {
  announceReply?: string;
  latestReply?: string;
};

export async function runSessionsSendA2AFlow(params: SessionsSendA2AParams) {
  const runContextId = params.waitRunId ?? "unknown";
  if (!shouldUseExecutionGraphRuntimeV0(params)) {
    await runSessionsSendA2AFlowLegacy(params, runContextId);
    return;
  }
  await runSessionsSendA2AFlowGraphV0(params, runContextId);
}

function shouldUseExecutionGraphRuntimeV0(params: SessionsSendA2AParams): boolean {
  if (!isExecutionGraphRuntimeV0Enabled(process.env)) {
    return false;
  }
  return Boolean(params.waitRunId?.trim());
}

async function runSessionsSendA2AFlowGraphV0(params: SessionsSendA2AParams, runContextId: string) {
  try {
    const runId = params.waitRunId?.trim();
    if (!runId) {
      await runSessionsSendA2AFlowLegacy(params, runContextId);
      return;
    }

    const stateStore = new FileExecutionGraphStateStoreV0(process.env);
    const result = await runExecutionGraphV0({
      graphId: SESSIONS_SEND_A2A_GRAPH_ID_V0,
      runId,
      planVersion: SESSIONS_SEND_A2A_PLAN_VERSION_V0,
      context: {
        params,
        runContextId,
      },
      graphInputs: {
        targetSessionKey: params.targetSessionKey,
        displayKey: params.displayKey,
        message: params.message,
        announceTimeoutMs: params.announceTimeoutMs,
        maxPingPongTurns: params.maxPingPongTurns,
        requesterSessionKey: params.requesterSessionKey,
        requesterChannel: params.requesterChannel,
        roundOneReply: params.roundOneReply,
        waitRunId: params.waitRunId,
      },
      stateStore,
      nodes: [
        {
          id: "resolve_round_one_reply",
          run: async ({ context }) => {
            let primaryReply = context.params.roundOneReply;
            let latestReply = context.params.roundOneReply;
            if (!primaryReply && context.params.waitRunId) {
              const waitMs = Math.min(context.params.announceTimeoutMs, 60_000);
              const wait = await callGateway<{ status: string }>({
                method: "agent.wait",
                params: {
                  runId: context.params.waitRunId,
                  timeoutMs: waitMs,
                },
                timeoutMs: waitMs + 2000,
              });
              if (wait?.status === "ok") {
                primaryReply = await readLatestAssistantReply({
                  sessionKey: context.params.targetSessionKey,
                });
                latestReply = primaryReply;
              }
            }
            return {
              primaryReply,
              latestReply,
            } satisfies ResolveRoundOneReplyOutput;
          },
          summarizeOutput: (output) => {
            const resolved = asResolveRoundOneReplyOutput(output);
            return resolved.latestReply ? "latestReply=present" : "latestReply=missing";
          },
        },
        {
          id: "resolve_announce_target",
          deps: ["resolve_round_one_reply"],
          run: async ({ context, depOutputs }) => {
            const roundOne = asResolveRoundOneReplyOutput(depOutputs.resolve_round_one_reply);
            if (!roundOne.latestReply) {
              return {
                targetChannel: "unknown",
              } satisfies ResolveAnnounceTargetOutput;
            }
            const announceTargetResolved = await resolveAnnounceTarget({
              sessionKey: context.params.targetSessionKey,
              displayKey: context.params.displayKey,
            });
            const announceTarget = announceTargetResolved ?? undefined;
            return {
              announceTarget,
              targetChannel: announceTarget?.channel ?? "unknown",
            } satisfies ResolveAnnounceTargetOutput;
          },
          summarizeOutput: (output) => {
            const resolved = asResolveAnnounceTargetOutput(output);
            const targetType = resolved.announceTarget ? "target=resolved" : "target=none";
            return `${targetType} channel=${resolved.targetChannel}`;
          },
        },
        {
          id: "ping_pong_turns",
          deps: ["resolve_round_one_reply", "resolve_announce_target"],
          run: async ({ context, depOutputs }) => {
            const roundOne = asResolveRoundOneReplyOutput(depOutputs.resolve_round_one_reply);
            const target = asResolveAnnounceTargetOutput(depOutputs.resolve_announce_target);
            let latestReply = roundOne.latestReply;
            if (!latestReply) {
              return {
                latestReply,
                turns: 0,
              } satisfies PingPongOutput;
            }
            if (
              context.params.maxPingPongTurns > 0 &&
              context.params.requesterSessionKey &&
              context.params.requesterSessionKey !== context.params.targetSessionKey
            ) {
              let currentSessionKey = context.params.requesterSessionKey;
              let nextSessionKey = context.params.targetSessionKey;
              let incomingMessage = latestReply;
              let turns = 0;
              for (let turn = 1; turn <= context.params.maxPingPongTurns; turn += 1) {
                const currentRole =
                  currentSessionKey === context.params.requesterSessionKey ? "requester" : "target";
                const replyPrompt = buildAgentToAgentReplyContext({
                  requesterSessionKey: context.params.requesterSessionKey,
                  requesterChannel: context.params.requesterChannel,
                  targetSessionKey: context.params.displayKey,
                  targetChannel: target.targetChannel,
                  currentRole,
                  turn,
                  maxTurns: context.params.maxPingPongTurns,
                });
                const replyText = await runAgentStep({
                  sessionKey: currentSessionKey,
                  message: incomingMessage,
                  extraSystemPrompt: replyPrompt,
                  timeoutMs: context.params.announceTimeoutMs,
                  lane: AGENT_LANE_NESTED,
                  sourceSessionKey: nextSessionKey,
                  sourceChannel:
                    nextSessionKey === context.params.requesterSessionKey
                      ? context.params.requesterChannel
                      : target.targetChannel,
                  sourceTool: "sessions_send",
                });
                if (!replyText || isReplySkip(replyText)) {
                  break;
                }
                latestReply = replyText;
                incomingMessage = replyText;
                turns += 1;
                const swap = currentSessionKey;
                currentSessionKey = nextSessionKey;
                nextSessionKey = swap;
              }
              return {
                latestReply,
                turns,
              } satisfies PingPongOutput;
            }
            return {
              latestReply,
              turns: 0,
            } satisfies PingPongOutput;
          },
          summarizeOutput: (output) => {
            const resolved = asPingPongOutput(output);
            return `turns=${resolved.turns} latestReply=${resolved.latestReply ? "present" : "missing"}`;
          },
        },
        {
          id: "build_announce_reply",
          deps: ["resolve_round_one_reply", "resolve_announce_target", "ping_pong_turns"],
          run: async ({ context, depOutputs }) => {
            const roundOne = asResolveRoundOneReplyOutput(depOutputs.resolve_round_one_reply);
            const target = asResolveAnnounceTargetOutput(depOutputs.resolve_announce_target);
            const pingPong = asPingPongOutput(depOutputs.ping_pong_turns);
            const latestReply = pingPong.latestReply;
            if (!latestReply) {
              return {
                latestReply,
                announceReply: undefined,
              } satisfies BuildAnnounceReplyOutput;
            }
            const announcePrompt = buildAgentToAgentAnnounceContext({
              requesterSessionKey: context.params.requesterSessionKey,
              requesterChannel: context.params.requesterChannel,
              targetSessionKey: context.params.displayKey,
              targetChannel: target.targetChannel,
              originalMessage: context.params.message,
              roundOneReply: roundOne.primaryReply,
              latestReply,
            });
            const announceReply = await runAgentStep({
              sessionKey: context.params.targetSessionKey,
              message: "Agent-to-agent announce step.",
              extraSystemPrompt: announcePrompt,
              timeoutMs: context.params.announceTimeoutMs,
              lane: AGENT_LANE_NESTED,
              sourceSessionKey: context.params.requesterSessionKey,
              sourceChannel: context.params.requesterChannel,
              sourceTool: "sessions_send",
            });
            return {
              latestReply,
              announceReply,
            } satisfies BuildAnnounceReplyOutput;
          },
          summarizeOutput: (output) => {
            const resolved = asBuildAnnounceReplyOutput(output);
            return resolved.announceReply ? "announceReply=present" : "announceReply=missing";
          },
        },
        {
          id: "deliver_announce",
          deps: ["resolve_announce_target", "build_announce_reply"],
          run: async ({ context, depOutputs }) => {
            const target = asResolveAnnounceTargetOutput(depOutputs.resolve_announce_target);
            const announce = asBuildAnnounceReplyOutput(depOutputs.build_announce_reply);
            const announceReply = announce.announceReply;
            if (!target.announceTarget || !announceReply || !announceReply.trim()) {
              return { delivered: false, skipped: true, reason: "missing_target_or_reply" };
            }
            if (isAnnounceSkip(announceReply)) {
              return { delivered: false, skipped: true, reason: "announce_skip_directive" };
            }
            try {
              await callGateway({
                method: "send",
                params: {
                  to: target.announceTarget.to,
                  message: announceReply.trim(),
                  channel: target.announceTarget.channel,
                  accountId: target.announceTarget.accountId,
                  idempotencyKey: crypto.randomUUID(),
                },
                timeoutMs: 10_000,
              });
              return { delivered: true, skipped: false };
            } catch (err) {
              log.warn("sessions_send announce delivery failed", {
                runId: context.runContextId,
                channel: target.announceTarget.channel,
                to: target.announceTarget.to,
                error: formatErrorMessage(err),
              });
              return {
                delivered: false,
                skipped: false,
                reason: "delivery_error",
                error: formatErrorMessage(err),
              };
            }
          },
          summarizeOutput: (output) => {
            if (!output || typeof output !== "object") {
              return "delivered=unknown";
            }
            const data = output as {
              delivered?: boolean;
              skipped?: boolean;
              reason?: string;
            };
            return `delivered=${String(Boolean(data.delivered))} skipped=${String(Boolean(data.skipped))} reason=${data.reason ?? "none"}`;
          },
        },
      ],
    });

    if (result.status === "failed") {
      log.warn("sessions_send announce flow failed", {
        runId: runContextId,
        failedNodeId: result.failedNodeId,
        error: result.error,
      });
    }
  } catch (err) {
    log.warn("sessions_send announce flow failed", {
      runId: runContextId,
      error: formatErrorMessage(err),
    });
  }
}

async function runSessionsSendA2AFlowLegacy(params: SessionsSendA2AParams, runContextId: string) {
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

function asResolveRoundOneReplyOutput(value: unknown): ResolveRoundOneReplyOutput {
  if (!value || typeof value !== "object") {
    return {};
  }
  const typed = value as Partial<ResolveRoundOneReplyOutput>;
  return {
    primaryReply: typeof typed.primaryReply === "string" ? typed.primaryReply : undefined,
    latestReply: typeof typed.latestReply === "string" ? typed.latestReply : undefined,
  };
}

function asResolveAnnounceTargetOutput(value: unknown): ResolveAnnounceTargetOutput {
  if (!value || typeof value !== "object") {
    return { targetChannel: "unknown" };
  }
  const typed = value as Partial<ResolveAnnounceTargetOutput>;
  const announceTarget = typed.announceTarget;
  return {
    targetChannel: typeof typed.targetChannel === "string" ? typed.targetChannel : "unknown",
    announceTarget:
      announceTarget &&
      typeof announceTarget === "object" &&
      typeof (announceTarget as { channel?: unknown }).channel === "string" &&
      typeof (announceTarget as { to?: unknown }).to === "string"
        ? {
            channel: (announceTarget as { channel: string }).channel,
            to: (announceTarget as { to: string }).to,
            accountId:
              typeof (announceTarget as { accountId?: unknown }).accountId === "string"
                ? (announceTarget as { accountId: string }).accountId
                : undefined,
          }
        : undefined,
  };
}

function asPingPongOutput(value: unknown): PingPongOutput {
  if (!value || typeof value !== "object") {
    return {
      latestReply: undefined,
      turns: 0,
    };
  }
  const typed = value as Partial<PingPongOutput>;
  return {
    latestReply: typeof typed.latestReply === "string" ? typed.latestReply : undefined,
    turns: typeof typed.turns === "number" && typed.turns > 0 ? Math.floor(typed.turns) : 0,
  };
}

function asBuildAnnounceReplyOutput(value: unknown): BuildAnnounceReplyOutput {
  if (!value || typeof value !== "object") {
    return {
      latestReply: undefined,
      announceReply: undefined,
    };
  }
  const typed = value as Partial<BuildAnnounceReplyOutput>;
  return {
    latestReply: typeof typed.latestReply === "string" ? typed.latestReply : undefined,
    announceReply: typeof typed.announceReply === "string" ? typed.announceReply : undefined,
  };
}
