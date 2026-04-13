import { describe, expect, it } from "vitest";
import { createPlanRecord, resetPlanRegistryForTests, updatePlanStatus } from "./plan-registry.js";
import { isPlanStatusTransitionError } from "./plan-registry.types.js";

describe("plan registry status transitions", () => {
  it("allows draft to ready_for_review to approved to archived", () => {
    resetPlanRegistryForTests();
    const plan = createPlanRecord({
      ownerKey: "agent:main:main",
      scopeKind: "session",
      title: "Week 1 plan",
      content: "- inspect surfaces",
      status: "draft",
      createdAt: 1,
      updatedAt: 1,
    });

    const review = updatePlanStatus({
      planId: plan.planId,
      status: "ready_for_review",
      updatedAt: 2,
    });
    expect(review.previousStatus).toBe("draft");
    expect(review.plan.status).toBe("ready_for_review");
    expect(review.plan.reviewedAt).toBe(2);

    const approve = updatePlanStatus({ planId: plan.planId, status: "approved", updatedAt: 3 });
    expect(approve.previousStatus).toBe("ready_for_review");
    expect(approve.plan.status).toBe("approved");
    expect(approve.plan.approvedAt).toBe(3);

    const archive = updatePlanStatus({ planId: plan.planId, status: "archived", updatedAt: 4 });
    expect(archive.previousStatus).toBe("approved");
    expect(archive.plan.status).toBe("archived");
    expect(archive.plan.archivedAt).toBe(4);
  });

  it("rejects invalid transitions", () => {
    resetPlanRegistryForTests();
    const plan = createPlanRecord({
      ownerKey: "agent:main:main",
      scopeKind: "session",
      title: "Week 1 plan",
      content: "- inspect surfaces",
      status: "draft",
      createdAt: 1,
      updatedAt: 1,
    });

    let thrown: unknown;
    try {
      updatePlanStatus({ planId: plan.planId, status: "approved" });
    } catch (error) {
      thrown = error;
    }

    expect(isPlanStatusTransitionError(thrown)).toBe(true);
    expect((thrown as Error).message).toContain("invalid plan status transition draft -> approved");
  });
});
