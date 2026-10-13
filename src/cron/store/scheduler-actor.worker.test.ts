import { once } from "node:events";
import { BroadcastChannel } from "node:worker_threads";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { runWithSqliteWorkerStateContext } from "../../infra/sqlite-worker-state-context.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import type { CronJob } from "../types.js";
import { loadCronStoreFromDatabase } from "./load.kernel.js";
import { ensureCronRunReceiptSchema } from "./run-receipt-store.js";
import { saveCronStoreInDatabase } from "./save.kernel.js";
import type { CronSchedulerOperations, CronSchedulerSnapshot } from "./scheduler-actor.types.js";
import { runCronSchedulerInWorker, stopCronSchedulerInWorker } from "./scheduler-actor.worker.js";

const now = Date.parse("2026-10-11T12:00:00.000Z");
const minute = 60_000;
const snapshot: CronSchedulerSnapshot = {
  version: 1,
  config: { cronEnabled: true, defaultAgentId: "main" },
};
let fixture: OpenClawTestState;
let database: ReturnType<typeof openOpenClawStateDatabase>;
const active = new Map<string, string>();

beforeAll(async () => {
  fixture = await createOpenClawTestState({ label: "cron-scheduler-actor" });
  database = openOpenClawStateDatabase();
  ensureCronRunReceiptSchema(database.db);
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});

afterEach(() => {
  for (const [channelName, storeKey] of active) {
    stopCronSchedulerInWorker({ storeKey, channelName });
  }
  active.clear();
  vi.useRealTimers();
});

afterAll(async () => {
  await fixture?.cleanup();
});

function job(id: string, dueAtMs: number, overrides: Partial<CronJob> = {}): CronJob {
  return {
    id,
    name: id,
    agentId: "main",
    enabled: true,
    createdAtMs: now - 24 * 60 * minute,
    updatedAtMs: now - 24 * 60 * minute,
    schedule: { kind: "every", everyMs: minute, anchorMs: dueAtMs },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "command", argv: ["echo", id] },
    delivery: { mode: "none" },
    state: { nextRunAtMs: dueAtMs },
    ...overrides,
  };
}

function withinWorker<T>(run: () => T): T {
  return runWithSqliteWorkerStateContext(
    { environment: { ...fixture.env, OPENCLAW_STATE_DIR: fixture.stateDir } },
    run,
  );
}

function storedScheduler(label: string, jobs: CronJob[]) {
  const storeKey = fixture.statePath("cron", `${label}.json`);
  const channelName = `cron-scheduler-test:${storeKey}`;
  withinWorker(() =>
    runOpenClawStateWriteTransaction(
      () => saveCronStoreInDatabase(database, storeKey, { version: 1, jobs }),
      { database, path: database.path, env: fixture.env },
    ),
  );
  const start = (
    atMs = now,
    options: Partial<CronSchedulerOperations["cron.schedulerStart"]["input"]> = {},
  ) => {
    active.set(options.channelName ?? channelName, storeKey);
    return withinWorker(() =>
      runCronSchedulerInWorker(database, {
        type: "cron.schedulerStart",
        input: { storeKey, channelName, snapshot, nowMs: atMs, monotonicMs: 0, ...options },
      }),
    );
  };
  const read = () => loadCronStoreFromDatabase(database.db, storeKey).store.jobs;
  return {
    storeKey,
    channelName,
    start,
    read,
    refresh: (
      input: Omit<CronSchedulerOperations["cron.schedulerRefresh"]["input"], "storeKey"> = {},
    ) =>
      withinWorker(() =>
        runCronSchedulerInWorker(database, {
          type: "cron.schedulerRefresh",
          input: { storeKey, channelName, nowMs: now, monotonicMs: 0, ...input },
        }),
      ),
    tick: (
      atMs: number,
      monotonicMs: number,
      input: Omit<
        CronSchedulerOperations["cron.schedulerTick"]["input"],
        "storeKey" | "nowMs" | "monotonicMs"
      > = {},
    ) =>
      withinWorker(() =>
        runCronSchedulerInWorker(database, {
          type: "cron.schedulerTick",
          input: { storeKey, nowMs: atMs, monotonicMs, ...input },
        }),
      ),
    receipts: () =>
      database.db
        .prepare(
          "SELECT job_id, receipt_id FROM cron_run_receipts WHERE store_key = ? ORDER BY job_id",
        )
        .all(storeKey),
    restart: async (atMs: number) => {
      stopCronSchedulerInWorker({ storeKey, channelName });
      active.delete(channelName);
      await closeOpenClawStateDatabaseAsync();
      database = openOpenClawStateDatabase();
      return start(atMs);
    },
  };
}

