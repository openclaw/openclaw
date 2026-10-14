import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { listAgentIds } from "../../agents/agent-scope.js";
import { isExecApprovalFollowupSessionRebound } from "../../agents/bash-tools.exec-approval-followup-state.js";
import { resolveExistingSessionKeyForRequest } from "../../agents/command/session.js";
import { resolveExplicitAgentSessionKey } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { emitDiagnosticEvent } from "../../infra/diagnostic-events.js";
import { resolveAgentExplicitRecipientSession } from "../../infra/outbound/agent-delivery.js";
import { classifySessionKeyShape, normalizeAgentId } from "../../routing/session-key.js";
import {
  isDeliverableMessageChannel,
  normalizeMessageChannel,
} from "../../utils/message-channel.js";
import {
  validateExpectedExistingSessionTarget,
  type ExpectedExistingSessionConstraint,
} from "../server-methods/agent-expected-session.js";
import type { AgentRunRequest } from "../server-methods/agent-request-types.js";
import { normalizeRpcAttachmentsToChatAttachments } from "../server-methods/attachment-normalize.js";
import type { GatewayRequestHandlerOptions } from "../server-methods/types.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import { loadGatewaySessionEntryReadOnlyInWorker } from "../session-utils-store-worker.js";
import { resolveSessionStoreKey } from "../session-utils.js";
import { formatForLog } from "../ws-log.js";
import { setGatewayDedupeEntries } from "./agent-dedupe.js";
import { respondUnavailableAgentSession } from "./agent-handler-helpers.js";
import type { AgentTurnContext } from "./types.js";

type ExplicitRecipientSession = Awaited<ReturnType<typeof resolveAgentExplicitRecipientSession>>;

