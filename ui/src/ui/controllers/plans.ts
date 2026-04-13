import { listAllowedPlanStatusTransitions } from "../../../../src/plans/plan-registry.types.js";
import type { GatewayBrowserClient } from "../gateway.ts";
import type {
  PlanRecord,
  PlansGetResult,
  PlansListResult,
  PlansUpdateStatusResult,
} from "../types.ts";
import {
  formatMissingOperatorReadScopeMessage,
  isMissingOperatorReadScopeError,
} from "./scope-errors.ts";

export type PlanStatusFilter = PlanRecord["status"] | "all";
export type PlanStatus = PlanRecord["status"];

export type PlansState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  plansLoading: boolean;
  plansError: string | null;
  plansResult: PlansListResult | null;
  plansSelectedId: string | null;
  plansStatusFilter: PlanStatusFilter;
  planDetailLoading: boolean;
  planDetailError: string | null;
  planDetail: PlanRecord | null;
  planStatusUpdating: boolean;
  planStatusError: string | null;
};

export function listAvailablePlanStatusActions(plan: PlanRecord | null): readonly PlanStatus[] {
  if (!plan) {
    return [];
  }
  return listAllowedPlanStatusTransitions(plan.status);
}

function isMissingOperatorWriteScopeError(err: unknown): boolean {
  return String(err).includes("missing scope: operator.write");
}

function formatMissingOperatorWriteScopeMessage(feature: string): string {
  return `This connection is missing operator.write, so ${feature} cannot be changed yet.`;
}

function applyUpdatedPlanToList(state: PlansState, nextPlan: PlanRecord) {
  if (!state.plansResult) {
    return;
  }
  const nextPlans = (state.plansResult.plans ?? []).map((plan) =>
    plan.planId === nextPlan.planId ? nextPlan : plan,
  );
  state.plansResult = {
    ...state.plansResult,
    plans: nextPlans,
  };
}

export async function updateSelectedPlanStatus(state: PlansState, status: PlanStatus) {
  const planId = state.planDetail?.planId ?? state.plansSelectedId;
  if (!state.client || !state.connected || !planId || state.planStatusUpdating) {
    return;
  }
  state.planStatusUpdating = true;
  state.planStatusError = null;
  try {
    const result = await state.client.request<PlansUpdateStatusResult>("plans.updateStatus", {
      planId,
      status,
    });
    state.planDetail = result.plan;
    state.plansSelectedId = result.plan.planId;
    applyUpdatedPlanToList(state, result.plan);
    await loadPlans(state);
    await loadSelectedPlan(state, result.plan.planId);
  } catch (err) {
    if (isMissingOperatorWriteScopeError(err)) {
      state.planStatusError = formatMissingOperatorWriteScopeMessage("plan status");
    } else {
      state.planStatusError = String(err);
    }
  } finally {
    state.planStatusUpdating = false;
  }
}

export function resetPlanStatusMutationState(state: PlansState) {
  state.planStatusError = null;
}

export function selectPlan(state: PlansState, planId: string) {
  state.plansSelectedId = planId;
  resetPlanStatusMutationState(state);
}

export function setPlansStatusFilter(state: PlansState, status: PlanStatusFilter) {
  state.plansStatusFilter = status;
  state.plansSelectedId = null;
  state.planDetail = null;
  state.planDetailError = null;
  resetPlanStatusMutationState(state);
}

export function buildPlansTeaserResult(
  result: PlansListResult | null,
  limit = 3,
): PlansListResult | null {
  if (!result) {
    return null;
  }
  return {
    ...result,
    plans: (result.plans ?? []).slice(0, limit),
  };
}

export type PlansViewProps = {
  loading: boolean;
  error: string | null;
  result: PlansListResult | null;
  selectedPlanId: string | null;
  statusFilter: PlanStatusFilter;
  detailLoading: boolean;
  detailError: string | null;
  detail: PlanRecord | null;
  statusUpdating: boolean;
  statusError: string | null;
  onRefresh: () => void;
  onSelectPlan: (planId: string) => void;
  onStatusFilterChange: (status: PlanStatusFilter) => void;
  onStatusAction: (status: PlanStatus) => void;
};

