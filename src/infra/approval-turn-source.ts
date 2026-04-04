import { loadConfig } from "../config/config.js";
import { resolveExecApprovalInitiatingSurfaceState } from "./exec-approval-surface.js";

export function hasApprovalTurnSourceRoute(params: {
  turnSourceChannel?: string | null;
  turnSourceAccountId?: string | null;
  turnSourceTo?: string | null;
  sessionKey?: string | null;
}): boolean {
  if (!params.turnSourceChannel?.trim()) {
    return false;
  }
  return (
    resolveExecApprovalInitiatingSurfaceState({
      channel: params.turnSourceChannel,
      accountId: params.turnSourceAccountId,
      turnSourceTo: params.turnSourceTo,
      sessionKey: params.sessionKey,
      cfg: loadConfig(),
    }).kind === "enabled"
  );
}
