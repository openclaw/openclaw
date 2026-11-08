import { channel } from "node:diagnostics_channel";
import { once } from "node:events";
import { setImmediate as nextTurn } from "node:timers/promises";
import { deserialize } from "node:v8";
import { Worker } from "node:worker_threads";
import { expect, it, vi } from "vitest";
import {
  createDueIsolatedJob,
  noopLogger,
  setupCronRegressionFixtures,
} from "../../../test/helpers/cron/service-regression-fixtures.js";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import type { CliDeps } from "../../cli/deps.types.js";
import type { GatewayCronState } from "../../gateway/server-cron-contract.js";
import { createLazyGatewayCronState } from "../../gateway/server-cron-lazy.js";
import type { SqliteWorkerRequest } from "../../infra/sqlite-worker-contract.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../../test-utils/gateway-scheduler-clock.js";
import { createCronServiceWithStateForTest } from "../service.test-harness.js";
import { loadCronStore, saveCronStore } from "../store.js";
import { waitForCronRunQueue } from "./run-queue.js";
import { captureCronSchedulerWakeForTest } from "./scheduler-actor.test-support.js";
import type { CronServiceDeps } from "./state.js";

const gateway = vi.hoisted(() => ({ state: undefined as GatewayCronState | undefined }));
vi.mock("../../gateway/server-cron.js", () => ({
  buildGatewayCronService: () => gateway.state,
}));
vi.mock("node:diagnostics_channel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:diagnostics_channel")>();
  const pressure = actual.channel(Symbol("disabled-cron-retirement"));
  return {
    ...actual,
    channel: (name: string | symbol) =>
      name === "openclaw.memory.critical" ? pressure : actual.channel(name),
  };
});

const fixtures = setupCronRegressionFixtures({ prefix: "cron-start-arm-" });

it("reclaims a disabled scheduler's worker before stop and still accepts manual runs", async ({
  signal,
}) => {
  vi.useRealTimers();
  const { storePath } = fixtures.makeStorePath();
  const now = Date.now();
  const job = createDueIsolatedJob({ id: "manual-after-retirement", nowMs: now, nextRunAtMs: now });
  job.sessionTarget = "main";
  job.payload = { kind: "systemEvent", text: job.id };
  await saveCronStore(storePath, { version: 1, jobs: [job] });
  const runSessionEvent = vi.fn<NonNullable<CronServiceDeps["runSessionEvent"]>>(async () => ({
    status: "ok",
  }));
  const scheduler = createTestGatewayScheduler();
  const { cron, state } = createCronServiceWithStateForTest({
    scheduler,
    storePath,
    cronEnabled: false,
    log: noopLogger,
    enqueueSystemEvent: vi.fn(),
    runSessionEvent,
    runIsolatedAgentJob: vi.fn(),
  });
  const carrier = createDeferred<Worker>();
  // Capture the owner before postMessage transfers and detaches the input buffer.
  // oxlint-disable-next-line typescript/unbound-method -- Preserve the real Worker receiver.
  const postMessage = Worker.prototype.postMessage;
  const capture = vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (
    this: Worker,
    request: SqliteWorkerRequest,
    transferList,
  ) {
    if (request.type === "execute" && deserialize(request.input).type === "cron.schedulerStart") {
      carrier.resolve(this);
    }
    postMessage.call(this, request, transferList);
  });
  try {
    await cron.start();
    expect(runSessionEvent).not.toHaveBeenCalled();
    expect(await cron.status()).toMatchObject({ enabled: false, jobs: 1, nextWakeAtMs: null });
    const worker = await withinTest(carrier.promise, signal);
    expect(worker).toBeInstanceOf(Worker);
    const exited = once(worker, "exit");
    const pressure = channel("openclaw.memory.critical");
    expect(pressure.hasSubscribers).toBe(true);
    // Match the production sampler: finite refresh work may overlap one signal.
    const pressureTimer = setInterval(() => pressure.publish(undefined), 1_000);
    try {
      pressure.publish(undefined);
      await withinTest(exited, signal);
    } finally {
      clearInterval(pressureTimer);
    }
    expect(worker.threadId).toBe(-1);
    await expect(cron.run(job.id, "force")).resolves.toEqual({ ok: true, ran: true });
    expect(runSessionEvent).toHaveBeenCalledOnce();
  } finally {
    capture.mockRestore();
    cron.stop();
    await state.schedulerDrain;
    await scheduler.stop();
  }
}, 10_000);

