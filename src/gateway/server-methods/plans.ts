import { loadConfig } from "../../config/config.js";
import { updateSessionStore } from "../../config/sessions.js";
import {
  getPlanById,
  listPlanRecords,
  listPlansForOwnerKey,
  updatePlanStatus,
} from "../../plans/plan-registry.js";
import { summarizePlanRecords } from "../../plans/plan-registry.summary.js";
import type { PlanRecordStatus } from "../../plans/plan-registry.types.js";
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
import {
  migrateAndPruneGatewaySessionStoreKey,
  resolveGatewaySessionStoreTarget,
} from "../session-utils.js";
import { applySessionsPatchToStore } from "../sessions-patch.js";
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

function toSessionPlanArtifactPatch(plan: {
  status: PlanRecordStatus;
  updatedAt: number;
  approvedAt?: number;
}) {
  const patch: {
    updatedAt: number;
    approvedAt?: number;
    status?: "active" | "completed" | "cancelled";
  } = {
    updatedAt: plan.updatedAt,
  };
  if (plan.status === "approved") {
    patch.status = "completed";
  } else if (plan.status === "rejected" || plan.status === "archived") {
    patch.status = "cancelled";
  }
  if (typeof plan.approvedAt === "number") {
    patch.approvedAt = plan.approvedAt;
  }
  return patch;
}

async function persistSessionPlanStatus(plan: {
  scopeKind: "session" | "agent" | "system";
  sessionKey?: string;
  status: PlanRecordStatus;
  updatedAt: number;
  approvedAt?: number;
}) {
  if (plan.scopeKind !== "session") {
    return;
  }
  const sessionKey = normalizeOptionalString(plan.sessionKey);
  if (!sessionKey) {
    return;
  }
  const cfg = loadConfig();
  const target = resolveGatewaySessionStoreTarget({ cfg, key: sessionKey });
  await updateSessionStore(target.storePath, async (store) => {
    const { primaryKey } = migrateAndPruneGatewaySessionStoreKey({ cfg, key: sessionKey, store });
    const applied = await applySessionsPatchToStore({
      cfg,
      store,
      storeKey: primaryKey,
      patch: {
        key: sessionKey,
        planArtifact: toSessionPlanArtifactPatch(plan),
      },
    });
    if (!applied.ok) {
      throw new Error(applied.error.message);
    }
    return applied;
  });
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
  "plans.updateStatus": async ({ params, respond }) => {
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
      await persistSessionPlanStatus(result.plan);
      respond(true, result, undefined);
    } catch (error) {
      if (isPlanStatusTransitionError(error)) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, error.message));
        return;
      }
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
  },
};
