import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createReplyOperation } from "../sessions/session-controller.operation.js";
import { getSessionControllerOperation } from "../sessions/session-controller.state.js";
import { captureSessionTarget } from "../sessions/session-controller.target.js";
import { testing } from "../sessions/session-controller.test-support.js";
import { createDeferredCore } from "../shared/deferred.js";
import { getDiagnosticSessionActivitySnapshot } from "./diagnostic-run-activity.js";
import { requestStuckSessionRecovery } from "./diagnostic-session-recovery-coordinator.js";
import type { StuckSessionRecoveryRequest } from "./diagnostic-session-recovery.js";
import {
  getDiagnosticSessionState,
  resetDiagnosticSessionStateForTest,
} from "./diagnostic-session-state.js";
import { recoverStuckDiagnosticSession } from "./diagnostic-stuck-session-recovery.runtime.js";

const sessionKey = "agent:main:recovery-boundary";
const sessionId = "recovery-incarnation";
const classification = {
  eventType: "session.stalled",
  reason: "active_work_without_progress",
  classification: "stalled_agent_run",
  activeWorkKind: "embedded_run",
  recoveryEligible: false,
} as const;
function begin(backend?: Parameters<ReturnType<typeof createReplyOperation>["attachBackend"]>[0]) {
  const operation = createReplyOperation({ sessionKey, sessionId, resetTriggered: false });
  operation.setPhase("running");
  if (backend) {
    operation.attachBackend(backend);
  }
  return operation;
}
function physicalOwner(incarnation: string) {
  return createReplyOperation({
    sessionKey,
    sessionId: `physical-${incarnation}`,
    resetTriggered: false,
    target: captureSessionTarget({
      storeScope: `/synthetic/diagnostic-${incarnation}/sessions.sqlite`,
      sessionKey,
      incarnation: `physical-${incarnation}`,
    }),
  });
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => {
  testing.resetSessionControllerForTest();
  resetDiagnosticSessionStateForTest();
  vi.useRealTimers();
});

