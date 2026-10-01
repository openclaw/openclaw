import type { AllowAlwaysPersistenceDecision } from "./exec-approvals-contracts.js";
// Resolves exec approval requirements and approval-decision availability.
import {
  normalizeExecAsk,
  type ExecApprovalDecision,
  type ExecApprovalUnavailableDecision,
  type ExecAsk,
  type ExecSecurity,
} from "./exec-approvals-core.js";

export function requiresExecApproval(params: {
  ask: ExecAsk;
  security: ExecSecurity;
  analysisOk: boolean;
  allowlistSatisfied: boolean;
  durableApprovalSatisfied?: boolean;
}): boolean {
  if (params.ask === "always") {
    return true;
  }
  if (params.durableApprovalSatisfied === true) {
    return false;
  }
  return (
    params.ask === "on-miss" &&
    params.security === "allowlist" &&
    (!params.analysisOk || !params.allowlistSatisfied)
  );
}

export function minSecurity(a: ExecSecurity, b: ExecSecurity): ExecSecurity {
  const order: Record<ExecSecurity, number> = { deny: 0, allowlist: 1, full: 2 };
  return order[a] <= order[b] ? a : b;
}

export function maxAsk(a: ExecAsk, b: ExecAsk): ExecAsk {
  const order: Record<ExecAsk, number> = { off: 0, "on-miss": 1, always: 2 };
  return order[a] >= order[b] ? a : b;
}

const DEFAULT_EXEC_APPROVAL_DECISIONS = [
  "allow-once",
  "allow-always",
  "deny",
] as const satisfies readonly ExecApprovalDecision[];
const OPTIONAL_EXEC_APPROVAL_DECISIONS = [
  "allow-always",
] as const satisfies readonly ExecApprovalDecision[];
const OPTIONAL_EXEC_APPROVAL_DECISION_SET: ReadonlySet<string> = new Set(
  OPTIONAL_EXEC_APPROVAL_DECISIONS,
);

function isOptionalExecApprovalDecision(
  decision: string,
): decision is ExecApprovalUnavailableDecision {
  return OPTIONAL_EXEC_APPROVAL_DECISION_SET.has(decision);
}

function collectExecApprovalUnavailableDecisionSet(
  decisions?: readonly string[] | readonly ExecApprovalUnavailableDecision[] | null,
): ReadonlySet<ExecApprovalUnavailableDecision> {
  const unavailable = new Set<ExecApprovalUnavailableDecision>();
  if (!Array.isArray(decisions)) {
    return unavailable;
  }
  for (const decision of decisions) {
    if (isOptionalExecApprovalDecision(decision)) {
      unavailable.add(decision);
    }
  }
  return unavailable;
}

export function normalizeExecApprovalUnavailableDecisions(
  decisions?: readonly string[] | readonly ExecApprovalUnavailableDecision[] | null,
): readonly ExecApprovalUnavailableDecision[] {
  const unavailable = collectExecApprovalUnavailableDecisionSet(decisions);
  return OPTIONAL_EXEC_APPROVAL_DECISIONS.filter((decision) => unavailable.has(decision));
}

export function resolveExecApprovalAllowedDecisions(params?: {
  ask?: string | null;
  allowAlwaysPersistence?: AllowAlwaysPersistenceDecision | null;
}): readonly ExecApprovalDecision[] {
  const ask = normalizeExecAsk(params?.ask);
  if (ask === "always" || params?.allowAlwaysPersistence?.kind === "one-shot") {
    return ["allow-once", "deny"];
  }
  return DEFAULT_EXEC_APPROVAL_DECISIONS;
}

export function resolveExecApprovalUnavailableDecisions(params?: {
  ask?: string | null;
  allowAlwaysPersistence?: AllowAlwaysPersistenceDecision | null;
}): readonly ExecApprovalUnavailableDecision[] {
  const allowed = new Set(resolveExecApprovalAllowedDecisions(params));
  return OPTIONAL_EXEC_APPROVAL_DECISIONS.filter((decision) => !allowed.has(decision));
}

export function resolveExecApprovalRequestAllowedDecisions(params?: {
  ask?: string | null;
  unavailableDecisions?: readonly ExecApprovalUnavailableDecision[] | readonly string[] | null;
}): readonly ExecApprovalDecision[] {
  const policyDecisions = resolveExecApprovalAllowedDecisions({ ask: params?.ask });
  const unavailableDecisions = collectExecApprovalUnavailableDecisionSet(
    params?.unavailableDecisions,
  );
  if (unavailableDecisions.size === 0) {
    return policyDecisions;
  }
  return policyDecisions.filter(
    (decision) => !isOptionalExecApprovalDecision(decision) || !unavailableDecisions.has(decision),
  );
}
