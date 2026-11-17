import { expect, it } from "vitest";
import { buildPeakErrorHours, usageThroughputStats } from "./metrics.ts";

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
  const latency = { count: 91, avgMs: 155_981, p95Ms: 0, minMs: 0, maxMs: 0 };
  const stats = usageThroughputStats({ totals, latency });
  expect(stats.throughputTokensPerMin).toBeCloseTo(14_098_000 / ((91 * 155_981) / 60_000), 5);
  expect(stats.throughputCostPerMin).toBeCloseTo(21.5 / ((91 * 155_981) / 60_000), 5);
});

it("keeps throughput empty without latency samples instead of dividing by the session span", () => {
  const totals = { totalTokens: 14_098_000, totalCost: 21.5 };
  expect(usageThroughputStats({ totals, latency: undefined })).toEqual({
    throughputTokensPerMin: undefined,
    throughputCostPerMin: undefined,
  });
  expect(
    usageThroughputStats({ totals, latency: { count: 0, avgMs: 0, p95Ms: 0, minMs: 0, maxMs: 0 } }),
  ).toEqual({ throughputTokensPerMin: undefined, throughputCostPerMin: undefined });
});