describe("diagnostic recovery delegates only to a captured controller", () => {
  it("captures diagnostic recovery only for a unique matching physical session owner", () => {
    const first = physicalOwner("first");
    const second = physicalOwner("second");
    const activityBeforeRecovery = getDiagnosticSessionActivitySnapshot({ sessionKey });
    expect(activityBeforeRecovery.activeWorkKind).toBeUndefined();
    expect(activityBeforeRecovery.hasActiveEmbeddedRun).toBeUndefined();
    const captured: Array<StuckSessionRecoveryRequest["operation"]> = [];
    for (const request of [
      { sessionKey },
      { sessionKey, sessionId: "physical-first" },
      { sessionKey, sessionId: "physical-second" },
      { sessionKey: "agent:main:unrelated", sessionId: "physical-first" },
    ]) {
      requestStuckSessionRecovery({
        classification,
        request: { ...request, ageMs: 0 },
        recover: (resolved) => {
          captured.push(resolved.operation);
        },
      });
    }
    expect(captured).toEqual([undefined, first, second, undefined]);
    expect(getDiagnosticSessionActivitySnapshot({ sessionKey })).toEqual(activityBeforeRecovery);
  });

  it("cannot infer stop or idle authority from missing diagnostic/native records", async () => {
    const cancel = vi.fn();
    const operation = begin({ kind: "embedded", cancel });
    vi.setSystemTime(60 * 60_000);
    const outcome = await recoverStuckDiagnosticSession({
      sessionKey,
      sessionId,
      ageMs: Date.now(),
      allowActiveAbort: true,
    });
    expect(outcome).toMatchObject({ status: "skipped", reason: "missing_session_ref" });
    expect(cancel).not.toHaveBeenCalled();
    expect(getSessionControllerOperation(sessionKey)).toBe(operation);
  });

  it.each([true, false])(
    "captures A before asynchronous runtime loading and never stops replacement B (keyed=%s)",
    async (keyed) => {
      const first = begin();
      const loaded = createDeferredCore();
      const completed = createDeferredCore();
      let captured: StuckSessionRecoveryRequest | undefined;
      requestStuckSessionRecovery({
        classification,
        request: { ...(keyed ? { sessionKey } : {}), sessionId, ageMs: 1_000_000 },
        recover: async (request) => {
          captured = request;
          await loaded.promise;
          const result = await recoverStuckDiagnosticSession(request);
          completed.resolve();
          return result;
        },
      });
      const capturedOperation = captured?.operation;
      first.complete();
      const cancel = vi.fn();
      const replacement = begin({ kind: "embedded", cancel });
      vi.setSystemTime(1_000_000);
      loaded.resolve();
      await completed.promise;
      expect(capturedOperation).toBe(first);
      expect(cancel).not.toHaveBeenCalled();
      expect(getSessionControllerOperation(sessionKey)).toBe(replacement);
    },
  );

  it("reports accepted model recovery without treating early diagnostics as stop authority", async () => {
    const cancel = vi.fn();
    const recoverStalledModelCall = vi.fn(() => true);
    const operation = begin({ kind: "embedded", cancel, recoverStalledModelCall });
    const attempt = operation.watchdog.attachAttempt({ assertCurrent() {} });
    attempt.beginRequest({ deadlineAtMs: 45_000 });
    const request = { operation, sessionKey, sessionId, ageMs: 75_000, allowActiveAbort: true };

    // The release fixture reports a stall here, but diagnostics cannot shorten
    // the controller-owned semantic horizon or interrupt the current attempt.
    vi.setSystemTime(request.ageMs);
    expect(await recoverStuckDiagnosticSession(request)).toMatchObject({
      status: "skipped",
      action: "observe_only",
      reason: "active_reply_work",
    });
    expect(recoverStalledModelCall).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();

    vi.setSystemTime(6 * 60_000);
    expect(await recoverStuckDiagnosticSession({ ...request, ageMs: Date.now() })).toMatchObject({
      status: "skipped",
      action: "keep_lane",
      reason: "model_attempt_recovery",
    });
    expect(recoverStalledModelCall).toHaveBeenCalledOnce();
    expect(cancel).not.toHaveBeenCalled();
    expect(operation.result).toBeNull();
    expect(getSessionControllerOperation(sessionKey)).toBe(operation);
    operation.complete();
    await operation.ownerSettlement;
  });

  it("deduplicates stop on the operation, not a keyed recovery set", async () => {
    const cancel = vi.fn();
    const operation = begin({ kind: "embedded", cancel });
    const request = { operation, sessionKey, sessionId, ageMs: 6 * 60_000 };
    vi.setSystemTime(request.ageMs);
    const first = recoverStuckDiagnosticSession(request);
    const second = recoverStuckDiagnosticSession(request);
    await Promise.all([first, second]);
    expect(cancel).toHaveBeenCalledOnce();
    expect(operation.watchdog.snapshot().recovery?.status).toBe("blocked");
    expect(getSessionControllerOperation(sessionKey)).toBe(operation);
    operation.complete();
    await operation.ownerSettlement;
  });

  it("reports outcomes without manufacturing idle, queue counts or activity cleanup", async () => {
    const operation = begin();
    const state = getDiagnosticSessionState({ sessionKey, sessionId });
    state.state = "processing";
    state.queueDepth = 3;
    const done = createDeferredCore();
    requestStuckSessionRecovery({
      classification,
      request: { operation, sessionKey, sessionId, ageMs: 1_000_000 },
      recover: () => {
        done.resolve();
        return {
          status: "aborted",
          action: "abort_embedded_run",
          aborted: true,
          drained: false,
          forceCleared: false,
          released: 0,
        };
      },
    });
    await done.promise;
    await Promise.resolve();
    expect(state).toMatchObject({ state: "processing", queueDepth: 3 });
    expect(getSessionControllerOperation(sessionKey)).toBe(operation);
  });
});
