import { describe, expect, it } from "vitest";
import {
  createRunningCronServiceState,
  createCronStoreHarness,
  createNoopLogger,
} from "./service.test-harness.js";
import { computeJobNextRunAtMs } from "./service/jobs.js";
import { run } from "./service/ops.js";
import type { CronJob } from "./types.js";

// Regression test for https://github.com/openclaw/openclaw/issues/33940
// "Executing a Daily Cron Task Manually Changes the Timing of the Execution of the Cron Task"
//
// When a user manually triggers `openclaw cron run <id>` (force mode), the
// next automatic run should still fire at the original scheduled time.
// Before the fix, `lastRunAtMs` was updated to the manual trigger time, causing
// `computeJobNextRunAtMs` to schedule the next run as `manualTime + everyMs`
// instead of staying on the original anchor cadence.

const DAY_MS = 24 * 60 * 60_000;

// 7:00 AM anchor — simulates "morning affirmation at 7am"
const ANCHOR_7AM = Date.parse("2026-03-04T07:00:00.000Z");

function createDailyJob(state: CronJob["state"] = {}): CronJob {
  return {
    id: "daily-morning",
    name: "Morning Affirmation",
    enabled: true,
    createdAtMs: ANCHOR_7AM,
    updatedAtMs: ANCHOR_7AM,
    schedule: { kind: "every", everyMs: DAY_MS, anchorMs: ANCHOR_7AM },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: { kind: "systemEvent", text: "Morning affirmation!" },
    state,
  };
}

describe("Cron issue #33940 — manual run must not displace schedule anchor", () => {
  const { makeStorePath } = createCronStoreHarness({ prefix: "openclaw-cron-33940-" });
  const log = createNoopLogger();

  it("computeJobNextRunAtMs: normal run at 7am schedules next at tomorrow 7am", () => {
    const job = createDailyJob({ lastRunAtMs: ANCHOR_7AM });
    const nowMs = ANCHOR_7AM + 100;
    const next = computeJobNextRunAtMs(job, nowMs);
    expect(next).toBe(ANCHOR_7AM + DAY_MS);
  });

  it("computeJobNextRunAtMs: with lastRunAtMs=1pm, gives 1pm+1day (demonstrates the pre-fix bug at computation level)", () => {
    const manualRunMs = ANCHOR_7AM + 6 * 60 * 60_000; // 13:00
    const job = createDailyJob({ lastRunAtMs: manualRunMs });
    const nowMs = manualRunMs + 100;
    const next = computeJobNextRunAtMs(job, nowMs);
    // Without the fix, setting lastRunAtMs to a manual run time causes the
    // next scheduled run to shift from anchor-based to manual-time + interval.
    expect(next).toBe(manualRunMs + DAY_MS);
  });

  it("manual force-run at 1pm must NOT shift next scheduled run to tomorrow 1pm", async () => {
    const lastAutoRunMs = ANCHOR_7AM; // 07:00 today
    const manualRunMs = ANCHOR_7AM + 6 * 60 * 60_000; // 13:00 today

    const { storePath } = await makeStorePath();
    const state = createRunningCronServiceState({
      storePath,
      log,
      nowMs: () => manualRunMs,
      jobs: [createDailyJob({ lastRunAtMs: lastAutoRunMs })],
    });

    const result = await run(state, "daily-morning", "force");
    expect(result.ran).toBe(true);

    const job = state.store!.jobs.find((j) => j.id === "daily-morning")!;
    expect(job).toBeDefined();

    // lastRunAtMs must NOT be updated — must stay at last auto-run (7am)
    expect(job.state.lastRunAtMs).toBe(lastAutoRunMs);

    // Next run must be tomorrow 7am — NOT tomorrow 1pm
    const tomorrowAt7am = lastAutoRunMs + DAY_MS;
    const tomorrowAt1pm = manualRunMs + DAY_MS;
    expect(job.state.nextRunAtMs).toBe(tomorrowAt7am);
    expect(job.state.nextRunAtMs).not.toBe(tomorrowAt1pm);
  });

  it("manual force-run with no prior lastRunAtMs schedules from anchor (not from trigger time)", async () => {
    const manualRunMs = ANCHOR_7AM + 6 * 60 * 60_000; // 13:00

    const { storePath } = await makeStorePath();
    const state = createRunningCronServiceState({
      storePath,
      log,
      nowMs: () => manualRunMs,
      jobs: [createDailyJob({})], // no lastRunAtMs
    });

    await run(state, "daily-morning", "force");

    const job = state.store!.jobs.find((j) => j.id === "daily-morning")!;
    // lastRunAtMs stays undefined (was never set by an auto-run)
    expect(job.state.lastRunAtMs).toBeUndefined();
    // Next run should be anchor-based: next 7am after 1pm = tomorrow 7am
    const tomorrowAt7am = ANCHOR_7AM + DAY_MS;
    expect(job.state.nextRunAtMs).toBe(tomorrowAt7am);
  });

  it("due-mode run (normal timer tick) still updates lastRunAtMs correctly", async () => {
    const scheduledRunMs = ANCHOR_7AM;

    const { storePath } = await makeStorePath();
    const state = createRunningCronServiceState({
      storePath,
      log,
      nowMs: () => scheduledRunMs,
      jobs: [createDailyJob({ nextRunAtMs: scheduledRunMs })],
    });

    await run(state, "daily-morning", "due");

    const job = state.store!.jobs.find((j) => j.id === "daily-morning")!;
    // For due (scheduled) runs, lastRunAtMs must be updated
    expect(job.state.lastRunAtMs).toBe(scheduledRunMs);
    expect(job.state.nextRunAtMs).toBe(scheduledRunMs + DAY_MS);
  });
});
