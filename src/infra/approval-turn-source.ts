import { getRuntimeConfig } from "../config/config.js";
import { resolveApprovalInitiatingSurfaceState } from "./exec-approval-surface.js";

/**
 * Returns whether the original chat surface can accept the approval decision.
 *
 * This is checked at reply time with live config because pending approvals can outlive the turn
 * that created them, and channel/account native approval availability may change meanwhile.
 */
export function hasApprovalTurnSourceRoute(params: {
  turnSourceChannel?: string | null;
  turnSourceAccountId?: string | null;
  approvalKind?: "exec" | "plugin";
}): boolean {
  if (!params.turnSourceChannel?.trim()) {
    return false;
  }
  // The turn-source route uses live config because approvals can outlive the request that
  // created them and channel native approval state may change before the user replies.
  return (
    resolveApprovalInitiatingSurfaceState({
      channel: params.turnSourceChannel,
      accountId: params.turnSourceAccountId,
      cfg: getRuntimeConfig(),
      approvalKind: params.approvalKind ?? "exec",
    }).kind === "enabled"
  );
}