it("requests one overdue occurrence per job in oldest-first order", () => {
  const scheduler = storedScheduler("oldest-first", [
    job("newest", now - minute),
    job("oldest", now - 24 * 60 * minute),
    job("middle", now - 10 * minute),
  ]);
  const started = scheduler.start();
  expect(started.accepted.map(({ job: entry }) => entry.id)).toEqual([
    "oldest",
    "middle",
    "newest",
  ]);
  expect(scheduler.receipts()).toHaveLength(3);
  expect(scheduler.tick(now + 1, 1).accepted).toEqual([]);
  expect(scheduler.receipts()).toHaveLength(3);
});

it("persists the five-immediate limit, overflow staggering, and pending requests across restart", async () => {
  const scheduler = storedScheduler(
    "overflow-restart",
    Array.from({ length: 7 }, (_, index) => job(`job-${index}`, now - (7 - index) * minute)),
  );
  const started = scheduler.start();
  expect(started.accepted.map(({ job: entry }) => entry.id)).toEqual([
    "job-0",
    "job-1",
    "job-2",
    "job-3",
    "job-4",
  ]);
  const deferred = scheduler.read().slice(5);
  expect(deferred.map(({ state }) => [state.nextRunAtMs, state.startupCatchupAtMs])).toEqual([
    [now + 5_000, now + 5_000],
    [now + 10_000, now + 10_000],
  ]);
  const receipts = scheduler.receipts();
  expect((await scheduler.restart(now + 1_000)).accepted).toEqual([]);
  expect(scheduler.receipts()).toEqual(receipts);
  expect(scheduler.read().slice(5)).toEqual(deferred);
});

it("defers missed agent and heartbeat work for two minutes without blocking command work", () => {
  const scheduler = storedScheduler("agent-startup", [
    job("agent", now - 3 * minute, {
      payload: { kind: "agentTurn", message: "synthetic startup task" },
    }),
    job("heartbeat", now - 2 * minute, { payload: { kind: "heartbeat" } }),
    job("command", now - minute),
  ]);
  const started = scheduler.start(now, { deferAgentWork: true });
  expect(started.accepted.map(({ job: entry }) => entry.id)).toEqual(["command"]);
  expect(
    scheduler
      .read()
      .slice(0, 2)
      .map(({ id, state }) => [id, state.nextRunAtMs, state.startupCatchupAtMs]),
  ).toEqual([
    ["agent", now + 120_000, now + 120_000],
    ["heartbeat", now + 125_000, now + 125_000],
  ]);
  expect(scheduler.tick(now + 119_999, 119_999).accepted).toEqual([]);
  expect(scheduler.tick(now + 120_000, 120_000).accepted.map(({ job: entry }) => entry.id)).toEqual(
    ["agent"],
  );
});

it("retains a persisted paced occurrence across actor and database restart", async () => {
  const pacedAtMs = now + 30 * minute;
  const scheduler = storedScheduler("paced-restart", [
    job("paced", pacedAtMs, {
      schedule: { kind: "cron", expr: "* * * * *", tz: "UTC", staggerMs: 0 },
      pacing: { min: "15m", max: "4h" },
      state: {
        nextRunAtMs: pacedAtMs,
        pacedNextRunAtMs: pacedAtMs,
        lastRunAtMs: now - minute,
        lastRunStatus: "ok",
      },
    }),
  ]);
  expect(scheduler.start().accepted).toEqual([]);
  const before = scheduler.read()[0];
  expect((await scheduler.restart(now + 10 * minute)).accepted).toEqual([]);
  expect(scheduler.read()[0]).toEqual(before);
  expect(scheduler.tick(pacedAtMs, 20 * minute).accepted.map(({ job: entry }) => entry.id)).toEqual(
    ["paced"],
  );
});

it.each([false, true])("bounds forward clock catch-up with intervening refresh=%s", (refresh) => {
  const scheduler = storedScheduler(
    `forward-jump-${refresh}`,
    Array.from({ length: 7 }, (_, index) => job(`jump-${index}`, now + (index + 1) * minute)),
  );
  expect(scheduler.start().accepted).toEqual([]);
  const jumpedAtMs = now + 24 * 60 * minute;
  if (refresh) {
    expect(scheduler.refresh({ nowMs: jumpedAtMs, monotonicMs: 1_000 }).accepted).toEqual([]);
  }
  const jumped = scheduler.tick(jumpedAtMs, 1_000);
  expect(jumped.accepted.map(({ job: entry }) => entry.id)).toEqual([
    "jump-0",
    "jump-1",
    "jump-2",
    "jump-3",
    "jump-4",
  ]);
  expect(
    scheduler
      .read()
      .slice(5)
      .map(({ state }) => state.nextRunAtMs),
  ).toEqual([jumpedAtMs + 5_000, jumpedAtMs + 10_000]);
  expect(scheduler.tick(jumpedAtMs + 1, 1_001).accepted).toEqual([]);
  expect(scheduler.receipts()).toHaveLength(5);
});

