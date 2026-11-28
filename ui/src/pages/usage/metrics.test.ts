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

it("keeps throughput empty when the selected day has no timing", () => {
  const latency = {
    count: 1,
    avgMs: 60_000,
    p95Ms: 60_000,
    minMs: 60_000,
    maxMs: 60_000,
    timedMs: 60_000,
    timedTokens: 1_000,
    timedCost: 0.1,
  };
  expect(usageThroughputStats({ latency }, ["2026-05-14"])).toEqual({});
});
