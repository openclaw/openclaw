import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { renderRateLimitRetryExhaustion } from "../agents/failover/user-copy.js";
import {
  onDiagnosticEvent,
  resetDiagnosticEventsForTest,
  waitForDiagnosticEventsDrained,
  type DiagnosticEventPayload,
} from "../infra/diagnostic-events.js";
import { DEFAULT_UNDICI_STREAM_TIMEOUT_MS } from "../infra/net/undici-global-dispatcher.js";
import { withSessionTurn } from "../sessions/session-controller.admission.js";
import { createReplyOperation } from "../sessions/session-controller.operation.js";
import { testing } from "../sessions/session-controller.test-support.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import {
  beginDiagnosticRetryWait,
  createDiagnosticEmbeddedRunOwner,
  markDiagnosticEmbeddedRunStarted,
} from "./diagnostic-run-activity.js";
import { requestStuckSessionRecovery } from "./diagnostic-session-recovery-coordinator.js";
import { recoverStuckDiagnosticSession } from "./diagnostic-stuck-session-recovery.runtime.js";
import { logSessionStateChange, startGatewayDiagnosticHeartbeat } from "./diagnostic.js";
import { resetDiagnosticStateForTest } from "./diagnostic.test-support.js";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(6_000);
  resetDiagnosticStateForTest();
  resetDiagnosticEventsForTest();
});

afterEach(() => {
  testing.resetSessionControllerForTest();
  resetDiagnosticStateForTest();
  resetDiagnosticEventsForTest();
  vi.useRealTimers();
});

it("reports a 54-second stall without requesting recovery from an observing controller", async () => {
  const ref = {
    sessionKey: "agent:main:provider-deadline-heartbeat",
    sessionId: "deadline-session",
    runId: "deadline-run",
  };
  const operation = createReplyOperation({ ...ref, resetTriggered: false });
  operation.setPhase("running");
  const cancel = vi.fn(() => operation.complete());
  operation.attachBackend({ kind: "embedded", runId: ref.runId, cancel });
  const attempt = operation.watchdog.attachAttempt({ assertCurrent() {} });
  const owner = createDiagnosticEmbeddedRunOwner({ ...ref, watchdogAttempt: attempt });
  markDiagnosticEmbeddedRunStarted({ ...ref, owner });
  logSessionStateChange({ ...ref, state: "processing" });
  const events: DiagnosticEventPayload[] = [];
  onDiagnosticEvent((event) => events.push(event));
  const recover = vi.fn(recoverStuckDiagnosticSession);
  vi.setSystemTime(30_000);
  const clock = createGatewaySchedulerClock(30_000);
  startGatewayDiagnosticHeartbeat(
    createTestGatewayScheduler(clock.clock),
    { diagnostics: { enabled: true } },
    {
      testTimings: { stuckSessionWarnMs: 15_000, stuckSessionAbortMs: 30_000 },
      recoverStuckSession: recover,
      sampleLiveness: () => null,
    },
  );
  vi.setSystemTime(45_000);
  attempt.beginRequest({ requestTimeoutMs: 45_000, deadlineAtMs: 90_000 });
  vi.setSystemTime(60_000);
  expect(operation.watchdog.snapshot().semanticProgressAtMs).toBe(6_000);
  expect(operation.watchdog.decide().action).toBe("observe");
  await clock.advanceTo(60_000);
  await vi.advanceTimersByTimeAsync(0);
  await waitForDiagnosticEventsDrained();
  expect(events).toContainEqual(
    expect.objectContaining({ type: "session.stalled", ageMs: 54_000 }),
  );
  expect(events.filter((event) => event.type.startsWith("session.recovery."))).toEqual([]);
  expect(recover).not.toHaveBeenCalled();
  expect(cancel).not.toHaveBeenCalled();
  expect(operation.result).toBeNull();
});

