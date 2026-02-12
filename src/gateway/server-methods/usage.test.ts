import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../infra/session-cost-usage.js", async () => {
  const actual = await vi.importActual<typeof import("../../infra/session-cost-usage.js")>(
    "../../infra/session-cost-usage.js",
  );
  return {
    ...actual,
    loadCostUsageSummary: vi.fn(async () => ({
      updatedAt: Date.now(),
      startDate: "2026-02-01",
      endDate: "2026-02-02",
      daily: [],
      totals: { totalTokens: 1, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalCost: 0 },
    })),
  };
});

import { loadCostUsageSummary } from "../../infra/session-cost-usage.js";
import { __test } from "./usage.js";

describe("gateway usage helpers", () => {
  beforeEach(() => {
    __test.costUsageCache.clear();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("parseDateToMs accepts YYYY-MM-DD and rejects invalid input", () => {
    expect(__test.parseDateToMs("2026-02-05")).toBe(Date.UTC(2026, 1, 5));
    expect(__test.parseDateToMs(" 2026-02-05 ")).toBe(Date.UTC(2026, 1, 5));
    expect(__test.parseDateToMs("2026-2-5")).toBeUndefined();
    expect(__test.parseDateToMs("nope")).toBeUndefined();
    expect(__test.parseDateToMs(undefined)).toBeUndefined();
  });

  it("parseDays coerces strings/numbers to integers", () => {
    expect(__test.parseDays(7.9)).toBe(7);
    expect(__test.parseDays("30")).toBe(30);
    expect(__test.parseDays("")).toBeUndefined();
    expect(__test.parseDays("nope")).toBeUndefined();
  });

  it("parseDateRange uses explicit start/end (inclusive end of day)", () => {
    const range = __test.parseDateRange({ startDate: "2026-02-01", endDate: "2026-02-02" });
    expect(range.startMs).toBe(Date.UTC(2026, 1, 1));
    expect(range.endMs).toBe(Date.UTC(2026, 1, 2) + 24 * 60 * 60 * 1000 - 1);
  });

  it("parseDateRange clamps days to at least 1 and defaults to 30 days", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-05T12:34:56.000Z"));
    const oneDay = __test.parseDateRange({ days: 0 });
    expect(oneDay.endMs).toBe(Date.UTC(2026, 1, 5) + 24 * 60 * 60 * 1000 - 1);
    expect(oneDay.startMs).toBe(Date.UTC(2026, 1, 5));

    const def = __test.parseDateRange({});
    expect(def.endMs).toBe(Date.UTC(2026, 1, 5) + 24 * 60 * 60 * 1000 - 1);
    expect(def.startMs).toBe(Date.UTC(2026, 1, 5) - 29 * 24 * 60 * 60 * 1000);
  });

  it("loadCostUsageSummaryCached caches within TTL", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-05T00:00:00.000Z"));

    const config = {} as unknown as ReturnType<import("../../config/config.js").loadConfig>;
    const a = await __test.loadCostUsageSummaryCached({
      startMs: 1,
      endMs: 2,
      config,
    });
    const b = await __test.loadCostUsageSummaryCached({
      startMs: 1,
      endMs: 2,
      config,
    });

    expect(a.totals.totalTokens).toBe(1);
    expect(b.totals.totalTokens).toBe(1);
    expect(vi.mocked(loadCostUsageSummary)).toHaveBeenCalledTimes(1);
  });
});
