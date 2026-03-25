import { describe, it, expect } from "vitest";
import type { RouterConfig } from "../config/types.agent-defaults.js";
import { EscalationPolicy } from "./escalation.js";

describe("EscalationPolicy", () => {
  const baseConfig: RouterConfig = {
    enabled: true,
    defaultTier: "medium",
    tiers: {
      low: { model: "openai/gpt-5.4" },
      medium: { model: "anthropic/sonnet-4.6" },
      high: { model: "anthropic/claude-opus-4-6" },
    },
    escalation: {
      signals: {
        maxRetries: 2,
        maxToolCalls: 20,
        maxContextGrowth: 0.5,
        errorPatterns: ["insufficient", "complexity"],
      },
    },
  };

  it("returns false when no signals exceed thresholds", () => {
    const policy = new EscalationPolicy(baseConfig);
    const signals = {
      retryCount: 1,
      toolCallCount: 10,
      contextGrowth: 0.2,
      contextSize: 1000,
      errors: [],
    };
    expect(policy.shouldEscalate(signals)).toBe(false);
  });

  it("returns true when retries exceed maxRetries", () => {
    const policy = new EscalationPolicy(baseConfig);
    const signals = {
      retryCount: 3,
      toolCallCount: 5,
      contextGrowth: 0.1,
      contextSize: 1000,
      errors: [],
    };
    expect(policy.shouldEscalate(signals)).toBe(true);
  });

  it("returns true when tool calls exceed maxToolCalls", () => {
    const policy = new EscalationPolicy(baseConfig);
    const signals = {
      retryCount: 0,
      toolCallCount: 25,
      contextGrowth: 0.1,
      contextSize: 1000,
      errors: [],
    };
    expect(policy.shouldEscalate(signals)).toBe(true);
  });

  it("returns true when context growth exceeds maxContextGrowth", () => {
    const policy = new EscalationPolicy(baseConfig);
    const signals = {
      retryCount: 0,
      toolCallCount: 5,
      contextGrowth: 0.6,
      contextSize: 2000,
      errors: [],
    };
    expect(policy.shouldEscalate(signals)).toBe(true);
  });

  it("returns true when error matches pattern", () => {
    const policy = new EscalationPolicy(baseConfig);
    const signals = {
      retryCount: 0,
      toolCallCount: 5,
      contextGrowth: 0.1,
      contextSize: 1000,
      errors: ["insufficient context"],
    };
    expect(policy.shouldEscalate(signals)).toBe(true);
  });

  it("returns false when escalation is disabled in config", () => {
    const config = { ...baseConfig, enabled: false };
    const policy = new EscalationPolicy(config);
    const signals = {
      retryCount: 100,
      toolCallCount: 100,
      contextGrowth: 1.0,
      contextSize: 10000,
      errors: ["insufficient context"],
    };
    expect(policy.shouldEscalate(signals)).toBe(false);
  });
});
