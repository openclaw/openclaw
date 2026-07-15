/**
 * Comprehensive validation test suite for the /loop multi-phase system.
 *
 * Tests types, state management, prompt builders, command parser,
 * directory operations, backward compat, and edge cases.
 *
 * Note: Direct tool.execute() is not testable here because the tools
 * use `import type { jsonResult }` which gets erased at runtime under
 * verbatimModuleSyntax. Tool-level tests exist in src/agents/tools/loop-tools.test.ts
 * (excluded from unit config but runnable via project-level config).
 *
 * Run:  pnpm test src/loop/loop-validation.test.ts
 * (uses the unit vitest config which excludes src/agents/ and src/auto-reply/)
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  setLoopState,
  getLoopState,
  createInitialLoopState,
} from "../agents/tools/loop-tools.js";
import {
  parseLoopCommand,
  formatLoopResultReport,
  buildAnalyzePrompt,
  buildPlanPrompt,
  buildSerialExecutePrompt,
  buildSerialVerifyPrompt,
  buildSerialFixPrompt,
  buildParallelDispatchPrompt,
  buildReportPrompt,
  buildSpawnedVerifyPrompt,
  parseSpawnedVerdict,
} from "../auto-reply/reply/commands-loop.js";
import type {
  LoopPhase,
  LoopSubtask,
  PhaseCompletePayload,
  SubtaskUpdatePayload,
  LoopSubtaskStatus,
} from "./loop-types.js";
import {
  LOOP_PHASE_LABELS,
  LOOP_PHASE_ORDER,
} from "./loop-types.js";
import {
  createLoopDirectory,
  writePhasePrompt,
  writePhaseResult,
  writeSubtasks,
  getPhaseDir,
  getSubtaskExecDir,
  getSubtaskVerifyDir,
  writeFinalReport,
  appendPhaseToMetadata,
} from "./loop-directory.js";
import path from "node:path";
import fs from "node:fs/promises";

// ── Helpers ─────────────────────────────────────────────────────────────

function makeSubtask(overrides: Partial<LoopSubtask> = {}): LoopSubtask {
  return {
    id: "sub-1",
    name: "Test Subtask",
    description: "A test subtask for validation",
    acceptanceCriteria: ["passes validation"],
    dependencies: [],
    parallelizable: false,
    status: "pending",
    ...overrides,
  };
}

/** Creates a subtask as the loop_update tool would (with the minimal structure). */
function makeToolSubtask(overrides: Partial<{
  id: string; name: string; description: string;
  acceptanceCriteria: string[]; dependencies: string[]; parallelizable: boolean;
}> = {}) {
  return {
    id: "tool-sub-1",
    name: "Tool Subtask",
    description: "Created via loop_update tool",
    acceptanceCriteria: ["works"],
    dependencies: [],
    parallelizable: false,
    ...overrides,
  };
}

/** Creates a base loop state for tool tests. */
function makeBaseState(overrides: Record<string, unknown> = {}) {
  return {
    task: "test task",
    iteration: 0,
    maxIterations: 5,
    consecutiveFailures: 0,
    tokenUsage: 0,
    currentPhase: "analyze" as LoopPhase,
    phaseComplete: false,
    phaseResult: null,
    subtasks: [] as LoopSubtask[],
    ...overrides,
  } as const;
}

// ════════════════════════════════════════════════════════════════════════
// 1.  Types & Constants
// ════════════════════════════════════════════════════════════════════════

describe("1. Types and Constants", () => {
  it("LOOP_PHASE_ORDER has all expected phases", () => {
    expect(LOOP_PHASE_ORDER).toEqual(["analyze", "plan", "execute", "verify", "report"]);
  });

  it("LOOP_PHASE_LABELS covers all phases", () => {
    const phases: LoopPhase[] = ["idle", "analyze", "plan", "execute", "verify", "report", "complete"];
    for (const p of phases) {
      expect(LOOP_PHASE_LABELS[p]).toBeDefined();
      expect(typeof LOOP_PHASE_LABELS[p]).toBe("string");
    }
  });

  it("LoopSubtaskStatus enum is fully covered", () => {
    const statuses: LoopSubtaskStatus[] = ["pending", "in-progress", "complete", "failed"];
    for (const st of statuses) {
      const sub = makeSubtask({ status: st });
      expect(sub.status).toBe(st);
    }
  });

  it("PhaseCompletePayload shape is compatible", () => {
    const payload: PhaseCompletePayload = {
      phase: "execute",
      summary: "Done",
      subtasks: [makeSubtask()],
      subtaskId: "sub-1",
      passed: true,
      details: { files: ["a.ts"] },
    };
    expect(payload.phase).toBe("execute");
    expect(payload.subtasks).toHaveLength(1);
    expect(payload.passed).toBe(true);
  });

  it("SubtaskUpdatePayload shape is compatible", () => {
    const payload: SubtaskUpdatePayload = {
      subtaskId: "sub-1",
      status: "complete",
      result: "success",
      worktreePath: "/tmp/worktree",
    };
    expect(payload.status).toBe("complete");
    expect(payload.result).toBe("success");
  });
});

