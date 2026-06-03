import { describe, expect, it } from "vitest";
import {
  DEFAULT_CRON_MAX_CONCURRENT_RUNS,
  resolveCronMaxConcurrentRuns,
  resolveCronMinIntervalMs,
} from "./cron-limits.js";

describe("resolveCronMaxConcurrentRuns", () => {
  it("defaults when unset and clamps to a positive integer", () => {
    expect(resolveCronMaxConcurrentRuns(undefined)).toBe(DEFAULT_CRON_MAX_CONCURRENT_RUNS);
    expect(resolveCronMaxConcurrentRuns({ maxConcurrentRuns: 3.9 })).toBe(3);
    expect(resolveCronMaxConcurrentRuns({ maxConcurrentRuns: 0 })).toBe(1);
  });
});

describe("resolveCronMinIntervalMs", () => {
  it("returns no floor (0) when unset", () => {
    expect(resolveCronMinIntervalMs(undefined)).toBe(0);
    expect(resolveCronMinIntervalMs({})).toBe(0);
  });

  it("treats numbers as milliseconds and floors negatives to 0", () => {
    expect(resolveCronMinIntervalMs({ minInterval: 30_000 })).toBe(30_000);
    expect(resolveCronMinIntervalMs({ minInterval: 1500.9 })).toBe(1500);
    expect(resolveCronMinIntervalMs({ minInterval: -5 })).toBe(0);
  });

  it("parses duration strings with units", () => {
    expect(resolveCronMinIntervalMs({ minInterval: "30s" })).toBe(30_000);
    expect(resolveCronMinIntervalMs({ minInterval: "5m" })).toBe(300_000);
    expect(resolveCronMinIntervalMs({ minInterval: "1h30m" })).toBe(5_400_000);
  });

  it("treats bare numeric strings as milliseconds", () => {
    expect(resolveCronMinIntervalMs({ minInterval: "5000" })).toBe(5000);
  });

  it("falls back to no floor for empty or unparseable values", () => {
    expect(resolveCronMinIntervalMs({ minInterval: "" })).toBe(0);
    expect(resolveCronMinIntervalMs({ minInterval: "   " })).toBe(0);
    expect(resolveCronMinIntervalMs({ minInterval: "not-a-duration" })).toBe(0);
  });
});
