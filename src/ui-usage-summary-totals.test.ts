import { describe, expect, it } from "vitest";
import { __test } from "../ui/src/ui/views/usage.ts";

describe("usage summary totals", () => {
  it("prefers full daily aggregates for base totals when available", () => {
    const sessionTotals = {
      input: 10,
      output: 20,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 30,
      totalCost: 1,
      inputCost: 0.4,
      outputCost: 0.6,
      cacheReadCost: 0,
      cacheWriteCost: 0,
      missingCostEntries: 0,
    };

    const costDaily = [
      {
        date: "2026-02-25",
        input: 100,
        output: 200,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 300,
        totalCost: 9,
        inputCost: 4,
        outputCost: 5,
        cacheReadCost: 0,
        cacheWriteCost: 0,
        missingCostEntries: 2,
      },
    ];

    const totals = __test.resolveBaseTotals({
      sessionTotals,
      costDaily,
    });

    expect(totals?.totalTokens).toBe(300);
    expect(totals?.totalCost).toBe(9);
    expect(totals?.missingCostEntries).toBe(2);
  });

  it("falls back to session totals when daily aggregates are unavailable", () => {
    const sessionTotals = {
      input: 11,
      output: 22,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 33,
      totalCost: 1.23,
      inputCost: 0.5,
      outputCost: 0.73,
      cacheReadCost: 0,
      cacheWriteCost: 0,
      missingCostEntries: 1,
    };

    const totals = __test.resolveBaseTotals({
      sessionTotals,
      costDaily: [],
    });

    expect(totals).toEqual(sessionTotals);
  });

  it("resolves lifetime preset to a fixed start date", () => {
    const range = __test.resolvePresetRange(
      { lifetime: true },
      new Date("2026-02-26T12:00:00.000Z"),
    );

    expect(range).toEqual({
      startDate: "1970-01-01",
      endDate: "2026-02-26",
    });
  });

  it("resolves rolling presets based on day count", () => {
    const range = __test.resolvePresetRange({ days: 7 }, new Date("2026-02-26T12:00:00.000Z"));

    expect(range).toEqual({
      startDate: "2026-02-20",
      endDate: "2026-02-26",
    });
  });
});
