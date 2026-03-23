import { describe, expect, it } from "vitest";
import { getDefaultConfig } from "./config.js";
import {
  applyCooldownPeriod,
  applyCustomConstraint,
  applyMaxNudgesPerDay,
  applyRepeatedIgnores,
  applyUncertaintyThreshold,
  ConstraintLayer,
  evaluateCondition,
} from "./constraints.js";
import type {
  AggregateStats,
  CandidateAction,
  ConstraintRule,
  PolicyContext,
  PolicyFeedbackConfig,
  ScoredCandidate,
} from "./types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeCandidate(overrides?: Partial<CandidateAction>): CandidateAction {
  return {
    id: "cand-1",
    actionType: "agent_reply",
    description: "Reply to user",
    ...overrides,
  };
}

function makeScored(
  overrides?: Partial<ScoredCandidate>,
  candidateOverrides?: Partial<CandidateAction>,
): ScoredCandidate {
  return {
    candidate: makeCandidate(candidateOverrides),
    score: 0.7,
    reasons: ["Base score: 50"],
    suppress: false,
    ...overrides,
  };
}

function makeContext(overrides?: Partial<PolicyContext>): PolicyContext {
  return {
    channelId: "telegram",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// applyMaxNudgesPerDay
// ---------------------------------------------------------------------------

describe("applyMaxNudgesPerDay", () => {
  it("does not suppress when recentActionCount is below max", () => {
    const candidates = [makeScored()];
    const ctx = makeContext({ recentActionCount: 5 });
    const result = applyMaxNudgesPerDay(candidates, ctx, 20);
    expect(result[0].suppress).toBe(false);
  });

  it("suppresses all candidates when recentActionCount exceeds max", () => {
    const candidates = [makeScored(), makeScored({ score: 0.9 })];
    const ctx = makeContext({ recentActionCount: 25 });
    const result = applyMaxNudgesPerDay(candidates, ctx, 20);
    expect(result.every((c) => c.suppress)).toBe(true);
    expect(result[0].suppressionRule).toBe("max_nudges_per_day");
  });

  it("does not suppress when recentActionCount equals max", () => {
    const candidates = [makeScored()];
    const ctx = makeContext({ recentActionCount: 20 });
    const result = applyMaxNudgesPerDay(candidates, ctx, 20);
    expect(result[0].suppress).toBe(false);
  });

  it("handles undefined recentActionCount as zero", () => {
    const candidates = [makeScored()];
    const ctx = makeContext();
    const result = applyMaxNudgesPerDay(candidates, ctx, 20);
    expect(result[0].suppress).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// applyRepeatedIgnores
// ---------------------------------------------------------------------------

describe("applyRepeatedIgnores", () => {
  it("does not suppress when consecutiveIgnores is below threshold", () => {
    const candidates = [makeScored()];
    const ctx = makeContext({ consecutiveIgnores: 1 });
    const result = applyRepeatedIgnores(candidates, ctx, 3);
    expect(result[0].suppress).toBe(false);
  });

  it("suppresses user-facing actions when threshold is met", () => {
    const candidates = [makeScored()];
    const ctx = makeContext({ consecutiveIgnores: 3 });
    const result = applyRepeatedIgnores(candidates, ctx, 3);
    expect(result[0].suppress).toBe(true);
    expect(result[0].suppressionRule).toBe("repeated_ignores");
  });

  it("does not suppress non-user-facing actions (tool_call)", () => {
    const candidates = [makeScored(undefined, { actionType: "tool_call" })];
    const ctx = makeContext({ consecutiveIgnores: 5 });
    const result = applyRepeatedIgnores(candidates, ctx, 3);
    expect(result[0].suppress).toBe(false);
  });

  it("does not suppress no_op actions", () => {
    const candidates = [makeScored(undefined, { actionType: "no_op" })];
    const ctx = makeContext({ consecutiveIgnores: 5 });
    const result = applyRepeatedIgnores(candidates, ctx, 3);
    expect(result[0].suppress).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// applyCooldownPeriod
// ---------------------------------------------------------------------------

describe("applyCooldownPeriod", () => {
  it("does not suppress when timeSinceLastActionMs exceeds cooldown", () => {
    const candidates = [makeScored()];
    const ctx = makeContext({ timeSinceLastActionMs: 7_200_000 }); // 2 hours
    const result = applyCooldownPeriod(candidates, ctx, 3_600_000);
    expect(result[0].suppress).toBe(false);
  });

  it("suppresses when timeSinceLastActionMs is within cooldown", () => {
    const candidates = [makeScored()];
    const ctx = makeContext({ timeSinceLastActionMs: 1_000 }); // 1 second
    const result = applyCooldownPeriod(candidates, ctx, 3_600_000);
    expect(result[0].suppress).toBe(true);
    expect(result[0].suppressionRule).toBe("cooldown_period");
  });

  it("does not suppress when timeSinceLastActionMs is undefined", () => {
    const candidates = [makeScored()];
    const ctx = makeContext();
    const result = applyCooldownPeriod(candidates, ctx, 3_600_000);
    expect(result[0].suppress).toBe(false);
  });

  it("does not suppress when timeSinceLastActionMs equals cooldown", () => {
    const candidates = [makeScored()];
    const ctx = makeContext({ timeSinceLastActionMs: 3_600_000 });
    const result = applyCooldownPeriod(candidates, ctx, 3_600_000);
    expect(result[0].suppress).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// applyUncertaintyThreshold
// ---------------------------------------------------------------------------

describe("applyUncertaintyThreshold", () => {
  it("does not suppress when confidence is above threshold", () => {
    const candidates = [makeScored()];
    const result = applyUncertaintyThreshold(candidates, 0.5, 0.2);
    expect(result[0].suppress).toBe(false);
  });

  it("suppresses non-no-op candidates when confidence is below threshold", () => {
    const candidates = [makeScored()];
    const result = applyUncertaintyThreshold(candidates, 0.1, 0.2);
    expect(result[0].suppress).toBe(true);
    expect(result[0].suppressionRule).toBe("uncertainty_threshold");
  });

  it("boosts no_op candidates when confidence is below threshold", () => {
    const candidates = [makeScored(undefined, { actionType: "no_op" })];
    const result = applyUncertaintyThreshold(candidates, 0.1, 0.2);
    expect(result[0].suppress).toBe(false);
    expect(result[0].reasons).toContainEqual(expect.stringContaining("favors no-op"));
  });

  it("handles exact threshold value as passing", () => {
    const candidates = [makeScored()];
    const result = applyUncertaintyThreshold(candidates, 0.2, 0.2);
    expect(result[0].suppress).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// applyCustomConstraint
// ---------------------------------------------------------------------------

describe("applyCustomConstraint", () => {
  it("suppresses when custom rule condition is met and action is suppress", () => {
    const rule: ConstraintRule = {
      id: "quiet-hours",
      description: "No actions during quiet hours",
      condition: { type: "time_of_day_block", startHour: 22, endHour: 6 },
      action: "suppress",
      priority: 1,
    };
    const candidates = [makeScored()];
    const ctx = makeContext({ hourOfDay: 23 });
    const result = applyCustomConstraint(candidates, rule, ctx);
    expect(result[0].suppress).toBe(true);
    expect(result[0].suppressionRule).toBe("quiet-hours");
  });

  it("adds reason but does not suppress for warn action", () => {
    const rule: ConstraintRule = {
      id: "high-ignores",
      description: "High ignore count warning",
      condition: { type: "consecutive_ignores", threshold: 2 },
      action: "warn",
      priority: 1,
    };
    const candidates = [makeScored()];
    const ctx = makeContext({ consecutiveIgnores: 3 });
    const result = applyCustomConstraint(candidates, rule, ctx);
    expect(result[0].suppress).toBe(false);
    expect(result[0].reasons).toContainEqual(expect.stringContaining("high-ignores"));
  });

  it("does nothing when condition is not met", () => {
    const rule: ConstraintRule = {
      id: "min-interval",
      description: "Minimum interval between actions",
      condition: { type: "min_interval", minMs: 5000 },
      action: "suppress",
      priority: 1,
    };
    const candidates = [makeScored()];
    const ctx = makeContext({ timeSinceLastActionMs: 10000 });
    const result = applyCustomConstraint(candidates, rule, ctx);
    expect(result[0].suppress).toBe(false);
    expect(result[0].reasons).toHaveLength(1); // only base reason
  });
});

// ---------------------------------------------------------------------------
// evaluateCondition
// ---------------------------------------------------------------------------

describe("evaluateCondition", () => {
  it("max_actions_per_period: triggers when count exceeds max", () => {
    const ctx = makeContext({ recentActionCount: 15 });
    expect(
      evaluateCondition(
        { type: "max_actions_per_period", maxCount: 10, periodMs: 86_400_000 },
        ctx,
      ),
    ).toBe(true);
  });

  it("consecutive_ignores: triggers at threshold", () => {
    const ctx = makeContext({ consecutiveIgnores: 5 });
    expect(evaluateCondition({ type: "consecutive_ignores", threshold: 5 }, ctx)).toBe(true);
  });

  it("time_of_day_block: triggers within range", () => {
    const ctx = makeContext({ hourOfDay: 14 });
    expect(evaluateCondition({ type: "time_of_day_block", startHour: 12, endHour: 18 }, ctx)).toBe(
      true,
    );
  });

  it("time_of_day_block: handles midnight wraparound", () => {
    const ctx = makeContext({ hourOfDay: 2 });
    expect(evaluateCondition({ type: "time_of_day_block", startHour: 22, endHour: 6 }, ctx)).toBe(
      true,
    );
  });

  it("time_of_day_block: returns false when hourOfDay is undefined", () => {
    const ctx = makeContext();
    expect(evaluateCondition({ type: "time_of_day_block", startHour: 22, endHour: 6 }, ctx)).toBe(
      false,
    );
  });

  it("min_interval: triggers when elapsed < minMs", () => {
    const ctx = makeContext({ timeSinceLastActionMs: 1000 });
    expect(evaluateCondition({ type: "min_interval", minMs: 5000 }, ctx)).toBe(true);
  });

  it("min_interval: returns false when timeSinceLastActionMs is undefined", () => {
    const ctx = makeContext();
    expect(evaluateCondition({ type: "min_interval", minMs: 5000 }, ctx)).toBe(false);
  });

  it("low_effectiveness: returns false when no stats provided", () => {
    const ctx = makeContext();
    expect(
      evaluateCondition(
        { type: "low_effectiveness", threshold: 0.3, actionType: "agent_reply" },
        ctx,
      ),
    ).toBe(false);
  });

  it("low_effectiveness: triggers when reply rate is below threshold", () => {
    const ctx = makeContext();
    const stats: AggregateStats = {
      computedAt: new Date().toISOString(),
      totalActions: 50,
      totalOutcomes: 40,
      byActionType: {
        agent_reply: { count: 50, outcomeCount: 40, replyRate: 0.2, suppressionRate: 0 },
      },
      byHourOfDay: {},
      byConsecutiveIgnores: {},
      byChannel: {},
    };
    expect(
      evaluateCondition(
        { type: "low_effectiveness", threshold: 0.3, actionType: "agent_reply" },
        ctx,
        stats,
      ),
    ).toBe(true);
  });

  it("low_effectiveness: does not trigger when reply rate meets threshold", () => {
    const ctx = makeContext();
    const stats: AggregateStats = {
      computedAt: new Date().toISOString(),
      totalActions: 50,
      totalOutcomes: 40,
      byActionType: {
        agent_reply: { count: 50, outcomeCount: 40, replyRate: 0.5, suppressionRate: 0 },
      },
      byHourOfDay: {},
      byConsecutiveIgnores: {},
      byChannel: {},
    };
    expect(
      evaluateCondition(
        { type: "low_effectiveness", threshold: 0.3, actionType: "agent_reply" },
        ctx,
        stats,
      ),
    ).toBe(false);
  });

  it("low_effectiveness: returns false when action type has no data", () => {
    const ctx = makeContext();
    const stats: AggregateStats = {
      computedAt: new Date().toISOString(),
      totalActions: 10,
      totalOutcomes: 5,
      byActionType: {},
      byHourOfDay: {},
      byConsecutiveIgnores: {},
      byChannel: {},
    };
    expect(
      evaluateCondition(
        { type: "low_effectiveness", threshold: 0.3, actionType: "agent_reply" },
        ctx,
        stats,
      ),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ConstraintLayer
// ---------------------------------------------------------------------------

describe("ConstraintLayer", () => {
  it("applies all built-in constraints in sequence", () => {
    const config = getDefaultConfig();
    const layer = new ConstraintLayer(config);
    const candidates = [makeScored()];
    const ctx = makeContext({
      recentActionCount: 25,
      consecutiveIgnores: 5,
      timeSinceLastActionMs: 100,
    });

    const result = layer.applyConstraints(candidates, ctx);
    expect(result[0].suppress).toBe(true);
    // Should have reasons from multiple constraints
    expect(result[0].reasons.length).toBeGreaterThan(1);
  });

  it("does not apply constraints when mode is off", () => {
    const config: PolicyFeedbackConfig = { ...getDefaultConfig(), mode: "off" };
    const layer = new ConstraintLayer(config);
    const candidates = [makeScored()];
    const ctx = makeContext({ recentActionCount: 100 });

    const result = layer.applyConstraints(candidates, ctx);
    expect(result[0].suppress).toBe(false);
  });

  it("applies custom constraint rules sorted by priority", () => {
    const config: PolicyFeedbackConfig = {
      ...getDefaultConfig(),
      constraints: [
        {
          id: "low-priority",
          description: "Low priority rule",
          condition: { type: "consecutive_ignores", threshold: 1 },
          action: "warn",
          priority: 10,
        },
        {
          id: "high-priority",
          description: "High priority rule",
          condition: { type: "consecutive_ignores", threshold: 1 },
          action: "suppress",
          priority: 1,
        },
      ],
    };
    const layer = new ConstraintLayer(config);
    const candidates = [makeScored()];
    const ctx = makeContext({ consecutiveIgnores: 2 });

    const result = layer.applyConstraints(candidates, ctx);
    // Both should have fired; check that high-priority fired first
    // (suppressionRule should be from repeated_ignores built-in or high-priority custom)
    expect(result[0].suppress).toBe(true);
  });

  it("passes through candidates unchanged when no constraints trigger", () => {
    const config = getDefaultConfig();
    const layer = new ConstraintLayer(config);
    const candidates = [makeScored()];
    const ctx = makeContext({
      recentActionCount: 1,
      consecutiveIgnores: 0,
      timeSinceLastActionMs: 7_200_000,
    });

    const result = layer.applyConstraints(candidates, ctx);
    expect(result[0].suppress).toBe(false);
    expect(result[0].reasons).toEqual(["Base score: 50"]);
  });

  describe("isNoOpPreferred", () => {
    it("returns true when 2+ constraints would fire", () => {
      const config = getDefaultConfig();
      const layer = new ConstraintLayer(config);
      const ctx = makeContext({
        recentActionCount: 25, // exceeds max nudges
        consecutiveIgnores: 5, // exceeds repeated ignores
      });
      expect(layer.isNoOpPreferred(ctx)).toBe(true);
    });

    it("returns false when only 1 constraint would fire", () => {
      const config = getDefaultConfig();
      const layer = new ConstraintLayer(config);
      const ctx = makeContext({
        recentActionCount: 25, // exceeds max nudges
        consecutiveIgnores: 0, // below threshold
      });
      expect(layer.isNoOpPreferred(ctx)).toBe(false);
    });

    it("returns false when no constraints would fire", () => {
      const config = getDefaultConfig();
      const layer = new ConstraintLayer(config);
      const ctx = makeContext({
        recentActionCount: 1,
        consecutiveIgnores: 0,
        timeSinceLastActionMs: 7_200_000,
      });
      expect(layer.isNoOpPreferred(ctx)).toBe(false);
    });
  });

  describe("getActiveConstraints", () => {
    it("returns built-in constraint descriptions", () => {
      const config = getDefaultConfig();
      const layer = new ConstraintLayer(config);
      const descriptions = layer.getActiveConstraints();
      expect(descriptions).toHaveLength(4); // 4 built-in
      expect(descriptions[0]).toContain("max_nudges_per_day");
    });

    it("includes custom constraint descriptions", () => {
      const config: PolicyFeedbackConfig = {
        ...getDefaultConfig(),
        constraints: [
          {
            id: "custom-1",
            description: "My custom rule",
            condition: { type: "consecutive_ignores", threshold: 2 },
            action: "suppress",
            priority: 1,
          },
        ],
      };
      const layer = new ConstraintLayer(config);
      const descriptions = layer.getActiveConstraints();
      expect(descriptions).toHaveLength(5); // 4 built-in + 1 custom
      expect(descriptions[4]).toContain("My custom rule");
    });
  });
});
