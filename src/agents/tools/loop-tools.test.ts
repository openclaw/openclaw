// Loop tools tests cover loop state management and tool responses.
import { beforeEach, describe, expect, it } from "vitest";
import {
  createLoopStatusTool,
  createLoopCompleteTool,
  createLoopPhaseTool,
  createLoopUpdateTool,
  setLoopState,
  getLoopState,
} from "./loop-tools.js";

describe("loop tools", () => {
  beforeEach(() => {
    setLoopState(null);
  });

  describe("loop_status", () => {
    it("returns inactive state when no loop is active", async () => {
      const tool = createLoopStatusTool();
      const result = await tool.execute("call-1", {});
      const details = result.details as Record<string, unknown>;
      expect((details as { active?: boolean }).active).toBe(false);
    });

    it("returns loop state when active", async () => {
      setLoopState({
        task: "build a web server",
        iteration: 2,
        maxIterations: 5,
        consecutiveFailures: 0,
        tokenUsage: 1000,
        tokenBudget: 50000,
        currentPhase: "execute",
        phaseComplete: false,
        phaseResult: null,
        subtasks: [],
      });
      const tool = createLoopStatusTool();
      const result = await tool.execute("call-1", {});
      const details = result.details as Record<string, unknown>;
      expect(details).toMatchObject({
        active: true,
        task: "build a web server",
        iteration: 2,
        maxIterations: 5,
        remainingIterations: 3,
        consecutiveFailures: 0,
      });
    });
  });

  describe("loop_complete", () => {
    it("marks loop as completed on the shared state", async () => {
      setLoopState({
        task: "deploy the app",
        iteration: 3,
        maxIterations: 10,
        consecutiveFailures: 0,
        tokenUsage: 5000,
        completed: false,
        currentPhase: "execute",
        phaseComplete: false,
        phaseResult: null,
        subtasks: [],
      });
      const tool = createLoopCompleteTool();
      const result = await tool.execute("call-2", { summary: "App deployed to production" });

      const details = result.details as Record<string, unknown>;
      expect(details).toMatchObject({
        acknowledged: true,
        task: "deploy the app",
        summary: "App deployed to production",
      });

      // The shared state should be mutated
      const shared = getLoopState();
      expect(shared?.completed).toBe(true);
      expect(shared?.completedSummary).toBe("App deployed to production");
    });

    it("works without an active loop state", async () => {
      setLoopState(null);
      const tool = createLoopCompleteTool();
      const result = await tool.execute("call-3", { summary: "done" });
      const details = result.details as Record<string, unknown>;
      expect(details).toMatchObject({
        acknowledged: true,
        summary: "done",
      });
      // Should not throw when state is null
    });
  });

  describe("loop_phase", () => {
    it("returns inactive when no loop state", async () => {
      const tool = createLoopPhaseTool();
      const result = await tool.execute("call-1", {});
      const details = result.details as Record<string, unknown>;
      expect((details as { active?: boolean }).active).toBe(false);
    });

    it("returns phase info when active", async () => {
      setLoopState({
        task: "refactor auth",
        iteration: 0,
        maxIterations: 5,
        consecutiveFailures: 0,
        tokenUsage: 0,
        currentPhase: "plan",
        phaseComplete: false,
        phaseResult: null,
        subtasks: [
          {
            id: "task-1",
            name: "update login",
            description: "Refactor login controller",
            acceptanceCriteria: ["works", "tested"],
            dependencies: [],
            parallelizable: false,
            status: "complete",
          },
        ],
      });
      const tool = createLoopPhaseTool();
      const result = await tool.execute("call-2", {});
      const details = result.details as Record<string, unknown>;
      expect(details).toMatchObject({
        active: true,
        currentPhase: "plan",
        phaseComplete: false,
      });
    });
  });

  describe("loop_update", () => {
    it("phase_complete marks phase as done", async () => {
      setLoopState({
        task: "build api",
        iteration: 0,
        maxIterations: 5,
        consecutiveFailures: 0,
        tokenUsage: 0,
        currentPhase: "analyze",
        phaseComplete: false,
        phaseResult: null,
        subtasks: [],
      });
      const tool = createLoopUpdateTool();
      const result = await tool.execute("call-1", {
        action: "phase_complete",
        phase: "analyze",
        summary: "Analysis done. Found 3 key files.",
      });

      const details = result.details as Record<string, unknown>;
      expect(details).toMatchObject({
        acknowledged: true,
        action: "phase_complete",
      });

      const state = getLoopState();
      expect(state?.phaseComplete).toBe(true);
      expect(state?.phaseResult?.summary).toBe("Analysis done. Found 3 key files.");
    });

    it("subtask_status updates subtask state", async () => {
      setLoopState({
        task: "build api",
        iteration: 0,
        maxIterations: 5,
        consecutiveFailures: 0,
        tokenUsage: 0,
        currentPhase: "execute",
        phaseComplete: false,
        phaseResult: null,
        subtasks: [
          {
            id: "task-1",
            name: "create endpoint",
            description: "Create the API endpoint",
            acceptanceCriteria: ["works"],
            dependencies: [],
            parallelizable: false,
            status: "pending",
          },
        ],
      });
      const tool = createLoopUpdateTool();
      await tool.execute("call-2", {
        action: "subtask_status",
        subtaskId: "task-1",
        subtaskStatus: "complete",
        result: "Created the endpoint",
      });

      const state = getLoopState()!;
      expect(state.subtasks[0].status).toBe("complete");
      expect(state.subtasks[0].result).toBe("Created the endpoint");
    });

    it("returns error for unknown action", async () => {
      setLoopState({
        task: "test",
        iteration: 0,
        maxIterations: 5,
        consecutiveFailures: 0,
        tokenUsage: 0,
        currentPhase: "analyze",
        phaseComplete: false,
        phaseResult: null,
        subtasks: [],
      });
      const tool = createLoopUpdateTool();
      const result = await tool.execute("call-3", { action: "unknown" });
      const details = result.details as Record<string, unknown>;
      expect(details).toMatchObject({ acknowledged: false });
    });

    it("returns error when no active loop", async () => {
      setLoopState(null);
      const tool = createLoopUpdateTool();
      const result = await tool.execute("call-4", { action: "phase_complete" });
      const details = result.details as Record<string, unknown>;
      expect(details).toMatchObject({ acknowledged: false });
    });
  });
});