it.each([
  { kind: "request", deadlineAtMs: 396_000, rateLimited: false },
  { kind: "retry", deadlineAtMs: 396_000, rateLimited: false },
  { kind: "retry", deadlineAtMs: 396_000, rateLimited: true },
  { kind: "backend", deadlineAtMs: 366_000, rateLimited: false },
  { kind: "tool", deadlineAtMs: 1_296_000, rateLimited: false },
] as const)(
  "uses the controller-owned $kind allowance through its exact boundary (rate-limited: $rateLimited)",
  async ({ kind, deadlineAtMs, rateLimited }) => {
    const ref = {
      sessionKey: "agent:main:heartbeat-allowance",
      sessionId: "allowance-session",
      runId: "allowance-run",
    };
    const operation = createReplyOperation({ ...ref, resetTriggered: false });
    operation.setPhase("running");
    const cancel = vi.fn(() => operation.complete());
    operation.attachBackend({ kind: "embedded", runId: ref.runId, cancel });
    const attempt = operation.watchdog.attachAttempt({ assertCurrent() {} });
    const owner = createDiagnosticEmbeddedRunOwner({ ...ref, watchdogAttempt: attempt });
    markDiagnosticEmbeddedRunStarted({ ...ref, owner });
    logSessionStateChange({ ...ref, state: "processing" });
    const events: DiagnosticEventPayload[] = [];
    onDiagnosticEvent((event) => events.push(event));
    const recover = vi.fn(recoverStuckDiagnosticSession);
    vi.setSystemTime(306_000);
    const clock = createGatewaySchedulerClock(306_000);
    startGatewayDiagnosticHeartbeat(
      createTestGatewayScheduler(clock.clock),
      { diagnostics: { enabled: true } },
      {
        testTimings: { stuckSessionWarnMs: 15_000, stuckSessionAbortMs: 30_000 },
        recoverStuckSession: recover,
        sampleLiveness: () => null,
      },
    );
    vi.setSystemTime(330_000);
    if (kind === "request") {
      attempt.beginRequest({ requestTimeoutMs: 66_000, deadlineAtMs });
    } else if (kind === "tool") {
      // Explicit execution plus the existing 15-minute quiet-tool grace.
      attempt.beginTool({ toolName: "exec", toolCallId: "owned-command", deadlineAtMs: 396_000 });
    } else if (rateLimited) {
      beginDiagnosticRetryWait({
        owner,
        deadlineAtMs,
        rateLimitStopMessage: renderRateLimitRetryExhaustion(9),
        signal: operation.abortSignal,
        assertCurrent() {},
      });
    } else {
      // Backend traffic cannot rearm the six-minute semantic horizon.
      attempt.beginWait({
        kind,
        deadlineAtMs: kind === "backend" ? 600_000 : deadlineAtMs,
        isCurrent: () => true,
      });
    }
    for (let now = 336_000; now <= deadlineAtMs; now += 30_000) {
      vi.setSystemTime(now);
      await clock.advanceTo(now);
      await vi.advanceTimersByTimeAsync(0);
      await waitForDiagnosticEventsDrained();
      if (now < deadlineAtMs) {
        expect(recover).not.toHaveBeenCalled();
        expect(cancel).not.toHaveBeenCalled();
        expect(operation.result).toBeNull();
      }
    }
    expect(recover).toHaveBeenCalledOnce();
    await recover.mock.results[0]?.value;
    await waitForDiagnosticEventsDrained();
    expect(cancel).toHaveBeenCalledOnce();
    expect(operation.result).toMatchObject({ kind: "failed", code: "run_stalled" });
    if (rateLimited) {
      expect(operation.staleExpiryReason).toBe("rate_limited");
      expect(operation.abortSignal.reason).toMatchObject({
        name: "AbortError",
        code: "OPENCLAW_SESSION_WATCHDOG",
        message: renderRateLimitRetryExhaustion(9),
      });
    }
    expect(events.filter((event) => event.type === "session.recovery.requested")).toEqual([
      expect.objectContaining({ allowActiveAbort: true, reason: "semantic_stall" }),
    ]);
    expect(events.filter((event) => event.type === "session.recovery.completed")).toEqual([
      expect.objectContaining({ status: "aborted", action: "abort_embedded_run" }),
    ]);
  },
);

it.each(["missing", "retired"] as const)(
  "does not adopt a replacement after capturing a %s owner",
  (kind) => {
    const ref = {
      sessionKey: "agent:main:heartbeat-replacement",
      sessionId: "replacement-session",
    };
    const original =
      kind === "retired" ? createReplyOperation({ ...ref, resetTriggered: false }) : undefined;
    original?.complete();
    const replacement = createReplyOperation({ ...ref, resetTriggered: false });
    replacement.setPhase("running");
    vi.setSystemTime(1_000_000);
    const recover = vi.fn(recoverStuckDiagnosticSession);
    requestStuckSessionRecovery({
      classification: {
        eventType: "session.stalled",
        classification: "stalled_agent_run",
        reason: "active_work_without_progress",
      },
      request: { ...ref, operation: original, ageMs: 1_000_000 },
      recover,
    });
    expect(recover).not.toHaveBeenCalled();
    expect(replacement.result).toBeNull();
  },
);

