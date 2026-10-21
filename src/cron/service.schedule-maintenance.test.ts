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
    wakeMode: "now",
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
      updatedAtMs: startedAt - 120_000,
      schedule: { kind: "every", everyMs: 60_000 },
    },
    startedAt + 60_000,
    { nowMs: startedAt, recomputeExpired: true, changed: true },
  );
  expect(job.schedule).toEqual({ kind: "every", everyMs: 60_000 });
});

it("keeps recovered recurring error retries behind run-end backoff", () => {
  checkMaintenance(
    {
      createdAtMs: startedAt - 60_000,
      updatedAtMs: startedAt,
      schedule: { kind: "every", everyMs: 1_000, anchorMs: startedAt - 60_000 },
      state: {
        lastRunAtMs: startedAt,
        lastDurationMs: 90_000,
        lastStatus: "error",
        consecutiveErrors: 1,
      },
    },
    startedAt + 120_000,
    { nowMs: startedAt + 31_000, recomputeExpired: true, changed: true },
  );
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
  ["without duration", 120, 60, 70, 600, undefined],
  ["from run end", 600, 90, 330, 1230, 240_000],
] as const)(
  "preserves retry backoff %s",
  (_name, nowSeconds, runSeconds, updatedSeconds, retrySeconds, lastDurationMs) => {
    const at = (seconds: number) => Date.parse("2025-12-13T04:00:00Z") + seconds * 1000;
    checkMaintenance(
      {
        updatedAtMs: at(updatedSeconds),
        schedule: { kind: "cron", expr: "* * * * *", tz: "UTC" },
        wakeMode: "next-heartbeat",
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

it("preserves exact-second slots multiple intervals ahead (#81691)", () => {
  const nextRunAtMs = Date.parse("2026-05-08T19:00:00Z");
  checkMaintenance(
    {
      schedule: { kind: "cron", expr: "0 9 * * *", tz: "Pacific/Honolulu", staggerMs: 0 },
      state: { nextRunAtMs },
    },
    nextRunAtMs,
  );
});

it("keeps future slots while probing malformed schedules", () => {
  checkMaintenance(
    {
      schedule: { kind: "cron", expr: "not a valid cron", tz: "UTC" },
      state: { nextRunAtMs: badFuture },
    },
    badFuture,
  );
});

it.each([true, false])("preserves startup catch-up deferrals only while enabled=%s", (enabled) => {
  const deferred = now + 120_000;
  const { job, state } = checkMaintenance(
    {
      enabled,
      state: { nextRunAtMs: deferred, startupCatchupAtMs: deferred },
    },
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
