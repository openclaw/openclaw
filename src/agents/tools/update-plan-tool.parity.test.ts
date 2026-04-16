import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type AgentEventPayload,
  getAgentRunContext,
  onAgentEvent,
  registerAgentRunContext,
  resetAgentEventsForTest,
} from "../../infra/agent-events.js";
import { createUpdatePlanTool } from "./update-plan-tool.js";

describe("update_plan tool – parity tests", () => {
  it("cancelled status is accepted in the schema", async () => {
    const tool = createUpdatePlanTool();
    const result = await tool.execute("call-1", {
      plan: [
        { step: "Install deps", status: "completed" },
        { step: "Run failing tests", status: "cancelled" },
        { step: "Fix tests and retry", status: "pending" },
      ],
    });

    expect(result.details).toEqual({
      status: "updated",
      plan: [
        { step: "Install deps", status: "completed" },
        { step: "Run failing tests", status: "cancelled" },
        { step: "Fix tests and retry", status: "pending" },
      ],
    });
  });

  it("activeForm field is preserved in output", async () => {
    const tool = createUpdatePlanTool();
    const result = await tool.execute("call-1", {
      plan: [
        {
          step: "Fix auth bug",
          status: "in_progress",
          activeForm: "Fixing authentication bug",
        },
        { step: "Deploy", status: "pending" },
      ],
    });

    const plan = (result.details as Record<string, unknown>).plan as Array<Record<string, unknown>>;
    const inProgressStep = plan.find((s) => s.status === "in_progress");
    expect(inProgressStep).toBeDefined();
    expect(inProgressStep!.activeForm).toBe("Fixing authentication bug");
  });

  it("merge=true with no previousPlan falls back to replace", async () => {
    const tool = createUpdatePlanTool();
    const result = await tool.execute("call-1", {
      merge: true,
      plan: [{ step: "New step", status: "pending" }],
    });

    expect(result.details).toEqual({
      status: "updated",
      plan: [{ step: "New step", status: "pending" }],
    });
  });
});

