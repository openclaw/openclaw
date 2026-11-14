import { expect, it } from "vitest";
import { cronTestJob } from "./service.fixture-builders.test-support.js";
import { createMockCronStateForJobs } from "./service.test-harness.js";
import { recomputeNextRunsForMaintenance } from "./service/jobs-scheduling.test-support.js";
import type { CronJob } from "./types.js";

const now = Date.parse("2026-05-05T12:00:00Z");
const badFuture = Date.parse("2026-05-12T16:00:00Z");
const startedAt = Date.parse("2026-03-01T12:00:00Z");

function checkMaintenance(
  overrides: Partial<CronJob>,
  nextRunAtMs: number | undefined,
  { nowMs = now, changed = false, recomputeExpired = false } = {},
) {
  const job = cronTestJob({
    id: "maintenance",
    schedule: { kind: "cron", expr: "0 0 21 * * *", tz: "Asia/Shanghai", staggerMs: 0 },
    sessionTarget: "main",
    payload: { kind: "systemEvent", text: "tick" },
    ...overrides,
  });
  const state = createMockCronStateForJobs({ jobs: [job], nowMs });
  expect(
    recomputeNextRunsForMaintenance(state, { recomputeExpired, deferredNotifications: [] }),
  ).toBe(changed);
  expect(job.state.nextRunAtMs).toBe(nextRunAtMs);
  expect(job.state.scheduleErrorCount).toBeUndefined();
  return { job, state };
}

it("schedules loaded every jobs without backfilling anchorMs", () => {
  const { job } = checkMaintenance(
    {
      createdAtMs: startedAt - 120_000,
      schedule: { kind: "every", everyMs: 60_000 },
    },
    startedAt + 60_000,
    { nowMs: startedAt, recomputeExpired: true, changed: true },
  );
  expect(job.schedule).toEqual({ kind: "every", everyMs: 60_000 });
});

it.each([
  { name: "early system-event slots", state: { nextRunAtMs: now + 30 * 60_000 } },
  {
    name: "stale future slots after error backoff expires",
    state: {
      nextRunAtMs: badFuture,
      lastRunAtMs: Date.parse("2026-05-04T00:00:00Z"),
      lastStatus: "error" as const,
      consecutiveErrors: 1,
    },
  },
])("repairs $name", ({ state }) => {
  checkMaintenance({ state }, now + 60 * 60_000, { changed: true });
});

it.each([
  ["without duration", 120, 60, 600, undefined],
  ["from run end", 600, 90, 1230, 240_000],
] as const)(
  "preserves retry backoff %s",
  (_name, nowSeconds, runSeconds, retrySeconds, lastDurationMs) => {
    const at = (seconds: number) => Date.parse("2025-12-13T04:00:00Z") + seconds * 1000;
    checkMaintenance(
      {
        schedule: { kind: "cron", expr: "* * * * *", tz: "UTC" },
        state: {
          nextRunAtMs: at(retrySeconds),
          lastRunAtMs: at(runSeconds),
          lastDurationMs,
          lastStatus: "error",
          consecutiveErrors: 4,
        },
      },
      at(retrySeconds),
      { nowMs: at(nowSeconds) },
    );
  },
);

it.each([
  [
    "exact-second slots multiple intervals ahead (#81691)",
    "0 9 * * *",
    "Pacific/Honolulu",
    Date.parse("2026-05-08T19:00:00Z"),
  ],
  ["future slots while probing malformed schedules", "not a valid cron", "UTC", badFuture],
] as const)("preserves %s", (_name, expr, tz, nextRunAtMs) => {
  checkMaintenance(
    { schedule: { kind: "cron", expr, tz, staggerMs: 0 }, state: { nextRunAtMs } },
    nextRunAtMs,
  );
});

it.each([true, false])("preserves startup catch-up deferrals only while enabled=%s", (enabled) => {
  const deferred = now + 120_000;
  const { job, state } = checkMaintenance(
    { enabled, state: { nextRunAtMs: deferred, startupCatchupAtMs: deferred } },
    enabled ? deferred : undefined,
    { changed: !enabled },
  );
  expect(job.state.startupCatchupAtMs).toBe(enabled ? deferred : undefined);
  if (enabled) {
    expect(
      recomputeNextRunsForMaintenance(state, {
        deferredNotifications: [],
        nowMs: deferred,
        repairFutureCronNextRunAtMs: true,
      }),
    ).toBe(false);
    expect(job.state).toMatchObject({ nextRunAtMs: deferred, startupCatchupAtMs: deferred });
  }
});
