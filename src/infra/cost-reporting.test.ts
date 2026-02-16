import { describe, it, expect } from "vitest";
import type { BudgetConfig, CostAlert } from "./cost-reporting";
import type { SessionCostSummary, CostUsageSummary } from "./session-cost-usage";
import {
  generateBudgetAlert,
  formatCostAlert,
  formatBudgetBar,
  generateSessionCostReport,
  formatSessionCostReport,
  analyzeCostTrend,
  formatCostTrend,
  compareCostPeriods,
  formatCostComparison,
} from "./cost-reporting";

describe("Cost Reporting", () => {
  describe("generateBudgetAlert", () => {
    const budget: BudgetConfig = {
      monthlyBudget: 100,
      dailyBudget: 5,
      warningThreshold: 0.8,
      criticalThreshold: 1.0,
    };

    it("returns info alert for low spending", () => {
      const alert = generateBudgetAlert(1, budget);
      expect(alert?.level).toBe("info");
      expect(alert?.percentageUsed).toBeLessThan(80);
    });

    it("returns info alert for any positive spending", () => {
      const alert = generateBudgetAlert(0.5, budget);
      expect(alert?.level).toBe("info");
    });

    it("returns warning alert at 80% of budget", () => {
      const dailyFor80Percent = (100 * 0.8) / 30; // ~$2.67/day
      const alert = generateBudgetAlert(dailyFor80Percent, budget);
      expect(alert?.level).toBe("warning");
      expect(alert?.percentageUsed).toBeCloseTo(80, 1);
    });

    it("returns critical alert at 100% of budget", () => {
      const dailyFor100Percent = 100 / 30; // ~$3.33/day
      const alert = generateBudgetAlert(dailyFor100Percent, budget);
      expect(alert?.level).toBe("critical");
      expect(alert?.percentageUsed).toBeGreaterThanOrEqual(100);
    });

    it("calculates budget remaining correctly", () => {
      const alert = generateBudgetAlert(1, budget)!;
      expect(alert.budgetRemaining).toBeCloseTo(70, 0); // 100 - (1 * 30)
    });
  });

  describe("formatBudgetBar", () => {
    it("shows green bar for healthy spending", () => {
      const bar = formatBudgetBar(25);
      expect(bar).toContain("🟢");
      expect(bar).toContain("█");
      expect(bar).toContain("░");
    });

    it("shows yellow bar for warning", () => {
      const bar = formatBudgetBar(80);
      expect(bar).toContain("🟡");
    });

    it("shows red bar for critical", () => {
      const bar = formatBudgetBar(100);
      expect(bar).toContain("🔴");
    });

    it("caps bar at 20 characters", () => {
      const bar = formatBudgetBar(50);
      expect(bar.match(/█/g)?.length).toBeLessThanOrEqual(20);
    });
  });

  describe("formatCostAlert", () => {
    it("formats alert with all components", () => {
      const alert: CostAlert = {
        level: "warning",
        message: "Test warning",
        dailySpend: 2.5,
        monthlySpend: 75,
        budgetRemaining: 25,
        percentageUsed: 75,
      };

      const formatted = formatCostAlert(alert);
      expect(formatted).toContain("Test warning");
      expect(formatted).toContain("75.0%");
      expect(formatted).toContain("$25.00");
      expect(formatted).toContain("$2.50");
      expect(formatted).toContain("$75.00");
    });
  });

  describe("generateSessionCostReport", () => {
    it("generates report from cost summary", () => {
      const summary: SessionCostSummary = {
        sessionId: "test-session",
        totalCost: 0.5,
        totalTokens: 10000,
        input: 7000,
        output: 3000,
        cacheRead: 0,
        cacheWrite: 0,
        missingCostEntries: 0,
        lastActivity: Date.now() - 3600000, // 1 hour ago
      };

      const report = generateSessionCostReport("test-session", summary);

      expect(report.sessionId).toBe("test-session");
      expect(report.totalCost).toBe(0.5);
      expect(report.tokenCount).toBe(10000);
      expect(report.costPerToken).toBeCloseTo(0.00005, 6);
      expect(report.estimatedCostPerHour).toBeCloseTo(0.5, 2);
    });
  });

  describe("formatSessionCostReport", () => {
    it("formats session report with all fields", () => {
      const report = {
        sessionId: "test-session",
        totalCost: 0.5,
        tokenCount: 10000,
        costPerToken: 0.00005,
        estimatedCostPerHour: 0.5,
        lastActivity: new Date(Date.now() - 3600000),
      };

      const formatted = formatSessionCostReport(report);

      expect(formatted).toContain("test-session");
      expect(formatted).toContain("$0.50");
      expect(formatted).toContain("10,000");
      expect(formatted).toContain("1h ago");
    });
  });

  describe("analyzeCostTrend", () => {
    it("analyzes stable trend", () => {
      const summaries: CostUsageSummary[] = [
        {
          updatedAt: Date.now(),
          totals: {
            input: 1000,
            output: 500,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 1500,
            totalCost: 0.1,
            missingCostEntries: 0,
          },
        },
        {
          updatedAt: Date.now(),
          totals: {
            input: 1000,
            output: 500,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 1500,
            totalCost: 0.1,
            missingCostEntries: 0,
          },
        },
      ];

      const trend = analyzeCostTrend(summaries);

      expect(trend.trend).toBe("stable");
      expect(trend.avgDaily).toBeCloseTo(0.1, 2);
      expect(trend.projectedMonthly).toBeCloseTo(3.0, 1);
    });

    it("detects increasing trend", () => {
      const summaries: CostUsageSummary[] = [
        {
          updatedAt: 0,
          totals: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            totalCost: 0.1,
            missingCostEntries: 0,
          },
        },
        {
          updatedAt: 0,
          totals: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            totalCost: 0.1,
            missingCostEntries: 0,
          },
        },
        {
          updatedAt: 0,
          totals: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            totalCost: 0.2,
            missingCostEntries: 0,
          },
        },
        {
          updatedAt: 0,
          totals: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            totalCost: 0.2,
            missingCostEntries: 0,
          },
        },
      ];

      const trend = analyzeCostTrend(summaries);

      expect(trend.trend).toBe("increasing");
    });

    it("detects decreasing trend", () => {
      const summaries: CostUsageSummary[] = [
        {
          updatedAt: 0,
          totals: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            totalCost: 0.2,
            missingCostEntries: 0,
          },
        },
        {
          updatedAt: 0,
          totals: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            totalCost: 0.2,
            missingCostEntries: 0,
          },
        },
        {
          updatedAt: 0,
          totals: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            totalCost: 0.1,
            missingCostEntries: 0,
          },
        },
        {
          updatedAt: 0,
          totals: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            totalCost: 0.1,
            missingCostEntries: 0,
          },
        },
      ];

      const trend = analyzeCostTrend(summaries);

      expect(trend.trend).toBe("decreasing");
    });
  });

  describe("formatCostTrend", () => {
    it("formats trend analysis", () => {
      const analysis = {
        avgDaily: 0.1,
        trend: "increasing" as const,
        projectedMonthly: 3.0,
      };

      const formatted = formatCostTrend(analysis);

      expect(formatted).toContain("📈");
      expect(formatted).toContain("increasing");
      expect(formatted).toContain("$0.10");
      expect(formatted).toContain("$3.00");
    });
  });

  describe("compareCostPeriods", () => {
    it("compares two cost periods", () => {
      const before: CostUsageSummary = {
        updatedAt: 0,
        totals: {
          input: 5000,
          output: 2500,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 7500,
          totalCost: 0.25,
          missingCostEntries: 0,
        },
      };

      const after: CostUsageSummary = {
        updatedAt: 0,
        totals: {
          input: 5000,
          output: 2500,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 7500,
          totalCost: 0.5,
          missingCostEntries: 0,
        },
      };

      const comparison = compareCostPeriods(before, after);

      expect(comparison.costChange).toBe(0.25);
      expect(comparison.costChangePercent).toBeCloseTo(100, 1);
      expect(comparison.tokenChange).toBe(0);
    });

    it("flags worse efficiency", () => {
      const before: CostUsageSummary = {
        updatedAt: 0,
        totals: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          totalCost: 0.1,
          missingCostEntries: 0,
        },
      };

      const after: CostUsageSummary = {
        updatedAt: 0,
        totals: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          totalCost: 0.15,
          missingCostEntries: 0,
        },
      };

      const comparison = compareCostPeriods(before, after);

      expect(comparison.efficiency).toContain("⚠️");
    });
  });

  describe("formatCostComparison", () => {
    it("formats cost comparison", () => {
      const comparison = {
        costChange: 0.25,
        costChangePercent: 100,
        tokenChange: 0,
        efficiency: "📊 Better efficiency",
      };

      const formatted = formatCostComparison(comparison);

      expect(formatted).toContain("📈");
      expect(formatted).toContain("+$0.25");
      expect(formatted).toContain("100.0%");
      expect(formatted).toContain("📊 Better efficiency");
    });
  });
});
