import type { ErrorShape } from "./types.js";

export const ErrorCodes = {
  NOT_LINKED: "NOT_LINKED",
  NOT_PAIRED: "NOT_PAIRED",
  AGENT_TIMEOUT: "AGENT_TIMEOUT",
  INVALID_REQUEST: "INVALID_REQUEST",
  APPROVAL_NOT_FOUND: "APPROVAL_NOT_FOUND",
  UNAVAILABLE: "UNAVAILABLE",
  /**
   * Live-test iteration 1 Bug 3: returned by `sessions.patch
   * { planApproval: { action: "approve" | "edit" } }` when the parent
   * agent run still has open subagent runs from the plan-mode
   * investigation phase. Approving while subagents are in flight
   * would let the agent execute the plan with partial subagent
   * results — the gate makes the user wait for completion.
   *
   * `error.details.openSubagentRunIds` carries the in-flight child
   * runIds so the UI can render a precise toast. The webchat
   * approval card catches this code and surfaces a bottom-of-chat
   * fallback toast (mirrors the model-fallback pattern at
   * `chat.ts:renderFallbackIndicator`).
   */
  PLAN_APPROVAL_BLOCKED_BY_SUBAGENTS: "PLAN_APPROVAL_BLOCKED_BY_SUBAGENTS",
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

export function errorShape(
  code: ErrorCode,
  message: string,
  opts?: { details?: unknown; retryable?: boolean; retryAfterMs?: number },
): ErrorShape {
  return {
    code,
    message,
    ...opts,
  };
}
