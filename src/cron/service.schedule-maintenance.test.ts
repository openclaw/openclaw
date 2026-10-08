import { describe, expect, it } from "vitest";
import { createMockCronStateForJobs } from "./service.test-harness.js";
import { recomputeNextRunsForMaintenance } from "./service/jobs-scheduling.js";
import type { CronJob } from "./types.js";

const now = Date.parse("2026-05-05T12:00:00.000Z");
const nextSlot = Date.parse("2026-05-05T13:00:00.000Z");
const badFuture = Date.parse("2026-05-12T16:00:00.000Z");
const deferred = now + 120_000;

function createMaintenanceJob(name: string, overrides: Partial<CronJob>): CronJob {
  return {
    id: name,
    name,
    enabled: true,
    createdAtMs: Date.parse("2026-05-05T00:00:00.000Z"),
    updatedAtMs: Date.parse("2026-05-05T00:00:00.000Z"),
    schedule: { kind: "cron", expr: "0 0 21 * * *", tz: "Asia/Shanghai", staggerMs: 0 },
    sessionTarget: "main",
    wakeMode: "now",
    payload: { kind: "systemEvent", text: "tick" },
    state: {},
    ...overrides,
  };
}

type MaintenanceCase = {
  name: string;
  job: Partial<CronJob>;
  nowMs?: number;
  changed: boolean;
  expected: CronJob["state"];
};
const cases: MaintenanceCase[] = [
  {
    name: "repairs early system-event slots",
    job: { state: { nextRunAtMs: now + 30 * 60_000 } },
    changed: true,
    expected: { nextRunAtMs: nextSlot },
  },
  {
    name: "preserves retry backoff from run end",
    nowMs: Date.parse("2025-12-13T04:10:00Z"),
    job: {
      createdAtMs: Date.parse("2025-12-10T12:00:00Z"),
      updatedAtMs: Date.parse("2025-12-13T04:05:30Z"),
      schedule: { kind: "cron", expr: "* * * * *", tz: "UTC" },
      wakeMode: "next-heartbeat",
      state: {
        nextRunAtMs: Date.parse("2025-12-13T04:20:30Z"),
        lastRunAtMs: Date.parse("2025-12-13T04:01:30Z"),
        lastDurationMs: 4 * 60_000,
        lastStatus: "error",
        consecutiveErrors: 4,
      },
    },
    changed: false,
    expected: { nextRunAtMs: Date.parse("2025-12-13T04:20:30Z") },
  },
  {
    name: "repairs stale future slots after error backoff expires",
    job: {
      state: {
        nextRunAtMs: badFuture,
        lastRunAtMs: Date.parse("2026-05-04T00:00:00Z"),
        lastStatus: "error",
        consecutiveErrors: 1,
      },
    },
    changed: true,
    expected: { nextRunAtMs: nextSlot },
  },
  {
    // #81691: the exact-second probe must recognize slots multiple intervals ahead.
    name: "preserves exact-second slots multiple intervals ahead",
    job: {
      createdAtMs: Date.parse("2026-05-01T00:00:00Z"),
      updatedAtMs: Date.parse("2026-05-01T00:00:00Z"),
      schedule: { kind: "cron", expr: "0 9 * * *", tz: "Pacific/Honolulu", staggerMs: 0 },
      state: { nextRunAtMs: Date.parse("2026-05-08T19:00:00Z") },
    },
    changed: false,
    expected: { nextRunAtMs: Date.parse("2026-05-08T19:00:00Z") },
  },
  {
    name: "keeps future slots while probing malformed schedules",
    job: {
      schedule: { kind: "cron", expr: "not a valid cron", tz: "UTC" },
      state: { nextRunAtMs: badFuture },
    },
    changed: false,
    expected: { nextRunAtMs: badFuture, scheduleErrorCount: undefined },
  },
];

describe("cron schedule maintenance", () => {
  it.each(cases)("$name", ({ name, job: overrides, nowMs = now, changed, expected }) => {
    const job = createMaintenanceJob(name, overrides);
    const state = createMockCronStateForJobs({ jobs: [job], nowMs });
    expect(recomputeNextRunsForMaintenance(state, { deferredNotifications: [] })).toBe(changed);
    expect(job.state.nextRunAtMs).toBe(expected.nextRunAtMs);
    expect(job.state.scheduleErrorCount).toBe(expected.scheduleErrorCount);
  });

  it.each([true, false])(
    "preserves startup catch-up deferrals only while enabled=%s",
    (enabled) => {
      const job = createMaintenanceJob("startup deferral", {
        enabled,
        state: { nextRunAtMs: deferred, startupCatchupAtMs: deferred },
      });
      const state = createMockCronStateForJobs({ jobs: [job], nowMs: now });
      expect(recomputeNextRunsForMaintenance(state, { deferredNotifications: [] })).toBe(!enabled);
      expect(job.state.nextRunAtMs).toBe(enabled ? deferred : undefined);
      expect(job.state.startupCatchupAtMs).toBe(enabled ? deferred : undefined);
      if (enabled) {
        expect(
          recomputeNextRunsForMaintenance(state, {
            deferredNotifications: [],
            nowMs: deferred,
            repairFutureCronNextRunAtMs: true,
          }),
        ).toBe(false);
        expect(job.state.startupCatchupAtMs).toBe(deferred);
        expect(job.state.nextRunAtMs).toBe(deferred);
      }
    },
  );
});
