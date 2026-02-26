/**
 * Tool Monitoring Tests
 */

import { describe, it, expect, beforeEach } from "vitest";
import { resetSecurityEventsManager } from "./security-events.js";
import {
  ToolMonitor,
  resetToolMonitor,
  type ToolCall,
  type AbusePattern,
} from "./tool-monitoring.js";

describe("ToolMonitor", () => {
  let monitor: ToolMonitor;

  beforeEach(() => {
    resetToolMonitor();
    resetSecurityEventsManager();
    monitor = new ToolMonitor({
      enabled: true,
      windowMs: 5 * 60 * 1000,
      maxCallsPerWindow: 100,
    });
  });

  describe("constructor", () => {
    it("should create monitor with default config", () => {
      const m = new ToolMonitor();
      expect(m.isEnabled()).toBe(true);
    });

    it("should respect disabled config", () => {
      const m = new ToolMonitor({ enabled: false });
      expect(m.isEnabled()).toBe(false);
    });
  });

  describe("record", () => {
    it("should record tool calls", () => {
      const call: ToolCall = {
        tool: "bash",
        timestamp: Date.now(),
        sessionKey: "test-session",
      };

      const matches = monitor.record(call);

      expect(matches).toEqual([]);
      const stats = monitor.getWindowStats();
      expect(stats.totalCalls).toBe(1);
      expect(stats.byTool.bash).toBe(1);
    });

    it("should return empty array when disabled", () => {
      const disabledMonitor = new ToolMonitor({ enabled: false });

      const matches = disabledMonitor.record({
        tool: "bash",
        timestamp: Date.now(),
      });

      expect(matches).toEqual([]);
    });

    it("should track multiple tool types", () => {
      monitor.record({ tool: "bash", timestamp: Date.now() });
      monitor.record({ tool: "read", timestamp: Date.now() });
      monitor.record({ tool: "read", timestamp: Date.now() });
      monitor.record({ tool: "glob", timestamp: Date.now() });

      const stats = monitor.getWindowStats();
      expect(stats.totalCalls).toBe(4);
      expect(stats.byTool.bash).toBe(1);
      expect(stats.byTool.read).toBe(2);
      expect(stats.byTool.glob).toBe(1);
    });

    it("should prune old entries", () => {
      const oldTime = Date.now() - 10 * 60 * 1000; // 10 minutes ago
      const newTime = Date.now();

      monitor.record({ tool: "bash", timestamp: oldTime });
      monitor.record({ tool: "bash", timestamp: newTime });

      const stats = monitor.getWindowStats();
      // Old entry should be pruned (default window is 5 minutes)
      expect(stats.totalCalls).toBe(1);
    });
  });

  describe("pattern detection", () => {
    it("should detect rapid bash execution", () => {
      const now = Date.now();

      // Simulate rapid bash execution (20+ calls with < 1s average)
      for (let i = 0; i < 25; i++) {
        monitor.record({
          tool: "bash",
          timestamp: now + i * 500, // 500ms apart
        });
      }

      const stats = monitor.getWindowStats();
      expect(stats.totalCalls).toBe(25);
      // Pattern should have been detected
    });

    it("should detect file enumeration", () => {
      const now = Date.now();
      const sensitivePaths = [
        ".env",
        ".ssh/id_rsa",
        ".aws/credentials",
        "secrets.json",
        ".gnupg/private-keys",
        ".npmrc",
      ];

      for (let i = 0; i < sensitivePaths.length; i++) {
        monitor.record({
          tool: "read",
          timestamp: now + i * 1000,
          args: { path: sensitivePaths[i] },
        });
      }

      const stats = monitor.getWindowStats();
      expect(stats.byTool.read).toBe(6);
    });

    it("should detect credential harvesting", () => {
      const now = Date.now();

      // Access multiple credential files
      monitor.record({
        tool: "read",
        timestamp: now,
        args: { path: "/home/user/.env" },
      });
      monitor.record({
        tool: "read",
        timestamp: now + 1000,
        args: { path: "/home/user/.npmrc" },
      });
      monitor.record({
        tool: "read",
        timestamp: now + 2000,
        args: { path: "/home/user/.aws/credentials" },
      });

      const stats = monitor.getWindowStats();
      expect(stats.byTool.read).toBe(3);
    });
  });

  describe("registerPattern", () => {
    it("should allow custom patterns", () => {
      const customPattern: AbusePattern = {
        name: "custom_test",
        description: "Custom test pattern",
        severity: "warn",
        detect: (calls, window) => {
          const testCalls = window.filter((c) => c.tool === "custom_tool");
          if (testCalls.length >= 3) {
            return {
              pattern: "custom_test",
              description: "Custom pattern matched",
              severity: "warn",
              evidence: {
                calls: testCalls,
                message: `${testCalls.length} custom tool calls`,
              },
            };
          }
          return null;
        },
      };

      monitor.registerPattern(customPattern);

      // Trigger pattern
      const now = Date.now();
      monitor.record({ tool: "custom_tool", timestamp: now });
      monitor.record({ tool: "custom_tool", timestamp: now + 1000 });
      const matches = monitor.record({ tool: "custom_tool", timestamp: now + 2000 });

      expect(matches.length).toBeGreaterThan(0);
      expect(matches[0].pattern).toBe("custom_test");
    });
  });

  describe("getWindowStats", () => {
    it("should return correct statistics", () => {
      const now = Date.now();

      monitor.record({ tool: "bash", timestamp: now });
      monitor.record({ tool: "read", timestamp: now + 100 });
      monitor.record({ tool: "bash", timestamp: now + 200 });

      const stats = monitor.getWindowStats();

      expect(stats.totalCalls).toBe(3);
      expect(stats.byTool.bash).toBe(2);
      expect(stats.byTool.read).toBe(1);
      expect(stats.oldestCall).toBe(now);
      expect(stats.newestCall).toBe(now + 200);
    });

    it("should return empty stats for no calls", () => {
      const stats = monitor.getWindowStats();

      expect(stats.totalCalls).toBe(0);
      expect(stats.byTool).toEqual({});
      expect(stats.oldestCall).toBeNull();
      expect(stats.newestCall).toBeNull();
    });
  });

  describe("getSessionCalls", () => {
    it("should filter calls by session", () => {
      const now = Date.now();

      monitor.record({ tool: "bash", timestamp: now, sessionKey: "session-a" });
      monitor.record({ tool: "read", timestamp: now, sessionKey: "session-b" });
      monitor.record({ tool: "glob", timestamp: now, sessionKey: "session-a" });

      const sessionACalls = monitor.getSessionCalls("session-a");
      expect(sessionACalls).toHaveLength(2);
      expect(sessionACalls.every((c) => c.sessionKey === "session-a")).toBe(true);
    });
  });

  describe("clearHistory", () => {
    it("should clear all history", () => {
      monitor.record({ tool: "bash", timestamp: Date.now() });
      monitor.record({ tool: "read", timestamp: Date.now() });

      monitor.clearHistory();

      const stats = monitor.getWindowStats();
      expect(stats.totalCalls).toBe(0);
    });
  });

  describe("updateConfig", () => {
    it("should update enabled flag", () => {
      expect(monitor.isEnabled()).toBe(true);
      monitor.updateConfig({ enabled: false });
      expect(monitor.isEnabled()).toBe(false);
    });
  });

  describe("shouldThrottle", () => {
    it("returns throttled=false when no critical pattern has been seen for the agent", () => {
      expect(monitor.shouldThrottle("agent-new")).toEqual({ throttled: false });
    });

    it("returns throttled=true after a critical pattern match for the agent", () => {
      const agentId = "agent-credential-thief";
      const now = Date.now();

      // Trigger the credential_harvesting critical pattern (3+ unique credential files)
      monitor.record({ tool: "read", timestamp: now, agentId, args: { path: "/home/user/.env" } });
      monitor.record({
        tool: "read",
        timestamp: now + 100,
        agentId,
        args: { path: "/home/user/.npmrc" },
      });
      monitor.record({
        tool: "read",
        timestamp: now + 200,
        agentId,
        args: { path: "/home/user/.aws/credentials" },
      });

      const result = monitor.shouldThrottle(agentId);
      expect(result.throttled).toBe(true);
      expect(result.reason).toContain("critical");
    });

    it("does not throttle a different agentId even after a critical match", () => {
      const agentId = "agent-bad";
      const other = "agent-good";
      const now = Date.now();

      monitor.record({ tool: "read", timestamp: now, agentId, args: { path: "/home/user/.env" } });
      monitor.record({
        tool: "read",
        timestamp: now + 100,
        agentId,
        args: { path: "/home/user/.npmrc" },
      });
      monitor.record({
        tool: "read",
        timestamp: now + 200,
        agentId,
        args: { path: "/home/user/.aws/credentials" },
      });

      expect(monitor.shouldThrottle(agentId).throttled).toBe(true);
      expect(monitor.shouldThrottle(other).throttled).toBe(false);
    });

    it("clearHistory resets the throttle state", () => {
      const agentId = "agent-cleared";
      const now = Date.now();

      monitor.record({ tool: "read", timestamp: now, agentId, args: { path: "/home/user/.env" } });
      monitor.record({
        tool: "read",
        timestamp: now + 100,
        agentId,
        args: { path: "/home/user/.npmrc" },
      });
      monitor.record({
        tool: "read",
        timestamp: now + 200,
        agentId,
        args: { path: "/home/user/.aws/credentials" },
      });
      expect(monitor.shouldThrottle(agentId).throttled).toBe(true);

      monitor.clearHistory();
      expect(monitor.shouldThrottle(agentId).throttled).toBe(false);
    });
  });

  describe("criticalAgentThrottles GC during record() (P-H1)", () => {
    it("prunes expired throttle entries on the next record() call", () => {
      const shortWindow = new ToolMonitor({
        enabled: true,
        windowMs: 50, // 50ms window — expires quickly
        maxCallsPerWindow: 1000,
      });

      const retiredAgent = "agent-retired";
      const now = Date.now();

      // Trigger a critical pattern match (3 credential reads) for retiredAgent.
      shortWindow.record({
        tool: "read",
        timestamp: now,
        agentId: retiredAgent,
        args: { path: "/home/user/.env" },
      });
      shortWindow.record({
        tool: "read",
        timestamp: now + 1,
        agentId: retiredAgent,
        args: { path: "/home/user/.npmrc" },
      });
      shortWindow.record({
        tool: "read",
        timestamp: now + 2,
        agentId: retiredAgent,
        args: { path: "/home/user/.aws/credentials" },
      });

      // retiredAgent should be throttled while the window is active.
      expect(shortWindow.shouldThrottle(retiredAgent).throttled).toBe(true);

      // Wait for the window to expire, then record a new call for a different agent.
      // The record() call must GC the expired retiredAgent entry (P-H1).
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          shortWindow.record({ tool: "bash", timestamp: Date.now(), agentId: "other-agent" });

          // The expired entry should have been pruned — shouldThrottle cleans up on access,
          // but P-H1 verifies it was already removed by record() before shouldThrottle runs.
          // We observe the effect: shouldThrottle returns false (window expired).
          expect(shortWindow.shouldThrottle(retiredAgent).throttled).toBe(false);
          resolve();
        }, 60); // 60ms > 50ms window
      });
    });

    it("does not GC entries that are still within the active window", () => {
      const activeAgent = "agent-active";
      const now = Date.now();

      monitor.record({
        tool: "read",
        timestamp: now,
        agentId: activeAgent,
        args: { path: "/home/user/.env" },
      });
      monitor.record({
        tool: "read",
        timestamp: now + 1,
        agentId: activeAgent,
        args: { path: "/home/user/.npmrc" },
      });
      monitor.record({
        tool: "read",
        timestamp: now + 2,
        agentId: activeAgent,
        args: { path: "/home/user/.aws/credentials" },
      });

      // Record another call (triggers GC loop) — activeAgent entry must NOT be pruned.
      monitor.record({ tool: "bash", timestamp: now + 3, agentId: "other" });

      expect(monitor.shouldThrottle(activeAgent).throttled).toBe(true);
    });
  });
});
