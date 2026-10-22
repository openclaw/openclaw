import { channel } from "node:diagnostics_channel";
import { totalmem } from "node:os";
import { afterEach, expect, it, vi, type MockInstance } from "vitest";
import { recordCommandPoll } from "../agents/command-poll-backoff.js";
import { detectToolCallLoop, recordToolCall } from "../agents/tool-loop-detection.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/config.js";
import {
  onDiagnosticEvent,
  onInternalDiagnosticEvent,
  onTrustedInternalDiagnosticEvent,
  setDiagnosticsEnabledForProcess,
  waitForDiagnosticEventsDrained,
  type DiagnosticEventPayload,
} from "../infra/diagnostic-events.js";
import * as workerCpu from "../infra/worker-cpu.js";
import * as workerMessages from "../infra/worker-message-metrics.js";
import * as spawnDiagnostics from "../process/spawn-diagnostics.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import * as runActivity from "./diagnostic-run-activity.js";
import {
  getDiagnosticSessionState,
  isDiagnosticSessionStateCurrent,
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

function expectCalls(count: number, ...observers: MockInstance[]) {
  for (const observer of observers) {
    expect(observer).toHaveBeenCalledTimes(count);
  }
}

function heartbeatOptions() {
  return {
    emitMemorySample: vi.fn(),
    sampleLiveness: vi.fn(() => null),
    getConfig: vi.fn(() => ({})),
    recoverStuckSession: vi.fn(),
  };
}

const cleanups: Array<() => void | Promise<void>> = [];
function heartbeatFixture(internal = false, startedAt = Date.now()) {
  const clock = createGatewaySchedulerClock(startedAt);
  const scheduler = createTestGatewayScheduler(clock.clock);
  const events: DiagnosticEventPayload[] = [];
  cleanups.push(
    (internal ? onInternalDiagnosticEvent : onDiagnosticEvent)((event) => events.push(event)),
    () => scheduler.stop(),
  );
  return { clock, scheduler, events };
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup();
  }
  clearRuntimeConfigSnapshot();
  resetDiagnosticStateForTest();
  setDiagnosticsEnabledForProcess(true);
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("coalesces diagnostic heartbeats after sleep", async () => {
  const startedAt = Date.now();
  const { clock, scheduler, events } = heartbeatFixture(false, startedAt);
  const heartbeats = () => events.filter((event) => event.type === "diagnostic.heartbeat");
  scheduler.schedule({ id: "pending-work", atMs: startedAt + 60_000, run: () => {} });
  startGatewayDiagnosticHeartbeat(scheduler, {}, { sampleLiveness: () => null });
  logMessageQueued({ sessionKey: "diagnostic-schedule", source: "test" });
  await clock.advanceBy(30_000);
  await clock.advanceBy(120_000);
  await waitForDiagnosticEventsDrained();
  expect(heartbeats()).toHaveLength(2);
  stopGatewayDiagnosticHeartbeat();
  await clock.advanceBy(120_000);
  await waitForDiagnosticEventsDrained();
  expect(heartbeats()).toHaveLength(2);
});

// Mirrors the private per-field budget in diagnostic-content.ts.
const MAX_DIAGNOSTIC_CONTENT_CHARS = 128 * 1024;

it("bounds captured content and preserves ingesting-agent attribution on dispatch", () => {
  setRuntimeConfigSnapshot({ diagnostics: { otel: { enabled: true, captureContent: true } } });
  const oversizedContent = `${"x".repeat(MAX_DIAGNOSTIC_CONTENT_CHARS - 1)}🚀tail`;
  const captured: Array<{ userPrompt?: string; finalResponse?: string }> = [];
  const agents: Array<string | undefined> = [];
  cleanups.push(
    onDiagnosticEvent((event) => {
      if (event.type === "message.processed") {
        agents.push(event.agentId);
      }
    }),
    onTrustedInternalDiagnosticEvent((event, _metadata, privateData) => {
      if (event.type === "message.processed" && privateData.messageContent) {
        captured.push(privateData.messageContent);
      }
    }),
  );
  const lifecycle = createDiagnosticMessageLifecycle({
    enabled: true,
    channel: "test",
    source: "test",
    trackSessionState: false,
    sessionKey: "agent:main:lifecycle",
    agentId: "main",
    userPrompt: oversizedContent,
  });
  lifecycle.markProcessed("completed", { finalResponse: oversizedContent });

  expect(captured).toHaveLength(1);
  expect(agents).toEqual(["main"]);
  for (const value of [captured[0]?.userPrompt, captured[0]?.finalResponse]) {
    expect(value?.length).toBeLessThanOrEqual(MAX_DIAGNOSTIC_CONTENT_CHARS);
    expect(value?.charCodeAt((value?.length ?? 0) - 1)).not.toBe(0xd83d);
  }
});

it("preserves independent tool-loop and poll-backoff policy when diagnostic observation stops", () => {
  const session = { sessionKey: "diagnostic-tool-history" };
  const state = getDiagnosticSessionState(session);
  const args = { path: "fixture.txt" };
  for (let index = 0; index < 10; index += 1) {
    recordToolCall(state, "read", args);
  }
  const before = detectToolCallLoop(state, "read", args);
  expect(before).toMatchObject({ stuck: true, detector: "generic_repeat", count: 10 });
  expect(recordCommandPoll(state, "fixture-command", false)).toBe(5_000);
  expect(recordCommandPoll(state, "fixture-command", false)).toBe(10_000);
  setDiagnosticsEnabledForProcess(false);
  stopGatewayDiagnosticHeartbeat();
  const current = getDiagnosticSessionState(session);
  expect(detectToolCallLoop(current, "read", args)).toEqual(before);
  expect(recordCommandPoll(current, "fixture-command", false)).toBe(30_000);
});

it("keeps pressure sampling silent and reconciles diagnostic options on one cadence", async () => {
  const { clock, scheduler, events } = heartbeatFixture(true);
  const pressure = channel("openclaw.memory.critical");
  const critical = vi.fn();
  const workerSamples = vi.spyOn(workerCpu, "sampleTrackedWorkerMemory");
  const workerMessageSamples = vi.spyOn(workerMessages, "getWorkerMessageMetrics");
  const childSamples = vi.spyOn(spawnDiagnostics, "emitChildProcessSpawnSample");
  const trackActivity = vi.spyOn(runActivity, "startDiagnosticRunActivityTracking");
  const recordStability = vi.spyOn(stability, "startDiagnosticStabilityRecorder");
  const fatalHook = vi.spyOn(stabilityBundle, "installDiagnosticStabilityFatalHook");
  const warn = vi.spyOn(diagnosticLogger, "warn");
  const readMemoryUsage = process.memoryUsage;
  const criticalRss = totalmem();
  Object.assign(
    vi.spyOn(process, "memoryUsage").mockImplementation(() => ({
      ...readMemoryUsage(),
      rss: criticalRss,
    })),
    { rss: () => criticalRss },
  );
  const first = heartbeatOptions();
  const latest = heartbeatOptions();
  const passive = [workerSamples, workerMessageSamples];
  pressure.subscribe(critical);
  cleanups.unshift(() => pressure.unsubscribe(critical));
  setDiagnosticsEnabledForProcess(false);
  startGatewayDiagnosticHeartbeat(scheduler, undefined, first);
  await clock.advanceBy(30_000);
  expect(critical).toHaveBeenCalledTimes(1);
  expect(events).toEqual([]);
  expectCalls(
    0,
    ...Object.values(first),
    ...passive,
    childSamples,
    trackActivity,
    recordStability,
    fatalHook,
    warn,
  );

  setDiagnosticsEnabledForProcess(true);
  startGatewayDiagnosticHeartbeat(scheduler, undefined, first);
  await clock.advanceBy(30_000);
  expect(first.emitMemorySample).toHaveBeenCalledTimes(1);
  await clock.advanceBy(15_000);
  startGatewayDiagnosticHeartbeat(scheduler, undefined, latest);
  await clock.advanceBy(15_000);
  expectCalls(
    1,
    first.emitMemorySample,
    latest.emitMemorySample,
    latest.sampleLiveness,
    latest.getConfig,
  );
  expect(childSamples).toHaveBeenCalledTimes(2);

  setDiagnosticsEnabledForProcess(false);
  startGatewayDiagnosticHeartbeat(scheduler, undefined, latest);
  await waitForDiagnosticEventsDrained();
  const observed = events.length;
  await clock.advanceBy(5 * 60_000);
  await waitForDiagnosticEventsDrained();
  expect(critical).toHaveBeenCalledTimes(2);
  expect(events).toHaveLength(observed);
  expectCalls(0, ...passive, latest.recoverStuckSession);
  expectCalls(1, latest.emitMemorySample, latest.sampleLiveness, latest.getConfig);
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
  expectCalls(0, ...passive, warn);
  expect(childSamples).toHaveBeenCalledTimes(3);

  scheduler.beginClose();
  await scheduler.stop();
  startGatewayDiagnosticHeartbeat(scheduler, undefined, latest);
  await clock.advanceBy(30_000);
  expect(critical).toHaveBeenCalledTimes(3);
  expect(latest.emitMemorySample).toHaveBeenCalledTimes(2);
});

it("retires interrupted diagnostic observations before re-enable without reviving their authority", async () => {
  const { clock, scheduler, events } = heartbeatFixture();
  setDiagnosticsEnabledForProcess(true);
  const session = { sessionKey: "diagnostic-lifecycle", sessionId: "diagnostic-lifecycle" };
  startGatewayDiagnosticHeartbeat(scheduler, {}, { sampleLiveness: () => null });
  logMessageQueued({ ...session, source: "test" });
  logSessionStateChange({ ...session, state: "processing" });
  const generation = getDiagnosticSessionState(session).generation;
  expect(generation).toBeTypeOf("number");
  expect(isDiagnosticSessionStateCurrent({ ...session, generation, state: "processing" })).toBe(
    true,
  );
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
});
