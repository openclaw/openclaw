/**
 * IBEL Phase 1 — HITL escalation adapter.
 *
 * Integrates the guard pipeline's "escalate" result with OpenClaw's existing
 * ExecApprovalManager. Creates approval requests, awaits decisions, and
 * maps outcomes back to allow/block.
 *
 * Fail-closed on timeout: if no human responds, the tool call is blocked.
 */

import type { ExecApprovalManager } from "../gateway/exec-approval-manager.js";
import type { EscalateResult } from "./types.js";

export type HitlEscalationResult = { approved: true } | { approved: false; reason: string };

export type HitlEscalationMeta = {
  agentId?: string;
  sessionKey?: string;
};

/**
 * Handle a guard pipeline "escalate" result by creating an approval request
 * and waiting for a human decision.
 */
export async function handleEscalation(
  result: EscalateResult,
  approvalManager: ExecApprovalManager,
  meta?: HitlEscalationMeta,
): Promise<HitlEscalationResult> {
  const record = approvalManager.create(
    {
      command: result.hitlPayload.summary,
      agentId: meta?.agentId ?? null,
      sessionKey: meta?.sessionKey ?? null,
    },
    result.timeoutMs,
  );

  const decision = await approvalManager.register(record, result.timeoutMs);

  if (decision === null) {
    return {
      approved: false,
      reason: `HITL escalation timed out for tool "${result.hitlPayload.toolName}" (fail-closed)`,
    };
  }

  if (decision === "deny") {
    return {
      approved: false,
      reason: `HITL escalation denied for tool "${result.hitlPayload.toolName}"`,
    };
  }

  // "allow-once" or "allow-always"
  return { approved: true };
}
