import { describe, it, expect } from "vitest";
import type { RouterConfig } from "../config/types.agent-defaults.js";
import { ModelRouter } from "./router.js";

describe("ModelRouter", () => {
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
      },
    },
  };

  it("starts with default tier", () => {
    const router = new ModelRouter(baseConfig);
    expect(router.getCurrentModel()).toBe("anthropic/sonnet-4.6");
    expect(router.getCurrentTier()).toBe("medium");
  });

  it("escalates to higher tier", () => {
    const router = new ModelRouter(baseConfig);
    router.recordRetry();
    router.recordRetry();
    router.recordRetry();
    expect(router.shouldEscalate()).toBe(true);
    router.escalate();
    expect(router.getCurrentTier()).toBe("high");
    expect(router.getCurrentModel()).toBe("anthropic/claude-opus-4-6");
  });

  it("cannot escalate beyond highest tier", () => {
    const router = new ModelRouter(baseConfig);
    router.escalate(); // medium -> high
    router.escalate(); // high -> stays high (no higher tier)
    expect(router.getCurrentTier()).toBe("high");
  });

  it("does not escalate when disabled", () => {
    const config = { ...baseConfig, enabled: false };
    const router = new ModelRouter(config);
    for (let i = 0; i < 10; i++) {
      router.recordRetry();
    }
    expect(router.shouldEscalate()).toBe(false);
  });
});
