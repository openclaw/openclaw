/**
 * Metrics RPC handlers — agent performance and department budget summaries.
 */
import {
  getAgentMetrics,
  listAgentMetricsForWorkspace,
  listDepartmentBudgetSummary,
} from "../../orchestration/agent-metrics-sqlite.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

function storeErrorToShape(err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  return errorShape(ErrorCodes.UNAVAILABLE, msg);
}

export const metricsHandlers: GatewayRequestHandlers = {
  /** Get performance metrics for a single agent within a workspace. */
  "agents.metrics.get": ({ params, respond }) => {
    const p = params;
    const workspaceId = typeof p.workspaceId === "string" ? p.workspaceId.trim() : "";
    const agentId = typeof p.agentId === "string" ? p.agentId.trim() : "";
    if (!workspaceId || !agentId) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "workspaceId and agentId are required"),
      );
      return;
    }
    try {
      const metrics = getAgentMetrics(workspaceId, agentId);
      respond(true, metrics, undefined);
    } catch (err) {
      respond(false, undefined, storeErrorToShape(err));
    }
  },

  /** List performance metrics for all agents in a workspace. */
  "agents.metrics.list": ({ params, respond }) => {
    const p = params;
    const workspaceId = typeof p.workspaceId === "string" ? p.workspaceId.trim() : "";
    if (!workspaceId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "workspaceId is required"));
      return;
    }
    try {
      const metrics = listAgentMetricsForWorkspace(workspaceId);
      respond(true, { metrics }, undefined);
    } catch (err) {
      respond(false, undefined, storeErrorToShape(err));
    }
  },

  /** Get department budget summaries (cost aggregated by department) for a workspace. */
  "budgets.department.summary": ({ params, respond }) => {
    const p = params;
    const workspaceId = typeof p.workspaceId === "string" ? p.workspaceId.trim() : "";
    if (!workspaceId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "workspaceId is required"));
      return;
    }
    try {
      const departments = listDepartmentBudgetSummary(workspaceId);
      respond(true, { departments }, undefined);
    } catch (err) {
      respond(false, undefined, storeErrorToShape(err));
    }
  },
};
