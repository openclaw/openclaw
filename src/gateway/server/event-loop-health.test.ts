import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getInternalDiagnosticEventSequence,
  onDiagnosticEvent,
  onInternalDiagnosticEvent,
  onTrustedInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  setDiagnosticsEnabledForProcess,
  waitForDiagnosticEventsDrained,
  type DiagnosticEventPayload,
} from "../../infra/diagnostic-events.js";
import {
  createDiagnosticTraceContext,
  getActiveDiagnosticTraceContext,
  runWithDiagnosticTraceContext,
} from "../../infra/diagnostic-trace-context.js";
import * as mainThreadStall from "../../infra/main-thread-stall.js";
import {
  startDiagnosticStabilityRecorder,
  stopDiagnosticStabilityRecorder,
} from "../../logging/diagnostic-stability.js";
import { setLoggerOverride } from "../../logging/logger.js";
import { loggingState } from "../../logging/state.js";
import { registerSkillUsageTracking } from "../../skills/workshop/skill-usage.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../../test-utils/gateway-scheduler-clock.js";
import { createGatewayEventLoopHealthMonitor } from "./event-loop-health.js";

type CpuUsage = ReturnType<typeof process.cpuUsage>;
type EventLoopUtilization = ReturnType<typeof performance.eventLoopUtilization>;
const monitors: ReturnType<typeof createGatewayEventLoopHealthMonitor>[] = [];
const subscriptions: (() => void)[] = [];
const nativeDelay = vi.hoisted(() => ({ max: 20_000_000 }));
vi.mock("node:perf_hooks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:perf_hooks")>()),
  monitorEventLoopDelay: () => ({
    get max() {
      return nativeDelay.max;
    },
    percentile: () => nativeDelay.max,
    reset: () => {
      nativeDelay.max = 20_000_000;
    },
    enable: () => true,
    disable: () => true,
  }),
}));

beforeEach(resetDiagnosticEventsForTest);
afterEach(() => {
  for (const monitor of monitors.splice(0)) {
    monitor.stop();
  }
  subscriptions.splice(0).forEach((unsubscribe) => unsubscribe());
  stopDiagnosticStabilityRecorder();
  resetDiagnosticEventsForTest();
  vi.restoreAllMocks();
});

function collectEvents(type: "gateway.main_thread.stall" | "gateway.event_loop.sample") {
  const events: DiagnosticEventPayload[] = [];
  subscriptions.push(onInternalDiagnosticEvent((event) => events.push(event), { include: [type] }));
  return events;
}

function createMonitorHarness(params?: {
  cpuMsPerWallMs?: number;
  utilization?: number;
  isIdle?: () => boolean;
  schedulerWallOffsetMs?: number;
}) {
  let nowMs = 10_000;
  nativeDelay.max = 20_000_000;
  const wallOffsetMs = params?.schedulerWallOffsetMs ?? 0;
  const clock = createGatewaySchedulerClock(nowMs + wallOffsetMs);
  const scheduler = createTestGatewayScheduler(clock.clock);
  const cpuMsPerWallMs = params?.cpuMsPerWallMs ?? 0.1;
  const utilization = params?.utilization ?? 0.2;
  const cpuUsage = vi.fn((previous?: CpuUsage) => {
    const current = { user: Math.round(nowMs * cpuMsPerWallMs * 1_000), system: 0 };
    return previous
      ? { user: current.user - previous.user, system: current.system - previous.system }
      : current;
  });
  const eventLoopUtilization = vi.fn(
    (current?: EventLoopUtilization, previous?: EventLoopUtilization) => ({
      idle: 0,
      active: current && previous ? current.active - previous.active : nowMs,
      utilization,
    }),
  );
  vi.spyOn(performance, "now").mockImplementation(() => nowMs);
  vi.spyOn(process, "cpuUsage").mockImplementation(cpuUsage);
  vi.spyOn(performance, "eventLoopUtilization").mockImplementation(eventLoopUtilization);
  const monitor = createGatewayEventLoopHealthMonitor({
    scheduler,
    isIdle: params?.isIdle,
  });
  monitors.push(monitor);
  const elapseWithoutSampling = (elapsedMs: number) => {
    nowMs += elapsedMs;
    nativeDelay.max = Math.max(nativeDelay.max, elapsedMs * 1_000_000);
  };
  const sample = async (elapsedMs = 20) => {
    elapseWithoutSampling(elapsedMs);
    await clock.advanceTo(nowMs + wallOffsetMs);
  };
  const samples = async (count: number, expected?: object, elapsedMs = 20) => {
    for (let index = 0; index < count; index++) {
      await sample(elapsedMs);
    }
    if (expected) {
      expect(monitor.snapshot()).toMatchObject(expected);
    }
  };
  return {
    monitor,
    scheduler,
    cpuUsage,
    eventLoopUtilization,
    clock,
    sample,
    samples,
    elapseWithoutSampling,
    stall: (elapsedMs: number, nativeTimerCaughtUp = true) =>
      scheduler.schedule({
        id: "maintenance:synthetic-work",
        delayMs: 0,
        run: () => {
          elapseWithoutSampling(elapsedMs);
          // The native timer may not have observed the blocked callback yet.
          if (!nativeTimerCaughtUp) {
            nativeDelay.max = 20_000_000;
          }
        },
      }),
    expectHealth: (expected: object) => expect(monitor.snapshot()).toMatchObject(expected),
  };
}

