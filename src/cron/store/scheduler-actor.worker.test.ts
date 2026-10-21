import { once } from "node:events";
import { BroadcastChannel } from "node:worker_threads";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_CRON_MAX_CONCURRENT_RUNS } from "../../config/cron-limits.js";
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
import { projectCronRunHistoryPage } from "../run-history.js";
import type { CronJob } from "../types.js";
import { loadCronStoreFromDatabase } from "./load.kernel.js";
import { readCronRunRecordsInDatabase } from "./run-history.kernel.js";
import { queueJob } from "./run-queue.test-support.js";
import { cancelCronRequestsInWorker } from "./run-queue.worker.js";
import { ensureCronRunReceiptSchema } from "./run-receipt-store.js";
import { saveCronStoreInDatabase } from "./save.kernel.js";
import type { CronSchedulerOperations, CronSchedulerSnapshot } from "./scheduler-actor.types.js";
import { runCronSchedulerInWorker, stopCronSchedulerInWorker } from "./scheduler-actor.worker.js";

const now = Date.parse("2026-10-11T12:00:00.000Z");
const minute = 60_000;
const snapshot: CronSchedulerSnapshot = {
  config: { cronEnabled: true, defaultAgentId: "main" },
};
let fixture: OpenClawTestState;
let database: ReturnType<typeof openOpenClawStateDatabase>;
const active = new Map<string, string>();
type StartOptions = Partial<CronSchedulerOperations["cron.schedulerStart"]["input"]>;
type TickInput = Omit<
  CronSchedulerOperations["cron.schedulerTick"]["input"],
  "storeKey" | "nowMs" | "monotonicMs"
>;
const cronSchedule = { kind: "cron", expr: "* * * * *", tz: "UTC", staggerMs: 0 } as const;
const jobIds = (runs: { job: CronJob }[]) => runs.map(({ job: entry }) => entry.id);
const immediate = (count: number) => ({
  snapshot: { ...snapshot, config: { ...snapshot.config, maxMissedJobsPerRestart: count } },
});
const jobSeries = (prefix: string, count: number, due: (index: number) => number) =>
  Array.from({ length: count }, (_, index) => job(`${prefix}-${index}`, due(index)));

