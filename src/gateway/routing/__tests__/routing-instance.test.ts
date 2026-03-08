import { afterEach, describe, expect, it } from "vitest";
import { BudgetTracker } from "../budget-tracker.js";
import { HealthTracker } from "../health-tracker.js";
import { ModelSelector } from "../model-selector.js";
import { ReviewGate } from "../review-gate.js";
import { getRoutingInstance, resetRoutingInstance } from "../routing-instance.js";
import { ModelTier, TaskType, type RoutingConfig } from "../types.js";

// Helper to build a complete RoutingConfig for tests.
function makeConfig(overrides: Partial<RoutingConfig> = {}): RoutingConfig {
  return {
    default_task_type: TaskType.FALLBACK,
    cooldown_seconds: 30,
    antiflap_enabled: false,
    triggers: {},
    deny_list: [],
    ha_matrix: {
      [TaskType.CODE_EDIT]: {
        [ModelTier.TIER1]: "model-a",
        [ModelTier.TIER2]: "model-b",
        [ModelTier.TIER3]: "model-c",
      },
      [TaskType.CODE_REFACTOR]: {
        [ModelTier.TIER1]: "refactor-1",
        [ModelTier.TIER2]: "refactor-2",
      },
      [TaskType.FALLBACK]: {
        [ModelTier.TIER1]: "fallback-1",
        [ModelTier.TIER2]: "fallback-2",
      },
    },
    health: {
      enabled: true,
      window_size: 10,
      threshold: 0.5,
      cooldown_ms: 60_000,
    },
    budget: {
      enabled: true,
      daily_budget_usd: 10,
      daily_token_limit: 500_000,
      warning_threshold: 0.8,
      critical_action: "degrade",
    },
    review_gate: {
      enabled: true,
      mode: "auto",
      high_risk_types: [TaskType.CODE_REFACTOR, TaskType.SECURITY_AUDIT, TaskType.GIT_OPS],
      reviewer_model: "anthropic/claude-opus-4-6",
      reviewer_system_prompt: "You are a code reviewer.",
      timeout_ms: 60_000,
    },
    ...overrides,
  };
}

afterEach(() => {
  resetRoutingInstance();
});

describe("getRoutingInstance — singleton creation", () => {
  it("returns an instance with all expected fields", () => {
    const config = makeConfig();
    const instance = getRoutingInstance(config);

    expect(instance).toBeDefined();
    expect(instance.healthTracker).toBeInstanceOf(HealthTracker);
    expect(instance.budgetTracker).toBeInstanceOf(BudgetTracker);
    expect(instance.reviewGate).toBeInstanceOf(ReviewGate);
    expect(instance.selector).toBeInstanceOf(ModelSelector);
  });

  it("returns the same instance for the same config reference", () => {
    const config = makeConfig();
    const a = getRoutingInstance(config);
    const b = getRoutingInstance(config);
    expect(a).toBe(b);
  });

  it("creates a new instance when config reference changes", () => {
    const config1 = makeConfig();
    const config2 = makeConfig();
    const a = getRoutingInstance(config1);
    const b = getRoutingInstance(config2);
    expect(a).not.toBe(b);
  });
});

describe("getRoutingInstance — selector uses health + budget trackers", () => {
  it("resolves all tiers when no health issues or budget pressure", () => {
    const config = makeConfig();
    const { selector } = getRoutingInstance(config);
    const models = selector.resolveModels(TaskType.CODE_EDIT, config);
    expect(models).toEqual(["model-a", "model-b", "model-c"]);
  });

  it("skips unhealthy models as tracked by the shared HealthTracker", () => {
    // Use threshold=0.8 so that 10 failures (score≈0.7) marks model-a as unhealthy.
    // Each non-timeout failure penalty = 0.3/windowSize = 0.3/10 = 0.03
    // 10 failures → score = 1 - 0.3 = 0.7 < 0.8 threshold → unhealthy
    const config = makeConfig({
      health: { enabled: true, window_size: 10, threshold: 0.8, cooldown_ms: 60_000 },
    });
    const { selector, healthTracker } = getRoutingInstance(config);

    for (let i = 0; i < 10; i++) {
      healthTracker.recordResult("model-a", {
        timestamp: Date.now(),
        success: false,
        latencyMs: 100,
        error: "error",
      });
    }

    const models = selector.resolveModels(TaskType.CODE_EDIT, config);
    // model-a should be skipped, model-b and model-c remain
    expect(models).not.toContain("model-a");
    expect(models.length).toBeGreaterThan(0);
  });

  it("returns empty list when budget is blocked", () => {
    const config = makeConfig({
      budget: {
        enabled: true,
        daily_budget_usd: 1,
        daily_token_limit: 1000,
        warning_threshold: 0.8,
        critical_action: "block",
      },
    });
    const { selector, budgetTracker } = getRoutingInstance(config);

    // Exhaust the budget
    budgetTracker.recordUsage({
      model: "model-a",
      prompt_tokens: 500,
      completion_tokens: 500,
      cost_usd: 2, // exceeds daily_budget_usd of 1
      timestamp: Date.now(),
    });

    const models = selector.resolveModels(TaskType.CODE_EDIT, config);
    expect(models).toEqual([]);
  });
});

