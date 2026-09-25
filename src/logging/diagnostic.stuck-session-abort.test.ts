// Diagnostic logger tests cover event emission, metrics, and support output.
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetDiagnosticEventsForTest } from "../infra/diagnostic-events.js";
import {
  markDiagnosticArgumentChurnObservation,
  markDiagnosticEmbeddedRunStarted,
  markDiagnosticRunProgress,
} from "./diagnostic-run-activity.js";
import {
  logMessageQueued,
  logSessionStateChange,
  startDiagnosticHeartbeat as startDiagnosticHeartbeatImpl,
} from "./diagnostic.js";
import { resetDiagnosticStateForTest } from "./diagnostic.test-support.js";

function startDiagnosticHeartbeat(
  config?: Parameters<typeof startDiagnosticHeartbeatImpl>[0],
  opts?: Parameters<typeof startDiagnosticHeartbeatImpl>[1],
) {
  return startDiagnosticHeartbeatImpl(config, {
    testTimings: { stuckSessionWarnMs: 30_000, stuckSessionAbortMs: 60_000 },
    ...opts,
  });
}

function startEnabledDiagnosticHeartbeat(
  opts?: Parameters<typeof startDiagnosticHeartbeatImpl>[1],
) {
  return startDiagnosticHeartbeat({ diagnostics: { enabled: true } }, opts);
}

const requireRecord = createRequireRecord("object", "label-not-object");

function expectRecordFields(record: Record<string, unknown>, fields: Record<string, unknown>) {
  for (const [key, value] of Object.entries(fields)) {
    expect(record[key]).toEqual(value);
  }
}

function expectNumberField(record: Record<string, unknown>, key: string) {
  expect(typeof record[key]).toBe("number");
}

function requireFirstMockCallArg(mock: unknown, label: string) {
  const calls = (mock as { mock?: { calls?: unknown[][] } }).mock?.calls;
  const call = calls?.[0];
  if (!call) {
    throw new Error(`missing ${label} call`);
  }
  return requireRecord(call[0], `${label} argument`);
}

function expectRecoveryCall(
  recoverStuckSession: unknown,
  fields: Record<string, unknown>,
  numberFields: readonly string[],
) {
  const params = requireFirstMockCallArg(recoverStuckSession, "recoverStuckSession");
  expectRecordFields(params, fields);
  for (const key of numberFields) {
    expectNumberField(params, key);
  }
}

describe("stuck session diagnostics churn abort", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetDiagnosticStateForTest();
    resetDiagnosticEventsForTest();
  });

  afterEach(() => {
    resetDiagnosticEventsForTest();
    resetDiagnosticStateForTest();
    vi.useRealTimers();
  });

  it("aborts continuous argument churn without requiring queued follow-up work", () => {
    const recoverStuckSession = vi.fn();
    const stuckSessionAbortMs = 5 * 60_000;
    const sessionId = "argument-churn-zero-queue";
    const sessionKey = "main";
    const runId = "argument-churn-run";

    startDiagnosticHeartbeat(
      { diagnostics: { enabled: true } },
      {
        recoverStuckSession,
        testTimings: { stuckSessionWarnMs: 30_000, stuckSessionAbortMs },
      },
    );
    logSessionStateChange({ sessionId, sessionKey, state: "processing" });
    markDiagnosticEmbeddedRunStarted({ sessionId, sessionKey, runId });
    markDiagnosticArgumentChurnObservation({
      sessionId,
      sessionKey,
      runId,
      active: true,
    });

    for (let step = 1; step <= 9; step += 1) {
      vi.advanceTimersByTime(30_000);
      markDiagnosticRunProgress({
        sessionId,
        sessionKey,
        runId,
        reason: "model_call:stream_progress",
      });
      markDiagnosticArgumentChurnObservation({
        sessionId,
        sessionKey,
        runId,
        active: true,
      });
    }
    expect(recoverStuckSession).not.toHaveBeenCalled();

    vi.advanceTimersByTime(30_000);

    expectRecoveryCall(
      recoverStuckSession,
      { sessionId, sessionKey, queueDepth: 0, allowActiveAbort: true },
      ["ageMs", "stateGeneration"],
    );
  });

  it("aborts stale embedded runs when queued work refreshes session activity", () => {
    const recoverStuckSession = vi.fn();

    logSessionStateChange({ sessionId: "s1", sessionKey: "main", state: "processing" });
    markDiagnosticEmbeddedRunStarted({ sessionId: "s1", sessionKey: "main" });
    vi.advanceTimersByTime(507_000);
    logMessageQueued({ sessionId: "s1", sessionKey: "main", source: "test" });
    vi.advanceTimersByTime(122_000);

    startEnabledDiagnosticHeartbeat({ recoverStuckSession });

    vi.advanceTimersByTime(30_000);

    expectRecoveryCall(
      recoverStuckSession,
      { sessionId: "s1", sessionKey: "main", queueDepth: 1, allowActiveAbort: true },
      ["ageMs", "stateGeneration"],
    );
  });
});
