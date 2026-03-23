/**
 * Dashboard aggregation RPC handler.
 * Returns a summary of key metrics in a single call.
 */
import { getStateDb } from "../../infra/state-db/connection.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

export interface DashboardSummary {
  workspaceCount: number;
  agentCount: number;
  tasksTotal: number;
  tasksInProgress: number;
  tasksDone: number;
  goalsActive: number;
  goalsAchieved: number;
  pendingApprovals: number;
  activeBudgetIncidents: number;
  totalSpendMicrocents: number;
  pendingWakeups: number;
}

export const dashboardHandlers: GatewayRequestHandlers = {
  "dashboard.summary": ({ respond }) => {
    try {
      const db = getStateDb();

      const workspaceCount = (
        db.prepare("SELECT COUNT(*) AS n FROM op1_workspaces WHERE status != 'archived'").get() as {
          n: number;
        }
      ).n;

      // Count distinct agents registered in op1_workspace_agents
      const agentCount = (
        db.prepare("SELECT COUNT(DISTINCT agent_id) AS n FROM op1_workspace_agents").get() as {
          n: number;
        }
      ).n;

      // Task counts via conditional aggregation — single table scan
      const taskStats = db
        .prepare(
          `SELECT
            COUNT(*) AS total,
            SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) AS in_progress,
            SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done
          FROM op1_tasks`,
        )
        .get() as { total: number; in_progress: number; done: number };

      // Goal counts via conditional aggregation — single table scan
      const goalStats = db
        .prepare(
          `SELECT
            SUM(CASE WHEN status IN ('planned', 'in_progress') THEN 1 ELSE 0 END) AS active,
            SUM(CASE WHEN status = 'achieved' THEN 1 ELSE 0 END) AS achieved
          FROM op1_goals`,
        )
        .get() as { active: number; achieved: number };

      const pendingApprovals = (
        db.prepare("SELECT COUNT(*) AS n FROM op1_approvals WHERE status = 'pending'").get() as {
          n: number;
        }
      ).n;

      // Active budget incidents = not yet resolved (resolved_at IS NULL)
      const activeBudgetIncidents = (
        db
          .prepare("SELECT COUNT(*) AS n FROM op1_budget_incidents WHERE resolved_at IS NULL")
          .get() as { n: number }
      ).n;

      // Total spend across all cost events
      const totalSpendMicrocents = (
        db.prepare("SELECT COALESCE(SUM(cost_microcents), 0) AS n FROM op1_cost_events").get() as {
          n: number;
        }
      ).n;

      const pendingWakeups = (
        db
          .prepare("SELECT COUNT(*) AS n FROM op1_agent_wakeup_requests WHERE status = 'pending'")
          .get() as { n: number }
      ).n;

      const summary: DashboardSummary = {
        workspaceCount,
        agentCount,
        tasksTotal: taskStats.total ?? 0,
        tasksInProgress: taskStats.in_progress ?? 0,
        tasksDone: taskStats.done ?? 0,
        goalsActive: goalStats.active ?? 0,
        goalsAchieved: goalStats.achieved ?? 0,
        pendingApprovals,
        activeBudgetIncidents,
        totalSpendMicrocents,
        pendingWakeups,
      };

      respond(true, summary, undefined);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, msg));
    }
  },
};
