/**
 * HTTP/fetch tool approval system.
 *
 * Parallels the exec approval system but for HTTP/fetch tool calls.
 * Uses the same security/ask/askFallback knobs and the same gateway
 * approval manager for pending request tracking.
 */

import type { ExecApprovalDecision } from "./exec-approvals.js";

export type HttpSecurity = "deny" | "allowlist" | "full";
export type HttpAsk = "off" | "on-miss" | "always";

export function normalizeHttpSecurity(value?: string | null): HttpSecurity | null {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "deny" || normalized === "allowlist" || normalized === "full") {
    return normalized;
  }
  return null;
}

export function normalizeHttpAsk(value?: string | null): HttpAsk | null {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "off" || normalized === "on-miss" || normalized === "always") {
    return normalized;
  }
  return null;
}

export type HttpApprovalRequestPayload = {
  url: string;
  /** HTTP method (GET, POST, etc.) if known. */
  method?: string | null;
  agentId?: string | null;
  sessionKey?: string | null;
  host?: string | null;
  security?: string | null;
  ask?: string | null;
  turnSourceChannel?: string | null;
  turnSourceTo?: string | null;
  turnSourceAccountId?: string | null;
  turnSourceThreadId?: string | number | null;
};

export type HttpApprovalRequest = {
  id: string;
  request: HttpApprovalRequestPayload;
  createdAtMs: number;
  expiresAtMs: number;
};

export type HttpApprovalResolved = {
  id: string;
  decision: ExecApprovalDecision;
  resolvedBy?: string | null;
  ts: number;
  request?: HttpApprovalRequest["request"];
};

export type HttpAllowlistEntry = {
  id?: string;
  pattern: string;
  lastUsedAt?: number;
  lastUsedUrl?: string;
};

export type HttpApprovalsDefaults = {
  security?: HttpSecurity;
  ask?: HttpAsk;
  askFallback?: HttpSecurity;
};

export type HttpApprovalsAgent = HttpApprovalsDefaults & {
  allowlist?: HttpAllowlistEntry[];
};

export const DEFAULT_HTTP_SECURITY: HttpSecurity = "full";
export const DEFAULT_HTTP_ASK: HttpAsk = "off";
export const DEFAULT_HTTP_ASK_FALLBACK: HttpSecurity = "full";
export const DEFAULT_HTTP_APPROVAL_TIMEOUT_MS = 120_000;

export function requiresHttpApproval(params: {
  ask: HttpAsk;
  security: HttpSecurity;
  allowlistSatisfied: boolean;
}): boolean {
  return (
    params.ask === "always" ||
    (params.ask === "on-miss" && params.security === "allowlist" && !params.allowlistSatisfied)
  );
}

export function resolveHttpApprovalDefaults(
  defaults?: HttpApprovalsDefaults,
): Required<HttpApprovalsDefaults> {
  return {
    security: normalizeHttpSecurity(defaults?.security) ?? DEFAULT_HTTP_SECURITY,
    ask: normalizeHttpAsk(defaults?.ask) ?? DEFAULT_HTTP_ASK,
    askFallback: normalizeHttpSecurity(defaults?.askFallback) ?? DEFAULT_HTTP_ASK_FALLBACK,
  };
}

export function resolveHttpApprovalAgent(
  agent?: HttpApprovalsAgent,
  defaults?: Required<HttpApprovalsDefaults>,
): Required<HttpApprovalsDefaults> & { allowlist: HttpAllowlistEntry[] } {
  const resolved = defaults ?? resolveHttpApprovalDefaults();
  return {
    security: normalizeHttpSecurity(agent?.security) ?? resolved.security,
    ask: normalizeHttpAsk(agent?.ask) ?? resolved.ask,
    askFallback: normalizeHttpSecurity(agent?.askFallback) ?? resolved.askFallback,
    allowlist: Array.isArray(agent?.allowlist) ? agent.allowlist : [],
  };
}

/**
 * Derive a host-scoped URL pattern for an "allow always" decision.
 *
 * Given a URL like `https://api.example.com/v1/data?q=1`, returns
 * `https://api.example.com/**` so that all paths on the same host are
 * allowed in future requests. Returns null if the URL cannot be parsed.
 */
export function resolveHttpAllowAlwaysPattern(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = new URL(trimmed);
    return `${parsed.protocol}//${parsed.host}/**`;
  } catch {
    return null;
  }
}
