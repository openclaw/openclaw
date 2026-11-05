import crypto from "node:crypto";
import { getRuntimeConfig } from "../../config/config.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { composeSessionSourceAssertion } from "../../config/sessions/session-source-authority.js";
import type { TrustedAgentToolCaller } from "../../gateway/server-methods/client-types.js";
import { stringifyRouteThreadId } from "../../plugin-sdk/channel-route.js";
import { getPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { annotateInterSessionPromptText } from "../../sessions/input-provenance.js";
import { recordSessionParticipantBestEffort } from "../../sessions/session-participant-recording.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel.js";
import { resolveNestedAgentLaneForSession } from "../lanes.js";
import { waitForAgentRunReply } from "../run-wait.js";
import { withFollowupRequest } from "../subagents/completion/session-followup-completion.js";
import type { FollowupRequest } from "../subagents/completion/session-followup-completion.types.js";
import { captureGatewayToolCallerAssertion } from "./gateway-caller-context.js";
import {
  callAgentToolGatewayRequest,
  getInProcessGatewayToolContext,
  type AgentToolGatewayRequestCaller as GatewayCaller,
} from "./in-process-gateway.js";
import { readSessionCommunicationEndpoint } from "./sessions-send-communication-endpoint.js";
import {
  prepareSessionsSendCommunication,
  type SessionSendReplyAdmission,
} from "./sessions-send-communication.js";
import { prepareSessionsSendFollowup } from "./sessions-send-followup-custody.js";
import type { AgentStepSession } from "./sessions-send-tool.types.js";

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
  requester?: TrustedAgentToolCaller;
  callGateway?: GatewayCaller;
  deliveryContext?: DeliveryContext;
  expectedSession?: AgentStepSession;
  expectedSourceSession?: AgentStepSession;
  replyAdmission?: SessionSendReplyAdmission;
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
  const message = annotateInterSessionPromptText(params.message, inputProvenance);
  let communication: Awaited<ReturnType<typeof prepareSessionsSendCommunication>> | undefined;
  if (inputProvenance.sourceTool === "sessions_send") {
    const { agentId, sourceAgentId, sourceSessionKey, expectedSession, expectedSourceSession } =
      params;
    if (
      !agentId ||
      !sourceAgentId ||
      !sourceSessionKey ||
      !expectedSession ||
      !expectedSourceSession ||
      !params.replyAdmission
    ) {
      throw new Error("Returned peer result requires its original source and target sessions.");
    }
    const config = getRuntimeConfig();
    // Detached results retain the original operator's live continuation custody,
    // not the completed tool's lifetime or authority reconstructed from metadata.
    const operatorSource =
      getPluginRuntimeGatewayRequestScope()?.client?.internal?.operatorRunAuthority;
    const assertSourceCurrent = composeSessionSourceAssertion([
      captureGatewayToolCallerAssertion(),
      operatorSource?.assertCurrent,
    ]);
    const load = async (
      endpointAgentId: string,
      sessionKey: string,
      expected: AgentStepSession,
    ) => {
      const endpoint = await readSessionCommunicationEndpoint({
        config,
        endpoint: { agentId: endpointAgentId, sessionKey, storePath: "" },
        assertCurrent: assertSourceCurrent,
      });
      if (
        endpoint.agentId !== endpointAgentId ||
        endpoint.sessionKey !== sessionKey ||
        endpoint.entry?.sessionId !== expected.sessionId ||
        endpoint.entry.lifecycleRevision !== expected.lifecycleRevision ||
        endpoint.entry.archivedAt !== undefined
      ) {
        throw new Error("Returned peer result session changed before admission.");
      }
      return endpoint;
    };
    const [source, target] = await Promise.all([
      load(sourceAgentId, sourceSessionKey, expectedSourceSession),
      load(agentId, params.sessionKey, expectedSession),
    ]);
    communication = await prepareSessionsSendCommunication({
      config,
      source,
      target,
      message: params.message,
      dispatchMessage: message,
      inputProvenance,
      allowApproval: false,
      acceptedReply: params.replyAdmission,
      assertSourceCurrent,
      signal: operatorSource?.signal,
      callGateway: gatewayCall,
    });
  }
  let response: Record<string, unknown> | undefined;
  const callGateway = communication?.callGateway ?? gatewayCall;
  let followup: FollowupRequest | undefined;
  try {
    try {
      if (
        params.agentId &&
        params.agentId === params.sourceAgentId &&
        params.sessionKey === params.sourceSessionKey &&
        getInProcessGatewayToolContext()?.lifecycleRuntime
      ) {
        followup = await prepareSessionsSendFollowup({
          runId: stepIdem,
          requesterAgentId: params.agentId,
          requesterSessionKey: params.sessionKey,
          targetAgentId: params.agentId,
          targetSessionKey: params.sessionKey,
        });
      }
      const dispatch = () =>
        callGateway<Record<string, unknown>>({
          method: "agent",
          // This is a returned result, not a new request to the peer. Consuming it
          // must not require an acknowledgment or repeat an already delivered final.
          replyExpectation: "optional",
          agentToolCaller: params.requester,
          params: {
            message,
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
      response = await (followup ? withFollowupRequest(followup, dispatch) : dispatch());
    } finally {
      communication?.close();
    }

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
    const completion = followup?.completion;
    if (followup && !completion) {
      throw new Error("Requester continuation has no retained result; inspect the accepted run.");
    }
    const result = completion
      ? await completion.take()
      : await waitForAgentRunReply({
          runId: resolvedRunId,
          timeoutMs: Math.min(params.timeoutMs, 60_000),
          callGateway: gatewayCall,
          untilTerminal: true,
        });
    if (result?.status !== "ok") {
      throw new Error(
        result?.error ?? `Requester continuation ended with ${result?.status ?? "no result"}.`,
      );
    }
  } finally {
    followup?.completion?.close();
    if (followup && !followup.completion) {
      followup.custody.release();
    }
  }
}
