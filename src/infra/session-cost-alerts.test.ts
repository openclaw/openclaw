import { describe, it, expect } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import {
  checkSessionCostAlert,
  checkDailyCostAlert,
  getApplicableCostAlerts,
  formatCostAlerts,
  type CostAlertThresholds,
} from "./session-cost-alerts.js";

describe("SessionCostAlerts", () => {
  describe("checkSessionCostAlert", () => {
    it("should not alert when cost is below threshold", () => {
      const result = checkSessionCostAlert(5.0, { sessionThreshold: 10.0 });
      expect(result.triggered).toBe(false);
      expect(result.level).toBe("none");
    });

    it("should warn when cost is between 80-100% of threshold", () => {
      const result = checkSessionCostAlert(9.0, { sessionThreshold: 10.0 });
      expect(result.triggered).toBe(true);
      expect(result.level).toBe("warning");
      expect(result.message).toContain("warning");
      expect(result.thresholdExceeded).toBe("session");
    });

    it("should alert critically when cost exceeds 100% of threshold", () => {
      const result = checkSessionCostAlert(15.0, { sessionThreshold: 10.0 });
      expect(result.triggered).toBe(true);
      expect(result.level).toBe("critical");
      expect(result.message).toContain("critical");
    });

    it("should not alert when no threshold is configured", () => {
      const result = checkSessionCostAlert(100.0, {});
      expect(result.triggered).toBe(false);
    });

    it("should not alert when threshold is undefined", () => {
      const result = checkSessionCostAlert(100.0, { sessionThreshold: undefined });
      expect(result.triggered).toBe(false);
    });

    it("should include cost details in alert", () => {
      const result = checkSessionCostAlert(15.0, { sessionThreshold: 10.0 });
      expect(result.currentCost).toBe(15.0);
      expect(result.threshold).toBe(10.0);
      expect(result.message).toContain("$15.00");
      expect(result.message).toContain("$10.00");
    });
  });

  describe("checkDailyCostAlert", () => {
    it("should not alert when daily cost is below threshold", () => {
      const result = checkDailyCostAlert(2.0, { dailyThreshold: 5.0 });
      expect(result.triggered).toBe(false);
    });

    it("should warn when daily cost is between 80-100% of threshold", () => {
      const result = checkDailyCostAlert(4.5, { dailyThreshold: 5.0 });
      expect(result.triggered).toBe(true);
      expect(result.level).toBe("warning");
      expect(result.thresholdExceeded).toBe("daily");
    });

    it("should alert critically when daily cost exceeds threshold", () => {
      const result = checkDailyCostAlert(5.5, { dailyThreshold: 5.0 });
      expect(result.triggered).toBe(true);
      expect(result.level).toBe("critical");
    });

    it("should not alert when no threshold is configured", () => {
      const result = checkDailyCostAlert(10.0, {});
      expect(result.triggered).toBe(false);
    });
  });

  describe("getApplicableCostAlerts", () => {
    it("should return multiple alerts when both thresholds are exceeded", () => {
      const cfg = { costAlerts: { sessionThreshold: 20, dailyThreshold: 5 } } as any;
      const alerts = getApplicableCostAlerts(25, 6, cfg);

      expect(alerts).toHaveLength(2);
      expect(alerts[0].thresholdExceeded).toBe("session");
      expect(alerts[1].thresholdExceeded).toBe("daily");
    });

    it("should return only triggered alerts", () => {
      const cfg = { costAlerts: { sessionThreshold: 10, dailyThreshold: 20 } } as any;
      const alerts = getApplicableCostAlerts(12, 5, cfg);

      expect(alerts).toHaveLength(1);
      expect(alerts[0].thresholdExceeded).toBe("session");
    });

    it("should return empty array when no alerts are triggered", () => {
      const cfg = { costAlerts: { sessionThreshold: 100, dailyThreshold: 50 } } as any;
      const alerts = getApplicableCostAlerts(5, 2, cfg);

      expect(alerts).toHaveLength(0);
    });

    it("should handle missing costAlerts config", () => {
      const cfg = {} as OpenClawConfig;
      const alerts = getApplicableCostAlerts(100, 50, cfg);

      expect(alerts).toHaveLength(0);
    });
  });

  describe("formatCostAlerts", () => {
    it("should format critical alerts with emoji", () => {
      const alerts = [
        {
          triggered: true,
          level: "critical" as const,
          message: "Critical: $25.00 / $20.00",
          thresholdExceeded: "session",
        },
      ];

      const formatted = formatCostAlerts(alerts);
      expect(formatted).toContain("🚨");
      expect(formatted).toContain("CRITICAL");
      expect(formatted).toContain("$25.00");
    });

    it("should format warnings with emoji", () => {
      const alerts = [
        {
          triggered: true,
          level: "warning" as const,
          message: "Warning: $9.00 / $10.00",
          thresholdExceeded: "session",
        },
      ];

      const formatted = formatCostAlerts(alerts);
      expect(formatted).toContain("⚠️");
      expect(formatted).toContain("WARNINGS");
    });

    it("should format multiple alerts with sections", () => {
      const alerts = [
        {
          triggered: true,
          level: "critical" as const,
          message: "Critical alert",
          thresholdExceeded: "session",
        },
        {
          triggered: true,
          level: "warning" as const,
          message: "Warning alert",
          thresholdExceeded: "daily",
        },
      ];

      const formatted = formatCostAlerts(alerts);
      expect(formatted).toContain("🚨");
      expect(formatted).toContain("⚠️");
      expect(formatted).toContain("Critical alert");
      expect(formatted).toContain("Warning alert");
    });

    it("should return empty string for empty alerts", () => {
      const formatted = formatCostAlerts([]);
      expect(formatted).toBe("");
    });
  });
});
