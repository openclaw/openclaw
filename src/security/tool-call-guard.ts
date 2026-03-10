import { isExternalHookSession } from "./external-content.js";

/**
 * Tool categories that require human approval when invoked during
 * sessions containing untrusted external content (hooks, webhooks, emails).
 *
 * This creates an enforcement boundary beyond the prompt-level
 * security warnings in external-content.ts — even if the LLM is
 * tricked by a prompt injection, destructive tool calls will be
 * blocked unless a human approves them.
 */

const DESTRUCTIVE_TOOL_PATTERNS: RegExp[] = [
  // Shell/command execution
  /^system[._]run$/i,
  /^exec$/i,
  /^bash$/i,
  /^shell$/i,
  /^run[_-]?command$/i,
  // File mutation outside workspace
  /^write$/i,
  /^edit$/i,
  /^apply[_-]?patch$/i,
  // Outbound messaging (data exfiltration risk)
  /^send[_-]?message$/i,
  /^send[_-]?email$/i,
  /^reply$/i,
  // Sub-agent spawning
  /^sessions?[_-]?spawn$/i,
];

export type ToolCallGuardResult = {
  blocked: boolean;
  reason?: string;
  requiresApproval: boolean;
};

/**
 * Evaluates whether a tool call in the current session context should be
 * blocked or require human approval.
 *
 * When the session originates from an external/untrusted source (hook:gmail:*,
 * hook:webhook:*, etc.), destructive tool calls are flagged as requiring
 * human approval rather than being auto-executed.
 */
export function evaluateToolCallGuard(params: {
  toolName: string;
  sessionKey?: string | null;
  /** If true, bypass the guard (operator break-glass). */
  allowUnsafeExternalContent?: boolean;
}): ToolCallGuardResult {
  if (params.allowUnsafeExternalContent === true) {
    return { blocked: false, requiresApproval: false };
  }

  const sessionKey = params.sessionKey?.trim();
  if (!sessionKey || !isExternalHookSession(sessionKey)) {
    return { blocked: false, requiresApproval: false };
  }

  const toolName = params.toolName.trim();
  const isDestructive = DESTRUCTIVE_TOOL_PATTERNS.some((pattern) => pattern.test(toolName));

  if (!isDestructive) {
    return { blocked: false, requiresApproval: false };
  }

  return {
    blocked: false,
    requiresApproval: true,
    reason:
      `Tool "${toolName}" requires human approval because this session ` +
      `contains untrusted external content (${sessionKey}). This prevents ` +
      `indirect prompt injection from triggering destructive actions without oversight.`,
  };
}

/**
 * Returns true if the given tool name matches a destructive pattern
 * that should be gated in external content sessions.
 */
export function isDestructiveToolCall(toolName: string): boolean {
  return DESTRUCTIVE_TOOL_PATTERNS.some((pattern) => pattern.test(toolName.trim()));
}
