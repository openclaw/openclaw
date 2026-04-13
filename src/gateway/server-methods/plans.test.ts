import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPlanRecord, resetPlanRegistryForTests } from "../../plans/plan-registry.js";
import { ErrorCodes } from "../protocol/index.js";
import { plansHandlers } from "./plans.js";

type RespondCall = [boolean, unknown?, { code: number; message: string }?];

function createInvokeParams(method: keyof typeof plansHandlers, params: Record<string, unknown>) {
  const respond = vi.fn();
  return {
    respond,
    invoke: async () =>
      await plansHandlers[method]({
        params,
        respond: respond as never,
        context: {} as never,
        client: null,
        req: { type: "req", id: "req-1", method },
        isWebchatConnect: () => false,
      }),
  };
}

describe("plans gateway handlers", () => {
  beforeEach(() => {
    resetPlanRegistryForTests();
    createPlanRecord({
      ownerKey: "agent:main:main",
      scopeKind: "session",
      sessionKey: "session-1",
      title: "Week 1 orchestration metadata",
      summary: "Add inspect-only plan surfaces.",
      content: "- tools.catalog metadata\n- plans inspect",
      status: "ready_for_review",
      linkedFlowIds: ["flow-1"],
      createdAt: 100,
      updatedAt: 200,
    });
    createPlanRecord({
      ownerKey: "agent:work:main",
      scopeKind: "agent",
      title: "Deferred lifecycle work",
      content: "- status transitions later",
      status: "draft",
      createdAt: 300,
      updatedAt: 300,
    });
  });

  it("rejects invalid plans.list params", async () => {
    const { respond, invoke } = createInvokeParams("plans.list", { extra: true });
    await invoke();
    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(false);
    expect(call?.[2]?.code).toBe(ErrorCodes.INVALID_REQUEST);
    expect(call?.[2]?.message).toContain("invalid plans.list params");
  });

  it("lists plans with filters and summary", async () => {
    const { respond, invoke } = createInvokeParams("plans.list", {
      ownerKey: "agent:main:main",
      status: "ready_for_review",
    });
    await invoke();

    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(true);
    const payload = call?.[1] as
      | {
          count: number;
          summary: { total: number; byStatus: Record<string, number> };
          plans: Array<{ title: string; ownerKey: string; status: string }>;
        }
      | undefined;
    expect(payload?.count).toBe(1);
    expect(payload?.summary.total).toBe(1);
    expect(payload?.summary.byStatus.ready_for_review).toBe(1);
    expect(payload?.plans[0]).toMatchObject({
      title: "Week 1 orchestration metadata",
      ownerKey: "agent:main:main",
      status: "ready_for_review",
    });
  });

  it("rejects invalid plans.get params", async () => {
    const { respond, invoke } = createInvokeParams("plans.get", {});
    await invoke();
    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(false);
    expect(call?.[2]?.code).toBe(ErrorCodes.INVALID_REQUEST);
    expect(call?.[2]?.message).toContain("invalid plans.get params");
  });

  it("returns one plan by id", async () => {
    const list = createInvokeParams("plans.list", {});
    await list.invoke();
    const listCall = list.respond.mock.calls[0] as RespondCall | undefined;
    const firstPlanId = ((listCall?.[1] as { plans?: Array<{ planId: string }> } | undefined)
      ?.plans ?? [])[0]?.planId;

    const { respond, invoke } = createInvokeParams("plans.get", { planId: firstPlanId });
    await invoke();

    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(true);
    const payload = call?.[1] as { plan: { planId: string; title: string; status: string } };
    expect(payload.plan).toMatchObject({
      planId: firstPlanId,
      title: "Deferred lifecycle work",
      status: "draft",
    });
  });

  it("updates one plan status when the transition is valid", async () => {
    const list = createInvokeParams("plans.list", {});
    await list.invoke();
    const listCall = list.respond.mock.calls[0] as RespondCall | undefined;
    const draftPlanId = (
      (listCall?.[1] as { plans?: Array<{ planId: string; status: string }> } | undefined)?.plans ??
      []
    ).find((plan) => plan.status === "draft")?.planId;

    const { respond, invoke } = createInvokeParams("plans.updateStatus", {
      planId: draftPlanId,
      status: "ready_for_review",
    });
    await invoke();

    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(true);
    const payload = call?.[1] as { previousStatus: string; plan: { status: string } };
    expect(payload.previousStatus).toBe("draft");
    expect(payload.plan.status).toBe("ready_for_review");
  });

  it("rejects invalid plan status transitions", async () => {
    const list = createInvokeParams("plans.list", {});
    await list.invoke();
    const listCall = list.respond.mock.calls[0] as RespondCall | undefined;
    const draftPlanId = (
      (listCall?.[1] as { plans?: Array<{ planId: string; status: string }> } | undefined)?.plans ??
      []
    ).find((plan) => plan.status === "draft")?.planId;

    const { respond, invoke } = createInvokeParams("plans.updateStatus", {
      planId: draftPlanId,
      status: "approved",
    });
    await invoke();

    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(false);
    expect(call?.[2]?.code).toBe(ErrorCodes.INVALID_REQUEST);
    expect(call?.[2]?.message).toContain("invalid plan status transition draft -> approved");
  });

  it("rejects unknown plan ids", async () => {
    const { respond, invoke } = createInvokeParams("plans.get", { planId: "plan_missing" });
    await invoke();
    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(false);
    expect(call?.[2]?.code).toBe(ErrorCodes.INVALID_REQUEST);
    expect(call?.[2]?.message).toContain('unknown plan id "plan_missing"');
  });
});
