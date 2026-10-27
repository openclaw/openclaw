import { describe, expect, it } from "vitest";
import {
  buildUsageCostWindows,
  formatAnalysisCost,
  formatDayLabel,
  formatFullDate,
  formatUsageCost,
} from "./metrics.ts";

describe("usage metrics date labels", () => {
  it("uses the host's default locale and UTC calendar date", () => {
    const date = new Date("2026-01-01T00:00:00Z");
    expect([formatDayLabel("2026-01-01"), formatFullDate("2026-01-01")]).toEqual([
      date.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" }),
      date.toLocaleDateString(undefined, {
        month: "long",
        day: "numeric",
        year: "numeric",
        timeZone: "UTC",
      }),
    ]);
  });

  it("leaves invalid day labels unchanged", () => {
    expect(formatDayLabel("2026-02-31")).toBe("2026-02-31");
    expect(formatFullDate("2026-02-31")).toBe("2026-02-31");
  });
});

describe("usage cost windows", () => {
  it("rejects malformed and reversed ranges", () => {
    expect(buildUsageCostWindows([], "bad", "2026-07-01")).toEqual([]);
    expect(buildUsageCostWindows([], "2026-07-02", "2026-07-01")).toEqual([]);
  });
});

describe("usage fixed-precision costs", () => {
  it("preserves grouping, sign and precision across interleaved calls", () => {
    const costs = [
      [1234.5, 2, "$1,234.50"],
      [-0, 4, "$-0.0000"],
      [0.000001, 6, "$0.000001"],
      [-1234.5, 2, "$-1,234.50"],
      [0.0001, 4, "$0.0001"],
      [0, 6, "$0.000000"],
      [Number.NaN, 2, "$NaN"],
      [Number.POSITIVE_INFINITY, 4, "$∞"],
      [Number.NEGATIVE_INFINITY, 6, "$-∞"],
      [1234.5, 2, "$1,234.50"],
    ] as const;
    for (const [value, decimals, expected] of costs) {
      expect(formatUsageCost(value, decimals)).toBe(expected);
    }
    expect(formatUsageCost(1.5)).toBe("$1.50");
    expect(formatUsageCost(1.5, 2, { state: "unavailable" })).toBe("≥ $1.50");
  });

  it("keeps analysis scale boundaries and small negative amounts", () => {
    for (const [value, expected] of [
      [0, "$0.00"],
      [0.01, "$0.01"],
      [-0.01, "$-0.01"],
      [0.0001, "$0.0001"],
      [-0.0001, "$-0.0001"],
      [0.000001, "$0.000001"],
    ] as const) {
      expect(formatAnalysisCost(value)).toBe(expected);
    }
  });
});
