import { getStateDb } from "../../infra/state-db/index.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

function storeErrorToShape(err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  return errorShape(ErrorCodes.UNAVAILABLE, msg);
}

export const sidebarBadgesHandlers: GatewayRequestHandlers = {
  "sidebar.badges": async ({ respond }) => {
    try {
      const db = getStateDb();

      // Count pending approvals
      const approvalsRow = db
        .prepare("SELECT COUNT(*) as count FROM op1_approvals WHERE status = 'pending'")
        .get() as { count: number } | undefined;
      const pendingApprovals = approvalsRow?.count ?? 0;

      // Count active budget incidents (not resolved)
      const incidentsRow = db
        .prepare("SELECT COUNT(*) as count FROM op1_budget_incidents WHERE type != 'resolved'")
        .get() as { count: number } | undefined;
      const activeBudgetIncidents = incidentsRow?.count ?? 0;

      // Count tasks currently in progress
      const tasksRow = db
        .prepare("SELECT COUNT(*) as count FROM op1_tasks WHERE status = 'in_progress'")
        .get() as { count: number } | undefined;
      const tasksInProgress = tasksRow?.count ?? 0;

      respond(true, {
        pendingApprovals,
        activeBudgetIncidents,
        tasksInProgress,
        // Placeholder: unread messaging count not yet implemented
        unreadCount: 0,
      });
    } catch (err) {
      respond(false, undefined, storeErrorToShape(err));
    }
  },
};
