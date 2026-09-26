/**
 * Nested agent-step executor.
 *
 * Sends annotated inter-session messages through in-process or Gateway execution and reads the assistant reply.
 */
import crypto from "node:crypto";
import { getRuntimeConfig } from "../../config/config.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { stringifyRouteThreadId } from "../../plugin-sdk/channel-route.js";
import { annotateInterSessionPromptText } from "../../sessions/input-provenance.js";
import { recordSessionParticipantBestEffort } from "../../sessions/session-participant-recording.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel.js";
import { resolveNestedAgentLaneForSession } from "../lanes.js";
import { waitForAgentRunReply } from "../run-wait.js";
import {
  callAgentToolGatewayRequest,
  type AgentToolGatewayRequestCaller,
} from "./in-process-gateway.js";

export type AgentStepSession = {
  sessionId: string;
  lifecycleRevision?: string;
};

type GatewayCaller = AgentToolGatewayRequestCaller;
type AgentCommandRunner = typeof import("../../commands/agent.js").agentCommandFromIngress;

function extractAgentCommandReply(
  result: Awaited<ReturnType<AgentCommandRunner>>,
): string | undefined {
  const error = result?.meta.error;
  // Plain incomplete-turn output is a control failure; trusted terminal tool presentations remain deliverable.
  if (error?.kind === "incomplete_turn" && error.terminalPresentation !== true) {
    return undefined;
  }
  const texts = result?.payloads
    ?.map((payload) => payload.text)
    .filter((text): text is string => Boolean(text?.trim()));
  return texts?.length ? texts.join("\n\n") : undefined;
}

/** Sends one annotated message to a target session and returns the resulting assistant text. */
export async function runAgentStep(
  params: {
    agentId?: string;
    sessionKey: string;
    message: string;
    extraSystemPrompt: string;
    timeoutMs: number;
    channel?: string;
    lane?: string;
    sourceAgentId?: string;
    sourceSessionKey?: string;
    sourceChannel?: string;
    sourceTool?: string;
    sourceRole?: "subagent";
    callGateway?: GatewayCaller;
  } & (
    | {
        transcriptMessage?: undefined;
        deliveryContext?: DeliveryContext;
        expectedSession?: AgentStepSession;
      }
    | { transcriptMessage: string; deliveryContext?: never; expectedSession?: never }
  ),
): Promise<string | undefined> {
  const promptedAt = Date.now();
  const stepIdem = crypto.randomUUID();
  const inputProvenance = {
    kind: "inter_session" as const,
    sourceSessionKey: params.sourceSessionKey,
    sourceChannel: params.sourceChannel,
    sourceTool: params.sourceTool ?? "sessions_send",
    ...(params.sourceRole ? { sourceRole: params.sourceRole } : {}),
  };
  // Mark inter-session prompts so downstream transcripts can distinguish tool-routed text.
  const message = annotateInterSessionPromptText(params.message, inputProvenance);
  const lane = params.lane ?? resolveNestedAgentLaneForSession(params.sessionKey);
  const channel = params.deliveryContext?.channel ?? params.channel ?? INTERNAL_MESSAGE_CHANNEL;
  const gatewayCall = params.callGateway ?? callAgentToolGatewayRequest;
  if (params.transcriptMessage !== undefined) {
    // Intentional direct in-process exception: the public agent schema rejects transcriptMessage.
    // Keep announce bookkeeping off the wire without expanding the model-authored RPC surface.
    const ingress: Parameters<AgentCommandRunner>[0] = {
      message,
      ...(params.agentId ? { agentId: params.agentId } : {}),
      transcriptMessage: params.transcriptMessage,
      sessionKey: params.sessionKey,
      deliver: false,
      sourceReplyDeliveryMode: "message_tool_only",
      channel,
      lane,
      runId: stepIdem,
      extraSystemPrompt: params.extraSystemPrompt,
      inputProvenance,
      allowModelOverride: false,
    };
    const { agentCommandFromIngress } = await import("../../commands/agent.js");
    const result = await agentCommandFromIngress(ingress);
    return extractAgentCommandReply(result);
  }
  const response = await gatewayCall({
    method: "agent",
    params: {
      message,
      ...(params.agentId ? { agentId: params.agentId } : {}),
      sessionKey: params.sessionKey,
      idempotencyKey: stepIdem,
      expectedExistingSessionId: params.expectedSession?.sessionId,
      expectedExistingSessionLifecycleRevision: params.expectedSession
        ? (params.expectedSession.lifecycleRevision ?? null)
        : undefined,
      accountId: params.deliveryContext?.accountId,
      to: params.deliveryContext?.to,
      threadId: stringifyRouteThreadId(params.deliveryContext?.threadId),
      deliver: false,
      sourceReplyDeliveryMode: "message_tool_only",
      channel,
      lane,
      extraSystemPrompt: params.extraSystemPrompt,
      inputProvenance,
    },
    timeoutMs: 10_000,
  });

  if (params.sourceAgentId && params.agentId) {
    recordSessionParticipantBestEffort({
      identity: { type: "agent", id: params.sourceAgentId },
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      storePath: resolveSessionStorePathCore(getRuntimeConfig().session?.store, {
        agentId: params.agentId,
      }),
      promptedAt,
    });
  }

  const stepRunId = typeof response?.runId === "string" && response.runId ? response.runId : "";
  const resolvedRunId = stepRunId || stepIdem;
  const result = await waitForAgentRunReply({
    runId: resolvedRunId,
    timeoutMs: Math.min(params.timeoutMs, 60_000),
    callGateway: gatewayCall,
    untilTerminal: true,
  });
  if (result.status !== "ok") {
    return undefined;
  }
  return result.replyText;
}
