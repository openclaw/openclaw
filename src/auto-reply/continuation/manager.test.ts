import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { clearCompletionHandlers, processCompletion } from "./registry.js";
import {
  clearManagerState,
  clearSessionGoal,
  getManagedSession,
  getSessionSignals,
  initContinuationManager,
  isManagerInitialized,
  registerSignalDetector,
  resetSignalDetectors,
  setSessionGoal,
  stopContinuationManager,
  type ContinuationSignal,
} from "./manager.js";
import type { CompletionEvent, GoalState } from "./types.js";

describe("continuation/manager", () => {
  beforeEach(() => {
    clearCompletionHandlers();
    clearManagerState();
  });

  afterEach(() => {
    stopContinuationManager();
    clearCompletionHandlers();
    clearManagerState();
    resetSignalDetectors();
  });

  describe("initContinuationManager", () => {
    it("initializes the manager", () => {
      expect(isManagerInitialized()).toBe(false);
      initContinuationManager();
      expect(isManagerInitialized()).toBe(true);
    });

    it("is idempotent", () => {
      initContinuationManager();
      initContinuationManager();
      expect(isManagerInitialized()).toBe(true);
    });

    it("returns stop function", () => {
      const stop = initContinuationManager();
      expect(isManagerInitialized()).toBe(true);
      stop();
      expect(isManagerInitialized()).toBe(false);
    });
  });

  describe("stopContinuationManager", () => {
    it("stops the manager", () => {
      initContinuationManager();
      expect(isManagerInitialized()).toBe(true);
      stopContinuationManager();
      expect(isManagerInitialized()).toBe(false);
    });
  });

  describe("setSessionGoal / clearSessionGoal", () => {
    it("stores goal for session", () => {
      const goal: GoalState = {
        id: "goal-1",
        description: "Complete the task",
        status: "active",
        progress: 0,
        turnsUsed: 0,
        maxTurns: 10,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      setSessionGoal("sess-key", goal);
      const session = getManagedSession("sess-key");

      expect(session).toBeDefined();
      expect(session?.goal).toEqual(goal);
    });

    it("clears goal for session", () => {
      const goal: GoalState = {
        id: "goal-1",
        description: "Test",
        status: "active",
        progress: 0,
        turnsUsed: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      setSessionGoal("sess-key", goal);
      clearSessionGoal("sess-key");

      const session = getManagedSession("sess-key");
      // Session removed since turnCount is 0
      expect(session).toBeUndefined();
    });
  });

  describe("signal detection", () => {
    beforeEach(() => {
      initContinuationManager();
    });

    it("detects tool errors", async () => {
      const event: CompletionEvent = {
        level: "turn",
        runId: "run-1",
        sessionId: "sess-1",
        sessionKey: "test-key",
        timestamp: Date.now(),
        assistantTexts: ["Response"],
        toolMetas: [{ toolName: "bash" }],
        didSendViaMessagingTool: false,
        lastToolError: { toolName: "exec", error: "Command failed" },
      };

      await processCompletion(event);

      const signals = getSessionSignals("test-key");
      expect(signals.length).toBeGreaterThan(0);
      expect(signals.some((s) => s.reason.includes("Tool error"))).toBe(true);
    });

    it("detects silent completions", async () => {
      const event: CompletionEvent = {
        level: "turn",
        runId: "run-1",
        sessionId: "sess-1",
        sessionKey: "silent-key",
        timestamp: Date.now(),
        assistantTexts: [],
        toolMetas: [],
        didSendViaMessagingTool: false,
      };

      await processCompletion(event);

      const signals = getSessionSignals("silent-key");
      expect(signals.some((s) => s.reason.includes("Silent completion"))).toBe(true);
    });

    it("tracks turn count", async () => {
      const makeEvent = (n: number): CompletionEvent => ({
        level: "turn",
        runId: `run-${n}`,
        sessionId: "sess-1",
        sessionKey: "count-key",
        timestamp: Date.now(),
        assistantTexts: ["Response"],
        toolMetas: [],
        didSendViaMessagingTool: true,
      });

      await processCompletion(makeEvent(1));
      await processCompletion(makeEvent(2));
      await processCompletion(makeEvent(3));

      const session = getManagedSession("count-key");
      expect(session?.turnCount).toBe(3);
    });

    it("enforces maxTurns on active goal", async () => {
      const goal: GoalState = {
        id: "goal-limited",
        description: "Limited task",
        status: "active",
        progress: 0,
        turnsUsed: 0,
        maxTurns: 2,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      setSessionGoal("limited-key", goal);

      const makeEvent = (): CompletionEvent => ({
        level: "turn",
        runId: "run",
        sessionId: "sess",
        sessionKey: "limited-key",
        timestamp: Date.now(),
        assistantTexts: ["Response"],
        toolMetas: [],
        didSendViaMessagingTool: true,
      });

      // First turn - should be fine
      const result1 = await processCompletion(makeEvent());
      expect(result1.action).toBe("none");

      // Second turn - hits limit
      const result2 = await processCompletion(makeEvent());
      expect(result2.action).toBe("none");
      expect(result2.reason).toContain("Max turns");
      expect(result2.goalUpdate?.status).toBe("paused");
    });
  });

  describe("registerSignalDetector", () => {
    beforeEach(() => {
      initContinuationManager();
    });

    it("allows custom detectors", async () => {
      const customDetector = (event: CompletionEvent): ContinuationSignal | null => {
        if (event.level === "turn" && event.assistantTexts.includes("SPECIAL")) {
          return {
            level: "turn",
            reason: "Special keyword detected",
            confidence: 0.9,
            suggestedPrompt: "Handle special case",
          };
        }
        return null;
      };

      const unregister = registerSignalDetector(customDetector);

      const event: CompletionEvent = {
        level: "turn",
        runId: "run-1",
        sessionId: "sess-1",
        sessionKey: "custom-key",
        timestamp: Date.now(),
        assistantTexts: ["SPECIAL"],
        toolMetas: [],
        didSendViaMessagingTool: true,
      };

      await processCompletion(event);

      const signals = getSessionSignals("custom-key");
      expect(signals.some((s) => s.reason === "Special keyword detected")).toBe(true);

      unregister();
    });

    it("unregisters custom detectors", async () => {
      const customDetector = (): ContinuationSignal => ({
        level: "turn",
        reason: "Always fires",
        confidence: 0.5,
      });

      const unregister = registerSignalDetector(customDetector);
      unregister();

      const event: CompletionEvent = {
        level: "turn",
        runId: "run-1",
        sessionId: "sess-1",
        sessionKey: "unregistered-key",
        timestamp: Date.now(),
        assistantTexts: ["Test"],
        toolMetas: [],
        didSendViaMessagingTool: true,
      };

      await processCompletion(event);

      // Should only have built-in silent detection (no text, but sent via tool)
      const signals = getSessionSignals("unregistered-key");
      expect(signals.every((s) => s.reason !== "Always fires")).toBe(true);
    });
  });

  describe("continuation decisions", () => {
    beforeEach(() => {
      initContinuationManager();
    });

    it("auto-continues with active goal and high confidence signal", async () => {
      const goal: GoalState = {
        id: "active-goal",
        description: "Active task",
        status: "active",
        progress: 0,
        turnsUsed: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      setSessionGoal("active-key", goal);

      // Register a high-confidence detector
      registerSignalDetector(() => ({
        level: "turn",
        reason: "High confidence issue",
        confidence: 0.8,
        suggestedPrompt: "Please retry",
      }));

      const event: CompletionEvent = {
        level: "turn",
        runId: "run-1",
        sessionId: "sess-1",
        sessionKey: "active-key",
        timestamp: Date.now(),
        assistantTexts: ["Response"],
        toolMetas: [],
        didSendViaMessagingTool: true,
      };

      const result = await processCompletion(event);
      expect(result.action).toBe("enqueue");
      expect(result.nextPrompt).toBe("Please retry");
    });

    it("does not auto-continue without active goal", async () => {
      // Register a high-confidence detector
      registerSignalDetector(() => ({
        level: "turn",
        reason: "High confidence issue",
        confidence: 0.8,
        suggestedPrompt: "Please retry",
      }));

      const event: CompletionEvent = {
        level: "turn",
        runId: "run-1",
        sessionId: "sess-1",
        sessionKey: "no-goal-key",
        timestamp: Date.now(),
        assistantTexts: ["Response"],
        toolMetas: [],
        didSendViaMessagingTool: true,
      };

      const result = await processCompletion(event);
      expect(result.action).toBe("none");
    });

    it("does not auto-continue with low confidence signal", async () => {
      const goal: GoalState = {
        id: "active-goal",
        description: "Active task",
        status: "active",
        progress: 0,
        turnsUsed: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      setSessionGoal("low-conf-key", goal);

      // The built-in silent detector has low confidence (0.3)
      const event: CompletionEvent = {
        level: "turn",
        runId: "run-1",
        sessionId: "sess-1",
        sessionKey: "low-conf-key",
        timestamp: Date.now(),
        assistantTexts: [],
        toolMetas: [],
        didSendViaMessagingTool: false,
      };

      const result = await processCompletion(event);
      // Should not auto-continue because confidence is below 0.7
      expect(result.action).toBe("none");
    });
  });

  describe("clearManagerState", () => {
    it("clears all session data", () => {
      setSessionGoal("sess-1", {
        id: "goal-1",
        description: "Test",
        status: "active",
        progress: 0,
        turnsUsed: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      setSessionGoal("sess-2", {
        id: "goal-2",
        description: "Test 2",
        status: "active",
        progress: 0,
        turnsUsed: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      expect(getManagedSession("sess-1")).toBeDefined();
      expect(getManagedSession("sess-2")).toBeDefined();

      clearManagerState();

      expect(getManagedSession("sess-1")).toBeUndefined();
      expect(getManagedSession("sess-2")).toBeUndefined();
    });
  });
});
