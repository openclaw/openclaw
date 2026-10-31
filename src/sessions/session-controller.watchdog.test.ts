import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installSessionPlacementAdmissionProvider } from "../agents/session-placement-admission.js";
import { beginReplyOperationFinalizationWork } from "../auto-reply/reply/reply-run-finalization-lease.js";
import {
  resetDiagnosticEventsForTest,
  setDiagnosticsEnabledForProcess,
} from "../infra/diagnostic-events.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withSessionTurn } from "./session-controller.admission.js";
import { createReplyOperation } from "./session-controller.operation.js";
import { getSessionControllerOperation } from "./session-controller.state.js";
import { testing } from "./session-controller.test-support.js";
import type {
  ReplyBackendTurnAssessment,
  ReplyBackendTurnStatus,
} from "./session-controller.turn-status.types.js";
import {
  SESSION_WATCHDOG_CLEANUP_MS,
  SESSION_WATCHDOG_QUIET_TOOL_MS,
} from "./session-controller.watchdog-state.js";
import {
  createSessionControllerWatchdog,
  type SessionWatchdogEffect,
  type SessionWatchdogEffectResult,
} from "./session-controller.watchdog.js";

const key = "agent:main:watchdog-boundary";
const sessionId = "watchdog-incarnation";
const abortMs = 6 * 60_000;
let releasePlacementProvider: (() => void) | undefined;
function begin() {
  const operation = createReplyOperation({ sessionKey: key, sessionId, resetTriggered: false });
  operation.setPhase("running");
  return operation;
}
function attach(
  operation: ReturnType<typeof begin>,
  cancel: () => void = vi.fn(() => operation.complete()),
) {
  operation.attachBackend({ kind: "embedded", runId: "watchdog-run", cancel });
  return cancel;
}
function running() {
  const operation = begin();
  return { operation, cancel: attach(operation) };
}
function tickAt(watchdog: ReturnType<typeof createSessionControllerWatchdog>, at: number) {
  vi.setSystemTime(at);
  return watchdog.tick();
}

function recoverableRun(recovered: boolean) {
  const operation = begin();
  const cancel = vi.fn(() => operation.complete());
  const recoverStalledModelCall = vi.fn(() => recovered);
  operation.attachBackend({ kind: "embedded", cancel, recoverStalledModelCall });
  return { operation, cancel, recoverStalledModelCall };
}

function expectStalled(operation: ReturnType<typeof begin>, cancel: () => void) {
  expect(cancel).toHaveBeenCalledOnce();
  expect(operation.result).toMatchObject({ kind: "failed", code: "run_stalled" });
}
function watchdogFixture(
  overrides: Partial<Parameters<typeof createSessionControllerWatchdog>[0]>,
) {
  return createSessionControllerWatchdog({
    startedAtMs: 0,
    isCurrent: () => true,
    readPhase: () => "active",
    requestStop: () => "blocked",
    expireCleanup: () => "blocked",
    ...overrides,
  });
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  setDiagnosticsEnabledForProcess(false);
});
afterEach(() => {
  releasePlacementProvider?.();
  releasePlacementProvider = undefined;
  testing.resetSessionControllerForTest();
  resetDiagnosticEventsForTest();
  vi.useRealTimers();
});

