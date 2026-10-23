import { channel } from "node:diagnostics_channel";
import { once } from "node:events";
import { totalmem } from "node:os";
import { expect, it, vi } from "vitest";
import {
  areDiagnosticsEnabledForProcess,
  onDiagnosticEvent,
  setDiagnosticsEnabledForProcess,
  waitForDiagnosticEventsDrained,
} from "../infra/diagnostic-events.js";
import type { GatewaySchedulerClock } from "../infra/gateway-scheduler.js";
import * as workerCpu from "../infra/worker-cpu.js";
import * as workerMessages from "../infra/worker-message-metrics.js";
import { createOwnedWorkerTaskPool } from "../infra/worker-task-pool.js";
import type {
  PoolFixtureInput,
  PoolFixtureResult,
} from "../infra/worker-task-pool.test-support.js";
import { logWebhookReceived } from "../logging/diagnostic.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createGatewaySchedulerClock } from "../test-utils/gateway-scheduler-clock.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { getFreePort } from "../test-utils/ports.js";
import { createGatewayKernel } from "./server-kernel.js";
import { KERNEL_TEST_ENV } from "./test-helpers.env.js";

const schedulerClock = vi.hoisted((): { clock?: GatewaySchedulerClock } => ({}));

vi.mock("../infra/gateway-scheduler.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/gateway-scheduler.js")>();
  return {
    ...actual,
    GatewayScheduler: class extends actual.GatewayScheduler {
      constructor(options: ConstructorParameters<typeof actual.GatewayScheduler>[0] = {}) {
        super({ ...options, clock: schedulerClock.clock ?? options.clock });
      }
    },
  };
});

it("owns diagnostic dispatch and heartbeat across initial disable, enable, disable, and close", async () => {
  const previouslyEnabled = areDiagnosticsEnabledForProcess();
  await using cleanup = new AsyncDisposableStack();
  cleanup.defer(() => setDiagnosticsEnabledForProcess(previouslyEnabled));
  const state = await createOpenClawTestState({
    label: "gateway-diagnostics-policy",
    env: {
      ...KERNEL_TEST_ENV,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    },
  });
  cleanup.defer(() => state.cleanup());
  cleanup.defer(() => {
    delete schedulerClock.clock;
    vi.restoreAllMocks();
  });
  let unsubscribe: (() => void) | undefined = undefined;
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const pressure = channel("openclaw.memory.critical");
  const pressureSamples = vi.fn();
  pressure.subscribe(pressureSamples);
  using observers = new DisposableStack();
  observers.defer(() => {
    release.resolve();
    unsubscribe?.();
    pressure.unsubscribe(pressureSamples);
  });
  const port = await getFreePort();
  await state.writeConfig({
    diagnostics: { enabled: false },
    gateway: { mode: "local", port, auth: { mode: "none" }, controlUi: { enabled: false } },
  });
  state.applyEnv();
  const clock = createGatewaySchedulerClock(Date.now());
  schedulerClock.clock = clock.clock;
  const kernel = await createGatewayKernel(port, {
    auth: { mode: "none" },
    bind: "loopback",
    controlUiEnabled: false,
    sidecarStartup: "defer",
  });
  cleanup.defer(() => kernel.closeOnStartupFailure());
  expect(areDiagnosticsEnabledForProcess()).toBe(false);
  const spawned = vi.spyOn(workerCpu, "createCpuTrackedWorker");
  const pool = createOwnedWorkerTaskPool<PoolFixtureInput, PoolFixtureResult>({
    workerUrl: new URL("../infra/worker-task-pool.test-support.ts", import.meta.url),
    maxWorkers: 2,
  });
  cleanup.defer(() => pool.close());
  const warm = await pool.run({ label: "warm" }, {});
  const active = pool.runTask(
    { label: "active", exchanges: 1 },
    {
      onRequest: async () => {
        entered.resolve();
        await release.promise;
        return { input: undefined, timeoutMs: 10_000 };
      },
    },
  );
  cleanup.defer(() => active.close());
  await Promise.race([
    entered.promise,
    active.result.then(() => {
      throw new Error("Active Worker completed without entering its held exchange");
    }),
  ]);
  const idle = await pool.run({ label: "idle" }, {});
  const workers = spawned.mock.results.flatMap((result) =>
    result.type === "return" &&
    (result.value.threadId === warm.threadId || result.value.threadId === idle.threadId)
      ? [result.value]
      : [],
  );
  expect(workers).toHaveLength(2);
  const idleWorker = workers.find((worker) => worker.threadId === idle.threadId)!;
  const activeWorker = workers.find((worker) => worker !== idleWorker)!;
  const idleExit = once(idleWorker, "exit");
  const readMemoryUsage = process.memoryUsage;
  const criticalRss = totalmem();
  // Inject counters, not allocations; retirement still crosses the real scheduler and Worker.
  Object.assign(
    vi.spyOn(process, "memoryUsage").mockImplementation(() => ({
      ...readMemoryUsage(),
      rss: criticalRss,
    })),
    { rss: () => criticalRss },
  );
  const workerSamples = vi.spyOn(workerCpu, "sampleTrackedWorkerMemory");
  const workerMessageSamples = vi.spyOn(workerMessages, "getWorkerMessageMetrics");
  const events: string[] = [];
  unsubscribe = onDiagnosticEvent((event) => events.push(event.type));
  const tick = async (
    expected: Partial<Record<"webhook" | "heartbeat" | "pressure" | "worker" | "messages", number>>,
  ) => {
    logWebhookReceived({ channel: "test" });
    await clock.advanceBy(30_000);
    await waitForDiagnosticEventsDrained();
    expect({
      webhook: events.filter((event) => event === "webhook.received").length,
      heartbeat: events.filter((event) => event === "diagnostic.heartbeat").length,
      pressure: pressureSamples.mock.calls.length,
      worker: workerSamples.mock.calls.length,
      messages: workerMessageSamples.mock.calls.length,
    }).toMatchObject(expected);
  };
  await tick({ pressure: 1, worker: 0, messages: 0 });
  expect(events).toEqual([]);
  await idleExit;
  expect(idleWorker.threadId).toBe(-1);
  expect(activeWorker.threadId).toBeGreaterThan(0);
  expect(pool.getSnapshot()).toMatchObject({ activeTasks: 1, pendingTasks: 1 });
  release.resolve();
  expect(await active.result).toMatchObject({ label: "active", threadId: activeWorker.threadId });

  // A delivered result is still owned until the caller closes it.
  await tick({ pressure: 2 });
  expect(activeWorker.threadId).toBeGreaterThan(0);
  await active.close();
  await pool.close();
  expect(activeWorker.threadId).toBe(-1);
  expect(pool.getSnapshot()).toMatchObject({ workers: 0, activeTasks: 0, pendingTasks: 0 });

  // Keep activity timestamps on the scheduler clock after real Worker teardown.
  vi.spyOn(Date, "now").mockImplementation(clock.clock.now);

  kernel.configureDiagnostics({ diagnostics: { enabled: true } });
  await tick({ webhook: 1, heartbeat: 1, pressure: 3, worker: 1, messages: 1 });

  kernel.configureDiagnostics({ diagnostics: { enabled: false } });
  await tick({ webhook: 1, heartbeat: 1, pressure: 4, worker: 1, messages: 1 });

  kernel.configureDiagnostics({});
  await tick({ heartbeat: 2, pressure: 5 });
  await kernel.closeOnStartupFailure();
  kernel.configureDiagnostics({ diagnostics: { enabled: true } });
  await tick({ heartbeat: 2, pressure: 5 });
}, 60_000);
