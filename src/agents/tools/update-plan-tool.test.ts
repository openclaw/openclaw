import { afterEach, describe, expect, it, vi } from "vitest";
import {
  listPlansForSessionKey,
  resetPlanRegistryForTests,
  updatePlanStatus,
} from "../../plans/plan-registry.js";
import { createUpdatePlanTool } from "./update-plan-tool.js";

describe("update_plan tool", () => {
  afterEach(() => {
    resetPlanRegistryForTests();
  });

  it("returns a compact success payload", async () => {
    const tool = createUpdatePlanTool();
    const result = await tool.execute("call-1", {
      explanation: "Started work",
      plan: [
        { step: "Inspect harness", status: "completed" },
        { step: "Add tool", status: "in_progress" },
        { step: "Run tests", status: "pending" },
      ],
    });

    expect(result.content).toEqual([]);
    expect(result.details).toEqual({
      status: "updated",
      explanation: "Started work",
      plan: [
        { step: "Inspect harness", status: "completed" },
        { step: "Add tool", status: "in_progress" },
        { step: "Run tests", status: "pending" },
      ],
    });
  });

  it("rejects multiple in-progress steps", async () => {
    const tool = createUpdatePlanTool();

    await expect(
      tool.execute("call-1", {
        plan: [
          { step: "One", status: "in_progress" },
          { step: "Two", status: "in_progress" },
        ],
      }),
    ).rejects.toThrow("plan can contain at most one in_progress step");
  });

  it("ignores extra per-step fields instead of rejecting the plan", async () => {
    const tool = createUpdatePlanTool();
    const result = await tool.execute("call-1", {
      plan: [
        { step: "Inspect harness", status: "completed", owner: "agent-1" },
        { step: "Run tests", status: "pending", notes: ["later"] },
      ],
    });

    expect(result.content).toEqual([]);
    expect(result.details).toEqual({
      status: "updated",
      plan: [
        { step: "Inspect harness", status: "completed" },
        { step: "Run tests", status: "pending" },
      ],
    });
  });

  it("persists the plan artifact when a session key is available", async () => {
    const callGatewayMock = vi.fn(async () => ({ ok: true }));
    const tool = createUpdatePlanTool({
      agentSessionKey: "agent:main:main",
      callGateway: callGatewayMock as unknown as typeof import("../../gateway/call.js").callGateway,
    });

    const result = await tool.execute("call-1", {
      explanation: "Captured plan",
      plan: [
        { step: "Inspect harness", status: "completed" },
        { step: "Add tool", status: "in_progress" },
      ],
    });

    expect(callGatewayMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "sessions.patch",
        params: expect.objectContaining({
          key: "agent:main:main",
          planMode: "active",
          planArtifact: expect.objectContaining({
            status: "active",
            lastExplanation: "Captured plan",
            steps: [
              { step: "Inspect harness", status: "completed" },
              { step: "Add tool", status: "in_progress" },
            ],
          }),
        }),
      }),
    );
    const plans = listPlansForSessionKey("agent:main:main");
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({
      ownerKey: "agent:main:main",
      scopeKind: "session",
      sessionKey: "agent:main:main",
      status: "draft",
      title: "Add tool",
      summary: "Captured plan",
      format: "markdown",
    });
    expect(plans[0]?.content).toContain("Captured plan");
    expect(plans[0]?.content).toContain("- [x] Inspect harness");
    expect(plans[0]?.content).toContain("- [>] Add tool");
    expect(result.details).toEqual({
      status: "updated",
      persisted: true,
      explanation: "Captured plan",
      plan: [
        { step: "Inspect harness", status: "completed" },
        { step: "Add tool", status: "in_progress" },
      ],
    });
  });

  it("updates the existing session draft plan instead of creating duplicates", async () => {
    const callGatewayMock = vi.fn(async () => ({ ok: true }));
    const tool = createUpdatePlanTool({
      agentSessionKey: "agent:main:main",
      callGateway: callGatewayMock as unknown as typeof import("../../gateway/call.js").callGateway,
    });

    await tool.execute("call-1", {
      explanation: "Captured plan",
      plan: [
        { step: "Inspect harness", status: "completed" },
        { step: "Add tool", status: "in_progress" },
      ],
    });

    const firstPlan = listPlansForSessionKey("agent:main:main")[0];
    expect(firstPlan).toBeDefined();

    await tool.execute("call-2", {
      explanation: "Tests are next",
      plan: [
        { step: "Inspect harness", status: "completed" },
        { step: "Add tool", status: "completed" },
        { step: "Run tests", status: "in_progress" },
      ],
    });

    const plans = listPlansForSessionKey("agent:main:main");
    expect(plans).toHaveLength(1);
    expect(plans[0]?.planId).toBe(firstPlan?.planId);
    expect(plans[0]).toMatchObject({
      status: "draft",
      title: "Run tests",
      summary: "Tests are next",
    });
    expect(plans[0]?.content).toContain("- [x] Add tool");
    expect(plans[0]?.content).toContain("- [>] Run tests");

    const draftPlan = plans[0];
    expect(draftPlan).toBeDefined();
    const updated = updatePlanStatus({
      planId: draftPlan.planId,
      status: "ready_for_review",
    });
    expect(updated.plan.status).toBe("ready_for_review");
  });
});