describe("execution deadline recovery", () => {
  it("recovers the earliest execution owner when its deadline is mirrored on the attempt", async () => {
    const recover = vi.fn(async () => {
      attempt.close();
      return true;
    });
    const laterRecovery = vi.fn(async () => true);
    const watchdog = watchdogFixture({
      requestStop: async (effect) =>
        (await effect.recoverExecutionDeadline?.()) ? "resumed" : "blocked",
    });
    const attempt = watchdog.attachAttempt({ assertCurrent() {} });
    attempt.setExecutionDeadline(10);
    watchdog.beginExecution(() => 10, recover);
    watchdog.beginExecution(() => 20, laterRecovery);
    expect(await tickAt(watchdog, 20)).toEqual({ action: "observe", reason: "owner_recovery" });
    expect(recover).toHaveBeenCalledOnce();
    expect(laterRecovery).not.toHaveBeenCalled();
    expect(watchdog.snapshot().recovery).toBeUndefined();
    watchdog.close();
  });

  it.each(["semantic_stall", "ordinary_deadline"] as const)(
    "does not offer future execution recovery for %s",
    async (cause) => {
      const recover = vi.fn(async () => true);
      const stop = vi.fn((_effect: SessionWatchdogEffect) => "settled" as const);
      const watchdog = watchdogFixture({
        requestStop: stop,
      });
      watchdog.beginExecution(() => abortMs * 2, recover);
      if (cause === "ordinary_deadline") {
        watchdog.beginExecution(() => 1);
      }
      await tickAt(watchdog, cause === "ordinary_deadline" ? 1 : abortMs);
      expect(stop).toHaveBeenCalledOnce();
      const [effect] = expectDefined(stop.mock.calls[0], "captured watchdog Stop");
      expect(effect.recoverExecutionDeadline).toBeUndefined();
      expect(recover).not.toHaveBeenCalled();
      watchdog.close();
    },
  );

  it.each(["closed", "rearmed", "retired"] as const)(
    "rejects a captured execution recovery after its record is %s",
    async (change) => {
      const started = createDeferredCore();
      const resume = createDeferredCore();
      const recover = vi.fn(async () => true);
      let current = true;
      let effectCurrent: boolean | undefined;
      let accepted: boolean | undefined;
      const watchdog = watchdogFixture({
        isCurrent: () => current,
        requestStop: async (effect): Promise<SessionWatchdogEffectResult> => {
          started.resolve();
          await resume.promise;
          effectCurrent = effect.isCurrent();
          accepted = await effect.recoverExecutionDeadline?.();
          return "blocked";
        },
      });
      const execution = watchdog.beginExecution(undefined, recover);
      execution.setDeadline(1);
      const pending = tickAt(watchdog, 1);
      await started.promise;
      if (change === "closed") {
        execution.close();
      } else if (change === "rearmed") {
        execution.setDeadline(2);
      } else {
        current = false;
      }
      resume.resolve();
      await pending;
      expect(effectCurrent).toBe(false);
      expect(accepted).toBe(false);
      expect(recover).not.toHaveBeenCalled();
      watchdog.close();
    },
  );

  it.each(["owned", "attempt"] as const)(
    "revalidates a plain %s execution deadline before Stop",
    async (kind) => {
      const started = createDeferredCore();
      const resume = createDeferredCore();
      let effectCurrent: boolean | undefined;
      const watchdog = watchdogFixture({
        requestStop: async (effect): Promise<SessionWatchdogEffectResult> => {
          started.resolve();
          await resume.promise;
          effectCurrent = effect.isCurrent();
          return "resumed";
        },
      });
      const attempt = watchdog.attachAttempt({ assertCurrent() {} });
      const execution = kind === "owned" ? watchdog.beginExecution() : undefined;
      const setDeadline = (deadline: number) =>
        execution ? execution.setDeadline(deadline) : attempt.setExecutionDeadline(deadline);
      setDeadline(1);
      const pending = tickAt(watchdog, 1);
      await started.promise;
      setDeadline(2);
      resume.resolve();
      await pending;
      expect(effectCurrent).toBe(false);
      watchdog.close();
    },
  );
});