beforeAll(async () => {
  fixture = await createOpenClawTestState({ label: "cron-scheduler-actor" });
  database = openOpenClawStateDatabase();
  ensureCronRunReceiptSchema(database.db);
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(now);
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
  return queueJob(id, now, {
    createdAtMs: now - 24 * 60 * minute,
    updatedAtMs: now - 24 * 60 * minute,
    schedule: { kind: "every", everyMs: minute, anchorMs: dueAtMs },
    state: { nextRunAtMs: dueAtMs },
    ...overrides,
  });
}

function withinWorker<T>(run: () => T): T {
  return runWithSqliteWorkerStateContext(
    { environment: { ...fixture.env, OPENCLAW_STATE_DIR: fixture.stateDir } },
    run,
  );
}

function save(storeKey: string, jobs: CronJob[]) {
  withinWorker(() =>
    runOpenClawStateWriteTransaction(
      () => saveCronStoreInDatabase(database, storeKey, { version: 1, jobs }),
      { database, path: database.path, env: fixture.env },
    ),
  );
}

function storedScheduler(label: string, jobs: CronJob[]) {
  const storeKey = fixture.statePath("cron", `${label}.json`);
  const channelName = `cron-scheduler-test:${storeKey}`;
  save(storeKey, jobs);
  const run = (command: Parameters<typeof runCronSchedulerInWorker>[1]) =>
    withinWorker(() => runCronSchedulerInWorker(database, command));
  const start = (atMs = now, options: StartOptions = {}) => {
    active.set(options.channelName ?? channelName, storeKey);
    return run({
      type: "cron.schedulerStart",
      input: { storeKey, channelName, snapshot, nowMs: atMs, monotonicMs: 0, ...options },
    });
  };
  const read = () => loadCronStoreFromDatabase(database.db, storeKey).store.jobs;
  return {
    storeKey,
    channelName,
    start,
    read,
    job: (id: string) => read().find((entry) => entry.id === id)!,
    save: (entries: CronJob[]) => save(storeKey, entries),
    cancel: (receiptIds: string[], nowMs: number, reason: string) =>
      withinWorker(() =>
        cancelCronRequestsInWorker(database, { storeKey, receiptIds, nowMs, reason }),
      ),
    refresh: (
      input: Omit<CronSchedulerOperations["cron.schedulerRefresh"]["input"], "storeKey"> = {},
    ) =>
      run({
        type: "cron.schedulerRefresh",
        input: { storeKey, channelName, nowMs: now, monotonicMs: 0, ...input },
      }),
    tick: (atMs: number, monotonicMs: number, input: TickInput = {}) =>
      run({
        type: "cron.schedulerTick",
        input: { storeKey, nowMs: atMs, monotonicMs, ...input },
      }),
    receipts: () =>
      database.db
        .prepare(
          "SELECT job_id, receipt_id FROM cron_run_receipts WHERE store_key = ? ORDER BY job_id",
        )
        .all(storeKey),
    restart: async (atMs: number, options: StartOptions = {}) => {
      stopCronSchedulerInWorker({ storeKey, channelName });
      active.delete(channelName);
      await closeOpenClawStateDatabaseAsync();
      database = openOpenClawStateDatabase();
      return start(atMs, options);
    },
  };
}

function observeWakes(channelName: string) {
  const receiver = new BroadcastChannel(channelName);
  const posted = vi.spyOn(BroadcastChannel.prototype, "postMessage");
  return {
    posted,
    next: async (delay: number) => {
      const notification = once(receiver, "message");
      await vi.advanceTimersByTimeAsync(delay);
      await notification;
    },
    [Symbol.dispose]: () => {
      posted.mockRestore();
      receiver.close();
    },
  };
}

it("activates scheduled requests in FIFO capacity order and observes a queued edit on the next tick", () => {
  const count = DEFAULT_CRON_MAX_CONCURRENT_RUNS + 2;
  const scheduler = storedScheduler(
    "scheduled-activation",
    jobSeries("job", count, (index) => now - (count - index) * minute).toReversed(),
  );
  const started = scheduler.start(now, immediate(count));
  expect(jobIds(started.accepted)).toEqual(Array.from({ length: count }, (_, i) => `job-${i}`));
  expect(jobIds(started.launches)).toEqual(
    Array.from({ length: DEFAULT_CRON_MAX_CONCURRENT_RUNS }, (_, index) => `job-${index}`),
  );
  const queuedId = `job-${DEFAULT_CRON_MAX_CONCURRENT_RUNS}`;
  const persisted = scheduler.read();
  expect(persisted.filter((entry) => entry.state.runningAtMs === now)).toHaveLength(
    DEFAULT_CRON_MAX_CONCURRENT_RUNS,
  );
  expect(persisted.filter((entry) => entry.state.queuedAtMs === now)).toHaveLength(2);
  const queued = persisted.find((entry) => entry.id === queuedId)!;
  queued.payload = { kind: "command", argv: ["echo", "edited while queued"] };
  queued.state.lastError = "preserve earlier failure";
  scheduler.save(persisted);
  expect(scheduler.tick(now + 1, 1)).toMatchObject({ accepted: [], launches: [] });
  expect(scheduler.receipts()).toHaveLength(count);
  scheduler.cancel([started.launches[0]!.runReceipt.receiptId], now + 2, "test releases one slot");
  const resumed = scheduler.tick(now + 3, 3);
  expect(resumed.accepted).toEqual([]);
  expect(jobIds(resumed.launches)).toEqual([queuedId]);
  expect(resumed.launches[0]?.job.payload).toEqual({
    kind: "command",
    argv: ["echo", "edited while queued"],
  });
  expect(resumed.launches[0]?.job.state).toMatchObject({
    runningAtMs: now + 3,
    lastError: "preserve earlier failure",
  });
  expect(scheduler.job(queuedId)?.state).toEqual(resumed.launches[0]?.job.state);
});

it.each(["every", "cron"] as const)(
  "advances a cancelled %s slot across scheduler and database restart",
  async (kind) => {
    const target = job(`cancelled-${kind}`, now, {
      schedule: kind === "cron" ? cronSchedule : { kind: "every", everyMs: minute, anchorMs: now },
    });
    const jobs = [
      ...Array.from({ length: DEFAULT_CRON_MAX_CONCURRENT_RUNS }, (_, index) =>
        job(`blocker-${kind}-${index}`, now, {
          schedule: { kind: "every", everyMs: 60 * minute, anchorMs: now },
        }),
      ),
      target,
    ];
    const scheduler = storedScheduler(`cancelled-slot-${kind}`, jobs);
    const options = immediate(jobs.length);
    const started = scheduler.start(now, options);
    const receipt = started.accepted.find(({ job: entry }) => entry.id === target.id)!.runReceipt;
    expect(started.launches.some(({ job: entry }) => entry.id === target.id)).toBe(false);
    expect(scheduler.job(target.id)?.state.queuedAtMs).toBe(now);
    scheduler.cancel(
      started.accepted.map(({ runReceipt }) => runReceipt.receiptId),
      now + 1,
      "cron service stopped",
    );
    const cancelled = scheduler.job(target.id)!;
    expect(cancelled.state.nextRunAtMs).toBe(now);
    expect(cancelled.state.queuedAtMs).toBeUndefined();
    const restarted = await scheduler.restart(now + 2, options);
    expect(restarted.rejected.find(({ jobId }) => jobId === target.id)?.reason).toBe(
      "already-requested",
    );
    scheduler.tick(now + 3, 1);
    expect(scheduler.job(target.id)?.state.nextRunAtMs).toBe(now + minute);
    const resumed = scheduler.tick(now + minute, minute - 2);
    const launch = resumed.launches.find(({ job: entry }) => entry.id === target.id);
    expect(launch?.job.state.runningAtMs).toBe(now + minute);
    expect(launch?.runReceipt.receiptId).not.toBe(receipt.receiptId);
    const history = projectCronRunHistoryPage(
      readCronRunRecordsInDatabase(database.db, target.id),
      {
        storeKey: scheduler.storeKey,
      },
    );
    expect(history.entries).toMatchObject([{ status: "skipped", error: "cron service stopped" }]);
  },
);

it("keeps startup work pending while its subscriber is paused", () => {
  const scheduler = storedScheduler("paused-start", [job("pending", now - minute)]);
  const started = scheduler.start(now, { paused: true });
  expect(started.accepted).toEqual([]);
  expect(started.launches).toEqual([]);
  const resumed = scheduler.tick(now + 1, 1, { channelName: scheduler.channelName, paused: false });
  expect(jobIds(resumed.launches)).toEqual(["pending"]);
});

it("settles a removed queued request even when no queued job remains", () => {
  const count = DEFAULT_CRON_MAX_CONCURRENT_RUNS + 1;
  const scheduler = storedScheduler(
    "removed-queued-request",
    jobSeries("job", count, () => now - minute),
  );
  const started = scheduler.start(now, immediate(count));
  const removed = started.accepted.at(-1)!;
  withinWorker(() => {
    scheduler.cancel([removed.runReceipt.receiptId], now + 1, "removed before launch");
    const retained = scheduler.read().filter((entry) => entry.id !== removed.job.id);
    scheduler.save(retained);
  });
  const result = scheduler.tick(now + 2, 2, {
    requests: [{ receiptId: removed.runReceipt.receiptId, mode: "scheduled" }],
  });
  expect(result.launches).toEqual([]);
  expect(result.skipped.map(({ runReceipt }) => runReceipt.receiptId)).toEqual([
    removed.runReceipt.receiptId,
  ]);
});

it("does not activate work for a paused caller when another subscriber is active", () => {
  const scheduler = storedScheduler("paused-subscriber", [job("pending", now + minute)]);
  scheduler.start();
  const secondChannel = "cron-scheduler-test:unpaused-sibling";
  scheduler.start(now, { channelName: secondChannel });
  const paused = scheduler.tick(now + minute, minute, {
    channelName: scheduler.channelName,
    paused: true,
  });
  expect(paused.accepted).toHaveLength(1);
  expect(paused.launches).toEqual([]);
  const unpaused = scheduler.tick(now + minute + 1, minute + 1, {
    channelName: secondChannel,
    paused: false,
  });
  expect(jobIds(unpaused.launches)).toEqual(["pending"]);
});

it("persists the five-immediate limit, overflow staggering, and pending requests across restart", async () => {
  const scheduler = storedScheduler(
    "overflow-restart",
    jobSeries("job", 7, (index) => now - (7 - index) * minute),
  );
  const started = scheduler.start();
  expect(jobIds(started.accepted)).toEqual(["job-0", "job-1", "job-2", "job-3", "job-4"]);
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

it("defers missed isolated and main-session work for two minutes without blocking command work", () => {
  const scheduler = storedScheduler("agent-startup", [
    job("agent", now - 3 * minute, {
      payload: { kind: "agentTurn", message: "synthetic startup task" },
    }),
    job("main-session", now - 2 * minute, {
      sessionTarget: "main",
      payload: { kind: "systemEvent", text: "synthetic startup notice" },
    }),
    job("command", now - minute),
  ]);
  const started = scheduler.start(now, { deferAgentWork: true });
  expect(jobIds(started.accepted)).toEqual(["command"]);
  expect(
    scheduler
      .read()
      .slice(0, 2)
      .map(({ id, state }) => [id, state.nextRunAtMs, state.startupCatchupAtMs]),
  ).toEqual([
    ["agent", now + 120_000, now + 120_000],
    ["main-session", now + 125_000, now + 125_000],
  ]);
  expect(scheduler.tick(now + 119_999, 119_999).accepted).toEqual([]);
  expect(jobIds(scheduler.tick(now + 120_000, 120_000).accepted)).toEqual(["agent"]);
  expect(jobIds(scheduler.tick(now + 125_000, 125_000).accepted)).toEqual(["main-session"]);
});

it("retains a persisted paced occurrence across actor and database restart", async () => {
  const pacedAtMs = now + 30 * minute;
  const scheduler = storedScheduler("paced-restart", [
    job("paced", pacedAtMs, {
      schedule: cronSchedule,
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
  expect(jobIds(scheduler.tick(pacedAtMs, 20 * minute).accepted)).toEqual(["paced"]);
});

it.each([false, true])("bounds forward clock catch-up with intervening refresh=%s", (refresh) => {
  const scheduler = storedScheduler(
    `forward-jump-${refresh}`,
    jobSeries("jump", 7, (index) => now + (index + 1) * minute),
  );
  expect(scheduler.start().accepted).toEqual([]);
  const edited = scheduler.read();
  edited[5]!.name = "edited before catch-up";
  edited[5]!.state.lastError = "retained failure detail";
  scheduler.save(edited);
  const jumpedAtMs = now + 24 * 60 * minute;
  if (refresh) {
    expect(scheduler.refresh({ nowMs: jumpedAtMs, monotonicMs: 1_000 }).accepted).toEqual([]);
  }
  const jumped = scheduler.tick(jumpedAtMs, 1_000);
  expect(jobIds(jumped.accepted)).toEqual(["jump-0", "jump-1", "jump-2", "jump-3", "jump-4"]);
  expect(
    scheduler
      .read()
      .slice(5)
      .map(({ state }) => state.nextRunAtMs),
  ).toEqual([jumpedAtMs + 5_000, jumpedAtMs + 10_000]);
  expect(jumped.jobs.find(({ id }) => id === "jump-5")).toMatchObject({
    name: "edited before catch-up",
    state: { nextRunAtMs: jumpedAtMs + 5_000, lastError: "retained failure detail" },
  });
  expect(scheduler.read()[5]).toEqual(jumped.jobs.find(({ id }) => id === "jump-5"));
  expect(scheduler.tick(jumpedAtMs + 1, 1_001).accepted).toEqual([]);
  expect(scheduler.receipts()).toHaveLength(5);
});

it("keeps the persisted next deadline when the wall clock moves backward", () => {
  const deadline = now + minute;
  const scheduler = storedScheduler("backward-jump", [
    job("backward", deadline, {
      schedule: cronSchedule,
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

it("uses pushed owner and enablement configuration", () => {
  const scheduler = storedScheduler("snapshot-order", [
    job("default-owner", now + minute, { agentId: undefined }),
  ]);
  scheduler.start();
  const current = { config: { cronEnabled: false, defaultAgentId: "current" } };
  scheduler.refresh({ snapshot: current });
  expect(scheduler.tick(now + minute, minute).accepted).toEqual([]);

  scheduler.refresh({
    nowMs: now + minute,
    monotonicMs: minute,
    snapshot: { config: { ...current.config, cronEnabled: true } },
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
  expect(jobIds(scheduler.tick(deadline, minute).accepted)).toEqual(["shared"]);
  expect(scheduler.receipts()).toHaveLength(1);
});
it("parks empty and disabled actors until an explicit row/config refresh", async () => {
  const scheduler = storedScheduler("idle-parked", []);
  using wakes = observeWakes(scheduler.channelName);
  const { posted } = wakes;
  expect(scheduler.start().nextWakeAtMs).toBeUndefined();
  await vi.advanceTimersByTimeAsync(2 * minute);
  expect(posted).not.toHaveBeenCalled();
  scheduler.save([job("added", now + 3 * minute)]);
  const disabled = { config: { ...snapshot.config, cronEnabled: false } };
  expect(
    scheduler.refresh({ snapshot: disabled, nowMs: now + 2 * minute }).nextWakeAtMs,
  ).toBeUndefined();
  await vi.advanceTimersByTimeAsync(minute);
  expect(posted).not.toHaveBeenCalled();
  scheduler.refresh({
    nowMs: now + 3 * minute,
    snapshot: { config: snapshot.config },
  });
  await wakes.next(2_000);
  expect(jobIds(scheduler.tick(now + 3 * minute + 2_000, 3 * minute + 2_000).accepted)).toEqual([
    "added",
  ]);
});

it("observes future deadlines without SQL wakes and retries an unacknowledged due wake", async () => {
  const deadline = now + 10 * minute;
  const scheduler = storedScheduler("future-deadline", [job("future", deadline)]);
  using wakes = observeWakes(scheduler.channelName);
  const { posted } = wakes;
  expect(scheduler.start().nextWakeAtMs).toBe(deadline);
  await vi.advanceTimersByTimeAsync(9 * minute);
  expect(posted).not.toHaveBeenCalled();
  await wakes.next(minute);
  expect(posted).toHaveBeenCalledTimes(1);
  await wakes.next(minute);
  expect(posted).toHaveBeenCalledTimes(2);
  expect(jobIds(scheduler.tick(deadline + minute, 11 * minute).accepted)).toEqual(["future"]);
});

it.each([
  { name: "on-time long deadline", due: 10, elapsed: 10, accepted: 7 },
  { name: "missed work after sleep", due: 1, elapsed: 60, accepted: 5 },
])("bounds catch-up only for $name", ({ name, due, elapsed, accepted }) => {
  const scheduler = storedScheduler(
    name,
    jobSeries("job", 7, () => now + due * minute),
  );
  scheduler.start();
  expect(scheduler.tick(now + elapsed * minute, elapsed * minute).accepted).toHaveLength(accepted);
});
