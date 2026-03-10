import { describe, expect, it } from "vitest";
import { formatNextRun } from "../ui/src/ui/presenter.ts";

describe("formatNextRun", () => {
  it("returns n/a for nullish values", () => {
    expect(formatNextRun(null)).toBe("n/a");
    expect(formatNextRun(undefined)).toBe("n/a");
  });

  it("includes weekday and relative time", () => {
    const ts = Date.UTC(2026, 1, 23, 15, 0, 0);
    const out = formatNextRun(ts);
    const [weekday, rest] = out.split(", ", 2);
    expect(weekday.length).toBeGreaterThan(0);
    expect(rest?.length).toBeGreaterThan(0);
    expect(out).toContain("(");
    expect(out).toContain(")");
  });
});