describe("operation-owned watchdog through controller admission", () => {
  it("lets accepted model recovery settle before attaching a fallback attempt", async () => {
    const operation = begin();
    const cancel = vi.fn();
    const recoverStalledModelCall = vi.fn(() => true);
    operation.attachBackend({ kind: "embedded", cancel, recoverStalledModelCall });
    const first = operation.watchdog.attachAttempt({ assertCurrent() {} });
    expect(await tickAt(operation.watchdog, abortMs)).toEqual({
      action: "observe",
      reason: "model_recovery",
    });
    expect(recoverStalledModelCall).toHaveBeenCalledOnce();
    expect(cancel).not.toHaveBeenCalled();
    expect(operation.result).toBeNull();
    expect(operation.watchdog.snapshot()).toMatchObject({ semanticProgressAtMs: 0 });
    expect(operation.watchdog.snapshot().recovery).toBeUndefined();
    const fallback = operation.watchdog.attachAttempt({ assertCurrent() {} });
    fallback.beginRequest({ deadlineAtMs: abortMs * 2 });
    await operation.watchdog.tick();
    expect(first.isCurrent()).toBe(false);
    expect(fallback.isCurrent()).toBe(true);
    expect(recoverStalledModelCall).toHaveBeenCalledOnce();
    expect(cancel).not.toHaveBeenCalled();
  });

  it("stops the owner when its native backend cannot recover the stalled model call", async () => {
    const { operation, cancel, recoverStalledModelCall } = recoverableRun(false);
    await tickAt(operation.watchdog, abortMs);
    expect(operation.abortSignal.reason).toMatchObject({
      name: "AbortError",
      code: "OPENCLAW_SESSION_WATCHDOG",
    });
    expect(recoverStalledModelCall).toHaveBeenCalledOnce();
    expectStalled(operation, cancel);
  });

  it("does not treat an execution deadline as model-only recovery", async () => {
    const { operation, cancel, recoverStalledModelCall } = recoverableRun(true);
    const attempt = operation.watchdog.attachAttempt({ assertCurrent() {} });
    attempt.setExecutionDeadline(1);
    await tickAt(operation.watchdog, 1);
    expect(recoverStalledModelCall).not.toHaveBeenCalled();
    expectStalled(operation, cancel);
  });

  it.each([
    "backend",
    "attempt",
    "owner",
    "assessed backend",
    "assessed registration",
    "assessed deadline",
    "assessed evidence",
  ] as const)(
    "revalidates the exact %s after asynchronous placement recovery",
    async (replacement) => {
      const entered = createDeferredCore();
      const resume = createDeferredCore();
      releasePlacementProvider = installSessionPlacementAdmissionProvider({
        assertCompactionSuccessorAllowed() {},
        executeLocalTurn: async (_claim, runLocal) => await runLocal(),
        executeTurn: async (_claim, _params, runLocal) => await runLocal(),
        recoverTerminalTurn: async (_session, assertCurrent) => {
          entered.resolve();
          await resume.promise;
          assertCurrent?.();
          return undefined;
        },
      });
      const { operation, cancel } = running();
      const attempt = operation.watchdog.attachAttempt({ assertCurrent() {} });
      let evidenceCurrent = true;
      let status: ReplyBackendTurnStatus | undefined = {
        capture: () => ({
          isCurrent: () => evidenceCurrent,
          assess: async () => ({ state: "closed", basis: "transport_closed" }),
        }),
      };
      if (replacement.startsWith("assessed")) {
        operation.attachBackend({
          kind: "cli",
          cancel,
          get turnStatus() {
            return status;
          },
        });
      }
      const pending = tickAt(operation.watchdog, abortMs);
      await entered.promise;
      let successor = operation;
      if (replacement === "owner") {
        operation.complete();
        successor = begin();
      } else if (replacement === "attempt") {
        attempt.close();
      }
      const keepBackend =
        replacement === "assessed registration" ||
        replacement === "assessed deadline" ||
        replacement === "assessed evidence";
      const cancelSuccessor = keepBackend ? cancel : vi.fn(() => successor.complete());
      if (!keepBackend) {
        successor.attachBackend({
          kind: "cli",
          cancel: cancelSuccessor,
          turnStatus: replacement === "assessed backend" ? status : undefined,
        });
      }
      if (replacement === "assessed deadline") {
        attempt.setExecutionDeadline(abortMs);
      } else if (replacement === "assessed registration") {
        status = undefined;
      } else if (replacement === "assessed evidence") {
        evidenceCurrent = false;
      }
      resume.resolve();
      await pending;
      await vi.advanceTimersByTimeAsync(0);
      if (replacement === "assessed evidence") {
        expectStalled(operation, cancel);
        expect(operation.abortSignal.reason).toMatchObject({
          message: "Reply operation stalled",
          assessment: { state: "unknown", basis: "status_unsupported" },
        });
        return;
      }
      expect(cancel).not.toHaveBeenCalled();
      expect(cancelSuccessor).not.toHaveBeenCalled();
      expect(successor.result).toBeNull();
      expect(getSessionControllerOperation(key)).toBe(successor);
      expect(successor.watchdog.snapshot().recovery).toBeUndefined();
      expect(successor.watchdog.describeStop().error).not.toHaveProperty("assessment");
      if (replacement === "assessed deadline") {
        expect(await successor.watchdog.tick()).toMatchObject({
          action: "stop",
          reason: "execution_deadline",
        });
        expectStalled(operation, cancel);
        expect(operation.abortSignal.reason).not.toHaveProperty("assessment");
      } else {
        expect(successor.watchdog.attachAttempt({ assertCurrent() {} }).isCurrent()).toBe(true);
      }
    },
  );

  it("gives resumed terminal recovery cleanup time without manufacturing semantic progress", async () => {
    let phase: "active" | "terminal" = "active";
    const expireCleanup = vi.fn(() => "resumed" as const);
    const watchdog = watchdogFixture({
      readPhase: () => phase,
      requestStop: () => "resumed",
      expireCleanup,
    });
    phase = "terminal";
    watchdog.beginTerminal();
    expect(await tickAt(watchdog, SESSION_WATCHDOG_CLEANUP_MS)).toEqual({
      action: "observe",
      reason: "owner_recovery",
    });
    expect(watchdog.snapshot()).toMatchObject({
      semanticProgressAtMs: 0,
      cleanupDeadlineAtMs: SESSION_WATCHDOG_CLEANUP_MS * 2,
    });
    expect(watchdog.snapshot().recovery).toBeUndefined();
    await tickAt(watchdog, SESSION_WATCHDOG_CLEANUP_MS * 2 - 1);
    expect(expireCleanup).toHaveBeenCalledOnce();
    watchdog.close();
  });

  it("runs its timer without diagnostics and ignores non-semantic inbound activity", async () => {
    const { operation, cancel } = running();
    await vi.advanceTimersByTimeAsync(abortMs - 1);
    operation.recordActivity(); // A source arrival is not semantic progress.
    expect(operation.watchdog.decide().action).toBe("warn");
    await vi.advanceTimersByTimeAsync(1_001);
    expectStalled(operation, cancel);
    expect(getSessionControllerOperation(key)).toBeUndefined();
  });

  it.each(["global_capacity", "deferred_maintenance", "human_question", "runtime_owned"] as const)(
    "protects explicit live %s waits, not detached flags",
    async (kind) => {
      const { operation, cancel } = running();
      let live = true;
      operation.watchdog.beginWait({ kind, isCurrent: () => live });
      await tickAt(operation.watchdog, abortMs * 4);
      expect(cancel).not.toHaveBeenCalled();
      live = false;
      await operation.watchdog.tick();
      expect(cancel).toHaveBeenCalledOnce();
    },
  );

  it("uses actual approval expiry and revocation, without a second timeout", async () => {
    const { operation, cancel } = running();
    const expiry = abortMs * 3;
    operation.watchdog.beginWait({ kind: "approval", deadlineAtMs: expiry, isCurrent: () => true });
    await tickAt(operation.watchdog, expiry - 1);
    expect(cancel).not.toHaveBeenCalled();
    await tickAt(operation.watchdog, expiry);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each(["expires", "ends", "retires"] as const)(
    "honors the current fallback request until it %s without renewing semantic progress",
    async (terminal) => {
      const { operation, cancel } = running();
      const first = operation.watchdog.attachAttempt({ assertCurrent() {} });
      first.observeStagnation({ active: true });
      first.beginRequest({ deadlineAtMs: abortMs * 10 });
      vi.setSystemTime(abortMs - 1_000);
      const second = operation.watchdog.attachAttempt({ assertCurrent() {} });
      const deadlineAtMs = abortMs + 90_000;
      const endRequest = second.beginRequest({ deadlineAtMs, requestTimeoutMs: 91_000 });
      second.progress("transport", "retry:bytes");
      operation.watchdog.progress("source_arrival");
      expect(first.progress("semantic")).toBe(false);
      await tickAt(operation.watchdog, abortMs);
      expect(cancel).not.toHaveBeenCalled();
      expect(operation.watchdog.snapshot()).toMatchObject({
        semanticProgressAtMs: 0,
        semanticDeadlineAtMs: deadlineAtMs,
        requests: [{ requestTimeoutMs: 91_000, deadlineAtMs }],
      });
      if (terminal === "expires") {
        vi.setSystemTime(deadlineAtMs);
      } else if (terminal === "ends") {
        endRequest();
      } else {
        second.close();
      }
      await operation.watchdog.tick();
      expect(cancel).toHaveBeenCalledOnce();
    },
  );

  it("accepts exact meaningful progress and rejects an old callback after replacement", async () => {
    const operation = begin();
    const old = operation.watchdog.attachAttempt({ assertCurrent() {} });
    vi.setSystemTime(abortMs - 1);
    const current = operation.watchdog.attachAttempt({ assertCurrent() {} });
    expect(current.progress("semantic", "assistant:result")).toBe(true);
    expect(old.progress("semantic")).toBe(false);
    expect(operation.watchdog.decide().action).toBe("observe");
    operation.complete();
    const successor = begin();
    const cancel = attach(successor);
    await operation.watchdog.tick(abortMs * 10);
    expect(cancel).not.toHaveBeenCalled();
    expect(getSessionControllerOperation(key)).toBe(successor);
  });

  it("honors owned tool and execution deadlines on the exact attempt", async () => {
    const { operation, cancel } = running();
    const attempt = operation.watchdog.attachAttempt({ assertCurrent() {} });
    let enforcedDeadline = 120_000;
    attempt.beginTool({
      toolName: "exec",
      toolCallId: "command",
      get deadlineAtMs() {
        return enforcedDeadline;
      },
    });
    enforcedDeadline = 300_000;
    expect(operation.watchdog.snapshot().tools).toEqual([
      {
        toolName: "exec",
        toolCallId: "command",
        startedAtMs: 0,
        explicitDeadlineAtMs: 300_000,
        deadlineAtMs: 1_200_000,
      },
    ]);
    await tickAt(operation.watchdog, SESSION_WATCHDOG_QUIET_TOOL_MS + enforcedDeadline - 1);
    expect(cancel).not.toHaveBeenCalled();
    attempt.setExecutionDeadline(Date.now());
    await operation.watchdog.tick();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("counts async tool completion only while its exact attempt is current", async () => {
    const { operation, cancel } = running();
    const old = operation.watchdog.attachAttempt({ assertCurrent() {} });
    const endOldTool = old.beginTool({ toolName: "process", toolCallId: "old-command" });
    const current = operation.watchdog.attachAttempt({ assertCurrent() {} });
    const endCurrentTool = current.beginTool({ toolName: "process", toolCallId: "command" });
    vi.setSystemTime(SESSION_WATCHDOG_QUIET_TOOL_MS - 1);
    expect(current.progressModel("model_call:stream_progress")).toBe(false);
    endOldTool(true);
    expect(operation.watchdog.snapshot().semanticProgressAtMs).toBe(0);
    endCurrentTool(true);
    await operation.watchdog.tick();
    expect(cancel).not.toHaveBeenCalled();
    expect(operation.watchdog.snapshot()).toMatchObject({
      semanticProgressAtMs: SESSION_WATCHDOG_QUIET_TOOL_MS - 1,
      lastProgressReason: "tool:completed",
      tools: [],
    });
  });

  it("retains finishing custody after failed cleanup until the raw writer actually settles", async () => {
    const operation = begin();
    const cancel = attach(
      operation,
      vi.fn(() => {
        throw new Error("writer still live");
      }),
    );
    operation.freezeAbort();
    const releaseWork = beginReplyOperationFinalizationWork(
      operation,
      SESSION_WATCHDOG_CLEANUP_MS * 2,
    );
    let rawSettled = false;
    void operation.ownerSettlement.then(() => {
      rawSettled = true;
    });
    const successorStarted = createDeferredCore();
    const successor = withSessionTurn({ sessionKey: key, sessionId }, async () => {
      successorStarted.resolve();
    });
    let ranSuccessor = false;
    void successorStarted.promise.then(() => {
      ranSuccessor = true;
    });
    await tickAt(operation.watchdog, SESSION_WATCHDOG_CLEANUP_MS + 1);
    expect(cancel).not.toHaveBeenCalled();
    releaseWork();
    await operation.watchdog.tick();
    expect(cancel).toHaveBeenCalledOnce();
    expect(operation.result?.kind).not.toBe("aborted");
    expect(operation.result?.kind).not.toBe("failed");
    expect(rawSettled).toBe(false);
    expect(ranSuccessor).toBe(false);
    expect(getSessionControllerOperation(key)).toBe(operation);
    operation.complete();
    await operation.ownerSettlement;
    await successor;
    expect(rawSettled).toBe(true);
    expect(ranSuccessor).toBe(true);
    expect(operation.result).toEqual({ kind: "completed" });
  });
  it("retains committed delivery settlement after cleanup expiry", async () => {
    const operation = begin();
    const delivery = createDeferredCore();
    operation.freezeAbort();
    operation.completeWithAfterClearBarrier(delivery.promise, 10);
    expect(operation.result).toEqual({ kind: "completed" });
    let rawSettled = false;
    void operation.ownerSettlement.then(() => {
      rawSettled = true;
    });
    const createSuccessor = () =>
      createReplyOperation({
        sessionKey: key,
        sessionId,
        resetTriggered: false,
        turnKind: "queued_followup",
      });
    await tickAt(operation.watchdog, SESSION_WATCHDOG_CLEANUP_MS + 1);
    expect(operation.result).toEqual({ kind: "completed" });
    expect(rawSettled).toBe(false);
    // Moving wall time does not expire the delivery barrier timer.
    expect(createSuccessor).toThrow("Reply follow-up admission is blocked");
    delivery.resolve();
    await operation.ownerSettlement;
    createSuccessor().complete();
  });
  it.each([
    [
      "queued",
      "markWaitingForDeferredMaintenance",
      "markDeferredMaintenanceWaitEnded",
      "waiting_for_deferred_maintenance",
    ],
    [
      "running",
      "markWaitingForDeferredMaintenance",
      "markDeferredMaintenanceWaitEnded",
      "waiting_for_deferred_maintenance",
    ],
    ["queued", "markWaitingForGlobalLane", "markGlobalLaneWaitEnded", "waiting_for_global_lane"],
    ["running", "markWaitingForGlobalLane", "markGlobalLaneWaitEnded", "waiting_for_global_lane"],
  ] as const)(
    "publishes %s %s and resumes the same semantic owner",
    async (phase, wait, ready, waiting) => {
      const operation = begin();
      operation.setPhase(phase);
      const cancel = attach(operation);
      operation[wait]();
      await tickAt(operation.watchdog, abortMs * 2);
      expect(cancel).not.toHaveBeenCalled();
      expect(operation.phase).toBe(waiting);
      operation[ready]();
      expect(operation.phase).toBe(phase);
      expect(operation.watchdog.snapshot().semanticProgressAtMs).toBe(Date.now());
      operation.complete();
    },
  );

  it.each(["backend-throw", "cleanup-throw", "attempt-close"] as const)(
    "keeps an unfenced terminal writer after requesting every captured cleanup for %s",
    async (failure) => {
      const operation = begin();
      const attempt = operation.watchdog.attachAttempt({ assertCurrent() {} });
      attach(operation, () => {
        if (failure === "backend-throw") {
          throw new Error("backend cancellation failed");
        }
        if (failure === "attempt-close") {
          attempt.close();
        }
      });
      const firstCleanup = vi.fn(async () => {
        if (failure === "cleanup-throw") {
          throw new Error("placement retirement failed");
        }
      });
      const secondCleanup = vi.fn(async () => {});
      operation.registerExecutionCleanup(firstCleanup);
      operation.registerExecutionCleanup(secondCleanup);
      await tickAt(operation.watchdog, abortMs);
      expect(firstCleanup).toHaveBeenCalledOnce();
      expect(secondCleanup).toHaveBeenCalledOnce();
      expect(operation.watchdog.snapshot().recovery?.status).toBe("blocked");
      expect(operation.result).toMatchObject({ kind: "failed", code: "run_stalled" });
      expect(getSessionControllerOperation(key)).toBe(operation);
      await tickAt(operation.watchdog, abortMs + SESSION_WATCHDOG_CLEANUP_MS);
      expect(operation.watchdog.snapshot().recovery?.status).toBe("blocked");
      expect(getSessionControllerOperation(key)).toBe(operation);
      operation.complete();
      await operation.ownerSettlement;
    },
  );
  it("keeps the rekeyed after-clear watchdog live until its actual completion barrier", async () => {
    const operation = createReplyOperation({ sessionKey: key, sessionId, resetTriggered: false });
    operation.updateSessionKey(key + ":adopted");
    const writer = createDeferredCore();
    operation.completeWithAfterClearBarrier(writer.promise, 1);
    vi.setSystemTime(SESSION_WATCHDOG_CLEANUP_MS + 1);
    expect(operation.watchdog.decide().action).toBe("expire_cleanup");
    writer.resolve();
    await operation.ownerSettlement;
    expect(operation.watchdog.snapshot().phase).toBe("settled");
  });
});

function assessedRun(recoverStalledModelCall?: () => boolean) {
  const operation = begin();
  let current = true;
  const attempt = operation.watchdog.attachAttempt({
    assertCurrent() {
      if (!current) {
        throw new Error("revoked");
      }
    },
  });
  attempt.setExecutionDeadline(600_000);
  const response = createDeferredCore<ReplyBackendTurnAssessment>();
  let signal: AbortSignal | undefined;
  const assess = vi.fn(({ signal: next }: { signal: AbortSignal }) => {
    signal = next;
    return response.promise;
  });
  const capture = vi.fn(() => {
    expect(operation.watchdog.decide()).toMatchObject({ action: "observe", reason: "backend" });
    void operation.watchdog.tick();
    return { isCurrent: () => true, assess };
  });
  const cancel = vi.fn(() => operation.complete());
  operation.attachBackend({
    kind: "cli",
    cancel,
    turnStatus: { capture },
    recoverStalledModelCall,
  });
  return {
    operation,
    attempt,
    response,
    assess,
    capture,
    cancel,
    signal: () => signal,
    revoke: () => {
      current = false;
    },
  };
}

describe("bounded pre-stop assessment", () => {
  it.each([
    ["closed", { state: "closed", basis: "transport_closed" }],
    ["unknown", { state: "unknown", basis: "process_present" }],
    ["unsupported", { state: "unknown", basis: "status_unsupported" }],
    ["throw", { state: "unknown", basis: "failed" }],
    ["timeout", { state: "unknown", basis: "timeout" }],
  ] as const)(
    "rechecks silence once after %s without claiming unknown is dead",
    async (outcome, result) => {
      const { operation, response, assess, capture, cancel, signal } = assessedRun();
      expect(await tickAt(operation.watchdog, abortMs)).toMatchObject({
        action: "observe",
        reason: "backend",
        deadlineAtMs: abortMs + 10_000,
      });
      expect(operation.watchdog.snapshot().recovery).toBeUndefined();
      await operation.watchdog.tick();
      expect(capture).toHaveBeenCalledOnce();
      expect(assess).toHaveBeenCalledOnce();
      expect(cancel).not.toHaveBeenCalled();
      if (outcome === "timeout") {
        await tickAt(operation.watchdog, abortMs + 10_000);
      } else if (outcome === "throw") {
        response.reject(new Error("synthetic private error"));
      } else {
        response.resolve(result);
      }
      await operation.ownerSettlement;
      expectStalled(operation, cancel);
      expect(operation.abortSignal.reason).toMatchObject({
        message:
          outcome === "closed"
            ? "Reply backend closed before completing"
            : "Reply operation stalled",
        assessment: {
          ...result,
          durationMs: outcome === "timeout" ? 10_000 : 0,
        },
      });
      expect(signal()?.aborted).toBe(true);
      response.resolve({ state: "closed", basis: "process_exited" });
      await vi.advanceTimersByTimeAsync(0);
      expect(cancel).toHaveBeenCalledOnce();
    },
  );

  it("does not reassess the same target and silence episode after native recovery", async () => {
    const recover = vi.fn(() => true);
    const { operation, response, assess, cancel } = assessedRun(recover);
    await tickAt(operation.watchdog, abortMs);
    response.resolve({ state: "unknown", basis: "process_present" });
    await vi.advanceTimersByTimeAsync(0);
    expect(recover).toHaveBeenCalledOnce();
    await operation.watchdog.tick();
    expect(assess).toHaveBeenCalledOnce();
    expect(cancel).not.toHaveBeenCalled();
    expect(operation.watchdog.snapshot().semanticProgressAtMs).toBe(0);
    operation.complete();
  });

  it.each([
    "progress",
    "Stop",
    "hard deadline",
    "completion",
    "attempt",
    "backend",
    "revocation",
  ] as const)("%s wins over a late closed assessment", async (change) => {
    const { operation, attempt, response, assess, cancel, signal, revoke } = assessedRun();
    const successorResponse = createDeferredCore<ReplyBackendTurnAssessment>();
    let successorSignal: AbortSignal | undefined;
    if (change === "hard deadline") {
      attempt.setExecutionDeadline(abortMs + 5);
    }
    await tickAt(operation.watchdog, abortMs);
    expect(operation.watchdog.snapshot().waits).toEqual([
      { kind: "backend", deadlineAtMs: abortMs + (change === "hard deadline" ? 5 : 10_000) },
    ]);
    const originalSignal = signal();
    expect(originalSignal?.aborted).toBe(false);
    const replacementCancel = vi.fn(() => operation.complete());
    if (change === "progress") {
      expect(attempt.progressModel("fresh thinking")).toBe(true);
    }
    if (change === "Stop") {
      operation.abortByUser();
    }
    if (change === "hard deadline") {
      await tickAt(operation.watchdog, abortMs + 5);
    }
    if (change === "completion") {
      operation.complete();
    }
    if (change === "revocation") {
      revoke();
    }
    if (change === "attempt") {
      assess.mockImplementationOnce(({ signal: next }) => {
        successorSignal = next;
        return successorResponse.promise;
      });
      operation.watchdog.attachAttempt({ assertCurrent() {} });
      expect(operation.watchdog.snapshot().semanticProgressAtMs).toBe(0);
    }
    if (change === "backend") {
      operation.attachBackend({ kind: "cli", cancel: replacementCancel });
    }
    if (change === "backend" || change === "revocation" || change === "attempt") {
      await operation.watchdog.tick();
    }
    // Observe invalidation before the late response or final cleanup can abort anything.
    expect(originalSignal?.aborted).toBe(true);
    response.resolve({ state: "closed", basis: "transport_closed" });
    await vi.advanceTimersByTimeAsync(0);
    expect(cancel).toHaveBeenCalledTimes(
      change === "Stop" || change === "hard deadline" || change === "revocation" ? 1 : 0,
    );
    if (change === "backend") {
      expectStalled(operation, replacementCancel);
    } else {
      expect(replacementCancel).not.toHaveBeenCalled();
    }
    if (change === "Stop") {
      expect(operation.result).toMatchObject({ kind: "aborted", code: "aborted_by_user" });
    } else if (change === "completion") {
      expect(operation.result).toEqual({ kind: "completed" });
    } else if (change === "hard deadline" || change === "revocation") {
      expectStalled(operation, cancel);
    } else if (change === "progress" || change === "attempt") {
      expect(operation.watchdog.decide().action).toBe("observe");
      expect(operation.result).toBeNull();
      if (change === "attempt") {
        expect(assess).toHaveBeenCalledTimes(2);
        expect(successorSignal?.aborted).toBe(false);
      }
    }
    expect(operation.abortSignal.reason ?? {}).not.toHaveProperty("assessment");
    operation.complete();
    successorResponse.resolve({ state: "unknown", basis: "process_present" });
    if (change === "attempt") {
      expect(successorSignal?.aborted).toBe(true);
    }
  });
});
