import { describe, expect, it } from "vitest";
import { computeJobNextRunAtMs } from "./service/jobs.js";
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

describe("Cron issue #22895 interval scheduling", () => {
  it("uses lastRunAtMs cadence when the next interval is still in the future", () => {
    const nowMs = Date.parse("2026-02-22T10:10:00.000Z");
    const job = createEveryJob({
      lastRunAtMs: Date.parse("2026-02-22T10:04:00.000Z"),
    });

    const nextFromLast = computeJobNextRunAtMs(job, nowMs);
    const nextFromAnchor = computeJobNextRunAtMs(
      { ...job, state: { ...job.state, lastRunAtMs: undefined } },
      nowMs,
    );

    expect(nextFromLast).toBe(job.state.lastRunAtMs! + EVERY_30_MIN_MS);
    expect(nextFromAnchor).toBe(Date.parse("2026-02-22T10:14:00.000Z"));
    expect(nextFromLast).toBeGreaterThan(nextFromAnchor!);
  });

  it("falls back to anchor scheduling when lastRunAtMs cadence is already in the past", () => {
    const nowMs = Date.parse("2026-02-22T10:40:00.000Z");
    const job = createEveryJob({
      lastRunAtMs: Date.parse("2026-02-22T10:04:00.000Z"),
    });

    const next = computeJobNextRunAtMs(job, nowMs);
    expect(next).toBe(Date.parse("2026-02-22T10:44:00.000Z"));
  });

  it("ignoreLastRun skips lastRunAtMs cadence and uses anchor-based scheduling", () => {
    const nowMs = Date.parse("2026-02-22T10:10:00.000Z");
    const job = createEveryJob({
      lastRunAtMs: Date.parse("2026-02-22T10:04:00.000Z"),
    });

    // Without ignoreLastRun: cadence-based (lastRun + interval)
    const cadenceNext = computeJobNextRunAtMs(job, nowMs);
    expect(cadenceNext).toBe(job.state.lastRunAtMs! + EVERY_30_MIN_MS);

    // With ignoreLastRun: anchor-based (next anchor slot after now)
    const anchorNext = computeJobNextRunAtMs(job, nowMs, { ignoreLastRun: true });
    expect(anchorNext).toBe(Date.parse("2026-02-22T10:14:00.000Z"));
  });

  it("manual run of daily job does not drift schedule from anchor (#33940)", () => {
    const EVERY_DAY_MS = 24 * 60 * 60_000;
    const anchorMs = Date.parse("2026-03-04T07:00:00.000Z"); // 7am anchor

    const job: CronJob = {
      id: "issue-33940",
      name: "daily-affirmation",
      enabled: true,
      createdAtMs: anchorMs,
      updatedAtMs: anchorMs,
      schedule: { kind: "every", everyMs: EVERY_DAY_MS, anchorMs },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "morning affirmation" },
      delivery: { mode: "none" },
      state: {
        // Simulates a manual run at 1pm (6 hours after anchor)
        lastRunAtMs: Date.parse("2026-03-04T13:00:00.000Z"),
      },
    };

    const nowMs = Date.parse("2026-03-04T13:00:05.000Z");

    // Default: drifts to 1pm tomorrow (lastRun + 24h)
    const drifted = computeJobNextRunAtMs(job, nowMs);
    expect(drifted).toBe(Date.parse("2026-03-05T13:00:00.000Z"));

    // With ignoreLastRun (forced/manual run): stays at 7am tomorrow
    const anchored = computeJobNextRunAtMs(job, nowMs, { ignoreLastRun: true });
    expect(anchored).toBe(Date.parse("2026-03-05T07:00:00.000Z"));
  });
});
