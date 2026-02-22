import { describe, expect, it } from "vitest";
import { BudgetTracker, type UsageRecord } from "../budget-tracker.js";
import { ModelTier, type BudgetConfig } from "../types.js";

function makeConfig(overrides: Partial<BudgetConfig> = {}): BudgetConfig {
  return {
    enabled: true,
    daily_budget_usd: 10,
    daily_token_limit: 500_000,
    warning_threshold: 0.8,
    critical_action: "degrade",
    ...overrides,
  };
}

function makeRecord(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    model: "anthropic/claude-sonnet-4-6",
    prompt_tokens: 1000,
    completion_tokens: 500,
    cost_usd: 1.0,
    timestamp: Date.now(),
    ...overrides,
  };
}

// ── 1. recordUsage — getTodayCost accumulates correctly ──────────────────────
describe("BudgetTracker — recordUsage & getTodayCost", () => {
  it("accumulates cost from multiple records", () => {
    const tracker = new BudgetTracker(makeConfig());
    tracker.recordUsage(makeRecord({ cost_usd: 2.0 }));
    tracker.recordUsage(makeRecord({ cost_usd: 3.0 }));
    expect(tracker.getTodayCost()).toBeCloseTo(5.0);
  });

  // ── 2. records older than 24 h are auto-evicted ──────────────────────────
  it("evicts records older than 24 hours", () => {
    const tracker = new BudgetTracker(makeConfig());
    const staleTs = Date.now() - 25 * 60 * 60 * 1000; // 25 h ago
    tracker.recordUsage(makeRecord({ cost_usd: 9.0, timestamp: staleTs }));
    tracker.recordUsage(makeRecord({ cost_usd: 1.0 })); // fresh record triggers eviction
    expect(tracker.getTodayCost()).toBeCloseTo(1.0);
  });
});

// ── 3. getTodayTokens — accumulates prompt + completion ──────────────────────
describe("BudgetTracker — getTodayTokens", () => {
  it("sums prompt_tokens and completion_tokens", () => {
    const tracker = new BudgetTracker(makeConfig());
    tracker.recordUsage(makeRecord({ prompt_tokens: 1000, completion_tokens: 500 }));
    tracker.recordUsage(makeRecord({ prompt_tokens: 2000, completion_tokens: 1000 }));
    expect(tracker.getTodayTokens()).toBe(4500);
  });
});

// ── 4–8. getBudgetTier ───────────────────────────────────────────────────────
describe("BudgetTracker — getBudgetTier", () => {
  it("returns 'normal' when cost < 80% of budget", () => {
    const tracker = new BudgetTracker(makeConfig({ daily_budget_usd: 10 }));
    tracker.recordUsage(makeRecord({ cost_usd: 7.0 })); // 70%
    expect(tracker.getBudgetTier()).toBe("normal");
  });

  it("returns 'warning' when cost is 80%–99%", () => {
    const tracker = new BudgetTracker(makeConfig({ daily_budget_usd: 10 }));
    tracker.recordUsage(makeRecord({ cost_usd: 8.5 })); // 85%
    expect(tracker.getBudgetTier()).toBe("warning");
  });

  it("returns 'critical' when cost >= 100%", () => {
    const tracker = new BudgetTracker(makeConfig({ daily_budget_usd: 10 }));
    tracker.recordUsage(makeRecord({ cost_usd: 11.0 })); // 110%
    expect(tracker.getBudgetTier()).toBe("critical");
  });

  it("returns 'warning' when token usage is 80%–99% (even if cost is low)", () => {
    const tracker = new BudgetTracker(makeConfig({ daily_token_limit: 100_000 }));
    tracker.recordUsage(
      makeRecord({ cost_usd: 0.1, prompt_tokens: 50_000, completion_tokens: 35_000 }), // 85%
    );
    expect(tracker.getBudgetTier()).toBe("warning");
  });

  it("returns 'critical' when token usage >= 100%", () => {
    const tracker = new BudgetTracker(makeConfig({ daily_token_limit: 100_000 }));
    tracker.recordUsage(
      makeRecord({ cost_usd: 0.1, prompt_tokens: 60_000, completion_tokens: 50_000 }), // 110%
    );
    expect(tracker.getBudgetTier()).toBe("critical");
  });

  it("always returns 'normal' when enabled=false regardless of usage", () => {
    const tracker = new BudgetTracker(makeConfig({ enabled: false, daily_budget_usd: 1 }));
    tracker.recordUsage(makeRecord({ cost_usd: 100.0 }));
    expect(tracker.getBudgetTier()).toBe("normal");
  });
});

