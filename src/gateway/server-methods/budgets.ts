import {
  createBudgetPolicy,
  getBudgetPolicy,
  listBudgetPolicies,
  updateBudgetPolicy,
  deleteBudgetPolicy,
  listBudgetIncidents,
  resolveBudgetIncident,
} from "../../orchestration/budget-store-sqlite.js";
import { listCostEvents } from "../../orchestration/cost-event-store-sqlite.js";
import type {
  BudgetScopeType,
  BudgetWindowKind,
  BudgetIncidentType,
} from "../../orchestration/types.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type {
  BudgetPoliciesListParams,
  BudgetPoliciesGetParams,
  BudgetPoliciesCreateParams,
  BudgetPoliciesUpdateParams,
  BudgetPoliciesDeleteParams,
  BudgetIncidentsListParams,
  BudgetIncidentsResolveParams,
  CostEventsListParams,
} from "../protocol/schema/types.js";
import type { GatewayRequestHandlers } from "./types.js";

function storeErrorToShape(err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  return errorShape(ErrorCodes.UNAVAILABLE, msg);
}

export const budgetsHandlers: GatewayRequestHandlers = {
  "budgets.policies.list": async ({ params, respond }) => {
    try {
      const p = params as unknown as BudgetPoliciesListParams;
      const policies = listBudgetPolicies({
        workspaceId: p.workspaceId,
        scopeType: p.scopeType as BudgetScopeType | undefined,
        scopeId: p.scopeId,
      });
      respond(true, { policies });
    } catch (err) {
      respond(false, undefined, storeErrorToShape(err));
    }
  },

  "budgets.policies.get": async ({ params, respond }) => {
    try {
      const p = params as unknown as BudgetPoliciesGetParams;
      const policy = getBudgetPolicy(p.id);
      if (!policy) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, `Budget policy not found: ${p.id}`),
        );
        return;
      }
      respond(true, policy);
    } catch (err) {
      respond(false, undefined, storeErrorToShape(err));
    }
  },

  "budgets.policies.create": async ({ params, respond }) => {
    try {
      const p = params as unknown as BudgetPoliciesCreateParams;
      const policy = createBudgetPolicy({
        workspaceId: p.workspaceId,
        scopeType: p.scopeType as BudgetScopeType,
        scopeId: p.scopeId,
        amountMicrocents: p.amountMicrocents,
        windowKind: (p.windowKind as BudgetWindowKind) || "calendar_month_utc",
        warnPercent: p.warnPercent,
        hardStop: p.hardStop,
      });
      respond(true, policy);
    } catch (err) {
      respond(false, undefined, storeErrorToShape(err));
    }
  },

  "budgets.policies.update": async ({ params, respond }) => {
    try {
      const p = params as unknown as BudgetPoliciesUpdateParams;
      const policy = updateBudgetPolicy(p.id, {
        amountMicrocents: p.amountMicrocents,
        warnPercent: p.warnPercent,
        hardStop: p.hardStop,
      });
      respond(true, policy);
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes("not found")) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, err.message));
        return;
      }
      respond(false, undefined, storeErrorToShape(err));
    }
  },

  "budgets.policies.delete": async ({ params, respond }) => {
    try {
      const p = params as unknown as BudgetPoliciesDeleteParams;
      deleteBudgetPolicy(p.id);
      respond(true, { ok: true });
    } catch (err) {
      respond(false, undefined, storeErrorToShape(err));
    }
  },

  "budgets.incidents.list": async ({ params, respond }) => {
    try {
      const p = params as unknown as BudgetIncidentsListParams;
      const incidents = listBudgetIncidents({
        workspaceId: p.workspaceId,
        policyId: p.policyId,
        agentId: p.agentId,
        type: p.type as BudgetIncidentType | undefined,
      });
      respond(true, { incidents });
    } catch (err) {
      respond(false, undefined, storeErrorToShape(err));
    }
  },

  "budgets.incidents.resolve": async ({ params, respond }) => {
    try {
      const p = params as unknown as BudgetIncidentsResolveParams;
      const incident = resolveBudgetIncident(p.id);
      respond(true, incident);
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes("not found")) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, err.message));
        return;
      }
      respond(false, undefined, storeErrorToShape(err));
    }
  },

  "costs.events.list": async ({ params, respond }) => {
    try {
      const p = params as unknown as CostEventsListParams;
      const events = listCostEvents({
        workspaceId: p.workspaceId,
        agentId: p.agentId,
        projectId: p.projectId,
        taskId: p.taskId,
        sinceUtc: p.sinceUtc,
        untilUtc: p.untilUtc,
      });
      respond(true, { events });
    } catch (err) {
      respond(false, undefined, storeErrorToShape(err));
    }
  },
};
