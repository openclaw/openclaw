import { channel } from "node:diagnostics_channel";
import { afterEach, expect, it, vi } from "vitest";
import { recordCommandPoll } from "../agents/command-poll-backoff.js";
import { detectToolCallLoop, recordToolCall } from "../agents/tool-loop-detection.js";
import {
  onDiagnosticEvent,
  onInternalDiagnosticEvent,
  setDiagnosticsEnabledForProcess,
  waitForDiagnosticEventsDrained,
  type DiagnosticEventPayload,
  type DiagnosticMessageProcessedEvent,
} from "../infra/diagnostic-events.js";
import * as workerCpu from "../infra/worker-cpu.js";
import * as spawnDiagnostics from "../process/spawn-diagnostics.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import * as runActivity from "./diagnostic-run-activity.js";
import {
  getDiagnosticSessionState,
  isDiagnosticSessionStateCurrent,
  peekDiagnosticSessionState,
} from "./diagnostic-session-state.js";
import * as stabilityBundle from "./diagnostic-stability-bundle.js";
import * as stability from "./diagnostic-stability.js";
import {
  diagnosticLogger,
  logMessageQueued,
  logSessionStateChange,
  logWebhookReceived,
  startGatewayDiagnosticHeartbeat,
  stopGatewayDiagnosticHeartbeat,
} from "./diagnostic.js";
import { resetDiagnosticStateForTest } from "./diagnostic.test-support.js";
import { createDiagnosticMessageLifecycle } from "./message-lifecycle.js";