export async function prepareAgentRequestRouting(params: {
  request: AgentRunRequest;
  cfg: OpenClawConfig;
  expectedSession?: ExpectedExistingSessionConstraint;
  isRawModelRun: boolean;
  execApprovalFollowupApprovalId?: string;
  runId: string;
  agentDedupeKeys: string[];
  context: AgentTurnContext;
  respond: GatewayRequestHandlerOptions["respond"];
  reserveDedupe: (sessionKey?: string, agentId?: string) => void;
  bindDedupeSessionTarget: (target: {
    sessionKey: string;
    agentId?: string;
    sessionId?: string;
  }) => void;
  clearDedupe: () => void;
  assertCurrent?: () => void;
}) {
  const rejectInvalidRequest = (message: string): undefined => {
    params.respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, message));
    return undefined;
  };
  const normalizedAttachments = normalizeRpcAttachmentsToChatAttachments(
    params.request.attachments,
  );
  const knownAgents = listAgentIds(params.cfg);
  const agentIdRaw = normalizeOptionalString(params.request.agentId) ?? "";
  let agentId = agentIdRaw ? normalizeAgentId(agentIdRaw) : undefined;
  if (agentId && !knownAgents.includes(agentId)) {
    return rejectInvalidRequest(
      `invalid agent params: unknown agent id "${params.request.agentId}"`,
    );
  }
  const requestedSessionKeyParam = normalizeOptionalString(params.request.sessionKey);
  const requestedSessionId = normalizeOptionalString(params.request.sessionId);
  const requestedToRaw = normalizeOptionalString(params.request.to);
  const sessionKeyFromTo =
    !requestedSessionKeyParam &&
    !requestedSessionId &&
    classifySessionKeyShape(requestedToRaw) === "agent"
      ? requestedToRaw
      : undefined;
  const requestedSessionKeyRaw = requestedSessionKeyParam ?? sessionKeyFromTo;
  const agentSelectionKey =
    requestedSessionKeyRaw ?? (!requestedSessionId && !agentId ? "main" : undefined);
  if (agentSelectionKey) {
    const requestedSessionAgent = resolveRequestedSessionAgentId(
      params.cfg,
      agentSelectionKey,
      agentId,
    );
    if (!requestedSessionAgent.ok) {
      params.respond(false, undefined, requestedSessionAgent.error);
      return undefined;
    }
    agentId = requestedSessionAgent.agentId;
  }
  let sessionIdTarget: Awaited<ReturnType<typeof resolveExistingSessionKeyForRequest>> | undefined;
  if (requestedSessionId && !requestedSessionKeyRaw) {
    try {
      params.reserveDedupe(undefined, agentId);
      sessionIdTarget = await resolveExistingSessionKeyForRequest({
        cfg: params.cfg,
        sessionId: requestedSessionId,
        agentId,
      });
      agentId = sessionIdTarget.agentId ?? agentId;
    } catch (error) {
      params.clearDedupe();
      return rejectInvalidRequest(formatForLog(error));
    }
  }
  const explicitRecipientChannel = normalizeMessageChannel(params.request.channel);
  const explicitRecipient =
    !requestedSessionKeyRaw &&
    !requestedSessionId &&
    agentId &&
    explicitRecipientChannel &&
    isDeliverableMessageChannel(explicitRecipientChannel) &&
    requestedToRaw
      ? { agentId, channel: explicitRecipientChannel, to: requestedToRaw }
      : undefined;
  let explicitRecipientSession: ExplicitRecipientSession | undefined;
  if (explicitRecipient) {
    // Reservation protects the asynchronous provider-owned route lookup from duplicate starts.
    params.reserveDedupe(undefined, explicitRecipient.agentId);
    try {
      explicitRecipientSession = await resolveAgentExplicitRecipientSession({
        cfg: params.cfg,
        ...explicitRecipient,
        accountId: normalizeOptionalString(params.request.accountId),
        threadId: params.request.threadId,
      });
    } catch (error) {
      params.clearDedupe();
      return rejectInvalidRequest(formatForLog(error));
    }
  }
  if (explicitRecipientSession?.error) {
    params.clearDedupe();
    return rejectInvalidRequest(explicitRecipientSession.error.message);
  }
  const requestedSessionKey =
    requestedSessionKeyRaw ??
    sessionIdTarget?.sessionKey ??
    explicitRecipientSession?.sessionKey ??
    // Ownership selection alone must not turn a sessionless run into a main-session write.
    (!requestedSessionId
      ? resolveExplicitAgentSessionKey({
          cfg: params.cfg,
          agentId: agentIdRaw ? agentId : undefined,
        })
      : undefined);
  const expectedSessionTargetError = validateExpectedExistingSessionTarget({
    constraint: params.expectedSession,
    requestedSessionId,
    requestedSessionKey,
  });
  if (expectedSessionTargetError) {
    params.clearDedupe();
    return rejectInvalidRequest(expectedSessionTargetError);
  }
  let loaded: Awaited<ReturnType<typeof loadGatewaySessionEntryReadOnlyInWorker>> | undefined;
  if (requestedSessionKey) {
    // Reserve before the worker read yields, including ordinary session keys.
    params.reserveDedupe(requestedSessionKey, agentId);
    try {
      loaded = await loadGatewaySessionEntryReadOnlyInWorker({
        cfg: params.cfg,
        key: requestedSessionKey,
        agentId,
        projection: "list",
        excludeInternalEffects: true,
        assertActive: params.assertCurrent,
      });
      const unavailable = respondUnavailableAgentSession({
        loaded,
        requestedSessionId,
        isRawModelRun: params.isRawModelRun,
        respond: params.respond,
        assertCurrent: params.assertCurrent,
      });
      if (unavailable instanceof Promise ? await unavailable : unavailable) {
        params.clearDedupe();
        return undefined;
      }
    } catch (error) {
      params.clearDedupe();
      throw error;
    }
  }
  if (params.execApprovalFollowupApprovalId && requestedSessionKeyRaw) {
    const expectedSessionId = normalizeOptionalString(
      params.request.execApprovalFollowupExpectedSessionId,
    );
    const currentSessionId = normalizeOptionalString(loaded?.entry?.sessionId);
    if (
      isExecApprovalFollowupSessionRebound({
        expectedSessionId,
        resolvedSessionId: currentSessionId,
      })
    ) {
      emitDiagnosticEvent({
        type: "exec.approval.followup_suppressed",
        approvalId: params.execApprovalFollowupApprovalId,
        reason: "session_rebound",
        phase: "gateway_preflight",
      });
      params.context.logGateway.info(
        `Dropping stale exec approval followup ${params.execApprovalFollowupApprovalId}: session ${requestedSessionKeyRaw} rebound (expected ${expectedSessionId}, current ${currentSessionId}) before the approval resolved`,
      );
      const droppedPayload = {
        runId: params.runId,
        status: "ok" as const,
        summary: "exec approval followup dropped: session was reset before the approval resolved",
      };
      setGatewayDedupeEntries({
        dedupe: params.context.dedupe,
        keys: params.agentDedupeKeys,
        entry: { ts: Date.now(), ok: true, payload: droppedPayload },
      });
      params.respond(true, droppedPayload, undefined, { runId: params.runId });
      return undefined;
    }
  }
  const preAcceptedReservedSessionKey =
    requestedSessionKey &&
    resolveSessionStoreKey({
      cfg: params.cfg,
      sessionKey: requestedSessionKey,
      storeAgentId: agentId,
    }) === "global"
      ? "global"
      : requestedSessionKey;
  // Keyless runs still need the run-id reservation before asynchronous preparation,
  // otherwise concurrent callers can dispatch the same id without a session owner.
  params.reserveDedupe(preAcceptedReservedSessionKey, agentId);
  if (loaded) {
    params.bindDedupeSessionTarget({
      sessionKey: loaded.canonicalKey,
      agentId,
      sessionId: loaded.entry?.sessionId,
    });
  }
  return {
    normalizedAttachments,
    requestedBestEffortDeliver: params.request.bestEffortDeliver,
    knownAgents,
    agentId,
    requestedSessionId,
    requestedToRaw,
    sessionKeyFromTo,
    requestedSessionKeyRaw,
    requestedSessionKey,
    explicitRecipientSession,
    preAcceptedReservedSessionKey,
    preAttachmentSession: loaded?.entry
      ? { canonicalKey: loaded.canonicalKey, sessionId: loaded.entry.sessionId }
      : undefined,
  };
}
