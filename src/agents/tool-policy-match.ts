import { compileGlobPatterns, findMatchingGlobPattern } from "./glob-pattern.js";
import type { SandboxToolPolicy } from "./sandbox/types.js";
import { expandToolGroups, normalizeToolName } from "./tool-policy.js";

export type ToolPolicyNameDecision = {
  allowed: boolean;
  decision: "allow" | "deny";
  reason: "allow_rule" | "allow_default" | "deny_rule" | "allowlist_miss";
  rule?: string;
};

function makeToolPolicyMatcher(policy: SandboxToolPolicy) {
  const deny = compileGlobPatterns({
    raw: expandToolGroups(policy.deny ?? []),
    normalize: normalizeToolName,
  });
  const allow = compileGlobPatterns({
    raw: expandToolGroups(policy.allow ?? []),
    normalize: normalizeToolName,
  });
  return (name: string) => {
    const normalized = normalizeToolName(name);
    const denyRule = findMatchingGlobPattern(normalized, deny);
    if (denyRule) {
      return {
        allowed: false,
        decision: "deny",
        reason: "deny_rule",
        rule: denyRule,
      } satisfies ToolPolicyNameDecision;
    }
    const applyPatchDenyRule =
      normalized === "apply_patch" ? findMatchingGlobPattern("write", deny) : undefined;
    if (applyPatchDenyRule) {
      return {
        allowed: false,
        decision: "deny",
        reason: "deny_rule",
        rule: applyPatchDenyRule,
      } satisfies ToolPolicyNameDecision;
    }
    if (allow.length === 0) {
      return {
        allowed: true,
        decision: "allow",
        reason: "allow_default",
      } satisfies ToolPolicyNameDecision;
    }
    const allowRule = findMatchingGlobPattern(normalized, allow);
    if (allowRule) {
      return {
        allowed: true,
        decision: "allow",
        reason: "allow_rule",
        rule: allowRule,
      } satisfies ToolPolicyNameDecision;
    }
    const applyPatchAllowRule =
      normalized === "apply_patch" ? findMatchingGlobPattern("write", allow) : undefined;
    if (applyPatchAllowRule) {
      return {
        allowed: true,
        decision: "allow",
        reason: "allow_rule",
        rule: applyPatchAllowRule,
      } satisfies ToolPolicyNameDecision;
    }
    return {
      allowed: false,
      decision: "deny",
      reason: "allowlist_miss",
    } satisfies ToolPolicyNameDecision;
  };
}

export function explainToolPolicyNameDecision(
  name: string,
  policy?: SandboxToolPolicy,
): ToolPolicyNameDecision {
  if (!policy) {
    return {
      allowed: true,
      decision: "allow",
      reason: "allow_default",
    };
  }
  return makeToolPolicyMatcher(policy)(name);
}

export function isToolAllowedByPolicyName(name: string, policy?: SandboxToolPolicy): boolean {
  return explainToolPolicyNameDecision(name, policy).allowed;
}

export function isToolAllowedByPolicies(
  name: string,
  policies: Array<SandboxToolPolicy | undefined>,
) {
  return policies.every((policy) => isToolAllowedByPolicyName(name, policy));
}