it("joins a disabled scheduler borrow when stopped during its native command", async ({
  signal,
}) => {
  vi.useRealTimers();
  const { storePath } = fixtures.makeStorePath();
  const scheduler = createTestGatewayScheduler();
  const { cron, state } = createCronServiceWithStateForTest({
    scheduler,
    storePath,
    cronEnabled: false,
    log: noopLogger,
    enqueueSystemEvent: vi.fn(),
    runIsolatedAgentJob: vi.fn(),
  });
  const entered = createDeferred<Worker>();
  let forward: (() => void) | undefined;
  const commands: string[] = [];
  // Hold the real native request after lease acquisition, without replacing its result.
  // oxlint-disable-next-line typescript/unbound-method -- Preserve the real Worker receiver.
  const postMessage = Worker.prototype.postMessage;
  const capture = vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (
    this: Worker,
    request: SqliteWorkerRequest,
    transferList,
  ) {
    if (request.type === "execute") {
      const command = deserialize(request.input).type;
      if (command.startsWith("cron.scheduler")) {
        commands.push(command);
      }
      if (command === "cron.schedulerStart") {
        forward = () => {
          forward = undefined;
          postMessage.call(this, request, transferList);
        };
        entered.resolve(this);
        return;
      }
    }
    postMessage.call(this, request, transferList);
  });
  const started = cron.start();
  try {
    const worker = await withinTest(
      awaitGateBeforeSettlement(
        entered.promise,
        started,
        "Scheduler never reached native dispatch",
      ),
      signal,
    );
    cron.pauseScheduling();
    cron.stop();
    let drained = false;
    void state.schedulerDrain.then(() => {
      drained = true;
    });
    await nextTurn();
    expect(drained).toBe(false);
    forward!();
    await withinTest(Promise.all([started, state.schedulerDrain]), signal);
    expect(state.schedulerStarted).toBe(false);
    expect(state.stopped).toBe(true);
    expect(commands).toEqual(["cron.schedulerStart", "cron.schedulerStop"]);
    const exited = once(worker, "exit");
    channel("openclaw.memory.critical").publish(undefined);
    await withinTest(exited, signal);
    expect(worker.threadId).toBe(-1);
  } finally {
    forward?.();
    capture.mockRestore();
    cron.stop();
    await Promise.allSettled([started, state.schedulerDrain]);
    await scheduler.stop();
  }
}, 10_000);

it.each([false, true])(
  "delivers future jobs after suspension (write failure=%s)",
  async (failWrite) => {
    const { storePath } = fixtures.makeStorePath();
    const now = Date.now();
    const jobs = [
      createDueIsolatedJob({ id: "overdue", nowMs: now, nextRunAtMs: now - 30_000 }),
      createDueIsolatedJob({ id: "upcoming", nowMs: now, nextRunAtMs: now + 132_000 }),
    ];
    for (const job of jobs) {
      job.sessionTarget = "main";
      job.payload = { kind: "systemEvent", text: job.id };
    }
    await saveCronStore(storePath, { version: 1, jobs });
    const database = openOpenClawStateDatabase().db;
    if (failWrite) {
      database.exec(`
      CREATE TRIGGER reject_startup_terminal_write
      AFTER UPDATE ON cron_jobs
      WHEN NEW.job_id = 'overdue' AND json_extract(NEW.state_json, '$.lastRunStatus') = 'ok'
      BEGIN
        SELECT RAISE(ABORT, 'injected terminal write failure');
      END;
    `);
    }
    const runSessionEvent = vi.fn<NonNullable<CronServiceDeps["runSessionEvent"]>>(async () => ({
      status: "ok",
    }));
    const clock = createGatewaySchedulerClock(now);
    const scheduler = createTestGatewayScheduler(clock.clock);
    const { cron: service, state } = createCronServiceWithStateForTest({
      scheduler,
      storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent: vi.fn(),
      runSessionEvent,
      runIsolatedAgentJob: vi.fn(),
    });
    gateway.state = {
      cron: service,
      storePath,
      cronEnabled: true,
      reconcileExitWatchers: async () => {},
      reconcileStreamWatchers: async () => {},
      stopStreamWatchers: async () => {},
    };
    const { cron } = createLazyGatewayCronState({
      storePath,
      cfg: {},
      deps: {} as CliDeps,
      broadcast: vi.fn(),
      scheduler,
    });
    try {
      const { wake } = await captureCronSchedulerWakeForTest(() => cron.start());
      expect(runSessionEvent).not.toHaveBeenCalled();
      expect(service.getJob("overdue")?.state.nextRunAtMs).toBe(now + 120_000);
      clock.setTime(now + 120_000);
      await wake(state);
      // A tick acknowledges activation; the retained run owns terminal accounting.
      await waitForCronRunQueue(state);
      if (failWrite) {
        const overdue = (await loadCronStore(storePath)).jobs.find((job) => job.id === "overdue");
        expect(overdue?.state.runningAtMs).toBe(now + 120_000);
        expect(overdue?.state.lastRunStatus).toBeUndefined();
      }
      const tick = async (delayMs: number, expected: string[], drain = true) => {
        clock.setTime(clock.clock.now() + delayMs);
        await wake(state);
        if (drain) {
          await waitForCronRunQueue(state);
        }
        expect(runSessionEvent.mock.calls.map(([request]) => request.text)).toEqual(expected);
      };
      database.exec("DROP TRIGGER IF EXISTS reject_startup_terminal_write");
      expect(runSessionEvent.mock.calls.map(([request]) => request.text)).toEqual(["overdue"]);
      cron.pauseScheduling();
      await tick(15_000, ["overdue"], false);
      cron.resumeScheduling();
      await tick(15_000, ["overdue", "upcoming"]);
      await tick(60_000, ["overdue", "upcoming"]);
    } finally {
      cron.stop();
      await scheduler.stop();
      database.exec("DROP TRIGGER IF EXISTS reject_startup_terminal_write");
    }
  },
);
