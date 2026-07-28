import { randomUUID } from "node:crypto";
import {
  SYSTEM_AGENT_APPROVAL_DECISIONS,
  SYSTEM_AGENT_APPROVAL_TIMEOUT_MS,
  type SystemAgentApprovalRequestPayload,
} from "../../infra/system-agent-approvals.js";
import { describeSystemAgentPersistentOperation } from "../../system-agent/operations.js";
import { buildRequestedApprovalEvent, handlePendingApprovalRequest } from "./approval-shared.js";
import type { GatewayRequestContext, GatewaySystemAgentSession } from "./types.js";

export function queueDelegatedSystemAgentApproval(params: {
  context: GatewayRequestContext;
  sessions: Map<string, GatewaySystemAgentSession>;
  session: GatewaySystemAgentSession;
  sessionId: string;
  delegation: {
    agentId?: string;
    sessionKey?: string;
  };
  proposal: NonNullable<
    ReturnType<GatewaySystemAgentSession["engine"]["getPendingOperatorProposal"]>
  >;
}): string {
  if (params.session.pendingApproval?.proposalHash === params.proposal.hash) {
    return params.session.pendingApproval.id;
  }
  const manager = params.context.systemAgentApprovalManager;
  if (!manager) {
    throw new Error("OpenClaw approval registry unavailable");
  }
  const description = describeSystemAgentPersistentOperation(params.proposal.operation);
  const request: SystemAgentApprovalRequestPayload = {
    title: "OpenClaw change",
    description,
    command: description,
    proposalHash: params.proposal.hash,
    allowedDecisions: SYSTEM_AGENT_APPROVAL_DECISIONS,
    agentId: params.delegation.agentId ?? null,
    sessionKey: params.delegation.sessionKey ?? null,
    sessionId: params.sessionId,
    turnSourceChannel: null,
    turnSourceAccountId: null,
  };
  const record = manager.create(
    request,
    SYSTEM_AGENT_APPROVAL_TIMEOUT_MS,
    `system-agent:${randomUUID()}`,
  );
  const decisionPromise = manager.register(record, SYSTEM_AGENT_APPROVAL_TIMEOUT_MS);
  params.session.pendingApproval = { id: record.id, proposalHash: params.proposal.hash };
  const requestEvent = buildRequestedApprovalEvent(record);
  void handlePendingApprovalRequest({
    manager,
    record,
    decisionPromise,
    respond: () => undefined,
    context: params.context,
    requestEventName: "openclaw.approval.requested",
    requestEvent,
    twoPhase: true,
    deliverRequest: () => false,
    keepPendingWithoutRoute: true,
    requireDeliveryRoute: false,
    afterDecision: async (decision) => {
      if (params.sessions.get(params.sessionId) !== params.session) {
        return;
      }
      if (params.session.pendingApproval?.id === record.id) {
        params.session.pendingApproval = undefined;
      }
      await params.session.engine.resolveOperatorApproval(decision, params.proposal.hash);
    },
    afterDecisionErrorLabel: "OpenClaw approval apply failed",
  });
  return record.id;
}
