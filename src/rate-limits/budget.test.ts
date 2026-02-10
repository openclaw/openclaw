import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RateLimitScope } from "./types.js";
import { BudgetTracker } from "./budget.js";

const TEST_STATE_DIR = path.join(process.cwd(), ".test-state-budget");

describe("BudgetTracker", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    if (fs.existsSync(TEST_STATE_DIR)) {
      fs.rmSync(TEST_STATE_DIR, { recursive: true, force: true });
    }
  });

  const scope: RateLimitScope = { provider: "openai", model: "gpt-4" };

  it("accumulates daily tokens", () => {
    const budget = new BudgetTracker({ stateDir: TEST_STATE_DIR });

    budget.record_usage(scope, 100);
    const status1 = budget.getStatus(scope);
    expect(status1.dailyUsedTokens).toBe(100);

    budget.record_usage(scope, 50);
    const status2 = budget.getStatus(scope);
    expect(status2.dailyUsedTokens).toBe(150);
  });

  it("persists state to disk", () => {
    const budget1 = new BudgetTracker({ stateDir: TEST_STATE_DIR });
    budget1.record_usage(scope, 500);
    // Force flush
    budget1.flush();

    const budget2 = new BudgetTracker({ stateDir: TEST_STATE_DIR });
    const status = budget2.getStatus(scope);
    expect(status.dailyUsedTokens).toBe(500);
  });

  it("warns when thresholds are crossed", () => {
    const budget = new BudgetTracker({
      stateDir: TEST_STATE_DIR,
      providerLimits: {
        openai: { dailyTokenBudget: 1000 },
      },
    });

    // 50% - no warning
    const w1 = budget.record_usage(scope, 500);
    expect(w1).toHaveLength(0);

    // 85% - warning (default threshold 0.8)
    const w2 = budget.record_usage(scope, 350);
    expect(w2).toHaveLength(1);
    expect(w2[0].level).toBe(0.8);
    expect(w2[0].period).toBe("daily");
  });

  it("hard blocks when budget exceeded", () => {
    const budget = new BudgetTracker({
      stateDir: TEST_STATE_DIR,
      hardBlock: true,
      providerLimits: {
        openai: { dailyTokenBudget: 100 },
      },
    });

    budget.record_usage(scope, 80);
    expect(budget.checkBudget(scope).allowed).toBe(true);

    budget.record_usage(scope, 21); // Total 101
    expect(budget.checkBudget(scope).allowed).toBe(false);
  });
});