describe("createGatewayEventLoopHealthMonitor", () => {
  it("aligns idle sampling within ten seconds and resumes full sampling with work", async () => {
    let idle = true;
    const harness = createMonitorHarness({ isIdle: () => idle });
    await harness.samples(50);
    const first = harness.monitor.snapshot();
    const reads = harness.cpuUsage.mock.calls.length;
    await harness.samples(449);
    await harness.sample(19);
    expect(harness.monitor.snapshot()).toBe(first);
    expect(harness.cpuUsage).toHaveBeenCalledTimes(reads);
    await harness.sample(1);
    harness.expectHealth({ intervalMs: 9_000, delayP99Ms: 0, degraded: false, delayMaxMs: 0 });
    idle = false;
    await harness.samples(500);
    await harness.samples(50, { intervalMs: 1_000, delayMaxMs: 20 });
  });

  it("detects a late idle wake with separate wall and elapsed clocks", async () => {
    // Isolate deadline detection from callback attribution of the synthetic clock jump.
    vi.spyOn(mainThreadStall, "createMainThreadStallMonitor").mockReturnValue({
      drain: () => ({ stalls: [], dropped: 0, delayMaxMs: 0 }),
      reset: () => {},
      stop: () => {},
    });
    const harness = createMonitorHarness({
      isIdle: () => true,
      schedulerWallOffsetMs: 1_700_000_000_000,
    });
    await harness.samples(500, { degraded: false });
    harness.elapseWithoutSampling(12_000);
    nativeDelay.max = 20_000_000;
    await harness.samples(1, { degraded: true, delayMaxMs: 2_020, reasons: ["event_loop_delay"] });
  });

  it("keeps idle callback stalls and resumes one-second sampling after degradation", async () => {
    const harness = createMonitorHarness({ isIdle: () => true });
    await harness.samples(50);
    harness.stall(1_200);
    await harness.sample();
    await harness.samples(389, {
      degraded: true,
      reasons: ["event_loop_delay"],
      delayMaxMs: 1_200,
    });
    await harness.samples(50, { intervalMs: 1_000, degraded: false });
  });

  it("logs the blocking scheduler job once when its callback also contains the overdue sample", async () => {
    const warn = vi.fn();
    const rawConsole = loggingState.rawConsole;
    setLoggerOverride({ level: "silent", consoleLevel: "warn" });
    loggingState.rawConsole = { ...console, warn };
    try {
      const harness = createMonitorHarness();
      harness.stall(1_200, false);
      await harness.samples(3);
      expect(harness.monitor.snapshot()?.delayMaxMs).toBeGreaterThanOrEqual(1_200);
      expect(warn).toHaveBeenCalledOnce();
      expect(warn.mock.calls[0]?.[0]).toContain(
        'main-thread stall: elapsedMs=1200 task="scheduler:maintenance:synthetic-work" taskMs=1200',
      );
    } finally {
      loggingState.rawConsole = rawConsole;
      setLoggerOverride(null);
    }
  });

  it("exports a 250 ms scheduler stall once without exposing public events", async () => {
    setDiagnosticsEnabledForProcess(true);
    const internal = collectEvents("gateway.main_thread.stall");
    const publicEvents: DiagnosticEventPayload[] = [];
    subscriptions.push(onDiagnosticEvent((event) => publicEvents.push(event)));
    const harness = createMonitorHarness();
    harness.stall(250);
    await harness.samples(100);
    await waitForDiagnosticEventsDrained();
    expect(internal).toEqual([
      expect.objectContaining({
        type: "gateway.main_thread.stall",
        stalls: [{ task: "scheduler:maintenance:synthetic-work", durationMs: 250 }],
        dropped: 0,
      }),
    ]);
    expect(publicEvents).toEqual([]);
  });

  it.each([
    { cpuMsPerWallMs: 1, utilization: 1, delay: 20, reasons: [] },
    { cpuMsPerWallMs: 1, utilization: 0.2, delay: 30, reasons: ["cpu"] },
    { cpuMsPerWallMs: 0.1, utilization: 1, delay: 30, reasons: ["event_loop_utilization"] },
    { cpuMsPerWallMs: 1, utilization: 1, delay: 30, reasons: ["event_loop_utilization", "cpu"] },
  ])("classifies load with $delay ms delay: $reasons", async (params) => {
    const harness = createMonitorHarness(params);
    const count = Math.ceil(1_000 / params.delay);
    await harness.samples(count - 1, undefined, params.delay);
    expect(harness.monitor.snapshot()).toBeUndefined();
    await harness.sample(params.delay);
    harness.expectHealth({
      degraded: params.reasons.length > 0,
      degradedSinceMs: params.reasons.length ? 0 : null,
      intervalMs: count * params.delay,
      delayP99Ms: params.delay,
      delayMaxMs: params.delay,
      utilization: params.utilization,
      cpuCoreRatio: params.cpuMsPerWallMs,
      reasons: params.reasons,
    });
  });

  it("retains sub-second blocking co-evidence before the native timer catches up", async () => {
    const harness = createMonitorHarness({ cpuMsPerWallMs: 1, utilization: 1 });
    harness.stall(30, false);
    await harness.samples(50, { delayMaxMs: 30, reasons: ["event_loop_utilization", "cpu"] });
  });

  it("keeps overdue reads passive before the first sample under load", async () => {
    const harness = createMonitorHarness({ cpuMsPerWallMs: 1, utilization: 1 });
    harness.elapseWithoutSampling(1_200);
    for (let index = 0; index < 100; index++) {
      expect(harness.monitor.snapshot()).toBeUndefined();
      expect(harness.monitor.persistentDegradationSnapshot()).toBeUndefined();
    }
    expect(harness.cpuUsage).toHaveBeenCalledTimes(1);
    expect(harness.eventLoopUtilization).toHaveBeenCalledTimes(1);
    await harness.sample();
    const current = harness.monitor.snapshot();
    expect(current?.delayMaxMs).toBeGreaterThanOrEqual(1_200);
    expect(current?.delayMaxMs).toBeLessThanOrEqual(1_200.5);
    harness.expectHealth({
      degraded: true,
      intervalMs: 1_220,
      reasons: ["event_loop_delay", "event_loop_utilization", "cpu"],
    });
    expect(harness.monitor.snapshot()).toBe(current);
  });

  it("tracks persistent degradation at completed samples and clears on recovery", async () => {
    const harness = createMonitorHarness();
    await harness.sample(1_500);
    harness.expectHealth({ degraded: true, degradedSinceMs: 0 });
    await harness.sample(59_999);
    expect(harness.monitor.persistentDegradationSnapshot()).toBeUndefined();
    await harness.sample(1_000);
    expect(harness.monitor.persistentDegradationSnapshot()).toMatchObject({
      degraded: true,
      degradedSinceMs: 60_999,
    });
    const degraded = harness.monitor.snapshot();
    await harness.samples(49);
    expect(harness.monitor.snapshot()).toBe(degraded);
    expect(harness.monitor.persistentDegradationSnapshot()).toBe(degraded);
    await harness.sample();
    harness.expectHealth({ degraded: false, degradedSinceMs: null });
    expect(harness.monitor.persistentDegradationSnapshot()).toBeUndefined();
  });

  it("discards the pending interval and rate baselines only for an explicit host-thaw reset", async () => {
    const harness = createMonitorHarness();
    await harness.sample(1_500);
    harness.elapseWithoutSampling(90_000);
    harness.monitor.reset();
    expect(harness.monitor.snapshot()).toBeUndefined();
    await harness.samples(50, {
      degraded: false,
      intervalMs: 1_000,
      delayMaxMs: 20,
      cpuCoreRatio: 0.1,
    });
  });

  it("releases its only timer and cached observation when stopped", async () => {
    const harness = createMonitorHarness();
    expect(harness.clock.armedAtMs).not.toBeNull();
    await harness.samples(50);
    harness.monitor.stop();
    expect(harness.clock.armedAtMs).toBeNull();
    await harness.samples(100);
    harness.monitor.reset();
    expect(harness.monitor.snapshot()).toBeUndefined();
    expect(harness.clock.armedAtMs).toBeNull();
  });
});

