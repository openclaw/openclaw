import { channel } from "node:diagnostics_channel";
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
import { logWebhookReceived } from "../logging/diagnostic.js";
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
  const pressure = channel("openclaw.memory.critical");
  const pressureSamples = vi.fn();
  pressure.subscribe(pressureSamples);
  using observers = new DisposableStack();
  observers.defer(() => {
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
  const readMemoryUsage = process.memoryUsage;
  const criticalRss = totalmem();
  // Exercise the real scheduler's pressure publication without allocating memory.
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
  await tick({ pressure: 2 });
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
