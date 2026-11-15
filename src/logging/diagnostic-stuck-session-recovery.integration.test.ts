import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setDiagnosticsEnabledForProcess } from "../infra/diagnostic-events.js";
import {
  emitCoreModelRequestEndedDiagnosticEvent,
  emitCoreModelRequestStartedDiagnosticEvent,
} from "../infra/diagnostic-model-request.js";
import { emitCoreSemanticRunProgressDiagnosticEvent } from "../infra/diagnostic-semantic-run-progress.js";
import { withSessionTurn } from "../sessions/session-controller.admission.js";
import { createReplyOperation } from "../sessions/session-controller.operation.js";
import { getSessionControllerOperation } from "../sessions/session-controller.state.js";
import { testing } from "../sessions/session-controller.test-support.js";
import { createDeferredCore } from "../shared/deferred.js";
import { resetDiagnosticRecoveryState } from "./diagnostic-recovery.test-support.js";
import {
  beginDiagnosticBackendActivity,
  beginDiagnosticRetryWait,
  createDiagnosticEmbeddedRunOwner,
  getDiagnosticSessionActivitySnapshot,
  markDiagnosticArgumentChurnObservation,
  markDiagnosticEmbeddedRunStarted,
  markDiagnosticOwnedToolActivity,
} from "./diagnostic-run-activity.js";
import { recoverStuckDiagnosticSession } from "./diagnostic-stuck-session-recovery.runtime.js";

const ref = {
  sessionKey: "agent:main:watchdog-integration",
  sessionId: "watchdog-session",
  runId: "watchdog-run",
};
const abortMs = 6 * 60_000;
function begin() {
  const operation = createReplyOperation({ ...ref, resetTriggered: false });
  operation.setPhase("running");
  const cancel = vi.fn(() => operation.complete());
  operation.attachBackend({ kind: "embedded", runId: ref.runId, cancel });
  const watchdogAttempt = operation.watchdog.attachAttempt({ assertCurrent() {} });
  const owner = createDiagnosticEmbeddedRunOwner({ ...ref, watchdogAttempt });
  markDiagnosticEmbeddedRunStarted({ ...ref, owner });
  return { operation, cancel, owner, watchdogAttempt };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  setDiagnosticsEnabledForProcess(false);
});
afterEach(() => {
  testing.resetSessionControllerForTest();
  resetDiagnosticRecoveryState();
  vi.useRealTimers();
});

