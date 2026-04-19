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
  /**
   * Returned by `sessions.patch { planApproval: { action: "approve" |
   * "edit" } }` when a subagent has settled within the last
   * SUBAGENT_SETTLE_GRACE_MS (default 10s). Prevents the race where an
   * announce-turn from the just-completed subagent fires in parallel
   * with the approval-resume turn, stalling forward progress.
   *
   * `error.details.retryAfterMs` carries the remaining grace window in
   * milliseconds so the UI can render a countdown toast or queue an
   * auto-retry. Rejection is intentionally NOT gated — the user can
   * always reject a plan regardless of subagent settle state.
   */
  PLAN_APPROVAL_WAITING_FOR_SUBAGENT_SETTLE: "PLAN_APPROVAL_WAITING_FOR_SUBAGENT_SETTLE",
  /**
   * Returned by `sessions.patch { planApproval: { action: "approve" |
   * "edit" } }` when the server cannot safely evaluate the approval-
   * side subagent gate for the current plan cycle because both the
   * runtime context and the persisted gate snapshot are unavailable.
   *
   * This fails closed for modern plan-mode sessions so restart / ctx
   * cleanup does not silently bypass the gate.
   */
  PLAN_APPROVAL_GATE_STATE_UNAVAILABLE: "PLAN_APPROVAL_GATE_STATE_UNAVAILABLE",
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
