import { describe, expect, it } from "vitest";
import { buildUsageCostWindows, formatDayLabel, formatFullDate } from "./metrics.ts";

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