describe("event-loop measurement telemetry", () => {
  it("advances an idle window when telemetry gains interest without resetting or replaying it", async () => {
    const harness = createMonitorHarness({ isIdle: () => true });
    await harness.samples(50);
    const first = harness.monitor.snapshot();
    expect(first).toMatchObject({ intervalMs: 1_000 });
    expect(harness.clock.armedAtMs).toBe(20_000);
    await harness.samples(25);

    const events: DiagnosticEventPayload[] = [];
    const subscribe = () =>
      onTrustedInternalDiagnosticEvent((event) => events.push(event), { exclude: ["log.record"] });
    const stop = subscribe();
    expect(harness.monitor.snapshot()).toBe(first);
    expect(harness.clock.armedAtMs).toBe(12_000);
    await waitForDiagnosticEventsDrained();
    expect(events).toEqual([]);

    await harness.samples(24);
    expect(harness.monitor.snapshot()).toBe(first);
    await harness.sample();
    await waitForDiagnosticEventsDrained();
    expect(events).toMatchObject([{ type: "gateway.event_loop.sample", intervalMs: 1_000 }]);
    expect(harness.clock.armedAtMs).toBe(13_000);

    stop();
    await harness.samples(50);
    expect(harness.clock.armedAtMs).toBe(20_000);
    expect(events).toHaveLength(1);
    harness.monitor.stop();
    expect(harness.clock.armedAtMs).toBeNull();
    const stopAfterClose = subscribe();
    expect(harness.clock.armedAtMs).toBeNull();
    stopAfterClose();
  });

  it("records each sampling window once without needing a reader or inheriting reader context", async () => {
    const harness = createMonitorHarness();
    const events = collectEvents("gateway.event_loop.sample");
    const readerTrace = createDiagnosticTraceContext();
    await runWithDiagnosticTraceContext(readerTrace, async () => {
      await harness.sample(1_500);
      const first = harness.monitor.snapshot();
      for (let index = 0; index < 10; index++) {
        expect(harness.monitor.snapshot()).toBe(first);
      }
      expect(getActiveDiagnosticTraceContext()?.traceId).toBe(readerTrace.traceId);
    });
    await harness.samples(50);
    await waitForDiagnosticEventsDrained();
    expect(events).toMatchObject([
      { type: "gateway.event_loop.sample", intervalMs: 1_500 },
      { type: "gateway.event_loop.sample", intervalMs: 1_000, delayMaxMs: 20 },
    ]);
    const first = events[0];
    if (first?.type !== "gateway.event_loop.sample") {
      throw new Error("expected first event-loop sample");
    }
    expect(first.delayMaxMs).toBeGreaterThanOrEqual(1_500);
    expect(first.delayMaxMs).toBeLessThanOrEqual(1_500.5);
    expect(events.map((event) => event.trace)).toEqual([undefined, undefined]);
  });

  it("keeps diagnostics-disabled sampling active without emitting telemetry", async () => {
    const listener = vi.fn();
    onInternalDiagnosticEvent(listener, { include: ["gateway.event_loop.sample"] });
    setDiagnosticsEnabledForProcess(false);
    const harness = createMonitorHarness();
    await harness.sample(1_500);
    expect(harness.monitor.snapshot()?.reasons).toEqual(["event_loop_delay"]);
    await waitForDiagnosticEventsDrained();
    expect(listener).not.toHaveBeenCalled();
    expect(getInternalDiagnosticEventSequence()).toBe(0);
  });

  it.each<{
    name: string;
    subscribe: () => () => void | Promise<void>;
  }>([
    { name: "no listener", subscribe: () => () => {} },
    {
      name: "stability recorder",
      subscribe: () => {
        startDiagnosticStabilityRecorder();
        return stopDiagnosticStabilityRecorder;
      },
    },
    { name: "skill tracking", subscribe: () => registerSkillUsageTracking() },
  ])("does not emit exporter windows with only $name", async ({ subscribe }) => {
    const unsubscribe = subscribe();
    try {
      const harness = createMonitorHarness();
      await harness.sample(1_500);
      expect(harness.monitor.snapshot()?.reasons).toEqual(["event_loop_delay"]);
      await waitForDiagnosticEventsDrained();
      expect(getInternalDiagnosticEventSequence()).toBe(0);
    } finally {
      await unsubscribe();
    }
  });
});
