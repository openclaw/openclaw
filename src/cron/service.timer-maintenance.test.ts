import { Cron } from "croner";
import { describe, expect, it, vi } from "vitest";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { setupCronServiceSuite, writeCronStoreSnapshot } from "./service.test-harness.js";
import * as scheduleMaintenance from "./service/schedule-maintenance.js";
import { createCronServiceState } from "./service/state.js";
import { onTimer } from "./service/timer.test-support.js";
import { getCronJobsStoreRevision, loadCronJobsStoreWithConfigJobsReadOnly } from "./store.js";
import type { CronJob } from "./types.js";

const sqliteTransactionLabels = vi.hoisted(() => [] as string[]);

vi.mock("../state/openclaw-state-db.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../state/openclaw-state-db.js")>();
  const runOpenClawStateWriteTransaction: typeof actual.runOpenClawStateWriteTransaction = (
    operation,
    options,
    transactionOptions,
  ) => {
    sqliteTransactionLabels.push(transactionOptions?.operationLabel ?? "state.write");
    return actual.runOpenClawStateWriteTransaction(operation, options, transactionOptions);
  };
  return { ...actual, runOpenClawStateWriteTransaction };
});

const { logger, makeStorePath } = setupCronServiceSuite({
  prefix: "cron-timer-maintenance-",
  baseTimeIso: "2026-08-30T12:00:00.000Z",
});

function job(
  id: string,
  nowMs: number,
  schedule: CronJob["schedule"],
  state: CronJob["state"],
): CronJob {
  return {
    id,
    name: id,
    enabled: true,
    createdAtMs: nowMs - 60_000,
    updatedAtMs: nowMs - 60_000,
    schedule,
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: id },
    state,
  };
}

async function runTimer(jobs: CronJob[], nowMs: number) {
  const store = await makeStorePath();
  await writeCronStoreSnapshot({ storePath: store.storePath, jobs });
  const state = createCronServiceState({
    scheduler: createTestGatewayScheduler(),
    storePath: store.storePath,
    cronEnabled: true,
    log: logger,
    nowMs: () => nowMs,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
  });
  state.schedulerStarted = true;
  sqliteTransactionLabels.length = 0;
  const maintenance = vi.spyOn(scheduleMaintenance, "recomputeUnownedCronSchedules");
  try {
    await onTimer(state);
    expect(sqliteTransactionLabels.filter((label) => label === "cron.schedule-unowned")).toEqual(
      [],
    );
    return {
      jobs: state.store?.jobs ?? [],
      maintenanceCount: maintenance.mock.calls.length,
    };
  } finally {
    maintenance.mockRestore();
    if (state.timer) {
      state.timer.cancel();
      state.timer = null;
    }
  }
}

