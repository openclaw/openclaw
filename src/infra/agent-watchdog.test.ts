import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { AgentWatchdog, getGlobalWatchdog, stopGlobalWatchdog } from "./agent-watchdog.js";

vi.mock("./agent-lifecycle.js", () => ({
  emitStalled: vi.fn(),
  emitRecovered: vi.fn(),
}));

import { emitStalled, emitRecovered } from "./agent-lifecycle.js";

describe("AgentWatchdog", () => {
  let watchdog: AgentWatchdog;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    // Reset global watchdog
    stopGlobalWatchdog();
  });

  afterEach(() => {
    watchdog?.stop();
    vi.useRealTimers();
  });

  describe("constructor", () => {
    it("creates watchdog with default config", () => {
      watchdog = new AgentWatchdog();
      expect(watchdog.running).toBe(false);
    });

    it("creates watchdog with custom config", () => {
      watchdog = new AgentWatchdog({
        stalledThresholdMs: 30000,
        checkIntervalMs: 5000,
        enabled: true,
      });
      expect(watchdog.running).toBe(false);
    });

    it("accepts disabled config", () => {
      watchdog = new AgentWatchdog({ enabled: false });
      watchdog.start();
      expect(watchdog.running).toBe(false);
    });
  });

  describe("registerAgent", () => {
    it("registers a new agent", () => {
      watchdog = new AgentWatchdog({ enabled: true });
      watchdog.registerAgent({
        runId: "run-123",
        sessionKey: "session-abc",
        agentId: "agent-def",
      });

      const state = watchdog.getAgentState("run-123");
      expect(state).toBeDefined();
      expect(state?.runId).toBe("run-123");
      expect(state?.sessionKey).toBe("session-abc");
      expect(state?.agentId).toBe("agent-def");
      expect(state?.isStalled).toBe(false);
    });

    it("tracks multiple agents", () => {
      watchdog = new AgentWatchdog({ enabled: true });
      watchdog.registerAgent({ runId: "run-1" });
      watchdog.registerAgent({ runId: "run-2" });

      expect(watchdog.getAgentState("run-1")).toBeDefined();
      expect(watchdog.getAgentState("run-2")).toBeDefined();
      expect(watchdog.getMonitoredCount()).toBe(2);
    });
  });

  describe("unregisterAgent", () => {
    it("removes agent from monitoring", () => {
      watchdog = new AgentWatchdog({ enabled: true });
      watchdog.registerAgent({ runId: "run-123" });
      watchdog.unregisterAgent("run-123");

      expect(watchdog.getAgentState("run-123")).toBeUndefined();
      expect(watchdog.getMonitoredCount()).toBe(0);
    });
  });

  describe("recordActivity", () => {
    it("updates last activity timestamp", () => {
      watchdog = new AgentWatchdog({ enabled: true });
      const startedAt = Date.now() - 5000;
      watchdog.registerAgent({ runId: "run-123", startedAt });

      vi.advanceTimersByTime(1000);
      watchdog.recordActivity("run-123", "tool-execution");

      const state = watchdog.getAgentState("run-123");
      expect(state?.lastActivity).toBe("tool-execution");
    });

    it("emits recovered event when stalled agent becomes active", () => {
      watchdog = new AgentWatchdog({ enabled: true });
      watchdog.registerAgent({ runId: "run-123" });

      // Simulate stall
      const state = watchdog.getAgentState("run-123");
      if (state) {
        state.isStalled = true;
        state.stalledAt = Date.now() - 65000;
      }

      watchdog.recordActivity("run-123");

      expect(emitRecovered).toHaveBeenCalled();
    });
  });

  describe("start/stop", () => {
    it("starts and stops the watchdog", () => {
      watchdog = new AgentWatchdog({ enabled: true });
      watchdog.start();
      expect(watchdog.running).toBe(true);

      watchdog.stop();
      expect(watchdog.running).toBe(false);
    });

    it("does not start when disabled", () => {
      watchdog = new AgentWatchdog({ enabled: false });
      watchdog.start();
      expect(watchdog.running).toBe(false);
    });
  });

  describe("stall detection", () => {
    it("detects stalled agent after threshold", () => {
      watchdog = new AgentWatchdog({
        enabled: true,
        stalledThresholdMs: 5000,
        checkIntervalMs: 1000,
      });

      watchdog.registerAgent({ runId: "run-123" });
      watchdog.start();

      // Advance time past threshold
      vi.advanceTimersByTime(6000);

      expect(emitStalled).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: "run-123",
          stalledDurationMs: expect.any(Number),
        }),
      );
    });

    it("does not detect stall before threshold", () => {
      watchdog = new AgentWatchdog({
        enabled: true,
        stalledThresholdMs: 10000,
        checkIntervalMs: 1000,
      });

      watchdog.registerAgent({ runId: "run-123" });
      watchdog.start();

      // Advance time but not past threshold
      vi.advanceTimersByTime(5000);

      expect(emitStalled).not.toHaveBeenCalled();
    });
  });

  describe("getGlobalWatchdog", () => {
    it("returns singleton instance", () => {
      const wd1 = getGlobalWatchdog();
      const wd2 = getGlobalWatchdog();
      expect(wd1).toBe(wd2);
    });

    it("warns when config is provided but singleton exists", () => {
      const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      getGlobalWatchdog({ stalledThresholdMs: 30000 });
      getGlobalWatchdog({ stalledThresholdMs: 60000 });

      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });
  });

  describe("stopGlobalWatchdog", () => {
    it("resets singleton so new instance is created on next call", () => {
      const wd1 = getGlobalWatchdog();
      stopGlobalWatchdog();
      const wd2 = getGlobalWatchdog();

      // Should be a new instance, not the same one
      expect(wd1).not.toBe(wd2);
    });
  });
});
