import crypto from "node:crypto";
import { DEFAULT_EXEC_APPROVAL_TIMEOUT_MS } from "../infra/exec-approvals.js";
import type { GatewayClient, GatewayRequestContext } from "./server-methods/types.js";

type PolicyApprovalDecision = "allow-once" | "allow-always" | "deny" | null;

type PolicyApprovalResult =
  | { approved: true; decision: "allow-once" | "allow-always" }
  | { approved: false; reason: string; decision: PolicyApprovalDecision };

export async function requestPolicyApproval(params: {
  command: string;
  sessionKey?: string;
  context: GatewayRequestContext;
  client: GatewayClient | null;
  timeoutMs?: number;
}): Promise<PolicyApprovalResult> {
  const manager = params.context.execApprovalManager;
  if (!manager) {
    return { approved: false, reason: "exec approvals unavailable", decision: null };
  }

  const timeoutMs =
    typeof params.timeoutMs === "number" &&
    Number.isFinite(params.timeoutMs) &&
    params.timeoutMs > 0
      ? Math.floor(params.timeoutMs)
      : DEFAULT_EXEC_APPROVAL_TIMEOUT_MS;
  const record = manager.create(
    {
      command: params.command,
      cwd: process.cwd(),
      host: "gateway",
      security: "allowlist",
      ask: "always",
      agentId: null,
      resolvedPath: null,
      sessionKey: params.sessionKey ?? null,
    },
    timeoutMs,
    crypto.randomUUID(),
  );
  record.requestedByConnId = params.client?.connId ?? null;
  record.requestedByDeviceId = params.client?.connect?.device?.id ?? null;
  record.requestedByClientId = params.client?.connect?.client?.id ?? null;

  let decisionPromise: Promise<PolicyApprovalDecision>;
  try {
    decisionPromise = manager.register(record, timeoutMs);
  } catch (err) {
    return {
      approved: false,
      reason: `approval registration failed: ${String(err)}`,
      decision: null,
    };
  }

  params.context.broadcast(
    "exec.approval.requested",
    {
      id: record.id,
      request: record.request,
      createdAtMs: record.createdAtMs,
      expiresAtMs: record.expiresAtMs,
    },
    { dropIfSlow: true },
  );

  if (
    typeof params.context.hasExecApprovalClients === "function" &&
    !params.context.hasExecApprovalClients()
  ) {
    manager.expire(record.id, "auto-expire:no-approver-clients");
  }

  const decision = await decisionPromise;
  if (decision === "allow-once" || decision === "allow-always") {
    return { approved: true, decision };
  }
  if (decision === "deny") {
    return { approved: false, reason: "approval denied by operator", decision };
  }
  return {
    approved: false,
    reason: "approval timed out or unavailable",
    decision,
  };
}