describe("cron timer maintenance admission", () => {
  it.each([
    {
      name: "stable future schedule",
      create: (nowMs: number) =>
        job(
          "future",
          nowMs,
          { kind: "every", everyMs: 60_000, anchorMs: nowMs },
          { nextRunAtMs: nowMs + 60_000 },
        ),
    },
    {
      name: "valid future cron slot",
      create: (nowMs: number) =>
        job(
          "future-cron",
          nowMs,
          { kind: "cron", expr: "0 * * * * *", tz: "UTC", staggerMs: 0 },
          { nextRunAtMs: Math.floor(nowMs / 60_000) * 60_000 + 60_000 },
        ),
    },
    {
      name: "event-driven schedule without a timer slot",
      create: (nowMs: number) =>
        job(
          "stream",
          nowMs,
          { kind: "stream", command: ["true"] },
          {
            streamSourceIdentity: "source",
          },
        ),
    },
    {
      name: "active due schedule",
      create: (nowMs: number) =>
        job(
          "active",
          nowMs,
          { kind: "every", everyMs: 60_000, anchorMs: nowMs - 120_000 },
          { nextRunAtMs: nowMs - 60_000, runningAtMs: nowMs },
        ),
    },
  ])("skips a write sweep for $name", async ({ create }) => {
    const nowMs = Date.now();
    const result = await runTimer([create(nowMs)], nowMs);
    expect(result.maintenanceCount).toBe(0);
  });

  it("does not recheck natural-next slots during a 1000-job timer tick", async () => {
    const nowMs = Date.now();
    const nextRunAtMs = nowMs + 60_000;
    const jobs = Array.from({ length: 1_000 }, (_, index) =>
      job(
        `natural-next-${index}`,
        nowMs,
        { kind: "cron", expr: "0 * * * * *", tz: "UTC", staggerMs: 0 },
        { nextRunAtMs },
      ),
    );
    const { storePath } = await makeStorePath();
    await writeCronStoreSnapshot({ storePath, jobs });
    const before = await loadCronJobsStoreWithConfigJobsReadOnly(storePath);
    expect(before.store.jobs).toHaveLength(1_000);
    const revision = getCronJobsStoreRevision(storePath);
    const state = createCronServiceState({
      scheduler: createTestGatewayScheduler(),
      storePath,
      cronEnabled: true,
      log: logger,
      nowMs: () => nowMs,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });
    state.schedulerStarted = true;
    const previousRuns = vi.spyOn(Cron.prototype, "previousRuns");
    const maintenance = vi.spyOn(scheduleMaintenance, "recomputeUnownedCronSchedules");
    sqliteTransactionLabels.length = 0;
    try {
      await onTimer(state);
      expect(state.store?.jobs).toEqual(before.store.jobs);
      expect((await loadCronJobsStoreWithConfigJobsReadOnly(storePath)).store).toEqual(
        before.store,
      );
      expect(getCronJobsStoreRevision(storePath)).toBe(revision);
      expect(sqliteTransactionLabels).toEqual([]);
      expect(maintenance).not.toHaveBeenCalled();
      expect(state.deps.runIsolatedAgentJob).not.toHaveBeenCalled();
      expect(state.deps.enqueueSystemEvent).not.toHaveBeenCalled();
      expect(state.deps.requestHeartbeat).not.toHaveBeenCalled();
      expect(state.queuedRunReservationsByJobId.size).toBe(0);
      expect(state.running).toBe(false);
      expect(state.deps.scheduler.nextWakeAtMs).toBe(nowMs + 60_000);
      expect(previousRuns).toHaveBeenCalledTimes(0);
    } finally {
      previousRuns.mockRestore();
      maintenance.mockRestore();
      if (state.timer) {
        state.timer.cancel();
        state.timer = null;
      }
    }
  });

  it("runs one sweep for a stale backoff slot", async () => {
    const nowMs = Date.now();
    const nextRunAtMs = nowMs - 20_000;
    const result = await runTimer(
      [
        job(
          "stale-backoff",
          nowMs,
          { kind: "every", everyMs: 60_000, anchorMs: nowMs - 120_000 },
          {
            nextRunAtMs,
            lastRunAtMs: nowMs - 10_000,
            lastRunStatus: "error",
            consecutiveErrors: 1,
          },
        ),
      ],
      nowMs,
    );
    expect(result.maintenanceCount).toBe(1);
    expect(result.jobs[0]?.state.nextRunAtMs).toBeGreaterThan(nowMs);
  });

  it.each([false, true])(
    "repairs a stale future cron slot with one sweep (trigger=%s)",
    async (trigger) => {
      const nowMs = Date.now();
      const expected = Math.floor(nowMs / 60_000) * 60_000 + 60_000;
      const stale = job(
        "stale-future",
        nowMs,
        { kind: "cron", expr: "0 * * * * *", tz: "UTC", staggerMs: 0 },
        { nextRunAtMs: nowMs + 7 * 24 * 60 * 60_000 + 30_000 },
      );
      stale.payload = { kind: "systemEvent", text: "repair stale future slot" };
      if (trigger) {
        stale.trigger = { script: "json({ fire: false })" };
      }

      const result = await runTimer([stale], nowMs);
      expect(result.maintenanceCount).toBe(1);
      expect(result.jobs[0]?.state.nextRunAtMs).toBe(expected);
    },
  );

  it("keeps retrying malformed timed schedules until the third failure disables them", async () => {
    const nowMs = Date.now();
    let current = job(
      "malformed",
      nowMs,
      { kind: "cron", expr: "0 7 * * *", tz: "Invalid/Timezone" },
      {},
    );

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const result = await runTimer([current], nowMs);
      expect(result.maintenanceCount).toBe(1);
      current = result.jobs[0]!;
      expect(current.state.scheduleErrorCount).toBe(attempt);
      expect(current.enabled).toBe(attempt < 3);
    }
  });
});
