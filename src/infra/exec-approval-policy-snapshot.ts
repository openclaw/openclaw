// Canonicalizes the portable policy snapshot carried with delayed exec approvals.
import type { ExecApprovalRequestParams } from "../../packages/gateway-protocol/src/schema/exec-approvals.js";

type PolicySnapshot = NonNullable<
  NonNullable<ExecApprovalRequestParams["systemRunPlan"]>["policySnapshot"]
>;
type ExecApprovalPolicyRule = PolicySnapshot["allowlistRules"][number];

export type ExecApprovalPolicySnapshot = Omit<PolicySnapshot, "allowlistRules"> & {
  allowlistRules: readonly ExecApprovalPolicyRule[];
};

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function compareOptionalUtf8(left: string | undefined, right: string | undefined): number {
  if (left === undefined) {
    return right === undefined ? 0 : -1;
  }
  if (right === undefined) {
    return 1;
  }
  return compareUtf8(left, right);
}

/** Cross-runtime order: tuple fields, absent before present, UTF-8 byte lexicographic. */
function compareExecApprovalPolicyRules(
  left: ExecApprovalPolicyRule,
  right: ExecApprovalPolicyRule,
): number {
  return (
    compareUtf8(left.pattern, right.pattern) ||
    compareOptionalUtf8(left.argPattern, right.argPattern) ||
    compareOptionalUtf8(left.source, right.source)
  );
}

export function buildExecApprovalPolicyRuleKey(rule: ExecApprovalPolicyRule): string {
  // A JSON tuple preserves exact regex bytes without delimiter collisions.
  return JSON.stringify([rule.pattern, rule.argPattern ?? null, rule.source ?? null]);
}

export function canonicalizeExecApprovalPolicyRules(
  rules: readonly ExecApprovalPolicyRule[],
): ExecApprovalPolicyRule[] {
  const rulesByKey = new Map(rules.map((rule) => [buildExecApprovalPolicyRuleKey(rule), rule]));
  return [...rulesByKey.values()].toSorted(compareExecApprovalPolicyRules);
}

export function normalizeExecApprovalPolicySnapshot(
  value: unknown,
): ExecApprovalPolicySnapshot | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  const security = candidate.security;
  const ask = candidate.ask;
  const askFallback = candidate.askFallback;
  const autoAllowSkills = candidate.autoAllowSkills;
  const allowlistRules = candidate.allowlistRules;
  if (
    (security !== "deny" && security !== "allowlist" && security !== "full") ||
    (ask !== "off" && ask !== "on-miss" && ask !== "always") ||
    (askFallback !== "deny" && askFallback !== "allowlist" && askFallback !== "full") ||
    typeof autoAllowSkills !== "boolean" ||
    !Array.isArray(allowlistRules)
  ) {
    return null;
  }
  const normalizedRules: ExecApprovalPolicyRule[] = [];
  for (const rawRule of allowlistRules) {
    if (!rawRule || typeof rawRule !== "object" || Array.isArray(rawRule)) {
      return null;
    }
    const rule = rawRule as Record<string, unknown>;
    if (
      typeof rule.pattern !== "string" ||
      (rule.argPattern !== undefined && typeof rule.argPattern !== "string") ||
      (rule.source !== undefined && rule.source !== "allow-always")
    ) {
      return null;
    }
    normalizedRules.push({
      pattern: rule.pattern,
      ...(typeof rule.argPattern === "string" ? { argPattern: rule.argPattern } : {}),
      ...(rule.source === "allow-always" ? { source: rule.source } : {}),
    });
  }
  return {
    security,
    ask,
    askFallback,
    autoAllowSkills,
    allowlistRules: canonicalizeExecApprovalPolicyRules(normalizedRules),
  };
}
