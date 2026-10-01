import { afterEach, expect, it, vi } from "vitest";
import { recordCommandPoll } from "../agents/command-poll-backoff.js";
import { detectToolCallLoop, recordToolCall } from "../agents/tool-loop-detection.js";
import {
  onDiagnosticEvent,
  setDiagnosticsEnabledForProcess,
  waitForDiagnosticEventsDrained,
  type DiagnosticEventPayload,
  type DiagnosticMessageProcessedEvent,
} from "../infra/diagnostic-events.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import {
  getDiagnosticSessionState,
  isDiagnosticSessionStateCurrent,
  peekDiagnosticSessionState,
} from "./diagnostic-session-state.js";
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
    stopGatewayDiagnosticHeartbeat();
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
