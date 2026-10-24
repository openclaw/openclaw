import { expect, it, vi } from "vitest";
import {
  interruptReplyRunTarget,
  createReplyOperation,
} from "../../sessions/session-controller.js";
import { isSessionRunActiveForKey } from "../../sessions/session-controller.queries.js";
import { captureCurrentSessionRunInterruptTarget } from "../../sessions/session-controller.stop-runtime.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { waitForPreparedReplyQueue } from "./get-reply-run-queue.js";

it("waits for the active session before refreshing and rechecking admission", async () => {
  const order: string[] = [];
  const interruptActiveRun = vi.fn();
  const result = await waitForPreparedReplyQueue({
    activeSessionId: "session-active",
    queueMode: "followup",
    interruptActiveRun,
    waitForActiveRunEnd: async (sessionId) => {
      order.push(`wait:${sessionId}`);
    },
    refreshPreparedState: async () => {
      order.push("refresh");
    },
    resolveBusyState: () => {
      order.push("recheck");
      return { isActive: false };
    },
  });
  expect(result).toBeUndefined();
  expect(order).toEqual(["wait:session-active", "refresh", "recheck"]);
  expect(interruptActiveRun).not.toHaveBeenCalled();
});

it.each([
  ["interrupt", false, false, undefined],
  [
    "interrupt",
    true,
    false,
    "⚠️ Previous run is still shutting down. Please try again in a moment.",
  ],
  ["followup", true, true, expect.stringMatching(/separate session or restart the Gateway/u)],
] as const)(
  "%s admission with active=%s, blocked=%s",
  async (queueMode, isActive, terminalProducerBlocked, text) => {
    const interruptActiveRun = vi.fn(async () => queueMode === "interrupt");
    const waitForActiveRunEnd = vi.fn(async () => {
      if (queueMode === "interrupt") {
        throw new Error("interrupt mode must use session-work admission settling");
      }
    });
    const refreshPreparedState = vi.fn(async () => {});
    const result = await waitForPreparedReplyQueue({
      activeSessionId: "session-active",
      queueMode,
      interruptActiveRun,
      waitForActiveRunEnd,
      refreshPreparedState,
      resolveBusyState: () => ({ isActive, terminalProducerBlocked }),
    });
    expect(result).toEqual(text === undefined ? undefined : { text });
    expect(interruptActiveRun).toHaveBeenCalledTimes(queueMode === "interrupt" ? 1 : 0);
    expect(waitForActiveRunEnd).toHaveBeenCalledTimes(queueMode === "followup" ? 1 : 0);
    expect(refreshPreparedState).toHaveBeenCalledOnce();
  },
);
it("does not admit after interrupt timeout merely because the old slot cleared", async () => {
  vi.useFakeTimers();
  const operation = createReplyOperation({
    sessionKey: "agent:main:interrupt-settlement",
    sessionId: "old-writer",
    resetTriggered: false,
  });
  const delivery = createDeferredCore();
  const refreshPreparedState = vi.fn(async () => {});
  try {
    operation.setPhase("running");
    const target = captureCurrentSessionRunInterruptTarget(operation.key);
    if (!target) {
      throw new Error("Missing interrupt owner");
    }
    const waiting = waitForPreparedReplyQueue({
      activeSessionId: operation.sessionId,
      queueMode: "interrupt",
      interruptActiveRun: async () => (await interruptReplyRunTarget(target, 100)).settled,
      waitForActiveRunEnd: async () => {
        throw new Error("wrong wait owner");
      },
      refreshPreparedState,
      resolveBusyState: () => ({
        isActive: isSessionRunActiveForKey(operation.key),
      }),
    });
    expect(operation.abortSignal.aborted).toBe(true);
    operation.completeWithAfterClearBarrier(delivery.promise);
    expect(isSessionRunActiveForKey(operation.key)).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    expect((await waiting)?.text).toContain("shutting down");
    expect(refreshPreparedState).not.toHaveBeenCalled();
  } finally {
    delivery.resolve();
    operation.complete();
    await operation.ownerSettlement;
    vi.useRealTimers();
  }
});