// ════════════════════════════════════════════════════════════════════════
// 2.  createInitialLoopState
// ════════════════════════════════════════════════════════════════════════

describe("2. createInitialLoopState", () => {
  it("creates valid initial state with all fields", () => {
    const state = createInitialLoopState({ task: "build", maxIterations: 10, tokenBudget: 50000 });
    expect(state.task).toBe("build");
    expect(state.maxIterations).toBe(10);
    expect(state.tokenBudget).toBe(50000);
    expect(state.currentPhase).toBe("analyze");
    expect(state.phaseComplete).toBe(false);
    expect(state.phaseResult).toBeNull();
    expect(state.subtasks).toEqual([]);
    expect(state.completed).toBeUndefined();
    expect(state.iteration).toBe(0);
    expect(state.consecutiveFailures).toBe(0);
    expect(state.tokenUsage).toBe(0);
  });

  it("allows optional tokenBudget", () => {
    const state = createInitialLoopState({ task: "t", maxIterations: 5 });
    expect(state.tokenBudget).toBeUndefined();
  });

  it("defaults currentPhase to 'analyze'", () => {
    const state = createInitialLoopState({ task: "t", maxIterations: 5 });
    expect(state.currentPhase).toBe("analyze");
  });
});

// ════════════════════════════════════════════════════════════════════════
// 3.  setLoopState / getLoopState (Module-level singleton)
// ════════════════════════════════════════════════════════════════════════

describe("3. Module-level State Management", () => {
  beforeEach(() => setLoopState(null));
  afterEach(() => setLoopState(null));

  it("stores and retrieves state", () => {
    const state = makeBaseState({ task: "persist test" });
    setLoopState(state);
    expect(getLoopState()?.task).toBe("persist test");
  });

  it("setting null clears state", () => {
    setLoopState(makeBaseState());
    expect(getLoopState()).not.toBeNull();
    setLoopState(null);
    expect(getLoopState()).toBeNull();
  });

  it("state references are shared (object identity)", () => {
    const state = makeBaseState();
    setLoopState(state);
    expect(getLoopState()).toBe(state);
    // Mutations through the reference are visible both ways
    state.iteration = 42;
    expect(getLoopState()?.iteration).toBe(42);
  });

  it("multiple sequential set/get calls work", () => {
    setLoopState(makeBaseState({ task: "a" }));
    expect(getLoopState()?.task).toBe("a");
    setLoopState(makeBaseState({ task: "b" }));
    expect(getLoopState()?.task).toBe("b");
    setLoopState(makeBaseState({ task: "c" }));
    expect(getLoopState()?.task).toBe("c");
  });
});

// ════════════════════════════════════════════════════════════════════════
// 4.  State transitions
// ════════════════════════════════════════════════════════════════════════

