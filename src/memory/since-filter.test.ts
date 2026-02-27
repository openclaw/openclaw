import { describe, expect, it, vi } from "vitest";
import { buildSinceClause, parseSince } from "./since-filter.js";

describe("since filter", () => {
  it("parses relative day values", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-27T12:00:00.000Z"));

    expect(parseSince("7d")?.toISOString().slice(0, 10)).toBe("2026-02-20");
    expect(parseSince("30d")?.toISOString().slice(0, 10)).toBe("2026-01-28");
    expect(parseSince("0d")?.toISOString().slice(0, 10)).toBe("2026-02-27");

    vi.useRealTimers();
  });

  it("parses absolute date values", () => {
    expect(parseSince("2026-02-25")?.toISOString().slice(0, 10)).toBe("2026-02-25");
  });

  it("returns null for invalid input", () => {
    expect(parseSince("")).toBeNull();
    expect(parseSince("abc")).toBeNull();
  });

  it("builds a since SQL clause", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-27T12:00:00.000Z"));

    expect(buildSinceClause("7d")).toEqual({
      sql: " AND (source_date >= ? OR source_date IS NULL)",
      params: ["2026-02-20"],
    });

    vi.useRealTimers();
  });

  it("returns null SQL clause for invalid input", () => {
    expect(buildSinceClause("not-a-date")).toBeNull();
  });
});
