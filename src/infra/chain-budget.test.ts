import { describe, expect, it } from "vitest";
import { ChainBudget } from "./chain-budget.js";

describe("ChainBudget.declineToCarry", () => {
  it("declines when remaining is 0 (depth-cap fires)", () => {
    expect(ChainBudget.declineToCarry({ chainStepBudgetRemaining: 0 })).toBe(true);
  });

  it("declines when remaining is negative (overdrawn)", () => {
    expect(ChainBudget.declineToCarry({ chainStepBudgetRemaining: -1 })).toBe(true);
  });

  it("does not decline when remaining is positive (budget intact)", () => {
    expect(ChainBudget.declineToCarry({ chainStepBudgetRemaining: 1 })).toBe(false);
    expect(ChainBudget.declineToCarry({ chainStepBudgetRemaining: 99 })).toBe(false);
  });

  it("does not decline when state is undefined (caller has not opted in)", () => {
    // Callers that don't pass a budget see no behavioral change. The chain has
    // not opted in to carrying trace.
    expect(ChainBudget.declineToCarry(undefined)).toBe(false);
  });

  it("does not decline when remaining is NaN or Infinity (treated as untracked)", () => {
    expect(ChainBudget.declineToCarry({ chainStepBudgetRemaining: Number.NaN })).toBe(false);
    expect(ChainBudget.declineToCarry({ chainStepBudgetRemaining: Number.POSITIVE_INFINITY })).toBe(
      false,
    );
  });
});
