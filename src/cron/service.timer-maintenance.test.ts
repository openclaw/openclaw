import { Cron } from "croner";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runWithSqliteWorkerStateContext } from "../infra/sqlite-worker-state-context.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { loadCronStoreFromDatabase } from "./store/load.kernel.js";
import { ensureCronRunReceiptSchema } from "./store/run-receipt-store.js";
import { saveCronStoreInDatabase } from "./store/save.kernel.js";
import {
  runCronSchedulerInWorker,
  stopCronSchedulerInWorker,
} from "./store/scheduler-actor.worker.js";
import type { CronJob } from "./types.js";

const sqliteTransactionLabels = vi.hoisted(() => [] as string[]);

vi.mock("../state/openclaw-state-db.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../state/openclaw-state-db.js")>();
  const observedWriteTransaction: typeof actual.runOpenClawStateWriteTransaction = (
    operation,
    options,
    transactionOptions,
  ) => {
    sqliteTransactionLabels.push(transactionOptions?.operationLabel ?? "state.write");
    return actual.runOpenClawStateWriteTransaction(operation, options, transactionOptions);
  };
  return { ...actual, runOpenClawStateWriteTransaction: observedWriteTransaction };
});

const NOW = Date.parse("2026-08-30T12:00:00.000Z");
const CRON_SCHEDULE = { kind: "cron", expr: "0 * * * * *", tz: "UTC", staggerMs: 0 } as const;
let fixture: OpenClawTestState;
let database: ReturnType<typeof openOpenClawStateDatabase>;
let caseId = 0;
const actors = new Map<string, string>();

beforeAll(async () => {
  fixture = await createOpenClawTestState({ label: "cron-timer-maintenance" });
  database = openOpenClawStateDatabase();
  ensureCronRunReceiptSchema(database.db);
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});

afterEach(() => {
  for (const [channelName, storeKey] of actors) {
    stopCronSchedulerInWorker({ storeKey, channelName });
  }
  actors.clear();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

afterAll(async () => {
  await fixture?.cleanup();
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

function withinWorker<T>(run: () => T): T {
  return runWithSqliteWorkerStateContext(
    { environment: { ...fixture.env, OPENCLAW_STATE_DIR: fixture.stateDir } },
    run,
  );
}

function createScheduler(jobs: CronJob[]) {
  const storeKey = fixture.statePath("cron", `case-${caseId++}.json`);
  const channelName = `cron-maintenance-test:${storeKey}`;
  withinWorker(() => {
    runOpenClawStateWriteTransaction(
      () => saveCronStoreInDatabase(database, storeKey, { version: 1, jobs }),
      { database, path: database.path, env: fixture.env },
    );
    runCronSchedulerInWorker(database, {
      type: "cron.schedulerStart",
      input: {
        storeKey,
        channelName,
        snapshot: { version: 1, config: { cronEnabled: false, defaultAgentId: "main" } },
        nowMs: NOW,
        monotonicMs: 0,
      },
    });
  });
  actors.set(channelName, storeKey);
  return {
    read: () => loadCronStoreFromDatabase(database.db, storeKey).store,
    tick: () =>
      withinWorker(() =>
        runCronSchedulerInWorker(database, {
          type: "cron.schedulerTick",
          input: {
            storeKey,
            channelName,
            snapshot: { version: 2, config: { cronEnabled: true, defaultAgentId: "main" } },
            nowMs: NOW,
            monotonicMs: 0,
          },
        }),
      ),
  };
}

function runTimer(cronJob: CronJob) {
  const scheduler = createScheduler([cronJob]);
  sqliteTransactionLabels.length = 0;
  scheduler.tick();
  return {
    jobs: scheduler.read().jobs,
    maintenanceCount: sqliteTransactionLabels.filter((label) => label === "cron.schedule-unowned")
      .length,
  };
}

describe("cron timer maintenance admission", () => {
  it("skips a write sweep for an active due schedule", () => {
    const result = runTimer(
      job("active", { state: { nextRunAtMs: NOW - 60_000, runningAtMs: NOW } }),
    );
    expect(result.maintenanceCount).toBe(0);
  });

  it("does not recheck natural-next slots during a 1000-job timer tick", () => {
    const nextRunAtMs = NOW + 60_000;
    const jobs = Array.from({ length: 1_000 }, (_, index) =>
      job(`natural-next-${index}`, { schedule: CRON_SCHEDULE, state: { nextRunAtMs } }),
    );
    const scheduler = createScheduler(jobs);
    const before = scheduler.read();
    expect(before.jobs).toHaveLength(1_000);
    const changes = database.db.prepare("SELECT total_changes() AS changes").get();
    const previousRuns = vi.spyOn(Cron.prototype, "previousRuns");
    sqliteTransactionLabels.length = 0;
    try {
      const result = scheduler.tick();
      expect(scheduler.read()).toEqual(before);
      expect(database.db.prepare("SELECT total_changes() AS changes").get()).toEqual(changes);
      expect(sqliteTransactionLabels).toEqual([]);
      expect(result.accepted).toEqual([]);
      expect(result.notifications).toEqual([]);
      expect(result.ownerless).toEqual([]);
      expect(result.nextWakeAtMs).toBe(nextRunAtMs);
      expect(previousRuns).toHaveBeenCalledTimes(0);
    } finally {
      previousRuns.mockRestore();
    }
  });

  it("runs one sweep for a stale backoff slot", () => {
    const result = runTimer(
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

  it("repairs a stale future trigger cron slot with one sweep", () => {
    const result = runTimer(
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

  it("keeps retrying malformed timed schedules until the third failure disables them", () => {
    let current = job("malformed", {
      schedule: { kind: "cron", expr: "0 7 * * *", tz: "Invalid/Timezone" },
    });

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const result = runTimer(current);
      expect(result.maintenanceCount).toBe(1);
      current = result.jobs[0]!;
      expect(current.state.scheduleErrorCount).toBe(attempt);
      expect(current.enabled).toBe(attempt < 3);
    }
  });
});