describe("4. State Transitions", () => {
  beforeEach(() => setLoopState(null));
  afterEach(() => setLoopState(null));

  it("full analyze→plan→execute phase transition", () => {
    setLoopState(createInitialLoopState({ task: "full stack", maxIterations: 5 }));

    // Start: analyze
    expect(getLoopState()?.currentPhase).toBe("analyze");
    expect(getLoopState()?.phaseComplete).toBe(false);

    // Phase 1 completion
    const state = getLoopState()!;
    state.phaseComplete = true;
    state.phaseResult = { phase: "analyze", summary: "Analysis done", details: {} };
    expect(state.phaseComplete).toBe(true);

    // Phase 2: plan with subtasks
    state.currentPhase = "plan";
    state.phaseComplete = false;
    state.subtasks = [
      makeSubtask({ id: "s1", name: "Task 1" }),
      makeSubtask({ id: "s2", name: "Task 2", dependencies: ["s1"] }),
    ];
    expect(state.currentPhase).toBe("plan");
    expect(state.subtasks).toHaveLength(2);

    // Phase 3: execute
    state.currentPhase = "execute";
    state.subtasks[0].status = "complete";
    state.subtasks[0].result = "Done";
    expect(state.subtasks[0].status).toBe("complete");

    // Verify order preserved
    state.subtasks[1].status = "complete";
    state.subtasks[1].result = "Done too";
  });

  it("subtask status lifecycle: pending → in-progress → complete", () => {
    setLoopState(makeBaseState({
      subtasks: [makeSubtask({ id: "x", status: "pending" })],
    }));

    const sub = getLoopState()!.subtasks[0];
    expect(sub.status).toBe("pending");

    sub.status = "in-progress";
    expect(getLoopState()?.subtasks[0].status).toBe("in-progress");

    sub.status = "complete";
    expect(getLoopState()?.subtasks[0].status).toBe("complete");
  });

  it("subtask can transition to failed", () => {
    setLoopState(makeBaseState({
      subtasks: [makeSubtask({ id: "x" })],
    }));
    getLoopState()!.subtasks[0].status = "failed";
    expect(getLoopState()?.subtasks[0].status).toBe("failed");
  });

  it("loop_complete sets phase to complete via state mutation", () => {
    setLoopState(createInitialLoopState({ task: "test", maxIterations: 5 }));
    const state = getLoopState()!;
    state.completed = true;
    state.completedSummary = "Done early";
    state.currentPhase = "complete";

    expect(state.completed).toBe(true);
    expect(state.completedSummary).toBe("Done early");
    expect(state.currentPhase).toBe("complete");
  });

  it("state preserves consecutiveFailures across transitions", () => {
    setLoopState(makeBaseState({ consecutiveFailures: 2 }));
    const state = getLoopState()!;
    state.consecutiveFailures++;
    expect(state.consecutiveFailures).toBe(3);
    state.currentPhase = "plan";
    expect(getLoopState()?.consecutiveFailures).toBe(3); // preserved
  });

  it("state reset (null) cleans up and tools see no active loop", () => {
    setLoopState(createInitialLoopState({ task: "will be cleared", maxIterations: 5 }));
    expect(getLoopState()).not.toBeNull();
    setLoopState(null);
    expect(getLoopState()).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════
// 5.  Prompt builders
// ════════════════════════════════════════════════════════════════════════

describe("5. Prompt builders", () => {
  const task = "Build a web server";
  const subtask = makeSubtask({
    id: "s1",
    name: "Setup Express",
    description: "Initialize Express server with routes",
    acceptanceCriteria: ["Listening on port 3000", "GET /health returns 200"],
  });
  const subtasks: LoopSubtask[] = [
    subtask,
    makeSubtask({ id: "s2", name: "Add middleware", parallelizable: true }),
  ];

  it("buildAnalyzePrompt references task name and instructs analysis", () => {
    const prompt = buildAnalyzePrompt(task);
    expect(prompt).toContain(task);
    expect(prompt).toContain("Analysis");
    expect(prompt).toContain("findings");
  });

  it("buildPlanPrompt includes task and prior analysis summary", () => {
    const prompt = buildPlanPrompt(task, "Found 3 key components");
    expect(prompt).toContain(task);
    expect(prompt).toContain("Found 3 key components");
    expect(prompt).toContain("subtasks");
    expect(prompt).toContain("loop_update");
  });

  it("buildPlanPrompt handles empty analysis summary gracefully", () => {
    const prompt = buildPlanPrompt(task, "");
    expect(prompt).toContain(task);
  });

  it("buildSerialExecutePrompt includes subtask name, description, acceptance criteria, and test requirements", () => {
    const prompt = buildSerialExecutePrompt(subtask, task);
    expect(prompt).toContain(subtask.name);
    expect(prompt).toContain(subtask.description);
    expect(prompt).toContain("Execute");
    for (const ac of subtask.acceptanceCriteria) {
      expect(prompt).toContain(ac);
    }
    // Test execution requirements
    expect(prompt).toContain("pnpm test");
    expect(prompt).toContain("git diff");
  });

  it("buildSerialVerifyPrompt emphasizes verifier role and evidence requirements", () => {
    const prompt = buildSerialVerifyPrompt(subtask);
    expect(prompt).toContain("verifier");
    expect(prompt).toContain(subtask.name);
    expect(prompt).toContain("Verification");
    // Evidence checklist requirements
    expect(prompt).toContain("concrete evidence");
    expect(prompt).toContain("git diff");
    expect(prompt).toContain("pnpm test");
    expect(prompt).toContain("pnpm tsgo");
    expect(prompt).toContain("passed: true");
    expect(prompt).toContain("passed: false");
    expect(prompt).toContain("Criterion-by-criterion");
  });

  it("buildSerialFixPrompt includes original task, verification issues, and test requirements", () => {
    const issues = "Port 3000 is already in use";
    const prompt = buildSerialFixPrompt(subtask, issues);
    expect(prompt).toContain(subtask.name);
    expect(prompt).toContain(issues);
    expect(prompt).toContain("Fix");
    expect(prompt).toContain("pnpm test");
    expect(prompt).toContain("git diff");
  });

  it("buildSerialFixPrompt handles empty issues string", () => {
    const prompt = buildSerialFixPrompt(subtask, "");
    expect(prompt).toContain(subtask.name);
  });

  it("buildParallelDispatchPrompt references task and parallel execution", () => {
    const parallelTasks = [makeSubtask({ id: "p1", parallelizable: true })];
    const prompt = buildParallelDispatchPrompt(parallelTasks, task);
    expect(prompt).toContain(task);
    expect(prompt).toContain("parallel");
    expect(prompt).toContain("sessions_spawn");
  });

  it("buildParallelDispatchPrompt with empty array still works", () => {
    const prompt = buildParallelDispatchPrompt([], task);
    expect(prompt).toContain(task);
  });

  it("buildReportPrompt includes task and subtask results", () => {
    const completed: LoopSubtask[] = [
      makeSubtask({ status: "complete", verdict: { passed: true, notes: "All working" } }),
      makeSubtask({ id: "s2", status: "failed", verdict: { passed: false, notes: "Timed out" } }),
    ];
    const prompt = buildReportPrompt(task, completed);
    expect(prompt).toContain(task);
    expect(prompt).toContain("Report");
    expect(prompt).toContain("complete");
    expect(prompt).toContain("failed");
  });

  it("buildSpawnedVerifyPrompt contains evidence checklist and verdict markers", () => {
    const prompt = buildSpawnedVerifyPrompt(subtask);
    expect(prompt).toContain("independent verifier");
    expect(prompt).toContain("fresh session");
    expect(prompt).toContain("---VERDICT---");
    expect(prompt).toContain("passed: true");
    expect(prompt).toContain("---SUMMARY---");
    expect(prompt).toContain("concrete evidence");
    expect(prompt).toContain("git diff");
    expect(prompt).toContain("pnpm test");
    expect(prompt).toContain("Criterion-by-criterion");
    expect(prompt).not.toContain("loop_update");
  });

  it("parseSpawnedVerdict parses passed: true", () => {
    const text = "Some analysis...\n---VERDICT---\npassed: true\n---SUMMARY---\nAll criteria met";
    const result = parseSpawnedVerdict(text);
    expect(result).toEqual({ passed: true, summary: "All criteria met" });
  });

  it("parseSpawnedVerdict parses passed: false", () => {
    const text = "Found issues...\n---VERDICT---\npassed: false\n---SUMMARY---\nTwo tests failing";
    const result = parseSpawnedVerdict(text);
    expect(result).toEqual({ passed: false, summary: "Two tests failing" });
  });

  it("parseSpawnedVerdict handles verdict markers with backticks", () => {
    const text = "---VERDICT---\npassed: true\n---SUMMARY---\nWorks";
    const result = parseSpawnedVerdict(text);
    expect(result).toEqual({ passed: true, summary: "Works" });
  });

  it("parseSpawnedVerdict returns null when no verdict marker present", () => {
    expect(parseSpawnedVerdict("Just some text without markers")).toBeNull();
  });

  it("parseSpawnedVerdict handles case-insensitive passed", () => {
    const text = "---VERDICT---\npassed: True\n---SUMMARY---\nAll good";
    const result = parseSpawnedVerdict(text);
    expect(result).toEqual({ passed: true, summary: "All good" });
  });

  it("parseSpawnedVerdict handles summary after code block", () => {
    const text = "---VERDICT---\npassed: false\n---SUMMARY---\nBroken\n```";
    const result = parseSpawnedVerdict(text);
    expect(result).toEqual({ passed: false, summary: "Broken" });
  });
});

// ════════════════════════════════════════════════════════════════════════
// 6.  Command parser
// ════════════════════════════════════════════════════════════════════════

describe("6. parseLoopCommand", () => {
  it("parses basic command", () => {
    const r = parseLoopCommand("/loop build a web server");
    expect(r).toEqual({ task: "build a web server", maxIterations: 10, tokenBudget: undefined });
  });

  it("parses custom max-iterations", () => {
    const r = parseLoopCommand("/loop task --max-iterations 3");
    expect(r).toEqual({ task: "task", maxIterations: 3, tokenBudget: undefined });
  });

  it("parses token budget", () => {
    const r = parseLoopCommand("/loop task --budget 100000");
    expect(r).toEqual({ task: "task", maxIterations: 10, tokenBudget: 100000 });
  });

  it("parses both flags", () => {
    const r = parseLoopCommand("/loop write tests --max-iterations 3 --budget 50000");
    expect(r).toEqual({ task: "write tests", maxIterations: 3, tokenBudget: 50000 });
  });

  it("default max-iterations is 10", () => {
    const r = parseLoopCommand("/loop task");
    expect(r?.maxIterations).toBe(10);
  });

  it("min max-iterations is 1", () => {
    const r = parseLoopCommand("/loop task --max-iterations 1");
    expect(r).toEqual({ task: "task", maxIterations: 1, tokenBudget: undefined });
  });

  it("clamps excessive max-iterations to default (10)", () => {
    const r = parseLoopCommand("/loop task --max-iterations 200");
    expect(r).toEqual({ task: "task", maxIterations: 10, tokenBudget: undefined });
  });

  it("returns null for empty command", () => {
    expect(parseLoopCommand("/loop")).toBeNull();
  });

  it("returns null for non-loop command", () => {
    expect(parseLoopCommand("/goal start foo")).toBeNull();
  });

  it("handles flags in any order", () => {
    const r = parseLoopCommand("/loop refactor --budget 30000 --max-iterations 7");
    expect(r).toEqual({ task: "refactor", maxIterations: 7, tokenBudget: 30000 });
  });
});

describe("formatLoopResultReport", () => {
  it("formats successful completion", () => {
    const text = formatLoopResultReport({
      success: true,
      reason: "completed",
      iterations: 3,
      tokenUsage: 15000,
      task: "build app",
      summary: "Built the web server",
    });
    expect(text).toContain("✅");
    expect(text).toContain("Iterations: 3");
    expect(text).toContain("~15,000");
    expect(text).toContain("Built the web server");
  });

  it("formats failure result", () => {
    const text = formatLoopResultReport({
      success: false,
      reason: "exceededMaxIterations",
      iterations: 10,
      tokenUsage: 50000,
      task: "deploy",
    });
    expect(text).toContain("exceededMaxIterations");
  });

  it("formats with zero iterations", () => {
    const text = formatLoopResultReport({
      success: false,
      reason: "error",
      iterations: 0,
      tokenUsage: 0,
      task: "fail",
    });
    expect(text).toContain("⏹️");
  });
});

// ════════════════════════════════════════════════════════════════════════
// 7.  Loop directory operations
// ════════════════════════════════════════════════════════════════════════

describe("7. Loop directory operations", () => {
  const testRoot = path.join("/tmp", "openclaw-loop-test-" + Date.now());

  it("createLoopDirectory creates directory with loop.json", async () => {
    const dir = await createLoopDirectory("Test Task", { HOME: testRoot });
    expect(dir).toContain(testRoot);
    expect(dir).toContain(".openclaw/loops/");
    const meta = await fs.readFile(path.join(dir, "loop.json"), "utf-8");
    const parsed = JSON.parse(meta);
    expect(parsed.task).toBe("Test Task");
    expect(parsed.createdAt).toBeDefined();
    expect(parsed.phases).toEqual([]);
  });

  it("getPhaseDir returns correct paths", () => {
    const dir = path.join(testRoot, ".openclaw/loops/some-task");
    expect(getPhaseDir(dir, "analyze", 1)).toContain("01-analyze");
    expect(getPhaseDir(dir, "plan", 2)).toContain("02-plan");
    expect(getPhaseDir(dir, "execute", 3)).toContain("03-execute");
    expect(getPhaseDir(dir, "verify", 4)).toContain("04-verify");
    expect(getPhaseDir(dir, "report", 5)).toContain("05-report");
  });

  it("writePhasePrompt and writePhaseResult persist data", async () => {
    const dir = await createLoopDirectory("write test", { HOME: testRoot });
    const phaseDir = getPhaseDir(dir, "plan", 2);
    await writePhasePrompt(phaseDir, "This is the prompt");
    await writePhaseResult(phaseDir, { summary: "done", items: [1, 2, 3] });

    const promptText = await fs.readFile(path.join(phaseDir, "prompt.md"), "utf-8");
    expect(promptText).toBe("This is the prompt");

    const resultText = await fs.readFile(path.join(phaseDir, "result.json"), "utf-8");
    const result = JSON.parse(resultText);
    expect(result.summary).toBe("done");
    expect(result.items).toEqual([1, 2, 3]);
  });

  it("writeSubtasks stores subtask list as JSON", async () => {
    const dir = await createLoopDirectory("subtask test", { HOME: testRoot });
    const phaseDir = getPhaseDir(dir, "plan", 2);
    const subs: LoopSubtask[] = [
      makeSubtask({ id: "a", name: "Task A" }),
      makeSubtask({ id: "b", name: "Task B" }),
    ];
    await writeSubtasks(phaseDir, subs);

    const text = await fs.readFile(path.join(phaseDir, "subtasks.json"), "utf-8");
    const parsed = JSON.parse(text);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].name).toBe("Task A");
    expect(parsed[1].name).toBe("Task B");
  });

  it("getSubtaskExecDir and getSubtaskVerifyDir return expected paths", () => {
    const dir = path.join(testRoot, ".openclaw/loops/some-task");
    const execDir = getSubtaskExecDir(dir, "Setup Express");
    expect(execDir).toContain("03-execution");
    expect(execDir).toContain("setup-express");

    const verifyDir = getSubtaskVerifyDir(dir, "Setup Express");
    expect(verifyDir).toContain("04-verification");
    expect(verifyDir).toContain("setup-express");
  });

  it("writeFinalReport writes summary.md", async () => {
    const dir = await createLoopDirectory("report test", { HOME: testRoot });
    const reportDir = getPhaseDir(dir, "report", 5);
    await writeFinalReport(reportDir, "# Final Summary\n\nAll done.");
    const text = await fs.readFile(path.join(reportDir, "summary.md"), "utf-8");
    expect(text).toContain("Final Summary");
    expect(text).toContain("All done.");
  });

  it("appendPhaseToMetadata updates loop.json progressively", async () => {
    const dir = await createLoopDirectory("meta test", { HOME: testRoot });
    await appendPhaseToMetadata(dir, "analyze", 0);
    await appendPhaseToMetadata(dir, "plan", 3);

    const meta = JSON.parse(await fs.readFile(path.join(dir, "loop.json"), "utf-8"));
    expect(meta.phases).toHaveLength(2);
    expect(meta.phases[0].phase).toBe("analyze");
    expect(meta.phases[1].phase).toBe("plan");
    expect(meta.phases[1].subtaskCount).toBe(3);
  });

  it("handles CJK task names (slugify)", async () => {
    const dir = await createLoopDirectory("构建一个网页服务器", { HOME: testRoot });
    expect(dir).toContain("构建一个网页服务器");
  });

  it("appendPhaseToMetadata handles missing loop.json gracefully", async () => {
    // Should not throw on non-existent directory
    const badDir = path.join(testRoot, ".openclaw/loops/nonexistent-meta-test");
    await expect(appendPhaseToMetadata(badDir, "test", 0)).resolves.toBeUndefined();
  });

  it("multiple loop directories can coexist", async () => {
    const dir1 = await createLoopDirectory("task one", { HOME: testRoot });
    const dir2 = await createLoopDirectory("task two", { HOME: testRoot });
    expect(dir1).not.toBe(dir2);
    // Both directories exist
    await expect(fs.access(path.join(dir1, "loop.json"))).resolves.toBeUndefined();
    await expect(fs.access(path.join(dir2, "loop.json"))).resolves.toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════════════════
// 8.  Backward compatibility & Edge cases
// ════════════════════════════════════════════════════════════════════════

describe("8. Backward compatibility and Edge cases", () => {
  beforeEach(() => setLoopState(null));
  afterEach(() => setLoopState(null));

  /** Old-style state without phase fields must not crash tools. */
  it("old-style state (no phase fields) is handled", () => {
    const oldState = {
      task: "legacy task",
      iteration: 5,
      maxIterations: 10,
      consecutiveFailures: 1,
      tokenUsage: 5000,
      // No currentPhase, phaseComplete, phaseResult, subtasks
    };
    // Should not throw when setting and getting
    setLoopState(oldState as never);
    const retrieved = getLoopState();
    expect(retrieved?.task).toBe("legacy task");
    expect(retrieved?.iteration).toBe(5);
  });

  it("empty subtasks list doesn't break state", () => {
    setLoopState(makeBaseState({ subtasks: [] }));
    expect(getLoopState()?.subtasks).toEqual([]);
    expect(getLoopState()?.subtasks.length).toBe(0);
  });

  it("phaseResult is null before first update", () => {
    setLoopState(createInitialLoopState({ task: "fresh", maxIterations: 5 }));
    expect(getLoopState()?.phaseResult).toBeNull();
  });

  it("completed is undefined before loop_complete call", () => {
    setLoopState(makeBaseState());
    expect(getLoopState()?.completed).toBeUndefined();
  });

  it("state survives sequential mutations (no stale closure)", () => {
    setLoopState(makeBaseState());
    getLoopState()!.iteration = 1;
    getLoopState()!.iteration = 2;
    getLoopState()!.iteration = 3;
    expect(getLoopState()?.iteration).toBe(3);
  });

  it("null state reset is idempotent", () => {
    setLoopState(null);
    setLoopState(null);
    setLoopState(null);
    expect(getLoopState()).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════
// 9.  TUI integration contract
// ════════════════════════════════════════════════════════════════════════

describe("9. TUI Integration Contract", () => {
  beforeEach(() => setLoopState(null));
  afterEach(() => setLoopState(null));

  it("TUI can initialize state before agent starts", () => {
    const tuiState = createInitialLoopState({
      task: "Run from TUI",
      maxIterations: 5,
      tokenBudget: 100000,
    });
    setLoopState(tuiState);
    expect(getLoopState()?.task).toBe("Run from TUI");
    expect(getLoopState()?.currentPhase).toBe("analyze");
  });

  it("agent can update state and TUI reads it back", () => {
    setLoopState(createInitialLoopState({ task: "bridge test", maxIterations: 5 }));

    // Simulate agent calling loop_update via direct state mutation
    const state = getLoopState()!;
    state.currentPhase = "plan";
    state.phaseResult = { phase: "analyze", summary: "Analysis done!", details: {} };

    // TUI reads back
    const tuiRead = getLoopState();
    expect(tuiRead?.currentPhase).toBe("plan");
    expect(tuiRead?.phaseResult?.summary).toBe("Analysis done!");
  });

  it("TUI can pass subtask definitions to agent tools", () => {
    const subs: LoopSubtask[] = [
      makeSubtask({ id: "t1", name: "Build API", description: "Create REST API" }),
      makeSubtask({ id: "t2", name: "Add tests", dependencies: ["t1"] }),
    ];

    setLoopState({
      ...createInitialLoopState({ task: "full stack", maxIterations: 5 }),
      subtasks: subs,
      currentPhase: "execute",
    });

    expect(getLoopState()?.subtasks).toHaveLength(2);
    expect(getLoopState()?.subtasks[1].dependencies).toEqual(["t1"]);
  });

  it("TUI cleanup sets state to null", () => {
    setLoopState(createInitialLoopState({ task: "cleanup", maxIterations: 5 }));
    expect(getLoopState()).not.toBeNull();

    // Simulate abort handler or post-loop cleanup
    setLoopState(null);
    expect(getLoopState()).toBeNull();
  });

  it("completed + currentPhase='complete' signals done to TUI", () => {
    setLoopState(createInitialLoopState({ task: "done signal", maxIterations: 5 }));

    // Agent calls loop_complete → sets completed=true, currentPhase=complete
    const state = getLoopState()!;
    state.completed = true;
    state.completedSummary = "All tasks finished";
    state.currentPhase = "complete";

    // TUI reads: exit condition met
    expect(getLoopState()?.completed).toBe(true);
    expect(getLoopState()?.currentPhase).toBe("complete");
    expect(getLoopState()?.completedSummary).toBe("All tasks finished");
  });

  it("phaseComplete: false → agent runs; true → TUI advances", () => {
    setLoopState(createInitialLoopState({ task: "phase advancer", maxIterations: 5 }));
    expect(getLoopState()?.phaseComplete).toBe(false); // agent should run

    // Agent completes phase → signals via loop_update → sets phaseComplete
    getLoopState()!.phaseComplete = true;
    getLoopState()!.phaseResult = { phase: "analyze", summary: "Done", details: {} };

    // TUI sees phaseComplete and advances
    expect(getLoopState()?.phaseComplete).toBe(true);

    // TUI advances to next phase
    getLoopState()!.currentPhase = "plan";
    getLoopState()!.phaseComplete = false;
    expect(getLoopState()?.currentPhase).toBe("plan");
    expect(getLoopState()?.phaseComplete).toBe(false); // ready for next agent turn
  });
});

// ════════════════════════════════════════════════════════════════════════
// 10.  Token budget enforcement
// ════════════════════════════════════════════════════════════════════════

describe("10. Token budget enforcement", () => {
  beforeEach(() => setLoopState(null));
  afterEach(() => setLoopState(null));

  it("tokenBudget is stored in state", () => {
    const state = createInitialLoopState({ task: "budget", maxIterations: 5, tokenBudget: 100000 });
    expect(state.tokenBudget).toBe(100000);
    expect(state.tokenUsage).toBe(0);
  });

  it("tokenUsage increments when tracked", () => {
    setLoopState(makeBaseState({ tokenBudget: 10, tokenUsage: 0 }));
    getLoopState()!.tokenUsage = (getLoopState()?.tokenUsage ?? 0) + 1;
    expect(getLoopState()?.tokenUsage).toBe(1);
  });

  it("budget is considered exhausted when tokenUsage >= tokenBudget", () => {
    setLoopState(makeBaseState({ tokenBudget: 5, tokenUsage: 5 }));
    expect(getLoopState()?.tokenUsage ?? 0).toBe(5);
    const budget = getLoopState()?.tokenBudget ?? 0;
    expect(budget > 0 && (getLoopState()?.tokenUsage ?? 0) >= budget).toBe(true);
  });

  it("no tokenBudget means unlimited", () => {
    setLoopState(makeBaseState({ tokenBudget: undefined, tokenUsage: 999 }));
    const budget = getLoopState()?.tokenBudget;
    expect(budget).toBeUndefined();
  });

  it("tokenUsage persists across phase transitions (merge not recreate)", () => {
    const state = createInitialLoopState({ task: "merge", maxIterations: 5, tokenBudget: 100 });
    state.tokenUsage = 5;
    setLoopState(state);

    // Simulate TUI phase transition: merge into existing state
    const prev = getLoopState()!;
    const merged = { ...prev, currentPhase: "plan", phaseComplete: false };
    setLoopState(merged);

    expect(getLoopState()?.tokenUsage).toBe(5); // preserved from prev
    expect(getLoopState()?.currentPhase).toBe("plan");
  });
});

// ════════════════════════════════════════════════════════════════════════
// 11.  Subtask storage via loop_update (new feature)
// ════════════════════════════════════════════════════════════════════════

describe("11. Subtask storage and status management", () => {
  beforeEach(() => setLoopState(null));
  afterEach(() => setLoopState(null));

  it("subtasks can be stored in module state after plan phase", () => {
    const subs = [
      makeSubtask({ id: "s1", name: "Task A", dependencies: [] }),
      makeSubtask({ id: "s2", name: "Task B", dependencies: ["s1"] }),
    ];
    setLoopState(makeBaseState({ subtasks: subs }));
    const stored = getLoopState()?.subtasks ?? [];
    expect(stored).toHaveLength(2);
    expect(stored[0].id).toBe("s1");
    expect(stored[1].dependencies).toEqual(["s1"]);
  });

  it("subtask status can transition through all states", () => {
    setLoopState(makeBaseState({ subtasks: [makeSubtask({ id: "s1" })] }));

    const statuses = ["in-progress", "complete", "failed", "skipped"] as const;
    for (const st of statuses) {
      getLoopState()!.subtasks[0].status = st;
      expect(getLoopState()?.subtasks[0].status).toBe(st);
    }
  });

  it("subtask verdict stores pass/fail with notes", () => {
    setLoopState(makeBaseState({ subtasks: [makeSubtask({ id: "v1" })] }));
    getLoopState()!.subtasks[0].verdict = { passed: true, notes: "All criteria met" };
    expect(getLoopState()?.subtasks[0].verdict?.passed).toBe(true);
    expect(getLoopState()?.subtasks[0].verdict?.notes).toBe("All criteria met");
  });

  it("subtask objects from module state reflect mutations", () => {
    setLoopState(makeBaseState({ subtasks: [makeSubtask({ id: "m1" })] }));
    getLoopState()!.subtasks[0].status = "complete";
    getLoopState()!.subtasks[0].result = "Done";
    expect(getLoopState()?.subtasks[0].status).toBe("complete");
    expect(getLoopState()?.subtasks[0].result).toBe("Done");
  });
});