export function buildPlansViewProps(
  state: PlansState,
  handlers: {
    onRefresh: () => void;
    onSelectPlan: (planId: string) => void;
    onStatusFilterChange: (status: PlanStatusFilter) => void;
    onStatusAction: (status: PlanStatus) => void;
  },
): PlansViewProps {
  return {
    loading: state.plansLoading,
    error: state.plansError,
    result: state.plansResult,
    selectedPlanId: state.plansSelectedId,
    statusFilter: state.plansStatusFilter,
    detailLoading: state.planDetailLoading,
    detailError: state.planDetailError,
    detail: state.planDetail,
    statusUpdating: state.planStatusUpdating,
    statusError: state.planStatusError,
    ...handlers,
  };
}

export type PlansOverviewTeaserProps = PlansViewProps & {
  result: PlansListResult | null;
};

export function buildPlansOverviewTeaserProps(
  state: PlansState,
  handlers: {
    onRefresh: () => void;
    onSelectPlan: (planId: string) => void;
    onStatusFilterChange: (status: PlanStatusFilter) => void;
    onStatusAction: (status: PlanStatus) => void;
  },
): PlansOverviewTeaserProps {
  return {
    ...buildPlansViewProps(state, handlers),
    result: buildPlansTeaserResult(state.plansResult),
  };
}

export async function loadPlans(state: PlansState) {
  if (!state.client || !state.connected || state.plansLoading) {
    return;
  }
  state.plansLoading = true;
  state.plansError = null;
  try {
    const params = state.plansStatusFilter === "all" ? {} : { status: state.plansStatusFilter };
    const result = await state.client.request<PlansListResult>("plans.list", params);
    state.plansResult = result;
    const availablePlans = result.plans ?? [];
    const selectedId = state.plansSelectedId;
    if (!selectedId || !availablePlans.some((plan) => plan.planId === selectedId)) {
      state.plansSelectedId = availablePlans[0]?.planId ?? null;
    }
  } catch (err) {
    if (isMissingOperatorReadScopeError(err)) {
      state.plansResult = null;
      state.plansError = formatMissingOperatorReadScopeMessage("plans");
    } else {
      state.plansError = String(err);
    }
    state.planStatusError = null;
  } finally {
    state.plansLoading = false;
  }
}

export async function loadSelectedPlan(state: PlansState, planId?: string | null) {
  const resolvedPlanId = planId?.trim() ?? state.plansSelectedId?.trim() ?? "";
  if (!state.client || !state.connected || !resolvedPlanId) {
    state.planDetail = null;
    state.planDetailError = null;
    state.planDetailLoading = false;
    return;
  }
  state.plansSelectedId = resolvedPlanId;
  state.planDetailLoading = true;
  state.planDetailError = null;
  try {
    const result = await state.client.request<PlansGetResult>("plans.get", {
      planId: resolvedPlanId,
    });
    if (state.plansSelectedId !== resolvedPlanId) {
      return;
    }
    state.planDetail = result.plan;
  } catch (err) {
    if (state.plansSelectedId !== resolvedPlanId) {
      return;
    }
    state.planDetail = null;
    if (isMissingOperatorReadScopeError(err)) {
      state.planDetailError = formatMissingOperatorReadScopeMessage("plan details");
    } else {
      state.planDetailError = String(err);
    }
  } finally {
    if (state.plansSelectedId === resolvedPlanId) {
      state.planDetailLoading = false;
    }
  }
}

export async function refreshPlansOverview(state: PlansState) {
  await loadPlans(state);
  const selectedPlanId = state.plansSelectedId;
  if (selectedPlanId) {
    await loadSelectedPlan(state, selectedPlanId);
    return;
  }
  state.planDetail = null;
  state.planDetailError = null;
  state.planDetailLoading = false;
}