it("retains the finite local request ceiling without a diagnostic timeout policy", async () => {
  const ref = {
    sessionKey: "agent:main:heartbeat-local-ceiling",
    sessionId: "local-ceiling-session",
  };
  const operation = createReplyOperation({ ...ref, resetTriggered: false });
  operation.setPhase("running");
  const cancel = vi.fn(() => operation.complete());
  operation.attachBackend({ kind: "embedded", cancel });
  const attempt = operation.watchdog.attachAttempt({ assertCurrent() {} });
  const deadlineAtMs = 6_000 + DEFAULT_UNDICI_STREAM_TIMEOUT_MS;
  attempt.beginRequest({ requestTimeoutMs: DEFAULT_UNDICI_STREAM_TIMEOUT_MS, deadlineAtMs });
  const recover = vi.fn(recoverStuckDiagnosticSession);
  const request = { ...ref, operation, ageMs: 1_000_000 };
  const classification = {
    eventType: "session.stalled",
    classification: "stalled_agent_run",
    reason: "active_work_without_progress",
  } as const;
  vi.setSystemTime(deadlineAtMs - 1);
  requestStuckSessionRecovery({ classification, request, recover });
  expect(recover).not.toHaveBeenCalled();
  vi.setSystemTime(deadlineAtMs);
  requestStuckSessionRecovery({ classification, request, recover });
  await vi.advanceTimersByTimeAsync(0);
  expect(recover).toHaveBeenCalledOnce();
  await recover.mock.results[0]?.value;
  await waitForDiagnosticEventsDrained();
  expect(cancel).toHaveBeenCalledOnce();
  expect(operation.result).toMatchObject({ kind: "failed", code: "run_stalled" });
});

it("defers an overdue heartbeat even when the captured controller is eligible", async () => {
  const ref = { sessionKey: "agent:main:overdue-recovery", sessionId: "overdue-session" };
  const operation = createReplyOperation({ ...ref, resetTriggered: false });
  operation.setPhase("running");
  const cancel = vi.fn(() => operation.complete());
  operation.attachBackend({ kind: "embedded", cancel });
  logSessionStateChange({ ...ref, state: "processing" });
  const recover = vi.fn(recoverStuckDiagnosticSession);
  vi.setSystemTime(306_000);
  const clock = createGatewaySchedulerClock(306_000);
  startGatewayDiagnosticHeartbeat(
    createTestGatewayScheduler(clock.clock),
    { diagnostics: { enabled: true } },
    { recoverStuckSession: recover, sampleLiveness: () => null },
  );
  vi.setSystemTime(371_000);
  expect(operation.watchdog.decide().action).toBe("stop");
  await clock.advanceTo(371_000);
  await vi.advanceTimersByTimeAsync(0);
  expect(recover).not.toHaveBeenCalled();
  expect(cancel).not.toHaveBeenCalled();
  vi.setSystemTime(401_000);
  await clock.advanceTo(401_000);
  await vi.advanceTimersByTimeAsync(0);
  expect(recover).toHaveBeenCalledOnce();
  await recover.mock.results[0]?.value;
  await waitForDiagnosticEventsDrained();
  expect(cancel).toHaveBeenCalledOnce();
});

it("projects cleanup eligibility without releasing queued work before its writer settles", async () => {
  const ref = { sessionKey: "agent:main:cleanup-recovery", sessionId: "cleanup-session" };
  const operation = createReplyOperation({ ...ref, resetTriggered: false });
  operation.setPhase("running");
  const cancel = vi.fn();
  operation.attachBackend({ kind: "embedded", cancel });
  const writer = createDeferredCore();
  operation.registerExecutionCleanup(() => writer.promise);
  operation.freezeAbort();
  const dispatch = vi.fn();
  const queued = withSessionTurn(ref, async () => {
    dispatch();
  });
  const recover = vi.fn(recoverStuckDiagnosticSession);
  const events: DiagnosticEventPayload[] = [];
  onDiagnosticEvent((event) => events.push(event));
  const classification = {
    eventType: "session.stalled",
    classification: "stalled_agent_run",
    reason: "active_work_without_progress",
  } as const;
  const request = { ...ref, operation, ageMs: 60_000 };
  vi.setSystemTime(65_999);
  requestStuckSessionRecovery({ request, classification, recover });
  expect(recover).not.toHaveBeenCalled();
  vi.setSystemTime(66_000);
  requestStuckSessionRecovery({ request, classification, recover });
  await vi.advanceTimersByTimeAsync(0);
  await waitForDiagnosticEventsDrained();
  expect(recover).toHaveBeenCalledOnce();
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "session.recovery.requested",
      allowActiveAbort: false,
      reason: "finalization_stalled",
    }),
  );
  expect(dispatch).not.toHaveBeenCalled();
  expect(operation.result?.kind).not.toBe("failed");
  writer.resolve();
  await recover.mock.results[0]?.value;
  operation.complete();
  await operation.ownerSettlement;
  await queued;
  expect(dispatch).toHaveBeenCalledOnce();
});
