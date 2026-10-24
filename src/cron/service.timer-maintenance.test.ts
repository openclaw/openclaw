import { Cron } from "croner";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { runWithSqliteWorkerStateContext } from "../infra/sqlite-worker-state-context.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { makeCronJob } from "./delivery.test-helpers.js";
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
  const observedWriteTransaction: typeof actual.runOpenClawStateWriteTransaction = (...args) => {
    sqliteTransactionLabels.push(args[2]?.operationLabel ?? "state.write");
    return actual.runOpenClawStateWriteTransaction(...args);
  };
  return { ...actual, runOpenClawStateWriteTransaction: observedWriteTransaction };
});

const NOW = Date.parse("2026-08-30T12:00:00.000Z");
const CRON_SCHEDULE = { kind: "cron", expr: "0 * * * * *", tz: "UTC", staggerMs: 0 } as const;
let fixture: Awaited<ReturnType<typeof createOpenClawTestState>>;
let database: ReturnType<typeof openOpenClawStateDatabase>;
let caseId = 0;
const actors = new Map<string, string>();

beforeAll(async () => {
  fixture = await createOpenClawTestState({ label: "cron-timer-maintenance" });
  database = openOpenClawStateDatabase();
  ensureCronRunReceiptSchema(database.db);
});

beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }));

afterEach(() => {
  for (const [channelName, storeKey] of actors) {
    stopCronSchedulerInWorker({ storeKey, channelName });
  }
  actors.clear();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

afterAll(async () => fixture?.cleanup());

function job(id: string, overrides: Partial<CronJob>): CronJob {
  return makeCronJob({
    id,
    name: id,
    createdAtMs: NOW - 60_000,
    updatedAtMs: NOW - 60_000,
    schedule: { kind: "every", everyMs: 60_000, anchorMs: NOW - 120_000 },
    payload: { kind: "agentTurn", message: id },
    ...overrides,
  });
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
  const send = (type: "cron.schedulerStart" | "cron.schedulerTick") =>
    withinWorker(() =>
      runCronSchedulerInWorker(database, {
        type,
        input: {
          storeKey,
          channelName,
          snapshot: {
            config: { cronEnabled: type === "cron.schedulerTick", defaultAgentId: "main" },
          },
          nowMs: NOW,
          monotonicMs: 0,
        },
      }),
    );
  withinWorker(() =>
    runOpenClawStateWriteTransaction(
      () => saveCronStoreInDatabase(database, storeKey, { version: 1, jobs }),
      { database, path: database.path, env: fixture.env },
    ),
  );
  send("cron.schedulerStart");
  sqliteTransactionLabels.length = 0;
  actors.set(channelName, storeKey);
  return {
    read: () => loadCronStoreFromDatabase(database.db, storeKey).store,
    tick: () => send("cron.schedulerTick"),
  };
}

function runTimer(overrides: Partial<CronJob>, expectedSweeps = 1) {
  const scheduler = createScheduler([job("timer", overrides)]);
  scheduler.tick();
  expect(sqliteTransactionLabels.filter((label) => label === "cron.schedule-unowned")).toHaveLength(
    expectedSweeps,
  );
  return scheduler.read().jobs[0]!;
}

it("uses the claimed job postimage for maintenance and the next wake", () => {
  const scheduler = createScheduler([job("due", { state: { nextRunAtMs: NOW } })]);
  const result = scheduler.tick();
  expect(result.accepted).toHaveLength(1);
  expect(scheduler.read().jobs[0]?.state.runningAtMs).toBe(NOW);
  expect(sqliteTransactionLabels).not.toContain("cron.schedule-unowned");
  expect(result.nextWakeAtMs).toBeGreaterThan(NOW);
  expect(scheduler.tick().accepted).toEqual([]);
});

it("skips a write sweep for an active due schedule", () => {
  runTimer({ state: { nextRunAtMs: NOW - 60_000, runningAtMs: NOW } }, 0);
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
  const result = scheduler.tick();
  expect(scheduler.read()).toEqual(before);
  expect(database.db.prepare("SELECT total_changes() AS changes").get()).toEqual(changes);
  expect(sqliteTransactionLabels).toEqual([]);
  expect(result).toMatchObject({
    accepted: [],
    notifications: [],
    ownerless: [],
    nextWakeAtMs: nextRunAtMs,
  });
  expect(previousRuns).toHaveBeenCalledTimes(0);
});

it("runs one sweep for a stale backoff slot", () => {
  const result = runTimer({
    state: {
      nextRunAtMs: NOW - 20_000,
      lastRunAtMs: NOW - 10_000,
      lastRunStatus: "error",
      consecutiveErrors: 1,
    },
  });
  expect(result.state.nextRunAtMs).toBeGreaterThan(NOW);
});

it("repairs a stale future trigger cron slot with one sweep", () => {
  const result = runTimer({
    schedule: CRON_SCHEDULE,
    state: { nextRunAtMs: NOW + 7 * 24 * 60 * 60_000 + 30_000 },
    payload: { kind: "systemEvent", text: "repair stale future slot" },
    trigger: { script: "json({ fire: false })" },
  });
  expect(result.state.nextRunAtMs).toBe(NOW + 60_000);
});

it("keeps retrying malformed timed schedules until the third failure disables them", () => {
  let current = job("malformed", {
    schedule: { kind: "cron", expr: "0 7 * * *", tz: "Invalid/Timezone" },
  });

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    current = runTimer(current);
    expect(current.state.scheduleErrorCount).toBe(attempt);
    expect(current.enabled).toBe(attempt < 3);
  }
});
