/**
 * Resolves MCP/plugin tool approval policy from config for a given agent.
 *
 * The policy chain is:
 *   1. approvals.toolPolicy (global defaults)
 *   2. approvals.toolPolicy.agents.<agentId> (per-agent overrides)
 *   3. Built-in defaults (security=full, ask=off, askFallback=full)
 */

import type { OpenClawConfig } from "../config/config.js";
import { DEFAULT_AGENT_ID } from "../routing/session-key.js";
import { evaluateToolAllowlist, type ToolAllowlistEvaluation } from "./tool-approvals-allowlist.js";
import {
  DEFAULT_TOOL_ASK,
  DEFAULT_TOOL_ASK_FALLBACK,
  DEFAULT_TOOL_SECURITY,
  normalizeToolAsk,
  normalizeToolSecurity,
  requiresToolApproval,
  type ToolAllowlistEntry,
  type ToolAsk,
  type ToolSecurity,
} from "./tool-approvals.js";

export type ResolvedToolApprovalPolicy = {
  security: ToolSecurity;
  ask: ToolAsk;
  askFallback: ToolSecurity;
  allowlist: ToolAllowlistEntry[];
};

export function resolveToolApprovalPolicy(params: {
  cfg: OpenClawConfig;
  agentId?: string;
}): ResolvedToolApprovalPolicy {
  const toolPolicy = params.cfg.approvals?.toolPolicy;
  const agentKey = params.agentId ?? DEFAULT_AGENT_ID;

  const globalSecurity = normalizeToolSecurity(toolPolicy?.security) ?? DEFAULT_TOOL_SECURITY;
  const globalAsk = normalizeToolAsk(toolPolicy?.ask) ?? DEFAULT_TOOL_ASK;
  const globalAskFallback =
    normalizeToolSecurity(toolPolicy?.askFallback) ?? DEFAULT_TOOL_ASK_FALLBACK;
  const globalAllowlist = normalizeAllowlist(toolPolicy?.allowlist);

  const agentConfig = toolPolicy?.agents?.[agentKey];
  const wildcardConfig = toolPolicy?.agents?.["*"];

  const agentSecurity =
    normalizeToolSecurity(agentConfig?.security) ??
    normalizeToolSecurity(wildcardConfig?.security) ??
    globalSecurity;
  const agentAsk =
    normalizeToolAsk(agentConfig?.ask) ?? normalizeToolAsk(wildcardConfig?.ask) ?? globalAsk;
  const agentAskFallback =
    normalizeToolSecurity(agentConfig?.askFallback) ??
    normalizeToolSecurity(wildcardConfig?.askFallback) ??
    globalAskFallback;

  // Per-agent allowlist overrides global. If the specific agent declares its
  // own allowlist, use it exclusively. Otherwise fall back to the wildcard
  // agent allowlist, and finally to the global allowlist. This prevents a
  // permissive global rule (e.g. "*") from undermining a tighter per-agent
  // restriction.
  const agentSpecificAllowlist = normalizeAllowlist(agentConfig?.allowlist);
  const wildcardAllowlist = normalizeAllowlist(wildcardConfig?.allowlist);
  const agentAllowlist =
    agentSpecificAllowlist.length > 0
      ? agentSpecificAllowlist
      : wildcardAllowlist.length > 0
        ? wildcardAllowlist
        : globalAllowlist;

  return {
    security: agentSecurity,
    ask: agentAsk,
    askFallback: agentAskFallback,
    allowlist: agentAllowlist,
  };
}

function normalizeAllowlist(entries?: Array<{ pattern: string }>): ToolAllowlistEntry[] {
  if (!Array.isArray(entries)) {
    return [];
  }
  return entries
    .filter((e) => typeof e?.pattern === "string" && e.pattern.trim().length > 0)
    .map((e) => ({ pattern: e.pattern.trim() }));
}

export type ToolApprovalDecisionResult = {
  allowed: boolean;
  requiresApproval: boolean;
  evaluation: ToolAllowlistEvaluation;
  security: ToolSecurity;
  ask: ToolAsk;
  askFallback: ToolSecurity;
};

/**
 * Evaluate whether a tool call should be allowed, denied, or requires approval.
 */
export function evaluateToolApprovalPolicy(params: {
  toolName: string;
  policy: ResolvedToolApprovalPolicy;
}): ToolApprovalDecisionResult {
  const { policy, toolName } = params;

  if (policy.security === "deny") {
    return {
      allowed: false,
      requiresApproval: false,
      evaluation: { allowlistSatisfied: false, matchedEntry: null },
      security: policy.security,
      ask: policy.ask,
      askFallback: policy.askFallback,
    };
  }

  if (policy.security === "full" && policy.ask === "off") {
    return {
      allowed: true,
      requiresApproval: false,
      evaluation: { allowlistSatisfied: true, matchedEntry: null },
      security: policy.security,
      ask: policy.ask,
      askFallback: policy.askFallback,
    };
  }

  const evaluation = evaluateToolAllowlist({
    toolName,
    allowlist: policy.allowlist,
  });

  const needsApproval = requiresToolApproval({
    ask: policy.ask,
    security: policy.security,
    allowlistSatisfied: evaluation.allowlistSatisfied,
  });

  if (needsApproval) {
    return {
      allowed: false,
      requiresApproval: true,
      evaluation,
      security: policy.security,
      ask: policy.ask,
      askFallback: policy.askFallback,
    };
  }

  // In allowlist mode without ask, the allowlist must match.
  if (policy.security === "allowlist" && !evaluation.allowlistSatisfied) {
    return {
      allowed: false,
      requiresApproval: false,
      evaluation,
      security: policy.security,
      ask: policy.ask,
      askFallback: policy.askFallback,
    };
  }

  return {
    allowed: true,
    requiresApproval: false,
    evaluation,
    security: policy.security,
    ask: policy.ask,
    askFallback: policy.askFallback,
  };
}
