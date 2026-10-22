import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as diagnostics from "../infra/diagnostic-events.js";
import * as schedulerModule from "../infra/gateway-scheduler.js";
import { logSessionStateChange } from "../logging/diagnostic.js";
import { resetDiagnosticStateForTest } from "../logging/diagnostic.test-support.js";
import * as resources from "../plugins/legacy-sdk-resource-host.js";
import { createReplyOperation } from "../sessions/session-controller.operation.js";
import { testing } from "../sessions/session-controller.test-support.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import * as logging from "./logging-core.js";

async function advance(clock: ReturnType<typeof createGatewaySchedulerClock>) {
  await clock.advanceBy(30_000);
  await diagnostics.waitForDiagnosticEventsDrained();
}
let previouslyEnabled: boolean;
let heartbeats: string[];
let unsubscribe: () => void;
beforeEach(() => {
  previouslyEnabled = diagnostics.areDiagnosticsEnabledForProcess();
  heartbeats = [];
  unsubscribe = diagnostics.onDiagnosticEvent((event) => {
    if (event.type === "diagnostic.heartbeat") {
      heartbeats.push(event.type);
    }
  });
  diagnostics.setDiagnosticsEnabledForProcess(true);
});
afterEach(() => {
  logging.stopDiagnosticHeartbeat();
  unsubscribe();
  diagnostics.setDiagnosticsEnabledForProcess(previouslyEnabled);
});

it.each(["heartbeat", "scheduler"] as const)(
  "stops %s-owned diagnostics and permits a new generation",
  async (stop) => {
    for (let generation = 0; generation < 2; generation++) {
      const clock = createGatewaySchedulerClock(Date.now());
      const scheduler = createTestGatewayScheduler(clock.clock);
      const host = new resources.LegacyPluginSdkResourceHost();
      host.bindScheduler(scheduler);
      const peer = vi.fn();
      try {
        scheduler.schedule({ id: "peer", delayMs: 30_000, everyMs: 30_000, run: peer });
        host.run(() => logging.startDiagnosticHeartbeat({}, { sampleLiveness: () => null }));
        logging.logWebhookReceived({ channel: "test" });
        await advance(clock);
        expect(heartbeats).toHaveLength(generation + 1);
        expect(peer).toHaveBeenCalledOnce();
        if (stop === "heartbeat") {
          host.run(logging.stopDiagnosticHeartbeat);
        } else {
          await scheduler.stop();
        }
        await advance(clock);
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
  const host = resources.getLegacyPluginSdkResourceHost();
  try {
    await host.track(async () => {
      logging.startDiagnosticHeartbeat({}, { sampleLiveness: () => null });
      expect(resources.getLegacyPluginSdkResourceHost()).toBe(host);
      logging.logWebhookReceived({ channel: "test" });
      await advance(clock);
    });
    expect(heartbeats).toHaveLength(1);
    host.invoke(logging.stopDiagnosticHeartbeat);
    expect(scheduler).toMatchObject({ signal: { aborted: true }, nextWakeAtMs: null });
    expect(() => host.assertOpen()).not.toThrow();
    await advance(clock);
    expect(heartbeats).toHaveLength(1);
  } finally {
    logging.stopDiagnosticHeartbeat();
    await scheduler.stop();
    constructor.mockRestore();
  }
});

it("rejects timed work from an explicit resource host whose scheduler was not bound", async () => {
  const host = new resources.LegacyPluginSdkResourceHost();
  try {
    expect(() => host.run(() => logging.startDiagnosticHeartbeat())).toThrow(
      "Plugin SDK resource host has no Gateway scheduler",
    );
  } finally {
    await host.close();
  }
});

it.each(["standalone", "bound"] as const)(
  "keeps %s SDK recovery callbacks on the eligible host controller",
  async (mode) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(6_000);
    resetDiagnosticStateForTest();
    const ref = { sessionKey: "agent:main:sdk-recovery", sessionId: "sdk-recovery-session" };
    // The host creates work; the public logging API does not manufacture session state.
    const operation = createReplyOperation({ ...ref, resetTriggered: false });
    operation.setPhase("running");
    logSessionStateChange({ ...ref, state: "processing" });
    vi.setSystemTime(306_000);
    const clock = createGatewaySchedulerClock(306_000);
    const scheduler = createTestGatewayScheduler(clock.clock);
    const constructor = vi
      .spyOn(schedulerModule, "GatewayScheduler")
      .mockImplementation(function () {
        return scheduler;
      });
    const host = mode === "bound" ? new resources.LegacyPluginSdkResourceHost() : undefined;
    host?.bindScheduler(scheduler);
    const recover = vi.fn();
    const start = () =>
      logging.startDiagnosticHeartbeat(
        { diagnostics: { enabled: true } },
        { recoverStuckSession: recover, sampleLiveness: () => null },
      );
    try {
      if (host) {
        host.run(start);
      } else {
        start();
      }
      vi.setSystemTime(336_000);
      await clock.advanceTo(336_000);
      expect(operation.watchdog.decide().action).toBe("warn");
      expect(recover).not.toHaveBeenCalled();
      vi.setSystemTime(366_000);
      expect(operation.watchdog.decide().action).toBe("stop");
      await clock.advanceTo(366_000);
      expect(recover).toHaveBeenCalledOnce();
      expect(recover).toHaveBeenCalledWith(
        expect.objectContaining({
          ...ref,
          operation,
          allowActiveAbort: true,
          expectedState: "processing",
        }),
      );
      // The callback remains the selected dispatch adapter, not an extra built-in effect.
      expect(operation.result).toBeNull();
    } finally {
      logging.stopDiagnosticHeartbeat();
      await host?.close();
      await scheduler.stop();
      constructor.mockRestore();
      operation.complete();
      testing.resetSessionControllerForTest();
      resetDiagnosticStateForTest();
      vi.useRealTimers();
    }
  },
);
