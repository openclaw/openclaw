import { randomUUID } from "node:crypto";
import { createAuditEvent } from "../../extensions/govdoss-core/src/audit";
import { evaluateGovdossPolicy } from "../../extensions/govdoss-core/src/policy";
import { scoreGovdossRisk } from "../../extensions/govdoss-core/src/risk";
import { createContinuation } from "../../extensions/govdoss-core/src/resume";
import type { GatewayRequestContext, GatewayRequestOptions } from "../gateway/server-methods/types";

type GatewayGuardExecuteParams = {
  req: GatewayRequestOptions["req"];
  client: GatewayRequestOptions["client"];
  context: GatewayRequestContext;
  executor: () => Promise<void>;
};

type GatewayGuardDecision = {
  decisionId: string;
  method: string;
  subject: string;
  object: string;
  role: string;
  scopes: string[];
  riskTier: "LOW" | "MEDIUM" | "HIGH";
  riskScore: number;
  reasons: string[];
  targetSurface: string;
  createdAt: number;
};

export type GatewayGuardResult =
  | { status: "executed"; decision: GatewayGuardDecision }
  | {
      status: "approval-required";
      decision: GatewayGuardDecision;
      approvalRequest: { id: string; risk: string; method: string };
      continuation: ReturnType<typeof createContinuation>;
    };

function resolveTargetSurface(method: string): string {
  if (method.startsWith("browser.")) return "browser";
  if (method.startsWith("node.")) return "node";
  if (method.startsWith("config.")) return "config";
  if (method.startsWith("device") || method.startsWith("devices.")) return "device";
  if (method.startsWith("send.") || method.startsWith("push.")) return "external-delivery";
  return "gateway";
}

function resolveSubject(client: GatewayRequestOptions["client"]): string {
  if (!client?.connect) return "unknown-client";
  return client.connect.client.displayName || client.connect.client.id || client.connId || "unknown-client";
}

function summarizeScopes(client: GatewayRequestOptions["client"]): string[] {
  return Array.isArray(client?.connect?.scopes) ? client.connect.scopes : [];
}

function shouldRequireApproval(method: string, riskTier: "LOW" | "MEDIUM" | "HIGH"): boolean {
  if (riskTier !== "HIGH") return false;
  return (
    method.startsWith("config.") ||
    method.startsWith("update.") ||
    method.startsWith("browser.") ||
    method.startsWith("node.") ||
    method.startsWith("send.") ||
    method.startsWith("push.") ||
    method.startsWith("devices.")
  );
}

export class GovdossGatewayGuard {
  async execute(params: GatewayGuardExecuteParams): Promise<GatewayGuardResult> {
    const subject = resolveSubject(params.client);
    const method = params.req.method;
    const scopes = summarizeScopes(params.client);
    const role = params.client?.connect?.role ?? "operator";
    const targetSurface = resolveTargetSurface(method);

    const risk = scoreGovdossRisk({
      action: method,
      targetType: targetSurface,
      containsSensitiveData: method.startsWith("secrets.") || method.startsWith("config."),
      externalDestination: method.startsWith("send.") || method.startsWith("push."),
    });

    const decision: GatewayGuardDecision = {
      decisionId: randomUUID(),
      method,
      subject,
      object: targetSurface,
      role,
      scopes,
      riskTier: risk.tier,
      riskScore: risk.score,
      reasons: risk.reasons,
      targetSurface,
      createdAt: Date.now(),
    };

    const policy = evaluateGovdossPolicy({
      risk: decision.riskTier,
      mode: shouldRequireApproval(method, decision.riskTier) ? "approval-required" : "bounded-autonomy",
    });

    params.context.logGateway.info(
      `[govdoss] request method=${method} subject=${subject} role=${role} risk=${decision.riskTier} surface=${targetSurface}`,
    );

    const preEvent = createAuditEvent({
      subject,
      object: targetSurface,
      authentication: "gateway-session",
      authorization: policy.allowed ? "allowed" : "blocked",
      approval: policy.requiresApproval ? "required" : "not-required",
      action: method,
      outcome: "requested",
      metadata: {
        decisionId: decision.decisionId,
        role,
        scopes,
        riskTier: decision.riskTier,
        riskScore: decision.riskScore,
        reasons: decision.reasons,
      },
    });
    params.context.logGateway.info(`[govdoss] audit start ${JSON.stringify(preEvent)}`);

    if (policy.requiresApproval) {
      const approvalId = `approval-${Date.now()}`;
      const continuation = createContinuation({
        approvalId,
        subject,
        action: method,
      });
      const result: GatewayGuardResult = {
        status: "approval-required",
        decision,
        approvalRequest: {
          id: approvalId,
          risk: decision.riskTier,
          method,
        },
        continuation,
      };
      params.context.logGateway.warn(
        `[govdoss] approval required method=${method} subject=${subject} approvalId=${approvalId}`,
      );
      return result;
    }

    await params.executor();

    const postEvent = createAuditEvent({
      subject,
      object: targetSurface,
      authentication: "gateway-session",
      authorization: "allowed",
      approval: "not-required",
      action: method,
      outcome: "completed",
      metadata: {
        decisionId: decision.decisionId,
        role,
        scopes,
        riskTier: decision.riskTier,
      },
    });
    params.context.logGateway.info(`[govdoss] audit end ${JSON.stringify(postEvent)}`);

    return {
      status: "executed",
      decision,
    };
  }
}

export const govdossGatewayGuard = new GovdossGatewayGuard();