describe("getRoutingInstance — serialize / deserialize round-trip", () => {
  it("persists and restores health records", () => {
    const config = makeConfig();
    const instance = getRoutingInstance(config);

    instance.healthTracker.recordResult("model-a", {
      timestamp: Date.now(),
      success: false,
      latencyMs: 100,
      error: "error",
    });

    const scoreBefore = instance.healthTracker.getHealthScore("model-a");
    const serialized = instance.serialize();

    // Create a fresh instance and restore
    resetRoutingInstance();
    const restored = getRoutingInstance(config);
    restored.deserialize(serialized);

    const scoreAfter = restored.healthTracker.getHealthScore("model-a");
    expect(scoreAfter).toBeCloseTo(scoreBefore, 5);
  });

  it("persists and restores budget records", () => {
    const config = makeConfig();
    const instance = getRoutingInstance(config);

    instance.budgetTracker.recordUsage({
      model: "model-a",
      prompt_tokens: 1000,
      completion_tokens: 500,
      cost_usd: 0.5,
      timestamp: Date.now(),
    });

    const costBefore = instance.budgetTracker.getTodayCost();
    const serialized = instance.serialize();

    resetRoutingInstance();
    const restored = getRoutingInstance(config);
    restored.deserialize(serialized);

    const costAfter = restored.budgetTracker.getTodayCost();
    expect(costAfter).toBeCloseTo(costBefore, 5);
  });

  it("silently ignores malformed deserialize input", () => {
    const config = makeConfig();
    const instance = getRoutingInstance(config);
    expect(() =>
      instance.deserialize({ health: "not-valid-json", budget: "also-bad" }),
    ).not.toThrow();
  });
});

describe("getRoutingInstance — ReviewGate flagging", () => {
  it("flags CODE_REFACTOR as requiring review (auto mode)", () => {
    const config = makeConfig();
    const { reviewGate } = getRoutingInstance(config);

    expect(reviewGate.shouldReview(TaskType.CODE_REFACTOR)).toBe(true);
    expect(reviewGate.isAutoMode()).toBe(true);
  });

  it("does not flag CODE_EDIT as requiring review", () => {
    const config = makeConfig();
    const { reviewGate } = getRoutingInstance(config);

    expect(reviewGate.shouldReview(TaskType.CODE_EDIT)).toBe(false);
  });

  it("returns false for all task types when review_gate is disabled", () => {
    const config = makeConfig({
      review_gate: {
        enabled: false,
        mode: "auto",
        high_risk_types: [TaskType.CODE_REFACTOR, TaskType.SECURITY_AUDIT, TaskType.GIT_OPS],
        reviewer_model: "anthropic/claude-opus-4-6",
        reviewer_system_prompt: "",
        timeout_ms: 60_000,
      },
    });
    const { reviewGate } = getRoutingInstance(config);

    expect(reviewGate.shouldReview(TaskType.CODE_REFACTOR)).toBe(false);
    expect(reviewGate.shouldReview(TaskType.SECURITY_AUDIT)).toBe(false);
  });

  it("uses manual mode when configured as manual", () => {
    const config = makeConfig({
      review_gate: {
        enabled: true,
        mode: "manual",
        high_risk_types: [TaskType.CODE_REFACTOR],
        reviewer_model: "anthropic/claude-opus-4-6",
        reviewer_system_prompt: "",
        timeout_ms: 60_000,
      },
    });
    const { reviewGate } = getRoutingInstance(config);

    expect(reviewGate.isAutoMode()).toBe(false);
    // shouldReview is still true even in manual mode — the gate is enabled
    expect(reviewGate.shouldReview(TaskType.CODE_REFACTOR)).toBe(true);
  });
});

describe("getRoutingInstance — no optional config sections", () => {
  it("creates instance without health/budget/review_gate sections", () => {
    const config: RoutingConfig = {
      default_task_type: TaskType.FALLBACK,
      cooldown_seconds: 0,
      antiflap_enabled: false,
      triggers: {},
      deny_list: [],
      ha_matrix: {
        [TaskType.FALLBACK]: {
          [ModelTier.TIER1]: "fallback-1",
        },
      },
    };

    const instance = getRoutingInstance(config);
    expect(instance).toBeDefined();

    const models = instance.selector.resolveModels(TaskType.FALLBACK, config);
    expect(models).toEqual(["fallback-1"]);

    expect(instance.reviewGate.shouldReview(TaskType.CODE_REFACTOR)).toBe(false);
    expect(instance.budgetTracker.shouldBlock()).toBe(false);
  });
});
