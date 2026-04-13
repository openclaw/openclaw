import {
  getPlanById,
  listPlanRecords,
  listPlansForOwnerKey,
  updatePlanStatus,
} from "../../plans/plan-registry.js";
import { summarizePlanRecords } from "../../plans/plan-registry.summary.js";
import { isPlanStatusTransitionError } from "../../plans/plan-registry.types.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  type PlansGetResult,
  type PlansListResult,
  validatePlansGetParams,
  validatePlansListParams,
  validatePlansUpdateStatusParams,
} from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

function buildPlansListResult(params: {
  ownerKey?: string;
  scopeKind?: "session" | "agent" | "system";
  status?: "draft" | "ready_for_review" | "approved" | "rejected" | "archived";
}): PlansListResult {
  const ownerKey = normalizeOptionalString(params.ownerKey);
  const scopeKind = params.scopeKind;
  const status = params.status;
  const basePlans = ownerKey ? listPlansForOwnerKey(ownerKey) : listPlanRecords();
  const plans = basePlans.filter((plan) => {
    if (scopeKind && plan.scopeKind !== scopeKind) {
      return false;
    }
    if (status && plan.status !== status) {
      return false;
    }
    return true;
  });
  return {
    count: plans.length,
    summary: summarizePlanRecords(plans),
    plans,
  };
}

function buildPlansGetResult(planId: string): PlansGetResult | null {
  const plan = getPlanById(planId);
  if (!plan) {
    return null;
  }
  return { plan };
}

export const plansHandlers: GatewayRequestHandlers = {
  "plans.list": ({ params, respond }) => {
    if (!validatePlansListParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid plans.list params: ${formatValidationErrors(validatePlansListParams.errors)}`,
        ),
      );
      return;
    }
    respond(
      true,
      buildPlansListResult({
        ownerKey: params.ownerKey,
        scopeKind: params.scopeKind,
        status: params.status,
      }),
      undefined,
    );
  },
  "plans.get": ({ params, respond }) => {
    if (!validatePlansGetParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid plans.get params: ${formatValidationErrors(validatePlansGetParams.errors)}`,
        ),
      );
      return;
    }
    const result = buildPlansGetResult(params.planId);
    if (!result) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `unknown plan id "${params.planId}"`),
      );
      return;
    }
    respond(true, result, undefined);
  },
  "plans.updateStatus": ({ params, respond }) => {
    if (!validatePlansUpdateStatusParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid plans.updateStatus params: ${formatValidationErrors(validatePlansUpdateStatusParams.errors)}`,
        ),
      );
      return;
    }
    try {
      const result = updatePlanStatus({
        planId: params.planId,
        status: params.status,
      });
      respond(true, result, undefined);
    } catch (error) {
      if (isPlanStatusTransitionError(error)) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, error.message));
        return;
      }
      throw error;
    }
  },
};
