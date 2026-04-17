/**
 * PR-8 follow-up Round 2: tests for the exit_plan_mode subagent-gate.
 *
 * Spec: when the parent run has open subagent runs (research spawned
 * during plan-mode investigation), `exit_plan_mode` must reject the
 * submission with a `ToolInputError` listing the pending children.
 * This matches the user's explicit rule: wait for all expected research
 * children before submitting the plan.
 *
 * Also covers: standalone path (no runId → no gate), empty set (passes),
 * and empty plan (pre-existing rejection path — unchanged).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearAgentRunContext, registerAgentRunContext } from "../../infra/agent-events.js";
import { createExitPlanModeTool } from "./exit-plan-mode-tool.js";

describe("createExitPlanModeTool — subagent gate", () => {
  const testRunId = "test-run-exit-plan-mode";

  beforeEach(() => {
    // Clean slate each test.
    clearAgentRunContext(testRunId);
  });

  afterEach(() => {
    clearAgentRunContext(testRunId);
  });

  const validPlanArgs = {
    plan: [{ step: "do the thing", status: "pending" }],
  };

  it("empty openSubagentRunIds → succeeds", async () => {
    registerAgentRunContext(testRunId, { openSubagentRunIds: new Set() });
    const tool = createExitPlanModeTool({ runId: testRunId });
    const result = await tool.execute("call-1", validPlanArgs, new AbortController().signal);
    expect(result.details).toMatchObject({ status: "approval_requested" });
  });

  it("no runId → succeeds (standalone/test path)", async () => {
    const tool = createExitPlanModeTool();
    const result = await tool.execute("call-1", validPlanArgs, new AbortController().signal);
    expect(result.details).toMatchObject({ status: "approval_requested" });
  });

  it("1 open subagent → throws with child run id in message", async () => {
    registerAgentRunContext(testRunId, {
      openSubagentRunIds: new Set(["child-run-abc"]),
    });
    const tool = createExitPlanModeTool({ runId: testRunId });
    await expect(() =>
      tool.execute("call-1", validPlanArgs, new AbortController().signal),
    ).rejects.toThrow(/child-run-abc/);
  });

  it("5 open subagents → lists all 5 in error", async () => {
    registerAgentRunContext(testRunId, {
      openSubagentRunIds: new Set(["r1", "r2", "r3", "r4", "r5"]),
    });
    const tool = createExitPlanModeTool({ runId: testRunId });
    await expect(() =>
      tool.execute("call-1", validPlanArgs, new AbortController().signal),
    ).rejects.toThrow(/r1.*r2.*r3.*r4.*r5/);
  });

  it("7 open subagents → truncates with '2 more' suffix", async () => {
    registerAgentRunContext(testRunId, {
      openSubagentRunIds: new Set(["r1", "r2", "r3", "r4", "r5", "r6", "r7"]),
    });
    const tool = createExitPlanModeTool({ runId: testRunId });
    await expect(() =>
      tool.execute("call-1", validPlanArgs, new AbortController().signal),
    ).rejects.toThrow(/and 2 more/);
  });

  it("error message includes plan-count and corrective guidance", async () => {
    registerAgentRunContext(testRunId, { openSubagentRunIds: new Set(["rx"]) });
    const tool = createExitPlanModeTool({ runId: testRunId });
    await expect(() =>
      tool.execute("call-1", validPlanArgs, new AbortController().signal),
    ).rejects.toThrow(/Wait for their completion/);
  });

  it("drained set after completion → succeeds", async () => {
    const ctx = { openSubagentRunIds: new Set(["child-x"]) };
    registerAgentRunContext(testRunId, ctx);
    const tool = createExitPlanModeTool({ runId: testRunId });

    // First call blocks.
    await expect(() =>
      tool.execute("call-1", validPlanArgs, new AbortController().signal),
    ).rejects.toThrow(/child-x/);

    // Simulate completion drain.
    ctx.openSubagentRunIds.delete("child-x");

    // Second call succeeds.
    const result = await tool.execute("call-2", validPlanArgs, new AbortController().signal);
    expect(result.details).toMatchObject({ status: "approval_requested" });
  });
});
