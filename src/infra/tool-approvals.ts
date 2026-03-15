/**
 * MCP/plugin tool call approval system.
 *
 * Parallels the exec and HTTP approval systems but for MCP/plugin tool calls.
 * Uses the same security/ask/askFallback knobs and the same gateway
 * approval manager for pending request tracking.
 */

import type { ExecApprovalDecision } from "./exec-approvals.js";

export type ToolSecurity = "deny" | "allowlist" | "full";
export type ToolAsk = "off" | "on-miss" | "always";

export function normalizeToolSecurity(value?: string | null): ToolSecurity | null {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "deny" || normalized === "allowlist" || normalized === "full") {
    return normalized;
  }
  return null;
}

export function normalizeToolAsk(value?: string | null): ToolAsk | null {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "off" || normalized === "on-miss" || normalized === "always") {
    return normalized;
  }
  return null;
}

export type ToolApprovalRequestPayload = {
  toolName: string;
  /** Tool call arguments (serialized for display). */
  args?: Record<string, unknown> | null;
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

export type ToolApprovalRequest = {
  id: string;
  request: ToolApprovalRequestPayload;
  createdAtMs: number;
  expiresAtMs: number;
};

export type ToolApprovalResolved = {
  id: string;
  decision: ExecApprovalDecision;
  resolvedBy?: string | null;
  ts: number;
  request?: ToolApprovalRequest["request"];
};

export type ToolAllowlistEntry = {
  id?: string;
  pattern: string;
  lastUsedAt?: number;
  lastUsedToolName?: string;
};

export type ToolApprovalsDefaults = {
  security?: ToolSecurity;
  ask?: ToolAsk;
  askFallback?: ToolSecurity;
};

export type ToolApprovalsAgent = ToolApprovalsDefaults & {
  allowlist?: ToolAllowlistEntry[];
};

export const DEFAULT_TOOL_SECURITY: ToolSecurity = "full";
export const DEFAULT_TOOL_ASK: ToolAsk = "off";
export const DEFAULT_TOOL_ASK_FALLBACK: ToolSecurity = "full";
export const DEFAULT_TOOL_APPROVAL_TIMEOUT_MS = 120_000;

export function requiresToolApproval(params: {
  ask: ToolAsk;
  security: ToolSecurity;
  allowlistSatisfied: boolean;
}): boolean {
  return (
    params.ask === "always" ||
    (params.ask === "on-miss" && params.security === "allowlist" && !params.allowlistSatisfied)
  );
}

export function resolveToolApprovalDefaults(
  defaults?: ToolApprovalsDefaults,
): Required<ToolApprovalsDefaults> {
  return {
    security: normalizeToolSecurity(defaults?.security) ?? DEFAULT_TOOL_SECURITY,
    ask: normalizeToolAsk(defaults?.ask) ?? DEFAULT_TOOL_ASK,
    askFallback: normalizeToolSecurity(defaults?.askFallback) ?? DEFAULT_TOOL_ASK_FALLBACK,
  };
}

export function resolveToolApprovalAgent(
  agent?: ToolApprovalsAgent,
  defaults?: Required<ToolApprovalsDefaults>,
): Required<ToolApprovalsDefaults> & { allowlist: ToolAllowlistEntry[] } {
  const resolved = defaults ?? resolveToolApprovalDefaults();
  return {
    security: normalizeToolSecurity(agent?.security) ?? resolved.security,
    ask: normalizeToolAsk(agent?.ask) ?? resolved.ask,
    askFallback: normalizeToolSecurity(agent?.askFallback) ?? resolved.askFallback,
    allowlist: Array.isArray(agent?.allowlist) ? agent.allowlist : [],
  };
}
