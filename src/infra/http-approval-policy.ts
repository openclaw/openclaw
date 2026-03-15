/**
 * Resolves HTTP approval policy from config for a given agent.
 *
 * The policy chain is:
 *   1. approvals.httpPolicy (global defaults)
 *   2. approvals.httpPolicy.agents.<agentId> (per-agent overrides)
 *   3. Built-in defaults (security=full, ask=off, askFallback=full)
 */

import type { OpenClawConfig } from "../config/config.js";
import { DEFAULT_AGENT_ID } from "../routing/session-key.js";
import { evaluateHttpAllowlist, type HttpAllowlistEvaluation } from "./http-approvals-allowlist.js";
import {
  DEFAULT_HTTP_ASK,
  DEFAULT_HTTP_ASK_FALLBACK,
  DEFAULT_HTTP_SECURITY,
  normalizeHttpAsk,
  normalizeHttpSecurity,
  requiresHttpApproval,
  type HttpAllowlistEntry,
  type HttpAsk,
  type HttpSecurity,
} from "./http-approvals.js";

export type ResolvedHttpApprovalPolicy = {
  security: HttpSecurity;
  ask: HttpAsk;
  askFallback: HttpSecurity;
  allowlist: HttpAllowlistEntry[];
};

export function resolveHttpApprovalPolicy(params: {
  cfg: OpenClawConfig;
  agentId?: string;
}): ResolvedHttpApprovalPolicy {
  const httpPolicy = params.cfg.approvals?.httpPolicy;
  const agentKey = params.agentId ?? DEFAULT_AGENT_ID;

  const globalSecurity = normalizeHttpSecurity(httpPolicy?.security) ?? DEFAULT_HTTP_SECURITY;
  const globalAsk = normalizeHttpAsk(httpPolicy?.ask) ?? DEFAULT_HTTP_ASK;
  const globalAskFallback =
    normalizeHttpSecurity(httpPolicy?.askFallback) ?? DEFAULT_HTTP_ASK_FALLBACK;
  const globalAllowlist = normalizeAllowlist(httpPolicy?.allowlist);

  const agentConfig = httpPolicy?.agents?.[agentKey];
  const wildcardConfig = httpPolicy?.agents?.["*"];

  const agentSecurity =
    normalizeHttpSecurity(agentConfig?.security) ??
    normalizeHttpSecurity(wildcardConfig?.security) ??
    globalSecurity;
  const agentAsk =
    normalizeHttpAsk(agentConfig?.ask) ?? normalizeHttpAsk(wildcardConfig?.ask) ?? globalAsk;
  const agentAskFallback =
    normalizeHttpSecurity(agentConfig?.askFallback) ??
    normalizeHttpSecurity(wildcardConfig?.askFallback) ??
    globalAskFallback;

  const agentAllowlist = [
    ...normalizeAllowlist(wildcardConfig?.allowlist),
    ...normalizeAllowlist(agentConfig?.allowlist),
    ...globalAllowlist,
  ];

  return {
    security: agentSecurity,
    ask: agentAsk,
    askFallback: agentAskFallback,
    allowlist: agentAllowlist,
  };
}

function normalizeAllowlist(entries?: Array<{ pattern: string }>): HttpAllowlistEntry[] {
  if (!Array.isArray(entries)) {
    return [];
  }
  return entries
    .filter((e) => typeof e?.pattern === "string" && e.pattern.trim().length > 0)
    .map((e) => ({ pattern: e.pattern.trim() }));
}

export type HttpApprovalDecisionResult = {
  allowed: boolean;
  requiresApproval: boolean;
  evaluation: HttpAllowlistEvaluation;
  security: HttpSecurity;
  ask: HttpAsk;
  askFallback: HttpSecurity;
};

/**
 * Evaluate whether an HTTP fetch should be allowed, denied, or requires approval.
 */
export function evaluateHttpApprovalPolicy(params: {
  url: string;
  policy: ResolvedHttpApprovalPolicy;
}): HttpApprovalDecisionResult {
  const { policy, url } = params;

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

  const evaluation = evaluateHttpAllowlist({
    url,
    allowlist: policy.allowlist,
  });

  const needsApproval = requiresHttpApproval({
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
