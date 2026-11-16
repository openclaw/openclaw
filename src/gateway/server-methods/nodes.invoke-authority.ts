import { getGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import { captureSessionEventTargetForHost } from "../../auto-reply/reply/session-event-handoff.js";
import {
  resolveEventSessionKeyForPolicy,
  resolveEventSessionRoutingPolicy,
} from "../../infra/event-session-routing.js";
import type { ExecApprovalDecision } from "../../infra/exec-approvals.js";
import type { ExecApprovalManager } from "../exec-approval-manager.js";
import type { NodeSystemRunEventSource } from "../node-invoke.types.js";
import { captureGatewayOperatorRunAuthority } from "../operator-run-authority.js";
import { resolveSessionStoreIdentity } from "../session-store-key.js";
import type {
  GatewayClient,
  GatewayRequestContext,
  GatewayRequestHandlerOptions,
} from "./types.js";

type ForwardedNodeInvokeApprovalAuthority = {
  recordId: string;
  decision: Extract<ExecApprovalDecision, "allow-once" | "allow-always">;
};

export function isForwardedNodeInvokeApprovalAuthorityActive(params: {
  manager?: Pick<ExecApprovalManager, "projectDecisionIfActive">;
  authority?: ForwardedNodeInvokeApprovalAuthority;
}): boolean {
  const authority = params.authority;
  return (
    !authority ||
    params.manager?.projectDecisionIfActive(authority.recordId, authority.decision) ===
      authority.decision
  );
}

export function resolveNodeInvokeRuntimeAuthorityError(params: {
  context: Pick<
    GatewayRequestContext,
    "execApprovalManager" | "validateAgentRuntimeApprovalAuthority"
  >;
  client: GatewayClient | null;
  approvalAuthority?: ForwardedNodeInvokeApprovalAuthority;
}): string | undefined {
  const callerIdentity = params.client?.internal?.agentRuntimeIdentity;
  if (
    callerIdentity &&
    params.context.validateAgentRuntimeApprovalAuthority?.(callerIdentity) !== true
  ) {
    return "agent runtime approval authority closed before node dispatch";
  }
  if (
    !isForwardedNodeInvokeApprovalAuthorityActive({
      manager: params.context.execApprovalManager,
      authority: params.approvalAuthority,
    })
  ) {
    return "approved runtime authority closed before node dispatch";
  }
  return undefined;
}

/** Capture the original caller before the node connection becomes the event producer. */
export async function captureNodeSystemRunEventSource(
  input: Pick<GatewayRequestHandlerOptions, "client" | "context" | "hasCurrentClientAuthority">,
  sessionKey: string,
): Promise<NodeSystemRunEventSource | undefined> {
  const captured = await captureGatewayOperatorRunAuthority({
    ...input,
    independentContinuation: true,
  });
  if (!captured && !getGatewayToolCallerIdentity()) {
    return undefined;
  }
  try {
    const cfg = input.context.getRuntimeConfig();
    const { canonicalKey, agentId } = resolveSessionStoreIdentity({ cfg, sessionKey });
    const destination = resolveEventSessionKeyForPolicy(
      canonicalKey,
      resolveEventSessionRoutingPolicy({ cfg, sessionKey: canonicalKey }),
    );
    const expectedTarget = await captureSessionEventTargetForHost(agentId, destination, {
      operatorAuthority: captured?.authority,
      assertCurrent: captured?.authority.assertCurrent,
      retainRequesterOwner: true,
    });
    return { expectedTarget, release: captured?.release ?? (() => {}) };
  } catch (error) {
    captured?.release();
    throw error;
  }
}
