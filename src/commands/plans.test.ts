import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPlanRecord, resetPlanRegistryForTests } from "../plans/plan-registry.js";
import type { RuntimeEnv } from "../runtime.js";
import { plansListCommand, plansSetStatusCommand, plansShowCommand } from "./plans.js";

function createRuntime(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  } as unknown as RuntimeEnv;
}

describe("plans commands", () => {
  beforeEach(() => {
    resetPlanRegistryForTests();
  });

  afterEach(() => {
    resetPlanRegistryForTests();
  });

  it("lists plans as JSON with additive metadata", async () => {
    createPlanRecord({
      ownerKey: "agent:main:main",
      scopeKind: "session",
      title: "Week 1 orchestration metadata",
      summary: "Add inspect-only plan primitives.",
      content: "- extend tool descriptors",
      status: "ready_for_review",
      sessionKey: "session-1",
      linkedFlowIds: ["flow-1"],
      createdAt: 1,
      updatedAt: 2,
    });

    const runtime = createRuntime();
    await plansListCommand({ json: true }, runtime);

    const payload = JSON.parse(String(vi.mocked(runtime.log).mock.calls[0]?.[0])) as {
      count: number;
      status: string | null;
      plans: Array<{ title: string; status: string; linkedFlowIds?: string[] }>;
    };

    expect(payload.count).toBe(1);
    expect(payload.status).toBeNull();
    expect(payload.plans[0]).toMatchObject({
      title: "Week 1 orchestration metadata",
      status: "ready_for_review",
      linkedFlowIds: ["flow-1"],
    });
  });

  it("shows one plan by id", async () => {
    const plan = createPlanRecord({
      ownerKey: "agent:main:main",
      scopeKind: "session",
      title: "Week 1 orchestration metadata",
      summary: "Add inspect-only plan primitives.",
      content: "- extend tool descriptors",
      status: "approved",
      createdAt: 1,
      updatedAt: 2,
    });

    const runtime = createRuntime();
    await plansShowCommand({ lookup: plan.planId }, runtime);

    const lines = vi.mocked(runtime.log).mock.calls.map((call) => String(call[0]));
    expect(lines).toContain(`planId: ${plan.planId}`);
    expect(lines).toContain("status: approved");
    expect(lines).toContain("content:");
    expect(lines).toContain("- extend tool descriptors");
  });

  it("updates one plan status through the command", async () => {
    createPlanRecord({
      ownerKey: "agent:main:main",
      scopeKind: "session",
      title: "Week 1 orchestration metadata",
      content: "- extend tool descriptors",
      status: "draft",
      createdAt: 1,
      updatedAt: 1,
    });

    const runtime = createRuntime();
    await plansSetStatusCommand(
      { lookup: "Week 1 orchestration metadata", status: "ready_for_review" },
      runtime,
    );

    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringContaining("status from draft to ready_for_review"),
    );
  });

  it("fails when a plan lookup is missing", async () => {
    const runtime = createRuntime();
    await plansShowCommand({ lookup: "missing-plan" }, runtime);

    expect(runtime.error).toHaveBeenCalledWith("Plan not found: missing-plan");
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("fails on invalid plan status transitions", async () => {
    createPlanRecord({
      ownerKey: "agent:main:main",
      scopeKind: "session",
      title: "Week 1 orchestration metadata",
      content: "- extend tool descriptors",
      status: "draft",
      createdAt: 1,
      updatedAt: 1,
    });

    const runtime = createRuntime();
    await plansSetStatusCommand(
      { lookup: "Week 1 orchestration metadata", status: "approved" },
      runtime,
    );

    expect(runtime.error).toHaveBeenCalledWith("invalid plan status transition draft -> approved");
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });
});
