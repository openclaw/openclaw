import crypto from "node:crypto";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { getRuntimeConfig } from "../../config/config.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { prepareSessionDeliveryGeneration } from "../../config/sessions/session-delivery-generation.js";
import { resolveGatewaySessionStoreTargetInWorker } from "../../gateway/session-utils-store-worker.js";
import { stringifyRouteThreadId } from "../../plugin-sdk/channel-route.js";
import { annotateInterSessionPromptText } from "../../sessions/input-provenance.js";
import { recordSessionParticipantBestEffort } from "../../sessions/session-participant-recording.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel.js";
import { resolveSessionAgentId } from "../agent-scope.js";
import { resolveActiveEmbeddedRunSessionId } from "../embedded-agent-runner/active-run-projections.js";
import { resolveNestedAgentLaneForSession } from "../lanes.js";
import { waitForAgentRunReply } from "../run-wait.js";
import {
  callAgentToolGatewayRequest,
  type AgentToolGatewayRequestCaller as GatewayCaller,
} from "./in-process-gateway.js";
import { trySessionsSendActiveRunDelivery } from "./sessions-send-tool.delivery.js";

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
  const gatewayCall = params.callGateway ?? callAgentToolGatewayRequest;
  let steered = false;
  if (params.sourceRole !== "subagent" && resolveActiveEmbeddedRunSessionId(params.sessionKey)) {
    const cfg = getRuntimeConfig();
    const agentId =
      params.agentId ?? resolveSessionAgentId({ config: cfg, sessionKey: params.sessionKey });
    const target = await resolveGatewaySessionStoreTargetInWorker({
      cfg,
      key: params.sessionKey,
      agentId,
    });
    const entry = target.store[target.canonicalKey];
    if (!entry?.sessionId) {
      throw new Error("Requester session no longer exists.");
    }
    const generation = await prepareSessionDeliveryGeneration({
      agentId: target.agentId,
      storePath: target.storePath,
      sessionKey: target.canonicalKey,
      sessionId: params.expectedSession?.sessionId ?? entry.sessionId,
      lifecycleRevision: params.expectedSession
        ? (params.expectedSession.lifecycleRevision ?? null)
        : (entry.lifecycleRevision ?? null),
    });
    let accepted = false;
    try {
      const result = await trySessionsSendActiveRunDelivery(
        {
          cfg,
          callGateway: gatewayCall,
          runId: stepIdem,
          sessionKey: target.canonicalKey,
          sessionStoreTarget: target,
          expectedSessionId: params.expectedSession?.sessionId ?? entry.sessionId,
          recipientGeneration: generation,
          transcriptText: annotateInterSessionPromptText(params.message, inputProvenance),
          onQueueAccepted: (value) => {
            accepted ||= value;
          },
          allowActiveRunQueueDelivery: true,
          deliveryTimeoutMs: Math.min(params.timeoutMs, 10_000),
          sendParams: {
            // Active input cannot change the running turn's system prompt. Carry
            // the returned-result instructions with this attributed input instead.
            message: annotateInterSessionPromptText(
              `${params.extraSystemPrompt}\n\n${params.message}`,
              inputProvenance,
            ),
            agentId: target.agentId,
            inputProvenance,
            sourceReplyDeliveryMode: "message_tool_only",
          },
        },
        false,
      );
      if ("ok" in result) {
        if (!result.ok) {
          const error = asOptionalRecord(result.result.details)?.error;
          throw new Error(typeof error === "string" ? error : "Requester result steering failed.");
        }
        steered = result.targetDisposition === "steered";
        accepted ||= steered;
      }
    } finally {
      if (!accepted) {
        generation.release();
      }
    }
  }
  const response = steered
    ? undefined
    : await gatewayCall({
        method: "agent",
        // This is a returned result, not a new request to the peer. Consuming it
        // must not require an acknowledgment or repeat an already delivered final.
        replyExpectation: "optional",
        params: {
          message: annotateInterSessionPromptText(params.message, inputProvenance),
          ...(params.agentId ? { agentId: params.agentId } : {}),
          sessionKey: params.sessionKey,
          deliver: false,
          sourceReplyDeliveryMode: "message_tool_only",
          channel: params.deliveryContext?.channel ?? INTERNAL_MESSAGE_CHANNEL,
          lane: resolveNestedAgentLaneForSession(params.sessionKey),
          extraSystemPrompt: params.extraSystemPrompt,
          inputProvenance,
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

  if (steered) {
    return;
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
