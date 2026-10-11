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

const NOW = Date.parse("2026-08-30T12:00:00.000Z");
const CRON_SCHEDULE = { kind: "cron", expr: "0 * * * * *", tz: "UTC", staggerMs: 0 } as const;
const { logger, makeStorePath } = setupCronServiceSuite({
  prefix: "cron-timer-maintenance-",
  baseTimeIso: "2026-08-30T12:00:00.000Z",
});

function job(id: string, overrides: Partial<CronJob>): CronJob {
  return {
    id,
    name: id,
    enabled: true,
    createdAtMs: NOW - 60_000,
    updatedAtMs: NOW - 60_000,
    schedule: { kind: "every", everyMs: 60_000, anchorMs: NOW - 120_000 },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: id },
    state: {},
    ...overrides,
  };
}

async function createState(jobs: CronJob[]) {
  const store = await makeStorePath();
  await writeCronStoreSnapshot({ storePath: store.storePath, jobs });
  const state = createCronServiceState({
    scheduler: createTestGatewayScheduler(),
    storePath: store.storePath,
    cronEnabled: true,
    log: logger,
    nowMs: () => NOW,
    enqueueSystemEvent: vi.fn(),
    runSessionEvent: vi.fn(async () => ({ status: "ok" as const })),
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
  });
  state.schedulerStarted = true;
  return { state, storePath: store.storePath };
}

async function runTimer(cronJob: CronJob) {
  const { state } = await createState([cronJob]);
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
  it("skips a write sweep for an active due schedule", async () => {
    const result = await runTimer(
      job("active", { state: { nextRunAtMs: NOW - 60_000, runningAtMs: NOW } }),
    );
    expect(result.maintenanceCount).toBe(0);
  });

  it("does not recheck natural-next slots during a 1000-job timer tick", async () => {
    const nextRunAtMs = NOW + 60_000;
    const jobs = Array.from({ length: 1_000 }, (_, index) =>
      job(`natural-next-${index}`, { schedule: CRON_SCHEDULE, state: { nextRunAtMs } }),
    );
    const { storePath, state } = await createState(jobs);
    const before = await loadCronJobsStoreWithConfigJobsReadOnly(storePath);
    expect(before.store.jobs).toHaveLength(1_000);
    const revision = getCronJobsStoreRevision(storePath);
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
      expect(state.deps.runSessionEvent).not.toHaveBeenCalled();
      expect(state.running).toBe(false);
      expect(state.deps.scheduler.nextWakeAtMs).toBe(nextRunAtMs);
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
    const result = await runTimer(
      job("stale-backoff", {
        state: {
          nextRunAtMs: NOW - 20_000,
          lastRunAtMs: NOW - 10_000,
          lastRunStatus: "error",
          consecutiveErrors: 1,
        },
      }),
    );
    expect(result.maintenanceCount).toBe(1);
    expect(result.jobs[0]?.state.nextRunAtMs).toBeGreaterThan(NOW);
  });

  it("repairs a stale future trigger cron slot with one sweep", async () => {
    const result = await runTimer(
      job("stale-future", {
        schedule: CRON_SCHEDULE,
        state: { nextRunAtMs: NOW + 7 * 24 * 60 * 60_000 + 30_000 },
        payload: { kind: "systemEvent", text: "repair stale future slot" },
        trigger: { script: "json({ fire: false })" },
      }),
    );
    expect(result.maintenanceCount).toBe(1);
    expect(result.jobs[0]?.state.nextRunAtMs).toBe(NOW + 60_000);
  });

  it("keeps retrying malformed timed schedules until the third failure disables them", async () => {
    let current = job("malformed", {
      schedule: { kind: "cron", expr: "0 7 * * *", tz: "Invalid/Timezone" },
    });

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const result = await runTimer(current);
      expect(result.maintenanceCount).toBe(1);
      current = result.jobs[0]!;
      expect(current.state.scheduleErrorCount).toBe(attempt);
      expect(current.enabled).toBe(attempt < 3);
    }
  });
});
