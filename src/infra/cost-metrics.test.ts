import { describe, it, expect } from "vitest";
import type { CostUsageSummary } from "./session-cost-usage";
import {
  formatCostMetrics,
  formatTokenCount,
  extractCostMetrics,
  calculateEfficiencyMetrics,
  estimateConversationCost,
  formatCostRange,
  formatCostValue,
  calculateCostSavingsROI,
  assessCostStatus,
  compareCosts,
} from "./cost-metrics";

describe("Cost Metrics", () => {
  describe("formatTokenCount", () => {
    it("formats tokens with appropriate units", () => {
      expect(formatTokenCount(500)).toBe("500");
      expect(formatTokenCount(1_200)).toBe("1.2k");
      expect(formatTokenCount(1_234_567)).toBe("1.2M");
      expect(formatTokenCount(1_000_000)).toBe("1.0M");
    });
  });

  describe("formatCostValue", () => {
    it("formats costs with appropriate precision", () => {
      expect(formatCostValue(0.0028)).toBe("$0.0028");
      expect(formatCostValue(0.3)).toBe("$0.30");
      expect(formatCostValue(5.25)).toBe("$5.25");
      expect(formatCostValue(100.0)).toBe("$100.00");
    });
  });

  describe("formatCostRange", () => {
    it("formats cost range for display", () => {
      const result = formatCostRange(0.008, 0.012);
      expect(result).toContain("–");
      // formatCostValue uses $0.0080 for <0.01 and $0.01 for >=0.01
      expect(result).toContain("$0.0080");
      expect(result).toContain("$0.01");
    });
  });

  describe("extractCostMetrics", () => {
    it("extracts metrics from cost usage summary", () => {
      const summary: CostUsageSummary = {
        updatedAt: Date.now(),
        days: 1,
        daily: [],
        totals: {
          input: 10000,
          output: 5000,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 15000,
          totalCost: 0.15,
          inputCost: 0.08,
          outputCost: 0.07,
          cacheReadCost: 0,
          cacheWriteCost: 0,
          missingCostEntries: 0,
        },
      };

      const metrics = extractCostMetrics(summary, 3);

      expect(metrics.totalCost).toBe(0.15);
      expect(metrics.totalTokens).toBe(15000);
      expect(metrics.inputTokens).toBe(10000);
      expect(metrics.outputTokens).toBe(5000);
      expect(metrics.averageCostPerToken).toBeCloseTo(0.00001, 6);
      expect(metrics.averageCostPerSession).toBeCloseTo(0.05, 2);
      expect(metrics.sessions).toBe(3);
    });
  });

  describe("calculateEfficiencyMetrics", () => {
    it("calculates efficiency metrics", () => {
      const efficiency = calculateEfficiencyMetrics(0.15, 15000, 3);

      expect(efficiency.costPerToken).toBeCloseTo(10, 0); // $10 per 1M tokens
      expect(efficiency.costPerSession).toBeCloseTo(0.05, 4);
      expect(efficiency.tokensPerDollar).toBe(100000);
      expect(efficiency.sessionsPerDollar).toBeCloseTo(20, 4);
    });
  });

  describe("estimateConversationCost", () => {
    it("estimates cost for hypothetical conversation", () => {
      const estimate = estimateConversationCost({
        estimatedInputTokens: 1000,
        estimatedOutputTokens: 500,
        estimatedTurns: 5,
        modelCostPerMillionInput: 0.8,
        modelCostPerMillionOutput: 4,
      });

      const turnCost = (1000 * 0.8 + 500 * 4) / 1_000_000; // 0.0028
      const totalCost = turnCost * 5; // 0.014

      expect(estimate.estimatedTotalCost).toBeCloseTo(totalCost, 4);
      expect(estimate.estimatedCostPerTurn).toBeCloseTo(turnCost, 5);
      expect(estimate.costRange.low).toBeCloseTo(totalCost * 0.8, 4);
      expect(estimate.costRange.high).toBeCloseTo(totalCost * 1.2, 4);
    });
  });

  describe("compareCosts", () => {
    it("compares costs between two usage patterns", () => {
      const before = { input: 1000, output: 500, total: 1500 };
      const after = { input: 800, output: 400, total: 1200 };
      const costPerToken = 0.00001; // $0.00001 per token

      const comparison = compareCosts(before, after, costPerToken);

      // 1500 * 0.00001 = 0.015, 1200 * 0.00001 = 0.012
      expect(comparison.beforeCost).toBeCloseTo(0.015, 4);
      expect(comparison.afterCost).toBeCloseTo(0.012, 4);
      expect(comparison.savings).toBeGreaterThan(0);
      expect(comparison.savingsPercent).toBeCloseTo(20, 1); // 20% savings
    });
  });

  describe("calculateCostSavingsROI", () => {
    it("calculates ROI for cost savings initiative", () => {
      const roi = calculateCostSavingsROI({
        previousMonthlyCost: 100,
        newMonthlyCost: 70,
        implementationCost: 100,
        months: 12,
      });

      expect(roi.monthlySavings).toBe(30);
      expect(roi.annualSavings).toBe(360);
      expect(roi.paybackMonths).toBeCloseTo(3.33, 1);
      expect(roi.roi).toBeCloseTo(260, 0); // 260% ROI
    });
  });

  describe("assessCostStatus", () => {
    it("assesses cost status as healthy", () => {
      const status = assessCostStatus({
        dailySpend: 1,
        monthlyBudget: 100,
        dailyBudget: 5,
      });

      expect(status).toBe("healthy");
    });

    it("assesses cost status as warning", () => {
      const status = assessCostStatus({
        dailySpend: 5.5,
        monthlyBudget: 100,
        dailyBudget: 5,
      });

      expect(status).toBe("warning");
    });

    it("assesses cost status as critical", () => {
      const status = assessCostStatus({
        dailySpend: 8,
        monthlyBudget: 100,
        dailyBudget: 5,
      });

      expect(status).toBe("critical");
    });

    it("assesses monthly budget overage as critical", () => {
      const status = assessCostStatus({
        dailySpend: 3.5, // Would be $105 monthly
        monthlyBudget: 100,
      });

      expect(status).toBe("critical");
    });
  });

  describe("formatCostMetrics", () => {
    it("formats complete cost metrics for display", () => {
      const metrics = {
        totalCost: 0.15,
        totalTokens: 15000,
        inputTokens: 10000,
        outputTokens: 5000,
        averageCostPerSession: 0.05,
        averageCostPerToken: 0.00001,
        sessions: 3,
      };

      const formatted = formatCostMetrics(metrics);

      expect(formatted).toContain("💵 Total Cost: $0.1500");
      expect(formatted).toContain("🧮 Total Tokens: 15.0k");
      expect(formatted).toContain("📊 Input:");
      expect(formatted).toContain("💰 Avg/Session");
      expect(formatted).toContain("🪙 Cost/Token");
      expect(formatted).toContain("🔢 Sessions: 3");
    });
  });
});