// ── 9. getSuggestedStartTier ─────────────────────────────────────────────────
describe("BudgetTracker — getSuggestedStartTier", () => {
  it("returns TIER1 when normal", () => {
    const tracker = new BudgetTracker(makeConfig());
    expect(tracker.getSuggestedStartTier()).toBe(ModelTier.TIER1);
  });

  it("returns TIER2 when warning", () => {
    const tracker = new BudgetTracker(makeConfig({ daily_budget_usd: 10 }));
    tracker.recordUsage(makeRecord({ cost_usd: 8.5 }));
    expect(tracker.getSuggestedStartTier()).toBe(ModelTier.TIER2);
  });

  it("returns TIER3 when critical", () => {
    const tracker = new BudgetTracker(makeConfig({ daily_budget_usd: 10 }));
    tracker.recordUsage(makeRecord({ cost_usd: 11.0 }));
    expect(tracker.getSuggestedStartTier()).toBe(ModelTier.TIER3);
  });
});

// ── 10–11. shouldBlock ───────────────────────────────────────────────────────
describe("BudgetTracker — shouldBlock", () => {
  it("returns true when critical + critical_action='block'", () => {
    const tracker = new BudgetTracker(
      makeConfig({ daily_budget_usd: 10, critical_action: "block" }),
    );
    tracker.recordUsage(makeRecord({ cost_usd: 11.0 }));
    expect(tracker.shouldBlock()).toBe(true);
  });

  it("returns false when critical + critical_action='degrade'", () => {
    const tracker = new BudgetTracker(
      makeConfig({ daily_budget_usd: 10, critical_action: "degrade" }),
    );
    tracker.recordUsage(makeRecord({ cost_usd: 11.0 }));
    expect(tracker.shouldBlock()).toBe(false);
  });

  it("returns false when normal + critical_action='block'", () => {
    const tracker = new BudgetTracker(makeConfig({ critical_action: "block" }));
    expect(tracker.shouldBlock()).toBe(false);
  });
});

// ── 12. getUsagePercent ──────────────────────────────────────────────────────
describe("BudgetTracker — getUsagePercent", () => {
  it("returns correct percentage based on cost", () => {
    const tracker = new BudgetTracker(makeConfig({ daily_budget_usd: 10 }));
    tracker.recordUsage(makeRecord({ cost_usd: 7.5 }));
    expect(tracker.getUsagePercent()).toBe(75);
  });

  it("returns percentage based on whichever ratio is higher (tokens)", () => {
    const tracker = new BudgetTracker(
      makeConfig({ daily_budget_usd: 100, daily_token_limit: 100_000 }),
    );
    tracker.recordUsage(
      makeRecord({ cost_usd: 5.0, prompt_tokens: 60_000, completion_tokens: 20_000 }), // 80% token, 5% cost
    );
    expect(tracker.getUsagePercent()).toBe(80);
  });
});

// ── 13. reset ────────────────────────────────────────────────────────────────
describe("BudgetTracker — reset", () => {
  it("clears all records", () => {
    const tracker = new BudgetTracker(makeConfig());
    tracker.recordUsage(makeRecord({ cost_usd: 5.0 }));
    tracker.reset();
    expect(tracker.getTodayCost()).toBe(0);
    expect(tracker.getTodayTokens()).toBe(0);
  });
});

// ── 14–15. serialize / deserialize ──────────────────────────────────────────
describe("BudgetTracker — serialize/deserialize", () => {
  it("round-trips correctly", () => {
    const tracker = new BudgetTracker(makeConfig());
    tracker.recordUsage(makeRecord({ cost_usd: 2.5, prompt_tokens: 100, completion_tokens: 50 }));
    tracker.recordUsage(makeRecord({ cost_usd: 1.5, prompt_tokens: 200, completion_tokens: 100 }));

    const json = tracker.serialize();

    const tracker2 = new BudgetTracker(makeConfig());
    tracker2.deserialize(json);

    expect(tracker2.getTodayCost()).toBeCloseTo(4.0);
    expect(tracker2.getTodayTokens()).toBe(450);
  });

  it("handles invalid JSON gracefully — results in empty records", () => {
    const tracker = new BudgetTracker(makeConfig());
    tracker.deserialize("not-valid-json{{");
    expect(tracker.getTodayCost()).toBe(0);
    expect(tracker.getTodayTokens()).toBe(0);
  });

  it("evicts stale records during deserialize", () => {
    const staleTs = Date.now() - 25 * 60 * 60 * 1000;
    const staleRecord = makeRecord({ cost_usd: 9.0, timestamp: staleTs });
    const json = JSON.stringify([staleRecord]);

    const tracker2 = new BudgetTracker(makeConfig());
    tracker2.deserialize(json);
    expect(tracker2.getTodayCost()).toBe(0);
  });
});
