import { describe, expect, it } from "vitest";
import { DEFAULT_CRON_MAX_CONCURRENT_RUNS, resolveCronMaxConcurrentRuns } from "./cron-limits.js";

describe("resolveCronMaxConcurrentRuns", () => {
  it("defaults when the env override is unset or invalid", () => {
    expect(resolveCronMaxConcurrentRuns({})).toBe(DEFAULT_CRON_MAX_CONCURRENT_RUNS);
    expect(resolveCronMaxConcurrentRuns({ OPENCLAW_CRON_MAX_CONCURRENT_RUNS: "abc" })).toBe(
      DEFAULT_CRON_MAX_CONCURRENT_RUNS,
    );
  });

  it("floors and clamps the env override to at least one", () => {
    expect(resolveCronMaxConcurrentRuns({ OPENCLAW_CRON_MAX_CONCURRENT_RUNS: "1" })).toBe(1);
    expect(resolveCronMaxConcurrentRuns({ OPENCLAW_CRON_MAX_CONCURRENT_RUNS: "2.9" })).toBe(2);
    expect(resolveCronMaxConcurrentRuns({ OPENCLAW_CRON_MAX_CONCURRENT_RUNS: "0" })).toBe(1);
  });
});
