import { describe, expect, it } from "vitest";
import { buildUsageCostWindows, formatDayLabel, formatFullDate } from "./metrics.ts";

describe("usage metrics date labels", () => {
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