describe("controller recovery through actual progress producers", () => {
  it("reclaims repeated request/byte activity exactly once without replaying queued work", async () => {
    const { operation, cancel, owner } = begin();
    const backend = beginDiagnosticBackendActivity({
      owner,
      noOutputTimeoutMs: 150_000,
      assertCurrent() {},
    });
    const delivered = vi.fn();
    const queued = withSessionTurn(ref, async () => {
      delivered();
    });
    for (let index = 0; index < 8; index++) {
      vi.setSystemTime(index * 50_000);
      if (index > 0) {
        emitCoreModelRequestEndedDiagnosticEvent(
          {
            ...ref,
            type: "model.call.error",
            callId: "request-" + (index - 1),
            provider: "mock",
            model: "retrying",
            durationMs: 50_000,
            errorCategory: "retry",
          },
          owner.generation,
        );
      }
      emitCoreModelRequestStartedDiagnosticEvent(
        { ...ref, callId: "request-" + index, provider: "mock", model: "retrying" },
        owner.generation,
        150_000,
      );
      backend.observeOutput(false);
    }
    expect(delivered).not.toHaveBeenCalled();
    vi.setSystemTime(abortMs);
    await recoverStuckDiagnosticSession({ ...ref, operation, ageMs: abortMs });
    expect(cancel).not.toHaveBeenCalled();
    expect(delivered).not.toHaveBeenCalled();
    vi.setSystemTime(500_000);
    await recoverStuckDiagnosticSession({ ...ref, operation, ageMs: Date.now() });
    await queued;
    expect(cancel).toHaveBeenCalledOnce();
    expect(delivered).toHaveBeenCalledOnce();
    expect(operation.result).toMatchObject({ kind: "failed", code: "run_stalled" });
    backend.close();
  });

  it("rechecks semantic results published while recovery dispatch was deferred", async () => {
    const { operation, cancel, owner } = begin();
    const request = { ...ref, operation, ageMs: abortMs };
    vi.setSystemTime(abortMs);
    emitCoreSemanticRunProgressDiagnosticEvent({ ...ref, reason: "assistant:result" }, owner);
    await recoverStuckDiagnosticSession(request);
    expect(cancel).not.toHaveBeenCalled();
    expect(getDiagnosticSessionActivitySnapshot(ref).lastProgressAgeMs).toBe(0);
    const retry = beginDiagnosticRetryWait({
      owner,
      deadlineAtMs: Date.now() + abortMs * 2,
      signal: operation.abortSignal,
      assertCurrent() {},
    });
    vi.setSystemTime(abortMs * 2 + 1);
    await recoverStuckDiagnosticSession(request);
    expect(cancel).not.toHaveBeenCalled();
    retry();
    await recoverStuckDiagnosticSession(request);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each(["quiet", "explicit", "overlapping", "mixed"] as const)(
    "protects %s owned tools even when diagnostics are disabled",
    async (kind) => {
      const { operation, cancel, owner } = begin();
      markDiagnosticOwnedToolActivity(owner, {
        phase: "start",
        toolName: "exec",
        toolCallId: "old",
        ...(kind === "explicit" || kind === "mixed" ? { deadlineAtMs: 1_200_000 } : {}),
      });
      if (kind === "overlapping" || kind === "mixed") {
        vi.setSystemTime(14 * 60_000);
        markDiagnosticOwnedToolActivity(owner, {
          phase: "start",
          toolName: "exec",
          toolCallId: "new",
        });
      }
      vi.setSystemTime(kind === "overlapping" || kind === "mixed" ? 16 * 60_000 : abortMs);
      await recoverStuckDiagnosticSession({ ...ref, operation, ageMs: Date.now() });
      expect(cancel).not.toHaveBeenCalled();
      const deadline = Math.max(
        ...operation.watchdog.snapshot().tools.map((tool) => tool.deadlineAtMs),
      );
      vi.setSystemTime(deadline);
      await recoverStuckDiagnosticSession({ ...ref, operation, ageMs: Date.now() });
      expect(cancel).toHaveBeenCalledOnce();
    },
  );

  it("keeps compaction/preflight on its actual deadline and allows immediate supersession", async () => {
    const { operation, cancel, watchdogAttempt } = begin();
    operation.setPhase("preflight_compacting");
    const safetyDeadline = 12 * 60_000;
    watchdogAttempt.beginWait({
      kind: "runtime_owned",
      deadlineAtMs: safetyDeadline,
      isCurrent: () => true,
    });
    watchdogAttempt.setExecutionDeadline(safetyDeadline);
    vi.setSystemTime(safetyDeadline - 1);
    await recoverStuckDiagnosticSession({ ...ref, operation, ageMs: Date.now() });
    expect(cancel).not.toHaveBeenCalled();
    expect(operation.supersede()).toBe(true);
    expect(cancel).toHaveBeenCalledOnce();
    expect(operation.result).toMatchObject({ kind: "aborted", code: "aborted_for_supersession" });
  });

  it("continuous argument churn cannot be renewed by mechanical model/tool handoffs", async () => {
    const { operation, cancel, watchdogAttempt } = begin();
    for (let step = 0; step <= 12; step++) {
      vi.setSystemTime(step * 30_000);
      watchdogAttempt.progress("semantic", "model:repeated_tool_request");
      markDiagnosticArgumentChurnObservation({ ...ref, watchdogAttempt, active: true });
    }
    expect(getDiagnosticSessionActivitySnapshot(ref)).toMatchObject({
      lastProgressAgeMs: abortMs,
      lastProgressReason: "tool_loop:argument_churn",
    });
    await recoverStuckDiagnosticSession({ ...ref, operation, ageMs: abortMs });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("a failed cleanup cannot admit a queued successor until the writer really settles", async () => {
    const { operation } = begin();
    const cancel = vi.fn(() => {
      throw new Error("write owner did not retire");
    });
    operation.attachBackend({ kind: "embedded", cancel });
    const delivered = createDeferredCore();
    const dispatch = vi.fn(() => delivered.resolve());
    const queued = withSessionTurn(ref, async () => {
      dispatch();
    });
    vi.setSystemTime(abortMs);
    await operation.watchdog.tick();
    vi.setSystemTime(abortMs + 60_000);
    await operation.watchdog.tick();
    expect(operation.watchdog.decide().action).toBe("blocked");
    expect(getSessionControllerOperation(ref.sessionKey)).toBe(operation);
    expect(dispatch).not.toHaveBeenCalled();
    operation.complete();
    await delivered.promise;
    await queued;
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("retired backend callbacks cannot refresh a replacement or reuse a same-ID owner", () => {
    const { operation, owner } = begin();
    const backend = beginDiagnosticBackendActivity({
      owner,
      noOutputTimeoutMs: 150_000,
      assertCurrent() {},
    });
    backend.close();
    vi.setSystemTime(100_000);
    expect(backend.observeOutput(true)).toBe(false);
    expect(operation.watchdog.snapshot().semanticProgressAtMs).toBe(0);
    operation.complete();
    const next = begin();
    expect(backend.observeOutput(true)).toBe(false);
    expect(getSessionControllerOperation(ref.sessionKey)).toBe(next.operation);
  });
});
