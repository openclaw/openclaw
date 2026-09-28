import { describe, expect, it } from "vitest";
import { createDueIsolatedJob } from "../../test/helpers/cron/service-regression-fixtures.js";
import { computeJobNextRunAtMs } from "./service/jobs-scheduling.js";

const originalAt = Date.parse("2026-02-22T10:00:00.000Z");
const lastRunAtMs = originalAt + 5_000;
const futureAt = originalAt + 2 * 60 * 60_000;

describe("one-shot rescheduling (#19676)", () => {
  it.each([
    { name: "leaves a completed occurrence retired", at: originalAt, expected: undefined },
    { name: "rearms a completed job at its new occurrence", at: futureAt, expected: futureAt },
  ])("$name", ({ at, expected }) => {
    const job = createDueIsolatedJob({ id: "reminder", nowMs: originalAt, nextRunAtMs: at });
    job.state = { lastStatus: "ok", lastRunAtMs };
    expect(computeJobNextRunAtMs(job, lastRunAtMs + 1_000)).toBe(expected);
  });

  it("keeps an unexecuted occurrence runnable", () => {
    const job = createDueIsolatedJob({
      id: "reminder",
      nowMs: originalAt,
      nextRunAtMs: originalAt,
    });
    job.state = {};
    expect(computeJobNextRunAtMs(job, originalAt - 60_000)).toBe(originalAt);
  });
});
