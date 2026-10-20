import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  areDiagnosticsEnabledForProcess,
  onDiagnosticEvent,
  setDiagnosticsEnabledForProcess,
  waitForDiagnosticEventsDrained,
} from "../infra/diagnostic-events.js";
import * as schedulerModule from "../infra/gateway-scheduler.js";
import {
  getLegacyPluginSdkResourceHost,
  LegacyPluginSdkResourceHost,
} from "../plugins/legacy-sdk-resource-host.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import {
  logWebhookReceived,
  startDiagnosticHeartbeat,
  stopDiagnosticHeartbeat,
} from "./logging-core.js";

let previouslyEnabled: boolean;
let heartbeats: string[];
let unsubscribe: () => void;
beforeEach(() => {
  previouslyEnabled = areDiagnosticsEnabledForProcess();
  heartbeats = [];
  unsubscribe = onDiagnosticEvent((event) => {
    if (event.type === "diagnostic.heartbeat") {
      heartbeats.push(event.type);
    }
  });
  setDiagnosticsEnabledForProcess(true);
});
afterEach(() => {
  stopDiagnosticHeartbeat();
  unsubscribe();
  setDiagnosticsEnabledForProcess(previouslyEnabled);
});

it.each(["heartbeat", "scheduler"] as const)(
  "stops %s-owned diagnostics and permits a new generation",
  async (stop) => {
    for (let generation = 0; generation < 2; generation++) {
      const clock = createGatewaySchedulerClock(Date.now());
      const scheduler = createTestGatewayScheduler(clock.clock);
      const host = new LegacyPluginSdkResourceHost();
      host.bindScheduler(scheduler);
      const peer = vi.fn();
      try {
        scheduler.schedule({ id: "peer", delayMs: 30_000, everyMs: 30_000, run: peer });
        host.run(() => startDiagnosticHeartbeat({}, { sampleLiveness: () => null }));
        logWebhookReceived({ channel: "test" });
        await clock.advanceBy(30_000);
        await waitForDiagnosticEventsDrained();
        expect(heartbeats).toHaveLength(generation + 1);
        expect(peer).toHaveBeenCalledOnce();
        if (stop === "heartbeat") {
          host.run(stopDiagnosticHeartbeat);
        } else {
          await scheduler.stop();
        }
        await clock.advanceBy(30_000);
        await waitForDiagnosticEventsDrained();
        expect(heartbeats).toHaveLength(generation + 1);
        expect(peer).toHaveBeenCalledTimes(stop === "heartbeat" ? 2 : 1);
      } finally {
        await host.close();
        await scheduler.stop();
      }
    }
  },
);

it("owns standalone diagnostics inside a retained SDK callback without replacing its resource host", async () => {
  const clock = createGatewaySchedulerClock(Date.now());
  const scheduler = createTestGatewayScheduler(clock.clock);
  const constructor = vi.spyOn(schedulerModule, "GatewayScheduler").mockImplementation(function () {
    return scheduler;
  });
  const host = getLegacyPluginSdkResourceHost();
  try {
    await host.track(async () => {
      startDiagnosticHeartbeat({}, { sampleLiveness: () => null });
      expect(getLegacyPluginSdkResourceHost()).toBe(host);
      logWebhookReceived({ channel: "test" });
      await clock.advanceBy(30_000);
      await waitForDiagnosticEventsDrained();
    });
    expect(heartbeats).toHaveLength(1);
    host.invoke(stopDiagnosticHeartbeat);
    expect(scheduler.signal.aborted).toBe(true);
    expect(scheduler.nextWakeAtMs).toBeNull();
    expect(() => host.assertOpen()).not.toThrow();
    await clock.advanceBy(30_000);
    await waitForDiagnosticEventsDrained();
    expect(heartbeats).toHaveLength(1);
  } finally {
    stopDiagnosticHeartbeat();
    await scheduler.stop();
    constructor.mockRestore();
  }
});

it("rejects timed work from an explicit resource host whose scheduler was not bound", async () => {
  const host = new LegacyPluginSdkResourceHost();
  try {
    expect(() => host.run(() => startDiagnosticHeartbeat())).toThrow(
      "Plugin SDK resource host has no Gateway scheduler",
    );
  } finally {
    await host.close();
  }
});