it("keeps the persisted next deadline when the wall clock moves backward", () => {
  const deadline = now + minute;
  const scheduler = storedScheduler("backward-jump", [
    job("backward", deadline, {
      schedule: { kind: "cron", expr: "* * * * *", tz: "UTC", staggerMs: 0 },
    }),
  ]);
  expect(scheduler.start().accepted).toEqual([]);
  const moved = scheduler.tick(now - 60 * minute, 1_000);
  expect(moved.accepted).toEqual([]);
  expect(moved.nextWakeAtMs).toBe(deadline);
  expect(scheduler.read()[0]?.state.nextRunAtMs).toBe(deadline);
  expect(scheduler.receipts()).toEqual([]);
});

it("keeps an overdue active occurrence on a bounded future wake", () => {
  const scheduler = storedScheduler("active-wake", [
    job("active", now - 17 * minute, {
      state: { nextRunAtMs: now - 17 * minute, runningAtMs: now - minute },
    }),
  ]);
  const started = scheduler.start();
  expect(started.accepted).toEqual([]);
  expect(started.nextWakeAtMs).toBeGreaterThanOrEqual(now + 2_000);
  expect(started.nextWakeAtMs).toBeLessThanOrEqual(now + minute);
  expect(scheduler.receipts()).toEqual([]);
});

it("uses the latest pushed owner and enablement configuration and ignores older snapshots", () => {
  const scheduler = storedScheduler("snapshot-order", [
    job("default-owner", now + minute, { agentId: undefined }),
  ]);
  scheduler.start();
  const current = { version: 3, config: { cronEnabled: false, defaultAgentId: "current" } };
  scheduler.refresh({ snapshot: current });
  expect(scheduler.tick(now + minute, minute).accepted).toEqual([]);

  scheduler.refresh({
    nowMs: now + minute,
    monotonicMs: minute,
    snapshot: { version: 2, config: { cronEnabled: true, defaultAgentId: "retired" } },
  });
  expect(scheduler.tick(now + minute, minute).accepted).toEqual([]);

  scheduler.refresh({
    nowMs: now + minute,
    monotonicMs: minute,
    snapshot: { version: 4, config: { ...current.config, cronEnabled: true } },
  });
  const requested = scheduler.tick(now + minute, minute).accepted;
  expect(requested).toHaveLength(1);
  expect(requested[0]?.runReceipt.agentId).toBe("current");
});

it("keeps scheduling for an active subscriber and resumes after every subscriber paused", () => {
  const deadline = now + minute;
  const scheduler = storedScheduler("subscribers", [job("shared", deadline)]);
  scheduler.start();
  const secondChannel = "cron-scheduler-test:second-subscriber";
  scheduler.start(now, { channelName: secondChannel });
  expect(scheduler.refresh({ paused: true }).nextWakeAtMs).toBe(deadline);
  expect(
    scheduler.refresh({ channelName: secondChannel, paused: true }).nextWakeAtMs,
  ).toBeUndefined();
  expect(scheduler.tick(deadline, minute).accepted).toEqual([]);

  expect(
    scheduler.refresh({ paused: false, nowMs: deadline, monotonicMs: minute }).nextWakeAtMs,
  ).toBe(deadline);
  expect(scheduler.tick(deadline, minute).accepted.map(({ job: entry }) => entry.id)).toEqual([
    "shared",
  ]);
  expect(scheduler.receipts()).toHaveLength(1);
});
it("keeps an idle notification watchdog and repairs a resume whose refresh was lost", async () => {
  const scheduler = storedScheduler("idle-watchdog", []);
  const receiver = new BroadcastChannel(scheduler.channelName);
  const posted = vi.spyOn(BroadcastChannel.prototype, "postMessage");
  try {
    expect(scheduler.start().nextWakeAtMs).toBeUndefined();
    const notification = once(receiver, "message");
    await vi.advanceTimersByTimeAsync(minute);
    expect(posted).toHaveBeenCalledWith({
      type: "cron.schedulerWake",
      storeKey: scheduler.storeKey,
    });
    const [event] = await notification;
    expect(event.data).toEqual({ type: "cron.schedulerWake", storeKey: scheduler.storeKey });

    expect(
      scheduler.refresh({ paused: true, nowMs: now + minute, monotonicMs: minute }).nextWakeAtMs,
    ).toBeUndefined();
    withinWorker(() =>
      runOpenClawStateWriteTransaction(
        () =>
          saveCronStoreInDatabase(database, scheduler.storeKey, {
            version: 1,
            jobs: [job("resumed", now + minute)],
          }),
        { database, path: database.path, env: fixture.env },
      ),
    );
    posted.mockClear();
    const resumeNotification = once(receiver, "message");
    await vi.advanceTimersByTimeAsync(minute);
    expect(posted).toHaveBeenCalledWith({
      type: "cron.schedulerWake",
      storeKey: scheduler.storeKey,
    });
    await resumeNotification;
    expect(
      scheduler
        .tick(now + 2 * minute, 2 * minute, { channelName: scheduler.channelName, paused: false })
        .accepted.map(({ job: entry }) => entry.id),
    ).toEqual(["resumed"]);
  } finally {
    posted.mockRestore();
    receiver.close();
  }
});
