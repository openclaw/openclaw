import { describe, expect, it } from "vitest";
import { buildUsageCostWindows, formatDayLabel, formatFullDate } from "./metrics.ts";

function costDay(date: string, totalCost: number, totalTokens: number) {
  return {
    date,
    input: totalTokens,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens,
    totalCost,
    inputCost: totalCost,
    outputCost: 0,
    cacheReadCost: 0,
    cacheWriteCost: 0,
    missingCostEntries: 0,
  };
}

describe("usage metrics date labels", () => {
  it("formats YYYY-MM-DD values as local calendar dates", () => {
    const date = new Date(2026, 1, 1);
    expect(formatDayLabel("2026-02-01")).toBe(
      date.toLocaleDateString(undefined, { month: "short", day: "numeric" }),
    );
    expect(formatFullDate("2026-02-01")).toBe(
      date.toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" }),
    );
  });

  it("leaves invalid day labels unchanged", () => {
    expect(formatDayLabel("2026-02-31")).toBe("2026-02-31");
    expect(formatFullDate("2026-02-31")).toBe("2026-02-31");
  });
});

describe("usage cost windows", () => {
  const daily = [
    costDay("2026-06-01", 1, 100),
    costDay("2026-06-02", 2, 200),
    costDay("2026-06-24", 3, 300),
    costDay("2026-06-25", 4, 400),
    costDay("2026-07-01", 5, 500),
    costDay("2026-07-02", 6, 600),
  ];

  it("uses calendar windows instead of the last non-empty rows", () => {
    const [, ...windows] = buildUsageCostWindows(daily, "2026-06-01", "2026-07-01");

    expect(windows.map(({ days, endDate }) => ({ days, endDate }))).toEqual([
      { days: 1, endDate: "2026-07-01" },
      { days: 7, endDate: "2026-07-01" },
      { days: 30, endDate: "2026-07-01" },
    ]);
    expect(windows.map((window) => window.totals.totalCost)).toEqual([5, 9, 14]);
    expect(windows.map((window) => window.totals.totalTokens)).toEqual([500, 900, 1_400]);
  });

  it("keeps the selected-range total separate from shorter comparisons", () => {
    const [range] = buildUsageCostWindows(daily, "2026-06-01", "2026-07-01");

    expect(range?.days).toBe(31);
    expect(range?.totals.totalCost).toBe(15);
    expect(range?.totals.totalTokens).toBe(1_500);
  });

  it("rejects malformed and reversed ranges", () => {
    expect(buildUsageCostWindows(daily, "bad", "2026-07-01")).toEqual([]);
    expect(buildUsageCostWindows(daily, "2026-07-02", "2026-07-01")).toEqual([]);
  });
});