afterEach(() => {
  resetDiagnosticStateForTest();
  setDiagnosticsEnabledForProcess(true);
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("reports the shared next wake and coalesces diagnostic heartbeats after sleep", async () => {
  const startedAt = Date.now();
  const clock = createGatewaySchedulerClock(startedAt);
  const scheduler = createTestGatewayScheduler(clock.clock);
  const debug = vi.spyOn(diagnosticLogger, "debug");
  const heartbeats: DiagnosticEventPayload[] = [];
  const unsubscribe = onDiagnosticEvent((event) => {
    if (event.type === "diagnostic.heartbeat") {
      heartbeats.push(event);
    }
  });
  try {
    scheduler.schedule({ id: "pending-work", atMs: startedAt + 60_000, run: () => {} });
    startGatewayDiagnosticHeartbeat(scheduler, {}, { sampleLiveness: () => null });
    logMessageQueued({ sessionKey: "diagnostic-schedule", source: "test" });
    await clock.advanceBy(30_000);
    expect(debug).toHaveBeenCalledWith(
      expect.stringContaining(`nextWakeAtMs=${startedAt + 60_000}`),
    );
    await clock.advanceBy(120_000);
    await waitForDiagnosticEventsDrained();
    expect(heartbeats).toHaveLength(2);
    stopGatewayDiagnosticHeartbeat();
    await clock.advanceBy(120_000);
    await waitForDiagnosticEventsDrained();
    expect(heartbeats).toHaveLength(2);
  } finally {
    unsubscribe();
    await scheduler.stop();
  }
});

it("preserves independent tool-loop and poll-backoff policy when diagnostic observation stops", () => {
  const session = { sessionKey: "diagnostic-tool-history" };
  const state = getDiagnosticSessionState(session);
  const args = { path: "fixture.txt" };
  for (let index = 0; index < 10; index += 1) {
    recordToolCall(state, "read", args);
  }
  const before = detectToolCallLoop(state, "read", args, { enabled: true });
  expect(before).toMatchObject({ stuck: true, detector: "generic_repeat", count: 10 });
  expect(recordCommandPoll(state, "fixture-command", false)).toBe(5_000);
  expect(recordCommandPoll(state, "fixture-command", false)).toBe(10_000);
  setDiagnosticsEnabledForProcess(false);
  stopGatewayDiagnosticHeartbeat();
  const current = getDiagnosticSessionState(session);
  expect(detectToolCallLoop(current, "read", args, { enabled: true })).toEqual(before);
  expect(recordCommandPoll(current, "fixture-command", false)).toBe(30_000);
});

it("keeps pressure sampling silent and reconciles diagnostic options on one cadence", async () => {
  const clock = createGatewaySchedulerClock(Date.now());
  const scheduler = createTestGatewayScheduler(clock.clock);
  const pressure = channel("openclaw.memory.critical");
  const critical = vi.fn();
  const events: DiagnosticEventPayload[] = [];
  const unsubscribe = onInternalDiagnosticEvent((event) => events.push(event));
  const workerSamples = vi.spyOn(workerCpu, "sampleTrackedWorkerMemory");
  const childSamples = vi.spyOn(spawnDiagnostics, "emitChildProcessSpawnSample");
  const trackActivity = vi.spyOn(runActivity, "startDiagnosticRunActivityTracking");
  const recordStability = vi.spyOn(stability, "startDiagnosticStabilityRecorder");
  const fatalHook = vi.spyOn(stabilityBundle, "installDiagnosticStabilityFatalHook");
  const warn = vi.spyOn(diagnosticLogger, "warn");
  const readMemoryUsage = process.memoryUsage;
  Object.assign(
    vi.spyOn(process, "memoryUsage").mockImplementation(() => ({
      ...readMemoryUsage(),
      rss: 64 * 1024 ** 3,
    })),
    { rss: () => readMemoryUsage.rss() },
  );
  const first = {
    emitMemorySample: vi.fn(),
    sampleLiveness: vi.fn(() => null),
    getConfig: vi.fn(() => ({})),
    recoverStuckSession: vi.fn(),
  };
  const latest = {
    emitMemorySample: vi.fn(),
    sampleLiveness: vi.fn(() => null),
    getConfig: vi.fn(() => ({})),
    recoverStuckSession: vi.fn(),
  };
  pressure.subscribe(critical);
  try {
    setDiagnosticsEnabledForProcess(false);
    startGatewayDiagnosticHeartbeat(scheduler, undefined, first);
    await clock.advanceBy(30_000);
    expect(critical).toHaveBeenCalledTimes(1);
    expect(events).toEqual([]);
    for (const observer of [
      ...Object.values(first),
      workerSamples,
      childSamples,
      trackActivity,
      recordStability,
      fatalHook,
      warn,
    ]) {
      expect(observer).not.toHaveBeenCalled();
    }

    setDiagnosticsEnabledForProcess(true);
    startGatewayDiagnosticHeartbeat(scheduler, undefined, first);
    await clock.advanceBy(30_000);
    expect(first.emitMemorySample).toHaveBeenCalledTimes(1);
    await clock.advanceBy(15_000);
    startGatewayDiagnosticHeartbeat(scheduler, undefined, latest);
    await clock.advanceBy(15_000);
    expect(first.emitMemorySample).toHaveBeenCalledTimes(1);
    expect(latest.emitMemorySample).toHaveBeenCalledTimes(1);
    expect(latest.sampleLiveness).toHaveBeenCalledTimes(1);
    expect(latest.getConfig).toHaveBeenCalledTimes(1);
    expect(childSamples).toHaveBeenCalledTimes(2);

    setDiagnosticsEnabledForProcess(false);
    startGatewayDiagnosticHeartbeat(scheduler, undefined, latest);
    await waitForDiagnosticEventsDrained();
    const observed = events.length;
    await clock.advanceBy(5 * 60_000);
    await waitForDiagnosticEventsDrained();
    expect(critical).toHaveBeenCalledTimes(2);
    expect(events).toHaveLength(observed);
    expect(workerSamples).not.toHaveBeenCalled();
    expect(latest.emitMemorySample).toHaveBeenCalledTimes(1);
    expect(latest.sampleLiveness).toHaveBeenCalledTimes(1);
    expect(latest.getConfig).toHaveBeenCalledTimes(1);
    expect(latest.recoverStuckSession).not.toHaveBeenCalled();
    expect(childSamples).toHaveBeenCalledTimes(2);

    setDiagnosticsEnabledForProcess(true);
    startGatewayDiagnosticHeartbeat(scheduler, undefined, latest);
    await clock.advanceBy(30_000);
    expect(latest.emitMemorySample).toHaveBeenCalledTimes(2);
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("heartbeat delayed"));
    // Explicit heartbeat config is also authoritative; recovery config is a separate lookup.
    startGatewayDiagnosticHeartbeat(scheduler, { diagnostics: { enabled: false } }, latest);
    await clock.advanceBy(30_000);
    expect(critical).toHaveBeenCalledTimes(3);
    expect(latest.emitMemorySample).toHaveBeenCalledTimes(2);
    expect(workerSamples).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(childSamples).toHaveBeenCalledTimes(3);

    scheduler.beginClose();
    await scheduler.stop();
    startGatewayDiagnosticHeartbeat(scheduler, undefined, latest);
    await clock.advanceBy(30_000);
    expect(critical).toHaveBeenCalledTimes(3);
    expect(latest.emitMemorySample).toHaveBeenCalledTimes(2);
  } finally {
    pressure.unsubscribe(critical);
    unsubscribe();
    await scheduler.stop();
  }
});

it("retires interrupted diagnostic observations before re-enable without reviving their authority", async () => {
  const clock = createGatewaySchedulerClock(Date.now());
  const scheduler = createTestGatewayScheduler(clock.clock);
  setDiagnosticsEnabledForProcess(true);
  const events: DiagnosticEventPayload[] = [];
  const unsubscribe = onDiagnosticEvent((event) => events.push(event));
  const session = { sessionKey: "diagnostic-lifecycle", sessionId: "diagnostic-lifecycle" };
  try {
    startGatewayDiagnosticHeartbeat(scheduler, {}, { sampleLiveness: () => null });
    logMessageQueued({ ...session, source: "test" });
    logSessionStateChange({ ...session, state: "processing" });
    const generation = peekDiagnosticSessionState(session)?.generation;
    expect(generation).toBeTypeOf("number");
    setDiagnosticsEnabledForProcess(false);
    startGatewayDiagnosticHeartbeat(scheduler, {}, { sampleLiveness: () => null });
    logSessionStateChange({ ...session, state: "idle" });
    setDiagnosticsEnabledForProcess(true);
    startGatewayDiagnosticHeartbeat(scheduler, {}, { sampleLiveness: () => null });
    logWebhookReceived({ channel: "test" });
    await clock.advanceBy(30_000);
    await waitForDiagnosticEventsDrained();
    expect(events.findLast((event) => event.type === "diagnostic.heartbeat")).toMatchObject({
      active: 0,
      queued: 0,
      waiting: 0,
    });
    logMessageQueued({ ...session, source: "test" });
    logSessionStateChange({ ...session, state: "processing" });
    expect(isDiagnosticSessionStateCurrent({ ...session, generation, state: "processing" })).toBe(
      false,
    );
  } finally {
    unsubscribe();
    await scheduler.stop();
  }
});

it("attributes message.processed to the ingesting agent recorded at the lifecycle owner", () => {
  const processed: DiagnosticMessageProcessedEvent[] = [];
  const unsubscribe = onDiagnosticEvent((event) => {
    if (event.type === "message.processed") {
      processed.push(event);
    }
  });
  try {
    const lifecycle = createDiagnosticMessageLifecycle({
      enabled: true,
      channel: "test",
      source: "test",
      sessionKey: "agent:main:lifecycle",
      trackSessionState: false,
      agentId: "main",
    });
    lifecycle.markProcessed("completed");
  } finally {
    unsubscribe();
  }

  expect(processed).toHaveLength(1);
  expect(processed[0]?.agentId).toBe("main");
});
