import type { GatewayBrowserClient } from "../gateway.ts";
import type { WorkflowPlan, WorkflowViewMode } from "../views/workflow.ts";

export type WorkflowState = {
  workflowLoading: boolean;
  workflowError: string | null;
  workflowActivePlans: WorkflowPlan[];
  workflowHistoryPlans: WorkflowPlan[];
  workflowHistoryTotal: number;
  workflowHistoryOffset: number;
  workflowHistoryLimit: number;
  workflowSelectedPlanId: string | null;
  workflowSelectedPlan: WorkflowPlan | null;
  workflowScope: "active" | "history" | "all";
  workflowViewMode: WorkflowViewMode;
  client: GatewayBrowserClient | null;
};

export async function loadWorkflow(state: WorkflowState): Promise<void> {
  if (!state.client) {
    return;
  }
  state.workflowLoading = true;
  state.workflowError = null;
  try {
    const result = await state.client.request("workflow.list", {
      scope: state.workflowScope,
      limit: state.workflowHistoryLimit,
      offset: 0,
    });
    const data = result as {
      activePlans?: WorkflowPlan[];
      historyPlans?: WorkflowPlan[];
      historyTotal?: number;
    };
    if (state.workflowScope === "active") {
      state.workflowActivePlans = data.activePlans ?? [];
      state.workflowHistoryPlans = [];
      state.workflowHistoryTotal = 0;
    } else if (state.workflowScope === "history") {
      state.workflowActivePlans = [];
      state.workflowHistoryPlans = data.historyPlans ?? [];
      state.workflowHistoryTotal = data.historyTotal ?? state.workflowHistoryPlans.length;
    } else {
      state.workflowActivePlans = data.activePlans ?? [];
      state.workflowHistoryPlans = data.historyPlans ?? [];
      state.workflowHistoryTotal = data.historyTotal ?? state.workflowHistoryPlans.length;
    }
    state.workflowHistoryOffset = state.workflowHistoryPlans.length;
  } catch (err) {
    state.workflowError = err instanceof Error ? err.message : String(err);
  } finally {
    state.workflowLoading = false;
  }
}

export async function loadMoreWorkflowHistory(state: WorkflowState): Promise<void> {
  if (!state.client) {
    return;
  }
  if (state.workflowHistoryOffset >= state.workflowHistoryTotal) {
    return;
  }
  state.workflowLoading = true;
  try {
    const result = await state.client.request("workflow.list", {
      scope: "history",
      limit: state.workflowHistoryLimit,
      offset: state.workflowHistoryOffset,
    });
    const data = result as { historyPlans?: WorkflowPlan[]; historyTotal?: number };
    const newPlans = data.historyPlans ?? [];
    state.workflowHistoryPlans = [...state.workflowHistoryPlans, ...newPlans];
    state.workflowHistoryTotal = data.historyTotal ?? state.workflowHistoryTotal;
    state.workflowHistoryOffset = state.workflowHistoryPlans.length;
  } catch (err) {
    state.workflowError = err instanceof Error ? err.message : String(err);
  } finally {
    state.workflowLoading = false;
  }
}

export async function loadWorkflowPlan(
  state: WorkflowState,
  planId: string,
  scope: "active" | "history",
): Promise<void> {
  if (!state.client) {
    return;
  }
  state.workflowSelectedPlanId = planId;
  state.workflowSelectedPlan = null;
  try {
    const result = await state.client.request("workflow.get", { planId, scope });
    const data = result as { plan?: WorkflowPlan };
    state.workflowSelectedPlan = data.plan ?? null;
  } catch (err) {
    state.workflowError = err instanceof Error ? err.message : String(err);
    state.workflowSelectedPlanId = null;
  }
}

export function getWorkflowInitialState(): Omit<WorkflowState, "client"> {
  return {
    workflowLoading: false,
    workflowError: null,
    workflowActivePlans: [],
    workflowHistoryPlans: [],
    workflowHistoryTotal: 0,
    workflowHistoryOffset: 0,
    workflowHistoryLimit: 20,
    workflowSelectedPlanId: null,
    workflowSelectedPlan: null,
    workflowScope: "active",
    workflowViewMode: "list",
  };
}
