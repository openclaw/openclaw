import { describe, it, expect } from "vitest";
import type { ThinkLevel } from "../../auto-reply/thinking.js";
import type { AgentThinkingEscalationConfig } from "../../config/types.agent-defaults.js";

// Re-implement the function to test it directly
const THINKING_LEVEL_ORDER: ThinkLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

function computeTargetThinkingLevel(params: {
  escalation: AgentThinkingEscalationConfig | undefined;
  totalTokens: number;
  contextTokens: number;
  allowedLevels: ThinkLevel[];
}): ThinkLevel | undefined {
  const { escalation, totalTokens, contextTokens, allowedLevels } = params;

  if (!escalation?.enabled || !escalation.thresholds || escalation.thresholds.length === 0) {
    return undefined;
  }

  if (contextTokens <= 0 || totalTokens < 0) {
    return undefined;
  }

  const usagePercent = (totalTokens / contextTokens) * 100;

  // Sort thresholds by atContextPercent descending to find the highest applicable
  const sortedThresholds = [...escalation.thresholds].toSorted(
    (a, b) => b.atContextPercent - a.atContextPercent,
  );

  // Find the first (highest) threshold that has been exceeded
  const applicableThreshold = sortedThresholds.find((t) => usagePercent >= t.atContextPercent);

  if (!applicableThreshold) {
    return undefined;
  }

  const targetLevel = applicableThreshold.thinking;

  // Check if the target level is supported
  if (!allowedLevels.includes(targetLevel)) {
    // Find the highest allowed level that is <= targetLevel
    const targetIndex = THINKING_LEVEL_ORDER.indexOf(targetLevel);
    for (let i = targetIndex - 1; i >= 0; i--) {
      const lowerLevel = THINKING_LEVEL_ORDER[i];
      if (allowedLevels.includes(lowerLevel)) {
        return lowerLevel;
      }
    }
    return undefined;
  }

  return targetLevel;
}

describe("computeTargetThinkingLevel", () => {
  it("returns undefined when escalation is disabled", () => {
    const result = computeTargetThinkingLevel({
      escalation: { enabled: false, thresholds: [{ atContextPercent: 50, thinking: "medium" }] },
      totalTokens: 60000,
      contextTokens: 100000,
      allowedLevels: ["off", "low", "medium", "high"],
    });
    expect(result).toBeUndefined();
  });

  it("returns undefined when no thresholds are defined", () => {
    const result = computeTargetThinkingLevel({
      escalation: { enabled: true },
      totalTokens: 60000,
      contextTokens: 100000,
      allowedLevels: ["off", "low", "medium", "high"],
    });
    expect(result).toBeUndefined();
  });

  it("returns undefined when usage is below all thresholds", () => {
    const result = computeTargetThinkingLevel({
      escalation: {
        enabled: true,
        thresholds: [
          { atContextPercent: 50, thinking: "medium" },
          { atContextPercent: 75, thinking: "high" },
        ],
      },
      totalTokens: 30000,
      contextTokens: 100000,
      allowedLevels: ["off", "low", "medium", "high"],
    });
    expect(result).toBeUndefined();
  });

  it("escalates to medium at 50% usage", () => {
    const result = computeTargetThinkingLevel({
      escalation: {
        enabled: true,
        thresholds: [
          { atContextPercent: 50, thinking: "medium" },
          { atContextPercent: 75, thinking: "high" },
        ],
      },
      totalTokens: 50000,
      contextTokens: 100000,
      allowedLevels: ["off", "low", "medium", "high"],
    });
    expect(result).toBe("medium");
  });

  it("escalates to high at 75% usage", () => {
    const result = computeTargetThinkingLevel({
      escalation: {
        enabled: true,
        thresholds: [
          { atContextPercent: 50, thinking: "medium" },
          { atContextPercent: 75, thinking: "high" },
        ],
      },
      totalTokens: 75000,
      contextTokens: 100000,
      allowedLevels: ["off", "low", "medium", "high"],
    });
    expect(result).toBe("high");
  });

  it("escalates to high at 90% usage (exceeds highest threshold)", () => {
    const result = computeTargetThinkingLevel({
      escalation: {
        enabled: true,
        thresholds: [
          { atContextPercent: 50, thinking: "medium" },
          { atContextPercent: 75, thinking: "high" },
        ],
      },
      totalTokens: 90000,
      contextTokens: 100000,
      allowedLevels: ["off", "low", "medium", "high"],
    });
    expect(result).toBe("high");
  });

  it("falls back to lower level when target is not supported", () => {
    const result = computeTargetThinkingLevel({
      escalation: {
        enabled: true,
        thresholds: [{ atContextPercent: 75, thinking: "high" }],
      },
      totalTokens: 80000,
      contextTokens: 100000,
      allowedLevels: ["off", "low", "medium"], // no "high" support
    });
    expect(result).toBe("medium");
  });

  it("returns 'off' when it's the only supported level", () => {
    const result = computeTargetThinkingLevel({
      escalation: {
        enabled: true,
        thresholds: [{ atContextPercent: 50, thinking: "low" }],
      },
      totalTokens: 60000,
      contextTokens: 100000,
      allowedLevels: ["off"], // only "off" supported
    });
    expect(result).toBe("off");
  });

  it("handles binary thinking providers (off/on)", () => {
    const result = computeTargetThinkingLevel({
      escalation: {
        enabled: true,
        thresholds: [{ atContextPercent: 50, thinking: "medium" }],
      },
      totalTokens: 60000,
      contextTokens: 100000,
      allowedLevels: ["off", "low"], // binary-like provider
    });
    expect(result).toBe("low");
  });

  it("handles xhigh models", () => {
    const result = computeTargetThinkingLevel({
      escalation: {
        enabled: true,
        thresholds: [
          { atContextPercent: 50, thinking: "medium" },
          { atContextPercent: 75, thinking: "high" },
          { atContextPercent: 90, thinking: "xhigh" },
        ],
      },
      totalTokens: 95000,
      contextTokens: 100000,
      allowedLevels: ["off", "minimal", "low", "medium", "high", "xhigh"],
    });
    expect(result).toBe("xhigh");
  });

  it("returns undefined for invalid token counts", () => {
    const result = computeTargetThinkingLevel({
      escalation: {
        enabled: true,
        thresholds: [{ atContextPercent: 50, thinking: "medium" }],
      },
      totalTokens: -100,
      contextTokens: 100000,
      allowedLevels: ["off", "low", "medium", "high"],
    });
    expect(result).toBeUndefined();
  });

  it("returns undefined when contextTokens is zero", () => {
    const result = computeTargetThinkingLevel({
      escalation: {
        enabled: true,
        thresholds: [{ atContextPercent: 50, thinking: "medium" }],
      },
      totalTokens: 50000,
      contextTokens: 0,
      allowedLevels: ["off", "low", "medium", "high"],
    });
    expect(result).toBeUndefined();
  });
});
