import {
  listBudgetPolicies,
  listBudgetIncidents,
  createBudgetIncident,
} from "./budget-store-sqlite.js";
import { getAggregateCost } from "./cost-event-store-sqlite.js";
import type { BudgetPolicy, BudgetIncident } from "./types.js";
import { listWorkspaces } from "./workspace-store-sqlite.js";

type BroadcastFn = (event: string, payload: unknown) => void;

/**
 * Reconciles costs against budget policies and emits incidents if thresholds are breached.
 * Intended to run periodically via a cron job or hook.
 */
export function reconcileBudgets(broadcast?: BroadcastFn) {
  const workspaces = listWorkspaces();
  const now = new Date();

  // Calculate start of current UTC month
  const startOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const sinceUtcMonth = Math.floor(startOfMonth.getTime() / 1000);

  for (const workspace of workspaces) {
    const policies = listBudgetPolicies({ workspaceId: workspace.id });
    const activeIncidents = listBudgetIncidents({ workspaceId: workspace.id }).filter(
      (inc) => inc.type !== "resolved",
    );

    for (const policy of policies) {
      checkPolicy(policy, sinceUtcMonth, activeIncidents, broadcast);
    }
  }
}

function checkPolicy(
  policy: BudgetPolicy,
  sinceUtcMonth: number,
  activeIncidents: BudgetIncident[],
  broadcast?: BroadcastFn,
) {
  const sinceUtc = policy.windowKind === "calendar_month_utc" ? sinceUtcMonth : undefined;

  let spentMicrocents = 0;
  let agentId: string | undefined;

  if (policy.scopeType === "workspace") {
    spentMicrocents = getAggregateCost({
      workspaceId: policy.workspaceId,
      sinceUtc,
    }).totalMicrocents;
  } else if (policy.scopeType === "agent") {
    agentId = policy.scopeId;
    spentMicrocents = getAggregateCost({
      workspaceId: policy.workspaceId,
      agentId,
      sinceUtc,
    }).totalMicrocents;
  } else if (policy.scopeType === "project") {
    spentMicrocents = getAggregateCost({
      workspaceId: policy.workspaceId,
      projectId: policy.scopeId,
      sinceUtc,
    }).totalMicrocents;
  }

  const limit = policy.amountMicrocents;
  let newIncidentType: "warning" | "hard_stop" | null = null;
  let message = "";

  if (policy.hardStop > 0 && spentMicrocents >= limit * (policy.hardStop / 100)) {
    newIncidentType = "hard_stop";
    message = `Budget hard stop breached for ${policy.scopeType} ${policy.scopeId}`;
  } else if (policy.warnPercent > 0 && spentMicrocents >= limit * (policy.warnPercent / 100)) {
    newIncidentType = "warning";
    message = `Budget warning threshold breached for ${policy.scopeType} ${policy.scopeId}`;
  }

  if (newIncidentType) {
    // Check if we already have an active incident of the same or higher severity for this policy
    const existing = activeIncidents.find((inc) => inc.policyId === policy.id);
    if (!existing || (existing.type === "warning" && newIncidentType === "hard_stop")) {
      createBudgetIncident({
        workspaceId: policy.workspaceId,
        policyId: policy.id,
        type: newIncidentType,
        agentId,
        spentMicrocents,
        limitMicrocents: limit,
        message,
      });
      // Emit gateway event so connected clients can react in real time
      const eventName = newIncidentType === "hard_stop" ? "budget.exceeded" : "budget.warning";
      broadcast?.(eventName, {
        workspaceId: policy.workspaceId,
        policyId: policy.id,
        scopeType: policy.scopeType,
        scopeId: policy.scopeId,
        agentId,
        spentMicrocents,
        limitMicrocents: limit,
        message,
      });
    }
  }
}
