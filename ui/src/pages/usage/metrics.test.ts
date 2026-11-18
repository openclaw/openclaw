import { expect, it } from "vitest";
import { buildPeakErrorHours, usageActiveMs, usageThroughputStats } from "./metrics.ts";

it("formats the five highest nonzero server error rates", () => {
  expect(
    buildPeakErrorHours(Array(8).fill(100), [2, 4, 6, 8, 10, 12, 14, 16]).map(({ value, sub }) => ({
      value,
      sub,
    })),
  ).toEqual(
    [16, 14, 12, 10, 8].map((errors) => ({
      value: `${errors.toFixed(2)}%`,
      sub: `${errors} errors · 100 msgs`,
    })),
  );
  expect(buildPeakErrorHours([10, 0], [0, 1])).toEqual([]);
});

it("divides throughput by active time from recorded turn durations", () => {
  const totals = { totalTokens: 14_098_000, totalCost: 21.5 };
  const activeMs = usageActiveMs({ latency: { count: 91, avgMs: 155_981 } }, []);
  expect(activeMs).toBe(91 * 155_981);
  const stats = usageThroughputStats({ totals, activeMs });
  expect(stats.throughputTokensPerMin).toBeCloseTo(14_098_000 / ((91 * 155_981) / 60_000), 5);
  expect(stats.throughputCostPerMin).toBeCloseTo(21.5 / ((91 * 155_981) / 60_000), 5);
});

it("scopes the active-time denominator to the selected days", () => {
  const dailyLatency = [
    { date: "2026-11-16", count: 1, avgMs: 60_000 },
    { date: "2026-11-17", count: 9, avgMs: 60_000 },
  ];
  expect(usageActiveMs({ dailyLatency }, ["2026-11-16"])).toBe(60_000);
  expect(usageActiveMs({ dailyLatency }, ["2026-11-16", "2026-11-17"])).toBe(600_000);
  // Without daily buckets the full-range aggregate stays the denominator.
  expect(
    usageActiveMs(
      {
        latency: { count: 10, avgMs: 60_000 },
        dailyLatency: [{ date: "2026-11-16", count: 1, avgMs: 60_000 }],
      },
      [],
    ),
  ).toBe(600_000);
  // With days selected, a missing daily breakdown must not fall back to the
  // unfiltered aggregate — the day-filtered totals would divide by other
  // days' activity.
  expect(
    usageActiveMs({ latency: { count: 10, avgMs: 60_000 } }, ["2026-11-16"]),
  ).toBe(0);
  expect(
    usageActiveMs(
      {
        latency: { count: 10, avgMs: 60_000 },
        dailyLatency: [{ date: "2026-11-15", count: 4, avgMs: 60_000 }],
      },
      ["2026-11-16"],
    ),
  ).toBe(0);
});

it("keeps throughput empty without latency samples instead of dividing by the session span", () => {
  const totals = { totalTokens: 14_098_000, totalCost: 21.5 };
  expect(usageThroughputStats({ totals, activeMs: usageActiveMs({}, []) })).toEqual({
    throughputTokensPerMin: undefined,
    throughputCostPerMin: undefined,
  });
  expect(
    usageThroughputStats({
      totals,
      activeMs: usageActiveMs({ latency: { count: 0, avgMs: 0 } }, []),
    }),
  ).toEqual({ throughputTokensPerMin: undefined, throughputCostPerMin: undefined });
});
