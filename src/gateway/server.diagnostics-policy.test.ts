import { channel } from "node:diagnostics_channel";
import { once } from "node:events";
import { expect, it, vi } from "vitest";
import {
  areDiagnosticsEnabledForProcess,
  onDiagnosticEvent,
  setDiagnosticsEnabledForProcess,
  waitForDiagnosticEventsDrained,
} from "../infra/diagnostic-events.js";
import type { GatewaySchedulerClock } from "../infra/gateway-scheduler.js";
import * as workerCpu from "../infra/worker-cpu.js";
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
  const state = await createOpenClawTestState({
    label: "gateway-diagnostics-policy",
    env: {
      OPENCLAW_GATEWAY_TOKEN: undefined,
      OPENCLAW_GATEWAY_PASSWORD: undefined,
      OPENCLAW_TEST_MINIMAL_GATEWAY: "1",
      OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
      OPENCLAW_SKIP_CANVAS_HOST: "1",
      OPENCLAW_SKIP_CHANNELS: "1",
      OPENCLAW_SKIP_CRON: "1",
      OPENCLAW_SKIP_GMAIL_WATCHER: "1",
      OPENCLAW_SKIP_PROVIDERS: "1",
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    },
  });
  let kernel: Awaited<ReturnType<typeof createGatewayKernel>> | undefined;
  let unsubscribe: (() => void) | undefined;
  let pool:
    | ReturnType<typeof createOwnedWorkerTaskPool<PoolFixtureInput, PoolFixtureResult>>
    | undefined;
  let active: ReturnType<NonNullable<typeof pool>["runTask"]> | undefined;
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const pressure = channel("openclaw.memory.critical");
  const pressureSamples = vi.fn();
  pressure.subscribe(pressureSamples);
  try {
    const port = await getFreePort();
    await state.writeConfig({
      diagnostics: { enabled: false },
      gateway: { mode: "local", port, auth: { mode: "none" }, controlUi: { enabled: false } },
    });
    state.applyEnv();
    const clock = createGatewaySchedulerClock(Date.now());
    schedulerClock.clock = clock.clock;
    kernel = await createGatewayKernel(port, {
      auth: { mode: "none" },
      bind: "loopback",
      controlUiEnabled: false,
      sidecarStartup: "defer",
    });
    expect(areDiagnosticsEnabledForProcess()).toBe(false);
    const spawned = vi.spyOn(workerCpu, "createCpuTrackedWorker");
    pool = createOwnedWorkerTaskPool<PoolFixtureInput, PoolFixtureResult>({
      workerUrl: new URL("../infra/worker-task-pool.test-support.ts", import.meta.url),
      maxWorkers: 2,
    });
    const warm = await pool.run({ label: "warm" }, {});
    active = pool.runTask(
      { label: "active", exchanges: 1 },
      {
        onRequest: async () => {
          entered.resolve();
          await release.promise;
          return { input: undefined, timeoutMs: 10_000 };
        },
      },
    );
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
    // Inject counters, not allocations; retirement still crosses the real scheduler and Worker.
    Object.assign(
      vi.spyOn(process, "memoryUsage").mockImplementation(() => ({
        ...readMemoryUsage(),
        rss: 64 * 1024 ** 3,
      })),
      { rss: () => readMemoryUsage.rss() },
    );
    const workerSamples = vi.spyOn(workerCpu, "sampleTrackedWorkerMemory");
    const events: string[] = [];
    unsubscribe = onDiagnosticEvent((event) => events.push(event.type));
    const tick = async () => {
      logWebhookReceived({ channel: "test" });
      await clock.advanceBy(30_000);
      await waitForDiagnosticEventsDrained();
    };
    await tick();
    expect(pressureSamples).toHaveBeenCalledTimes(1);
    expect(events).toEqual([]);
    expect(workerSamples).not.toHaveBeenCalled();
    await idleExit;
    expect(idleWorker.threadId).toBe(-1);
    expect(activeWorker.threadId).toBeGreaterThan(0);
    expect(pool.getSnapshot()).toMatchObject({ activeTasks: 1, pendingTasks: 1 });
    release.resolve();
    expect(await active.result).toMatchObject({ label: "active", threadId: activeWorker.threadId });

    // A delivered result is still owned until the caller closes it.
    await tick();
    expect(pressureSamples).toHaveBeenCalledTimes(2);
    expect(activeWorker.threadId).toBeGreaterThan(0);
    await active.close();
    await pool.close();
    expect(activeWorker.threadId).toBe(-1);
    expect(pool.getSnapshot()).toMatchObject({ workers: 0, activeTasks: 0, pendingTasks: 0 });

    // Keep activity timestamps on the scheduler clock after real Worker teardown.
    vi.spyOn(Date, "now").mockImplementation(clock.clock.now);

    kernel.configureDiagnostics({ diagnostics: { enabled: true } });
    await tick();
    expect(events.filter((event) => event === "webhook.received")).toHaveLength(1);
    expect(events.filter((event) => event === "diagnostic.heartbeat")).toHaveLength(1);
    expect(pressureSamples).toHaveBeenCalledTimes(3);
    expect(workerSamples).toHaveBeenCalledTimes(1);

    kernel.configureDiagnostics({ diagnostics: { enabled: false } });
    await tick();
    expect(events.filter((event) => event === "webhook.received")).toHaveLength(1);
    expect(events.filter((event) => event === "diagnostic.heartbeat")).toHaveLength(1);
    expect(pressureSamples).toHaveBeenCalledTimes(4);
    expect(workerSamples).toHaveBeenCalledTimes(1);

    kernel.configureDiagnostics({});
    await tick();
    expect(events.filter((event) => event === "diagnostic.heartbeat")).toHaveLength(2);
    expect(pressureSamples).toHaveBeenCalledTimes(5);
    await kernel.closeOnStartupFailure();
    kernel.configureDiagnostics({ diagnostics: { enabled: true } });
    await tick();
    expect(events.filter((event) => event === "diagnostic.heartbeat")).toHaveLength(2);
    expect(pressureSamples).toHaveBeenCalledTimes(5);
  } finally {
    release.resolve();
    unsubscribe?.();
    pressure.unsubscribe(pressureSamples);
    try {
      await active?.close();
    } finally {
      try {
        await pool?.close();
      } finally {
        try {
          await kernel?.closeOnStartupFailure();
        } finally {
          delete schedulerClock.clock;
          vi.restoreAllMocks();
          try {
            await state.cleanup();
          } finally {
            setDiagnosticsEnabledForProcess(previouslyEnabled);
          }
        }
      }
    }
  }
}, 60_000);
