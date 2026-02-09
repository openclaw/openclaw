import { describe, it, expect } from "vitest";
import {
  detectComplexityThreshold,
  generateSwitchJustification,
  createModelSwitchRequest,
  formatModelSwitchRequestForSlack,
  shouldAutoApplyModelSwitch,
  type ComplexityIndicators,
} from "./model-switching.js";

describe("ModelSwitching", () => {
  describe("detectComplexityThreshold", () => {
    it("should detect high context usage", () => {
      const result = detectComplexityThreshold({ contextUsagePercent: 75 });
      expect(result).toBe(true);
    });

    it("should detect multiple failed attempts", () => {
      const result = detectComplexityThreshold({ failedAttempts: 4 });
      expect(result).toBe(true);
    });

    it("should detect token budget exceeded", () => {
      const result = detectComplexityThreshold({ tokenBudgetExceeded: true });
      expect(result).toBe(true);
    });

    it("should detect long-running operations", () => {
      const result = detectComplexityThreshold({ operationDuration: 45000 });
      expect(result).toBe(true);
    });

    it("should not trigger on minor indicators", () => {
      const result = detectComplexityThreshold({
        contextUsagePercent: 30,
        failedAttempts: 1,
        tokenBudgetExceeded: false,
        operationDuration: 5000,
      });
      expect(result).toBe(false);
    });

    it("should handle empty indicators", () => {
      const result = detectComplexityThreshold({});
      expect(result).toBe(false);
    });

    it("should trigger at exact 50% context usage", () => {
      const result = detectComplexityThreshold({ contextUsagePercent: 50 });
      expect(result).toBe(false); // > 50, not >= 50
    });

    it("should trigger above 50% context usage", () => {
      const result = detectComplexityThreshold({ contextUsagePercent: 51 });
      expect(result).toBe(true);
    });
  });

  describe("generateSwitchJustification", () => {
    it("should include all triggered reasons", () => {
      const indicators: ComplexityIndicators = {
        contextUsagePercent: 80,
        failedAttempts: 5,
        tokenBudgetExceeded: true,
        operationDuration: 35000,
      };

      const justification = generateSwitchJustification("haiku", "opus", indicators);

      expect(justification).toContain("haiku");
      expect(justification).toContain("opus");
      expect(justification).toContain("80%");
      expect(justification).toContain("5");
      expect(justification).toContain("budget");
      expect(justification).toContain("35s");
    });

    it("should only include triggered reasons", () => {
      const indicators: ComplexityIndicators = {
        contextUsagePercent: 75,
      };

      const justification = generateSwitchJustification("haiku", "sonnet", indicators);

      expect(justification).toContain("75%");
      expect(justification).not.toContain("budget");
      expect(justification).not.toContain("failed");
    });
  });

  describe("createModelSwitchRequest", () => {
    it("should create request with all fields", () => {
      const indicators: ComplexityIndicators = {
        contextUsagePercent: 60,
        failedAttempts: 2,
      };

      const request = createModelSwitchRequest("haiku", "opus", indicators);

      expect(request.fromModel).toBe("haiku");
      expect(request.toModel).toBe("opus");
      expect(request.justification).toBeTruthy();
      expect(request.indicators).toBe(indicators);
      expect(request.timestamp).toBeLessThanOrEqual(Date.now());
    });
  });

  describe("formatModelSwitchRequestForSlack", () => {
    it("should format request for Slack", () => {
      const indicators: ComplexityIndicators = {
        contextUsagePercent: 70,
        failedAttempts: 3,
        inputTokens: 50000,
        outputTokens: 25000,
      };

      const request = createModelSwitchRequest("haiku", "opus", indicators);
      const formatted = formatModelSwitchRequestForSlack(request);

      expect(formatted).toContain("🤖");
      expect(formatted).toContain("Model Upgrade Request");
      expect(formatted).toContain("`haiku`");
      expect(formatted).toContain("`opus`");
      expect(formatted).toContain("50,000");
      expect(formatted).toContain("25,000");
      expect(formatted).toContain("✅");
      expect(formatted).toContain("⛔");
    });

    it("should handle missing token counts", () => {
      const request = createModelSwitchRequest("haiku", "opus", {});
      const formatted = formatModelSwitchRequestForSlack(request);

      expect(formatted).toContain("Model Upgrade Request");
      expect(formatted).not.toContain("Token Usage");
    });
  });

  describe("shouldAutoApplyModelSwitch", () => {
    it("should auto-apply for extreme cases", () => {
      const result = shouldAutoApplyModelSwitch({
        tokenBudgetExceeded: true,
        contextUsagePercent: 80,
      });
      expect(result).toBe(true);
    });

    it("should not auto-apply for moderate cases", () => {
      const result = shouldAutoApplyModelSwitch({
        tokenBudgetExceeded: true,
        contextUsagePercent: 50,
      });
      expect(result).toBe(false);
    });

    it("should not auto-apply without budget exceeded", () => {
      const result = shouldAutoApplyModelSwitch({
        tokenBudgetExceeded: false,
        contextUsagePercent: 90,
      });
      expect(result).toBe(false);
    });

    it("should require both conditions", () => {
      expect(
        shouldAutoApplyModelSwitch({
          tokenBudgetExceeded: true,
          contextUsagePercent: 75,
        }),
      ).toBe(true);

      expect(
        shouldAutoApplyModelSwitch({
          tokenBudgetExceeded: true,
          contextUsagePercent: 74,
        }),
      ).toBe(false);

      expect(
        shouldAutoApplyModelSwitch({
          tokenBudgetExceeded: false,
          contextUsagePercent: 75,
        }),
      ).toBe(false);
    });
  });
});
