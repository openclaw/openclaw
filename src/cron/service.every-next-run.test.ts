// Every-next-run regression tests cover next-run calculations for repeating jobs.
import { MAX_DATE_TIMESTAMP_MS } from "@openclaw/normalization-core/number-coercion";
import { describe, expect, it } from "vitest";
import {
  computeJobNextRunAtMs,
  hasScheduledNextRunAtMs,
  resolveJobErrorBackoffUntilMs,
} from "./service/jobs-scheduling.js";
import type { CronJob } from "./types.js";

const EVERY_30_MIN_MS = 30 * 60_000;
const ANCHOR_MS = Date.parse("2026-02-22T09:14:00.000Z");

function createEveryJob(state: CronJob["state"]): CronJob {
  return {
    id: "issue-22895",
    name: "every-30-min",
    enabled: true,
    createdAtMs: ANCHOR_MS,
    updatedAtMs: ANCHOR_MS,
    schedule: { kind: "every", everyMs: EVERY_30_MIN_MS, anchorMs: ANCHOR_MS },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "check cadence" },
    delivery: { mode: "none" },
    state,
  };
}

// regression: #22895
describe("Cron issue #22895 interval scheduling", () => {
  it("does not return an invalid Date when last-run cadence exceeds the timestamp range", () => {
    const job = createEveryJob({ lastRunAtMs: MAX_DATE_TIMESTAMP_MS });
    job.schedule = { kind: "every", everyMs: 1, anchorMs: 0 };

    expect(computeJobNextRunAtMs(job, MAX_DATE_TIMESTAMP_MS - 1)).toBeUndefined();
    expect(hasScheduledNextRunAtMs(MAX_DATE_TIMESTAMP_MS + 1)).toBe(false);
  });

  it("rejects malformed intervals, anchors, and overflowing error backoff", () => {
    const job = createEveryJob({
      lastRunAtMs: MAX_DATE_TIMESTAMP_MS,
      lastDurationMs: 1,
      lastStatus: "error",
      consecutiveErrors: 1,
    });

    expect(resolveJobErrorBackoffUntilMs(job)).toBeUndefined();
    job.state.lastRunAtMs = MAX_DATE_TIMESTAMP_MS - 30_000;
    job.state.lastDurationMs = 0;
    expect(resolveJobErrorBackoffUntilMs(job)).toBe(MAX_DATE_TIMESTAMP_MS);
    job.schedule = { kind: "every", everyMs: 0.5, anchorMs: 0 };
    expect(computeJobNextRunAtMs(job, ANCHOR_MS)).toBeUndefined();
    job.schedule = { kind: "every", everyMs: 1, anchorMs: -1 };
    expect(computeJobNextRunAtMs(job, ANCHOR_MS)).toBeUndefined();
  });
});
