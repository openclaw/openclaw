/**
 * Session Monitoring Tests
 */

import { describe, it, expect, beforeEach } from "vitest";
import { resetSecurityEventsManager } from "./security-events.js";
import { SessionRiskMonitor, resetSessionRiskMonitor, RISK_FACTORS } from "./session-monitoring.js";

describe("SessionRiskMonitor", () => {
  let monitor: SessionRiskMonitor;

  beforeEach(() => {
    resetSessionRiskMonitor();
    resetSecurityEventsManager();
    monitor = new SessionRiskMonitor({
      enabled: true,
      threshold: 70,
      sessionExpiryMs: 60 * 60 * 1000,
      decayPerMinute: 1,
    });
  });

  describe("constructor", () => {
    it("should create monitor with default config", () => {
      const m = new SessionRiskMonitor();
      expect(m.isEnabled()).toBe(true);
    });

    it("should respect disabled config", () => {
      const m = new SessionRiskMonitor({ enabled: false });
      expect(m.isEnabled()).toBe(false);
    });
  });

  describe("addRiskFactor", () => {
    it("should add risk factor to session", () => {
      const profile = monitor.addRiskFactor("session-1", "BASH_EXECUTION");

      expect(profile.sessionKey).toBe("session-1");
      expect(profile.totalScore).toBe(RISK_FACTORS.BASH_EXECUTION.baseScore);
      expect(profile.factors).toHaveLength(1);
    });

    it("should accumulate risk scores", () => {
      monitor.addRiskFactor("session-1", "BASH_EXECUTION");
      monitor.addRiskFactor("session-1", "SENSITIVE_FILE_ACCESS");
      const profile = monitor.addRiskFactor("session-1", "NETWORK_COMMAND");

      const expectedScore =
        RISK_FACTORS.BASH_EXECUTION.baseScore +
        RISK_FACTORS.SENSITIVE_FILE_ACCESS.baseScore +
        RISK_FACTORS.NETWORK_COMMAND.baseScore;

      expect(profile.totalScore).toBe(expectedScore);
      expect(profile.factors).toHaveLength(3);
    });

    it("should accept custom score", () => {
      const profile = monitor.addRiskFactor("session-1", "BASH_EXECUTION", {
        score: 100,
      });

      expect(profile.totalScore).toBe(100);
    });

    it("should track agent ID", () => {
      const profile = monitor.addRiskFactor("session-1", "BASH_EXECUTION", {
        agentId: "agent-1",
      });

      expect(profile.agentId).toBe("agent-1");
    });

    it("should include details", () => {
      const details = { command: "rm -rf /", user: "root" };
      const profile = monitor.addRiskFactor("session-1", "PRIVILEGE_COMMAND", {
        details,
      });

      expect(profile.factors[0].details).toEqual(details);
    });

    it("should accept custom factor names", () => {
      const profile = monitor.addRiskFactor("session-1", "custom_factor", {
        score: 25,
      });

      expect(profile.factors[0].name).toBe("custom_factor");
      expect(profile.totalScore).toBe(25);
    });
  });

  describe("getSession", () => {
    it("should return null for unknown session", () => {
      expect(monitor.getSession("unknown")).toBeNull();
    });

    it("should return session profile", () => {
      monitor.addRiskFactor("session-1", "BASH_EXECUTION");

      const profile = monitor.getSession("session-1");
      expect(profile).not.toBeNull();
      expect(profile!.sessionKey).toBe("session-1");
    });
  });

  describe("getHighRiskSessions", () => {
    it("should return empty array when no high-risk sessions", () => {
      monitor.addRiskFactor("session-1", "BASH_EXECUTION"); // Low risk

      const highRisk = monitor.getHighRiskSessions();
      expect(highRisk).toHaveLength(0);
    });

    it("should return sessions above threshold", () => {
      // Add enough factors to exceed threshold (70)
      monitor.addRiskFactor("session-1", "PRIVILEGE_COMMAND"); // 25
      monitor.addRiskFactor("session-1", "ABUSE_PATTERN_MATCH"); // 30
      monitor.addRiskFactor("session-1", "CREDENTIAL_ACCESS_SPIKE"); // 25 = 80 total

      const highRisk = monitor.getHighRiskSessions();
      expect(highRisk).toHaveLength(1);
      expect(highRisk[0].sessionKey).toBe("session-1");
      expect(highRisk[0].isHighRisk).toBe(true);
    });

    it("should sort by score descending", () => {
      // Session 1: score 75
      monitor.addRiskFactor("session-1", "PRIVILEGE_COMMAND");
      monitor.addRiskFactor("session-1", "CREDENTIAL_FILE_ACCESS");
      monitor.addRiskFactor("session-1", "ABUSE_PATTERN_MATCH");

      // Session 2: score 80
      monitor.addRiskFactor("session-2", "PRIVILEGE_COMMAND");
      monitor.addRiskFactor("session-2", "CREDENTIAL_FILE_ACCESS");
      monitor.addRiskFactor("session-2", "ABUSE_PATTERN_MATCH");
      monitor.addRiskFactor("session-2", "BASH_EXECUTION");

      const highRisk = monitor.getHighRiskSessions();
      expect(highRisk).toHaveLength(2);
      expect(highRisk[0].sessionKey).toBe("session-2");
      expect(highRisk[1].sessionKey).toBe("session-1");
    });
  });

  describe("getSessionsAboveThreshold", () => {
    it("should filter by custom threshold", () => {
      monitor.addRiskFactor("session-1", "BASH_EXECUTION"); // 5
      monitor.addRiskFactor("session-2", "SENSITIVE_FILE_ACCESS"); // 15
      monitor.addRiskFactor("session-3", "PRIVILEGE_COMMAND"); // 25

      const above10 = monitor.getSessionsAboveThreshold(10);
      expect(above10).toHaveLength(2);

      const above20 = monitor.getSessionsAboveThreshold(20);
      expect(above20).toHaveLength(1);
      expect(above20[0].sessionKey).toBe("session-3");
    });
  });

  describe("getSessionSummary", () => {
    it("should return null for unknown session", () => {
      expect(monitor.getSessionSummary("unknown")).toBeNull();
    });

    it("should return summary with top factors", () => {
      monitor.addRiskFactor("session-1", "BASH_EXECUTION"); // 5
      monitor.addRiskFactor("session-1", "PRIVILEGE_COMMAND"); // 25
      monitor.addRiskFactor("session-1", "SENSITIVE_FILE_ACCESS"); // 15

      const summary = monitor.getSessionSummary("session-1");
      expect(summary).not.toBeNull();
      expect(summary!.score).toBe(45);
      expect(summary!.factorCount).toBe(3);
      // Top factors should be sorted by score
      expect(summary!.topFactors[0]).toBe(RISK_FACTORS.PRIVILEGE_COMMAND.name);
    });
  });

  describe("clearSession", () => {
    it("should remove session", () => {
      monitor.addRiskFactor("session-1", "BASH_EXECUTION");
      monitor.clearSession("session-1");

      expect(monitor.getSession("session-1")).toBeNull();
    });
  });

  describe("clearAllSessions", () => {
    it("should remove all sessions", () => {
      monitor.addRiskFactor("session-1", "BASH_EXECUTION");
      monitor.addRiskFactor("session-2", "BASH_EXECUTION");
      monitor.clearAllSessions();

      expect(monitor.getSession("session-1")).toBeNull();
      expect(monitor.getSession("session-2")).toBeNull();
    });
  });

  describe("getStats", () => {
    it("should return empty stats for no sessions", () => {
      const stats = monitor.getStats();

      expect(stats.totalSessions).toBe(0);
      expect(stats.highRiskCount).toBe(0);
      expect(stats.averageScore).toBe(0);
      expect(stats.maxScore).toBe(0);
    });

    it("should return correct statistics", () => {
      monitor.addRiskFactor("session-1", "BASH_EXECUTION"); // 5
      monitor.addRiskFactor("session-2", "SENSITIVE_FILE_ACCESS"); // 15

      // Add high-risk session
      monitor.addRiskFactor("session-3", "PRIVILEGE_COMMAND");
      monitor.addRiskFactor("session-3", "ABUSE_PATTERN_MATCH");
      monitor.addRiskFactor("session-3", "CREDENTIAL_ACCESS_SPIKE"); // 80 total

      const stats = monitor.getStats();

      expect(stats.totalSessions).toBe(3);
      expect(stats.highRiskCount).toBe(1);
      expect(stats.maxScore).toBe(80);
      expect(stats.averageScore).toBeCloseTo((5 + 15 + 80) / 3, 2);
    });
  });

  describe("decay", () => {
    it("should reduce scores over time", () => {
      monitor.addRiskFactor("session-1", "PRIVILEGE_COMMAND"); // 25

      // Manually trigger decay
      monitor.runDecay();

      const profile = monitor.getSession("session-1");
      // Score should have decayed
      expect(profile!.totalScore).toBeLessThanOrEqual(25);
    });
  });

  describe("updateConfig", () => {
    it("should update threshold", () => {
      monitor.updateConfig({ threshold: 50 });

      monitor.addRiskFactor("session-1", "PRIVILEGE_COMMAND"); // 25
      monitor.addRiskFactor("session-1", "ABUSE_PATTERN_MATCH"); // 30 = 55

      const highRisk = monitor.getHighRiskSessions();
      expect(highRisk).toHaveLength(1);
    });

    it("should update enabled flag", () => {
      expect(monitor.isEnabled()).toBe(true);
      monitor.updateConfig({ enabled: false });
      expect(monitor.isEnabled()).toBe(false);
    });
  });
});
