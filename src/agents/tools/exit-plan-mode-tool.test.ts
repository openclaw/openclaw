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

  // Bug 2/6 fix: title is now REQUIRED. All test args include a title
  // so the schema check passes. Tests asserting the no-title rejection
  // are explicitly named (see "rejects calls without title").
  const validPlanArgs = {
    title: "Test plan",
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

describe("createExitPlanModeTool — PR-10 archetype fields", () => {
  const planSteps = [{ step: "do thing", status: "pending" }];
  // Bug 2/6 fix: title is REQUIRED in the schema. Provide a default
  // title for archetype-field tests so they exercise the
  // archetype-specific behavior, not the title-required gate.
  const defaultTitle = "Test plan";

  // Bug 2/6 fix: title is REQUIRED. The agent must call exit_plan_mode
  // with a title field — without it the schema rejects the call so the
  // agent's next attempt includes one (preferred over a silent fallback
  // because "Active Plan" / "Untitled plan" are unhelpful for the user
  // reviewing the approval card and for the persisted markdown
  // filename).
  it("rejects calls without title (Bug 2/6 fix)", async () => {
    const tool = createExitPlanModeTool();
    await expect(
      tool.execute("c1", { plan: planSteps }, new AbortController().signal),
    ).rejects.toThrow(/exit_plan_mode requires a `title` field/);
  });

  it("rejects calls with whitespace-only title", async () => {
    const tool = createExitPlanModeTool();
    await expect(
      tool.execute("c1", { title: "   ", plan: planSteps }, new AbortController().signal),
    ).rejects.toThrow(/exit_plan_mode requires a `title` field/);
  });

  it("forwards title (clamped to 80 chars)", async () => {
    const tool = createExitPlanModeTool();
    const longTitle = "x".repeat(200);
    const result = await tool.execute(
      "c1",
      { plan: planSteps, title: longTitle },
      new AbortController().signal,
    );
    const details = result.details as { title?: string };
    expect(details.title).toBeDefined();
    expect(details.title!.length).toBe(80);
  });

  it("forwards analysis when non-empty (trimmed)", async () => {
    const tool = createExitPlanModeTool();
    const result = await tool.execute(
      "c1",
      { title: defaultTitle, plan: planSteps, analysis: "  Multi-paragraph analysis text.  " },
      new AbortController().signal,
    );
    expect(result.details).toMatchObject({
      analysis: "Multi-paragraph analysis text.",
    });
  });

  it("drops analysis when whitespace-only (treats as missing)", async () => {
    const tool = createExitPlanModeTool();
    const result = await tool.execute(
      "c1",
      { title: defaultTitle, plan: planSteps, analysis: "   " },
      new AbortController().signal,
    );
    expect((result.details as Record<string, unknown>).analysis).toBeUndefined();
  });

  it("forwards assumptions array (trim + drop blank)", async () => {
    const tool = createExitPlanModeTool();
    const result = await tool.execute(
      "c1",
      {
        title: defaultTitle,
        plan: planSteps,
        assumptions: [" tests pass first run ", "", "  ", "auth exports stable"],
      },
      new AbortController().signal,
    );
    expect(result.details).toMatchObject({
      assumptions: ["tests pass first run", "auth exports stable"],
    });
  });

  it("drops assumptions array when all entries blank", async () => {
    const tool = createExitPlanModeTool();
    const result = await tool.execute(
      "c1",
      { title: defaultTitle, plan: planSteps, assumptions: ["", "  "] },
      new AbortController().signal,
    );
    expect((result.details as Record<string, unknown>).assumptions).toBeUndefined();
  });

  it("forwards risks array (only entries with both risk + mitigation)", async () => {
    const tool = createExitPlanModeTool();
    const result = await tool.execute(
      "c1",
      {
        title: defaultTitle,
        plan: planSteps,
        risks: [
          { risk: "race condition", mitigation: "use mutex" },
          { risk: "missing mitigation only" }, // dropped
          { mitigation: "no risk text" }, // dropped
          { risk: "  ", mitigation: "  " }, // dropped (both blank after trim)
          { risk: "   sql injection   ", mitigation: "  use parameterized query  " },
          "not an object", // dropped
          null, // dropped
        ],
      },
      new AbortController().signal,
    );
    expect(result.details).toMatchObject({
      risks: [
        { risk: "race condition", mitigation: "use mutex" },
        { risk: "sql injection", mitigation: "use parameterized query" },
      ],
    });
  });

  it("drops risks array when no entries have both fields", async () => {
    const tool = createExitPlanModeTool();
    const result = await tool.execute(
      "c1",
      { title: defaultTitle, plan: planSteps, risks: [{ risk: "alone" }] },
      new AbortController().signal,
    );
    expect((result.details as Record<string, unknown>).risks).toBeUndefined();
  });

  it("forwards verification + references (trim + drop blank)", async () => {
    const tool = createExitPlanModeTool();
    const result = await tool.execute(
      "c1",
      {
        title: defaultTitle,
        plan: planSteps,
        verification: ["pnpm test passes", " "],
        references: ["src/x.ts:1", "PR #123", ""],
      },
      new AbortController().signal,
    );
    expect(result.details).toMatchObject({
      verification: ["pnpm test passes"],
      references: ["src/x.ts:1", "PR #123"],
    });
  });

  it("omits OPTIONAL archetype fields when none supplied (only title + plan required)", async () => {
    const tool = createExitPlanModeTool();
    const result = await tool.execute(
      "c1",
      { title: defaultTitle, plan: planSteps },
      new AbortController().signal,
    );
    const details = result.details as Record<string, unknown>;
    expect(details.analysis).toBeUndefined();
    expect(details.assumptions).toBeUndefined();
    expect(details.risks).toBeUndefined();
    expect(details.verification).toBeUndefined();
    expect(details.references).toBeUndefined();
    // Pre-existing fields still present.
    expect(details.status).toBe("approval_requested");
    expect(details.plan).toEqual(planSteps);
  });
});