describe("update_plan tool – merge mode (#67514)", () => {
  beforeEach(() => {
    resetAgentEventsForTest();
  });

  afterEach(() => {
    resetAgentEventsForTest();
  });

  function getPlan(result: { details: unknown }) {
    return (result.details as Record<string, unknown>).plan as Array<Record<string, unknown>>;
  }

  it("merge with overlap updates status without duplicating the step", async () => {
    const runId = "run-merge-overlap";
    registerAgentRunContext(runId, {});
    const tool = createUpdatePlanTool({ runId });

    // Seed previous plan via an initial replace.
    await tool.execute("call-1", {
      plan: [
        { step: "Install deps", status: "completed" },
        { step: "Run tests", status: "in_progress", activeForm: "Running tests" },
        { step: "Deploy", status: "pending" },
      ],
    });

    // Overlap: "Run tests" advances to completed, "Deploy" advances to in_progress.
    const result = await tool.execute("call-2", {
      merge: true,
      plan: [
        { step: "Run tests", status: "completed" },
        { step: "Deploy", status: "in_progress", activeForm: "Deploying" },
      ],
    });

    const plan = getPlan(result);
    expect(plan).toHaveLength(3);
    expect(plan[0]).toEqual({ step: "Install deps", status: "completed" });
    expect(plan[1]).toEqual({ step: "Run tests", status: "completed" });
    expect(plan[2]).toEqual({ step: "Deploy", status: "in_progress", activeForm: "Deploying" });
  });

  it("merge appends novel steps preserving incoming order", async () => {
    const runId = "run-merge-append";
    registerAgentRunContext(runId, {});
    const tool = createUpdatePlanTool({ runId });

    await tool.execute("c1", {
      plan: [
        { step: "Step A", status: "completed" },
        { step: "Step B", status: "in_progress", activeForm: "Doing B" },
      ],
    });

    const result = await tool.execute("c2", {
      merge: true,
      plan: [
        { step: "Step C", status: "pending" },
        { step: "Step D", status: "pending" },
      ],
    });

    const plan = getPlan(result);
    expect(plan.map((p) => p.step)).toEqual(["Step A", "Step B", "Step C", "Step D"]);
    // Existing steps retain their previous status.
    expect(plan[0]?.status).toBe("completed");
    expect(plan[1]?.status).toBe("in_progress");
  });

  it("merge preserves completed steps not present in the incoming patch", async () => {
    const runId = "run-merge-preserve";
    registerAgentRunContext(runId, {});
    const tool = createUpdatePlanTool({ runId });

    await tool.execute("c1", {
      plan: [
        { step: "Plan", status: "completed" },
        { step: "Implement", status: "in_progress", activeForm: "Implementing" },
        { step: "Verify", status: "pending" },
      ],
    });

    const result = await tool.execute("c2", {
      merge: true,
      plan: [{ step: "Implement", status: "completed" }],
    });

    const plan = getPlan(result);
    expect(plan).toHaveLength(3);
    expect(plan[0]).toEqual({ step: "Plan", status: "completed" });
    expect(plan[1]).toEqual({ step: "Implement", status: "completed" });
    expect(plan[2]).toEqual({ step: "Verify", status: "pending" });
  });

  it("merge can transition status from cancelled back to pending (rollback case)", async () => {
    const runId = "run-merge-rollback";
    registerAgentRunContext(runId, {});
    const tool = createUpdatePlanTool({ runId });

    await tool.execute("c1", {
      plan: [{ step: "Risky migration", status: "cancelled" }],
    });

    const result = await tool.execute("c2", {
      merge: true,
      plan: [{ step: "Risky migration", status: "pending" }],
    });

    const plan = getPlan(result);
    expect(plan).toHaveLength(1);
    expect(plan[0]).toEqual({ step: "Risky migration", status: "pending" });
  });

  it("merge=false with prior plan still replaces (default behavior)", async () => {
    const runId = "run-merge-replace";
    registerAgentRunContext(runId, {});
    const tool = createUpdatePlanTool({ runId });

    await tool.execute("c1", {
      plan: [
        { step: "Old step 1", status: "completed" },
        { step: "Old step 2", status: "in_progress", activeForm: "Working" },
      ],
    });

    const result = await tool.execute("c2", {
      merge: false,
      plan: [{ step: "Brand new plan", status: "pending" }],
    });

    const plan = getPlan(result);
    expect(plan).toEqual([{ step: "Brand new plan", status: "pending" }]);
  });

  it("two runs with different runIds maintain isolated plan state", async () => {
    const runA = "run-iso-a";
    const runB = "run-iso-b";
    registerAgentRunContext(runA, {});
    registerAgentRunContext(runB, {});
    const toolA = createUpdatePlanTool({ runId: runA });
    const toolB = createUpdatePlanTool({ runId: runB });

    await toolA.execute("c1", { plan: [{ step: "A1", status: "completed" }] });
    await toolB.execute("c2", {
      plan: [{ step: "B1", status: "in_progress", activeForm: "Doing B1" }],
    });

    const resultA = await toolA.execute("c3", {
      merge: true,
      plan: [{ step: "A2", status: "pending" }],
    });
    const resultB = await toolB.execute("c4", {
      merge: true,
      plan: [{ step: "B2", status: "pending" }],
    });

    expect(getPlan(resultA).map((s) => s.step)).toEqual(["A1", "A2"]);
    expect(getPlan(resultB).map((s) => s.step)).toEqual(["B1", "B2"]);
  });

  it("persists the merged plan back to AgentRunContext.lastPlanSteps", async () => {
    const runId = "run-persist";
    registerAgentRunContext(runId, {});
    const tool = createUpdatePlanTool({ runId });

    await tool.execute("c1", {
      plan: [
        { step: "S1", status: "completed" },
        { step: "S2", status: "pending" },
      ],
    });

    const ctx = getAgentRunContext(runId);
    expect(ctx?.lastPlanSteps).toEqual([
      { step: "S1", status: "completed" },
      { step: "S2", status: "pending" },
    ]);

    await tool.execute("c2", {
      merge: true,
      plan: [{ step: "S2", status: "completed" }],
    });

    const ctxAfter = getAgentRunContext(runId);
    expect(ctxAfter?.lastPlanSteps).toEqual([
      { step: "S1", status: "completed" },
      { step: "S2", status: "completed" },
    ]);
  });

  it("emits an agent_plan_event when runId is set", async () => {
    const runId = "run-emit";
    const sessionKey = "session-emit-1";
    registerAgentRunContext(runId, { sessionKey });
    const tool = createUpdatePlanTool({ runId });

    const events: AgentEventPayload[] = [];
    const off = onAgentEvent((evt) => {
      events.push(evt);
    });

    try {
      await tool.execute("c1", {
        explanation: "Initial plan",
        plan: [
          { step: "Plan", status: "completed" },
          { step: "Build", status: "in_progress", activeForm: "Building" },
        ],
      });

      const planEvents = events.filter((e) => e.stream === "plan");
      expect(planEvents).toHaveLength(1);
      const planEvent = planEvents[0];
      expect(planEvent.runId).toBe(runId);
      expect(planEvent.sessionKey).toBe(sessionKey);
      expect(planEvent.data).toMatchObject({
        phase: "update",
        title: "Plan updated",
        explanation: "Initial plan",
        steps: ["Plan", "Build"],
        source: "update_plan",
      });
    } finally {
      off();
    }
  });

  it("does NOT emit an agent_plan_event when runId is omitted", async () => {
    const tool = createUpdatePlanTool();
    const events: AgentEventPayload[] = [];
    const off = onAgentEvent((evt) => {
      events.push(evt);
    });

    try {
      await tool.execute("c1", { plan: [{ step: "S", status: "pending" }] });
    } finally {
      off();
    }

    expect(events.filter((e) => e.stream === "plan")).toHaveLength(0);
  });

  it("emits even when no AgentRunContext is registered (best-effort)", async () => {
    const runId = "run-no-context";
    // Note: we deliberately do NOT register a context for this run.
    const tool = createUpdatePlanTool({ runId });

    const events: AgentEventPayload[] = [];
    const off = onAgentEvent((evt) => {
      events.push(evt);
    });

    try {
      await tool.execute("c1", { plan: [{ step: "Solo step", status: "pending" }] });
    } finally {
      off();
    }

    const planEvents = events.filter((e) => e.stream === "plan");
    expect(planEvents).toHaveLength(1);
    expect(planEvents[0].runId).toBe(runId);
    // No sessionKey since context was never registered.
    expect(planEvents[0].sessionKey).toBeUndefined();
  });
});
