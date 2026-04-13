import { describe, expect, it, vi } from "vitest";
import { GatewayRequestError } from "../gateway.ts";
import type { PlanRecord } from "../types.ts";
import {
  buildPlansOverviewTeaserProps,
  buildPlansTeaserResult,
  buildPlansViewProps,
  listAvailablePlanStatusActions,
  loadPlans,
  loadSelectedPlan,
  refreshPlansOverview,
  resetPlanStatusMutationState,
  selectPlan,
  setPlansStatusFilter,
  updateSelectedPlanStatus,
  type PlansState,
} from "./plans.ts";

type RequestFn = (method: string, params?: unknown) => Promise<unknown>;

function createPlan(overrides: Partial<PlanRecord> = {}): PlanRecord {
  return {
    planId: "plan-1",
    ownerKey: "agent:main:main",
    scopeKind: "session",
    title: "Week 1 orchestration metadata",
    content: "- tools.catalog",
    format: "markdown",
    status: "draft",
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

function createState(request: RequestFn, overrides: Partial<PlansState> = {}): PlansState {
  return {
    client: { request } as unknown as PlansState["client"],
    connected: true,
    plansLoading: false,
    plansError: null,
    plansResult: null,
    plansSelectedId: null,
    plansStatusFilter: "all",
    planDetailLoading: false,
    planDetailError: null,
    planDetail: null,
    planStatusUpdating: false,
    planStatusError: null,
    ...overrides,
  };
}

describe("loadPlans", () => {
  it("loads plans and auto-selects the first plan", async () => {
    const request = vi.fn(async () => ({
      count: 2,
      summary: {
        total: 2,
        reviewable: 1,
        terminal: 0,
        byStatus: {
          draft: 1,
          ready_for_review: 1,
          approved: 0,
          rejected: 0,
          archived: 0,
        },
      },
      plans: [createPlan(), createPlan({ planId: "plan-2", status: "ready_for_review" })],
    }));
    const state = createState(request);

    await loadPlans(state);

    expect(request).toHaveBeenCalledWith("plans.list", {});
    expect(state.plansSelectedId).toBe("plan-1");
    expect(state.plansLoading).toBe(false);
    expect(state.plansError).toBeNull();
  });

  it("forwards status filter to plans.list", async () => {
    const request = vi.fn(async () => ({ count: 0, summary: null, plans: [] }));
    const state = createState(request, { plansStatusFilter: "approved" });

    await loadPlans(state);

    expect(request).toHaveBeenCalledWith("plans.list", { status: "approved" });
  });

  it("formats missing operator.read errors", async () => {
    const request = vi.fn(async () => {
      throw new GatewayRequestError({
        code: "AUTH_UNAUTHORIZED",
        message: "missing scope: operator.read",
        details: { code: "AUTH_UNAUTHORIZED" },
      });
    });
    const state = createState(request);

    await loadPlans(state);

    expect(state.plansResult).toBeNull();
    expect(state.plansError).toBe(
      "This connection is missing operator.read, so plans cannot be loaded yet.",
    );
  });
});

describe("loadSelectedPlan", () => {
  it("loads detail for the selected plan", async () => {
    const request = vi.fn(async () => ({
      plan: createPlan({ summary: "Inspect-only plan surface" }),
    }));
    const state = createState(request, { plansSelectedId: "plan-1" });

    await loadSelectedPlan(state);

    expect(request).toHaveBeenCalledWith("plans.get", { planId: "plan-1" });
    expect(state.planDetail).toEqual(expect.objectContaining({ planId: "plan-1" }));
    expect(state.planDetailLoading).toBe(false);
  });

  it("formats missing operator.read errors for details", async () => {
    const request = vi.fn(async () => {
      throw new GatewayRequestError({
        code: "AUTH_UNAUTHORIZED",
        message: "missing scope: operator.read",
        details: { code: "AUTH_UNAUTHORIZED" },
      });
    });
    const state = createState(request, { plansSelectedId: "plan-1" });

    await loadSelectedPlan(state);

    expect(state.planDetail).toBeNull();
    expect(state.planDetailError).toBe(
      "This connection is missing operator.read, so plan details cannot be loaded yet.",
    );
  });
});

describe("updateSelectedPlanStatus", () => {
  it("updates selected plan status and refreshes list/detail", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "plans.updateStatus") {
        return {
          previousStatus: "draft",
          plan: createPlan({ status: "ready_for_review", updatedAt: 10 }),
        };
      }
      if (method === "plans.list") {
        return {
          count: 1,
          summary: {
            total: 1,
            reviewable: 1,
            terminal: 0,
            byStatus: {
              draft: 0,
              ready_for_review: 1,
              approved: 0,
              rejected: 0,
              archived: 0,
            },
          },
          plans: [createPlan({ status: "ready_for_review", updatedAt: 10 })],
        };
      }
      if (method === "plans.get") {
        return { plan: createPlan({ status: "ready_for_review", updatedAt: 10 }) };
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const state = createState(request, {
      plansSelectedId: "plan-1",
      plansResult: {
        count: 1,
        summary: {
          total: 1,
          reviewable: 1,
          terminal: 0,
          byStatus: {
            draft: 1,
            ready_for_review: 0,
            approved: 0,
            rejected: 0,
            archived: 0,
          },
        },
        plans: [createPlan()],
      },
      planDetail: createPlan(),
    });

    await updateSelectedPlanStatus(state, "ready_for_review");

    expect(request).toHaveBeenNthCalledWith(1, "plans.updateStatus", {
      planId: "plan-1",
      status: "ready_for_review",
    });
    expect(state.planDetail).toEqual(expect.objectContaining({ status: "ready_for_review" }));
    expect(state.planStatusUpdating).toBe(false);
    expect(state.planStatusError).toBeNull();
  });

  it("formats missing operator.write errors", async () => {
    const request = vi.fn(async () => {
      throw new Error("missing scope: operator.write");
    });
    const state = createState(request, {
      plansSelectedId: "plan-1",
      planDetail: createPlan(),
    });

    await updateSelectedPlanStatus(state, "ready_for_review");

    expect(state.planStatusError).toBe(
      "This connection is missing operator.write, so plan status cannot be changed yet.",
    );
    expect(state.planStatusUpdating).toBe(false);
  });
});

describe("plans helpers", () => {
  it("returns allowed lifecycle actions from the registry", () => {
    expect(listAvailablePlanStatusActions(createPlan({ status: "ready_for_review" }))).toEqual([
      "approved",
      "rejected",
    ]);
  });

  it("resets selection side effects for filter changes", () => {
    const state = createState(async () => undefined, {
      plansSelectedId: "plan-1",
      planDetail: createPlan(),
      planDetailError: "boom",
      planStatusError: "bad",
    });

    setPlansStatusFilter(state, "approved");

    expect(state.plansStatusFilter).toBe("approved");
    expect(state.plansSelectedId).toBeNull();
    expect(state.planDetail).toBeNull();
    expect(state.planDetailError).toBeNull();
    expect(state.planStatusError).toBeNull();
  });

  it("selects a plan and clears mutation errors", () => {
    const state = createState(async () => undefined, {
      planStatusError: "bad",
    });

    selectPlan(state, "plan-2");

    expect(state.plansSelectedId).toBe("plan-2");
    expect(state.planStatusError).toBeNull();
  });

  it("builds teaser results with a limit", () => {
    const teaser = buildPlansTeaserResult(
      {
        count: 4,
        summary: {
          total: 4,
          reviewable: 0,
          terminal: 0,
          byStatus: {
            draft: 4,
            ready_for_review: 0,
            approved: 0,
            rejected: 0,
            archived: 0,
          },
        },
        plans: [
          createPlan(),
          createPlan({ planId: "plan-2" }),
          createPlan({ planId: "plan-3" }),
          createPlan({ planId: "plan-4" }),
        ],
      },
      2,
    );

    expect(teaser?.plans).toHaveLength(2);
    expect(teaser?.plans?.map((plan) => plan.planId)).toEqual(["plan-1", "plan-2"]);
  });

  it("builds plans view props and teaser props", () => {
    const state = createState(async () => undefined, {
      plansResult: {
        count: 4,
        summary: {
          total: 4,
          reviewable: 0,
          terminal: 0,
          byStatus: {
            draft: 4,
            ready_for_review: 0,
            approved: 0,
            rejected: 0,
            archived: 0,
          },
        },
        plans: [
          createPlan(),
          createPlan({ planId: "plan-2" }),
          createPlan({ planId: "plan-3" }),
          createPlan({ planId: "plan-4" }),
        ],
      },
      plansSelectedId: "plan-1",
      plansStatusFilter: "draft",
      planDetail: createPlan(),
      planStatusError: "bad",
    });
    const handlers = {
      onRefresh: vi.fn(),
      onSelectPlan: vi.fn(),
      onStatusFilterChange: vi.fn(),
      onStatusAction: vi.fn(),
    };

    const full = buildPlansViewProps(state, handlers);
    const teaser = buildPlansOverviewTeaserProps(state, handlers);

    expect(full.result?.plans).toHaveLength(4);
    expect(teaser.result?.plans).toHaveLength(3);
    expect(full.statusError).toBe("bad");
    expect(teaser.statusFilter).toBe("draft");
  });

  it("refreshes list then detail together", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "plans.list") {
        return {
          count: 1,
          summary: {
            total: 1,
            reviewable: 0,
            terminal: 0,
            byStatus: {
              draft: 1,
              ready_for_review: 0,
              approved: 0,
              rejected: 0,
              archived: 0,
            },
          },
          plans: [createPlan({ planId: "plan-1" })],
        };
      }
      if (method === "plans.get") {
        return { plan: createPlan({ planId: "plan-1", summary: "detail" }) };
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const state = createState(request, { plansSelectedId: "plan-1" });

    await refreshPlansOverview(state);

    expect(request).toHaveBeenNthCalledWith(1, "plans.list", {});
    expect(request).toHaveBeenNthCalledWith(2, "plans.get", { planId: "plan-1" });
    expect(state.planDetail).toEqual(expect.objectContaining({ planId: "plan-1" }));
  });

  it("resetPlanStatusMutationState clears status mutation errors", () => {
    const state = createState(async () => undefined, { planStatusError: "bad" });

    resetPlanStatusMutationState(state);

    expect(state.planStatusError).toBeNull();
  });
});
