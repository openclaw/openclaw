// User-facing copy for optional exec approval decisions that cannot be offered.
import type { ExecApprovalAllowAlwaysUnavailableReason } from "./exec-approvals.js";

export const EXEC_APPROVAL_ALLOW_ALWAYS_POLICY_UNAVAILABLE_TEXT =
  "The effective approval policy requires approval every time, so Allow Always is unavailable.";

export const EXEC_APPROVAL_ALLOW_ALWAYS_ONE_SHOT_UNAVAILABLE_TEXT =
  "Allow Always is unavailable because this command cannot be safely saved as a reusable approval.";

export function formatExecApprovalAllowAlwaysUnavailableText(
  reason?: ExecApprovalAllowAlwaysUnavailableReason | null,
): string {
  return reason === "one-shot"
    ? EXEC_APPROVAL_ALLOW_ALWAYS_ONE_SHOT_UNAVAILABLE_TEXT
    : EXEC_APPROVAL_ALLOW_ALWAYS_POLICY_UNAVAILABLE_TEXT;
}

export function formatExecApprovalAllowAlwaysUnavailableErrorMessage(
  reason?: ExecApprovalAllowAlwaysUnavailableReason | null,
): string {
  return reason === "one-shot"
    ? "allow-always is unavailable because this command cannot be safely saved as a reusable approval"
    : "allow-always is unavailable because the effective policy requires approval every time";
}
