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
  type AgentToolGatewayRequestCaller as GatewayCaller,
} from "./in-process-gateway.js";

export type AgentStepSession = {
  sessionId: string;
  lifecycleRevision?: string;
};

export async function runAgentStep(params: {
  agentId?: string;
  sessionKey: string;
  message: string;
  extraSystemPrompt: string;
  timeoutMs: number;
  sourceAgentId?: string;
  sourceSessionKey?: string;
  sourceTool?: string;
  sourceRole?: "subagent";
  callGateway?: GatewayCaller;
  deliveryContext?: DeliveryContext;
  expectedSession?: AgentStepSession;
}): Promise<void> {
  const promptedAt = Date.now();
  const stepIdem = crypto.randomUUID();
  const inputProvenance = {
    kind: "inter_session" as const,
    sourceSessionKey: params.sourceSessionKey,
    sourceTool: params.sourceTool ?? "sessions_send",
    ...(params.sourceRole ? { sourceRole: params.sourceRole } : {}),
  };
  const agentParams = {
    message: annotateInterSessionPromptText(params.message, inputProvenance),
    ...(params.agentId ? { agentId: params.agentId } : {}),
    sessionKey: params.sessionKey,
    deliver: false,
    sourceReplyDeliveryMode: "message_tool_only",
    channel: params.deliveryContext?.channel ?? INTERNAL_MESSAGE_CHANNEL,
    lane: resolveNestedAgentLaneForSession(params.sessionKey),
    extraSystemPrompt: params.extraSystemPrompt,
    inputProvenance,
  } as const;
  const gatewayCall = params.callGateway ?? callAgentToolGatewayRequest;
  const response = await gatewayCall({
    method: "agent",
    params: {
      ...agentParams,
      idempotencyKey: stepIdem,
      expectedExistingSessionId: params.expectedSession?.sessionId,
      expectedExistingSessionLifecycleRevision: params.expectedSession
        ? (params.expectedSession.lifecycleRevision ?? null)
        : undefined,
      accountId: params.deliveryContext?.accountId,
      to: params.deliveryContext?.to,
      threadId: stringifyRouteThreadId(params.deliveryContext?.threadId),
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

  const resolvedRunId =
    typeof response?.runId === "string" && response.runId ? response.runId : stepIdem;
  await waitForAgentRunReply({
    runId: resolvedRunId,
    timeoutMs: Math.min(params.timeoutMs, 60_000),
    callGateway: gatewayCall,
    untilTerminal: true,
  });
}
