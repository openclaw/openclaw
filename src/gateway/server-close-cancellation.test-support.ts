import { expect, it, vi } from "vitest";
import { isAgentRunRestartAbortReason } from "../agents/run-termination.js";
import { bindGatewayContextResolver } from "../plugins/runtime/gateway-request-scope.js";
import type { ReplyOperation } from "../sessions/session-controller.contracts.js";
import {
  beginSessionEffect,
  captureSessionTarget,
} from "../sessions/session-controller.lifecycle.js";
import { trackSessionControllerSourceWork } from "../sessions/session-controller.mailbox.js";
import { createReplyOperation } from "../sessions/session-controller.operation.js";
import { rpcSourceTesting } from "../sessions/session-lifecycle-admission.test-support.js";
import { createDeferredCore } from "../shared/deferred.js";
import { formatGatewayPendingCloseSteps } from "./restart-trace.js";
import type {
  createGatewayCloseTestHandlerFactory,
  GatewayCloseParams,
} from "./server-close.test-support.js";
import type { createRpcSourceForTest } from "./test-helpers.rpc-source.js";

type MarkMainSessionsAbortedForRestart = NonNullable<
  GatewayCloseParams["markMainSessionsAbortedForRestart"]
>;

export function registerGatewayCancellationTests({
  createClose,
  createSource,
  resolveGatewayContext: resolveClosingGatewayContext,
  setShutdownHook,
}: {
  createClose: (
    overrides?: Partial<GatewayCloseParams>,
  ) => ReturnType<ReturnType<typeof createGatewayCloseTestHandlerFactory>>;
  createSource: (
    runId: string,
    metadata?: Parameters<typeof createRpcSourceForTest>[0],
    options?: Parameters<typeof createRpcSourceForTest>[1],
  ) => Promise<{ source: ReturnType<typeof createRpcSourceForTest> }>;
  resolveGatewayContext: GatewayCloseParams["resolveGatewayContext"];
  setShutdownHook: (hook: () => Promise<void>) => void;
}) {
  it.each([-60_000, 60_000])(
    "honors the reply drain budget when the wall clock moves by %s ms",
    async (clockShift) => {
      const { source } = await createSource("clock-shift");
      vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
      vi.setSystemTime(100_000);
      const closing = createClose()({ reason: "clock-shift shutdown", drainTimeoutMs: 1_000 });
      try {
        await vi.advanceTimersByTimeAsync(100);
        vi.setSystemTime(Date.now() + clockShift);
        await vi.advanceTimersByTimeAsync(899);
        expect(source.input.abortSignal.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(source.input.abortSignal.aborted).toBe(true);
        expect((await closing).warnings).toContain("restart-reply-drain");
        expect(rpcSourceTesting.size).toBe(0);
      } finally {
        // Release the original wall-clock implementation too when proving the regression red.
        vi.setSystemTime(102_000);
        await vi.advanceTimersByTimeAsync(1_000);
        await closing;
      }
    },
  );

  it("records recovery before aborting queued turns and retains effect custody after sources settle", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const active = [];
    for (let index = 0; index < 5; index++) {
      active.push(await createSource(`active-${index}`));
    }
    const { source: pendingReply } = await createSource("pending-reply", {}, { phase: "waiting" });
    const background = await beginSessionEffect({
      target: captureSessionTarget({
        storeScope: "/synthetic/gateway-close/sessions.sqlite",
        sessionKey: "agent:main:background",
        incarnation: "background",
      }),
      resolveGatewayContext: resolveClosingGatewayContext,
      onInterrupt: () => background.release(),
    });
    const cleanup = createDeferredCore();
    const effectCleanup = createDeferredCore();
    const retainedEffect = await beginSessionEffect({
      target: captureSessionTarget({
        storeScope: "/synthetic/gateway-close/sessions.sqlite",
        sessionKey: "agent:main:retained-effect",
        incarnation: "retained-effect",
      }),
      run: { runId: "retained-effect-run" },
      resolveGatewayContext: resolveClosingGatewayContext,
      onInterrupt: () => retainedEffect.release(),
    });
    const effectWork = retainedEffect.run(() => effectCleanup.promise);
    const retained = active[0]!.source;
    trackSessionControllerSourceWork(retained.input, cleanup.promise);
    const sourcesSettled = Promise.all([
      ...active.slice(1).map(({ source }) => source.input.settlement.promise),
      pendingReply.input.settlement.promise,
      background.released,
    ]);
    const closed = vi.fn();
    let queuedAbortedAtRecovery: boolean | undefined;
    const closing = createClose({
      getPendingReplyCount: () => Number(!pendingReply.input.abortSignal.aborted),
      markMainSessionsAbortedForRestart: () => {
        queuedAbortedAtRecovery = pendingReply.input.abortSignal.aborted;
      },
    })({ reason: "SIGTERM", drainTimeoutMs: 0 }).then((result) => {
      expect(result.warnings).toContain("restart-reply-drain");
      closed();
    });
    try {
      await sourcesSettled;
      expect(active.every(({ source }) => source.input.abortSignal.aborted)).toBe(true);
      expect(pendingReply.input.abortSignal.aborted).toBe(true);
      expect(queuedAbortedAtRecovery).toBe(false);
      expect(pendingReply.input.phase).toBe("consumed");
      expect(background.isActive()).toBe(false);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(formatGatewayPendingCloseSteps()).toMatch(
        /session-sources=\d+ms sources=1.0 operations=0.0 sourceWork=1.0/,
      );
      expect(formatGatewayPendingCloseSteps()).toMatch(
        /session-effects=\d+ms effects=1.0 phase=acquired sessionKey=agent:main:retained-effect runId=retained-effect-run interrupted=true/,
      );
      cleanup.resolve();
      await retained.input.settlement.promise;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(formatGatewayPendingCloseSteps()).not.toContain("session-sources=");
      expect(formatGatewayPendingCloseSteps()).toContain("effects=1.0");
      expect(closed).not.toHaveBeenCalled();
    } finally {
      cleanup.resolve();
      effectCleanup.resolve();
      await effectWork;
      retainedEffect.release();
      background.release();
      await closing;
    }
    expect(closed).toHaveBeenCalledOnce();
    expect(rpcSourceTesting.size).toBe(0);
    expect(formatGatewayPendingCloseSteps()).toBe("none");
  });

  it.each([false, true])(
    "cancels only captured Gateway replies before disposal (marker fails: %s)",
    async (markerFails) => {
      const resolveGatewayContext = () => undefined;
      const otherGatewayContext = () => undefined;
      const operations: ReplyOperation[] = [];
      const begin = (key: string, resolver = resolveGatewayContext) => {
        const operation = createReplyOperation({
          sessionKey: key,
          sessionId: key,
          resetTriggered: false,
          target: captureSessionTarget({
            storeScope: "/synthetic/gateway-close/cancellation.sqlite",
            sessionKey: key,
            incarnation: key,
            agentId: "main",
          }),
        });
        operation.setPhase("running");
        bindGatewayContextResolver(operation, resolver);
        operation.abortSignal.addEventListener("abort", () => operation.complete(), { once: true });
        operations.push(operation);
        return operation;
      };
      const owned = begin("agent:main:closing");
      const reboundDuringAbort = begin("agent:main:rebound");
      owned.abortSignal.addEventListener(
        "abort",
        () => bindGatewayContextResolver(reboundDuringAbort, otherGatewayContext),
        { once: true },
      );
      const replaced = begin("agent:main:replaced");
      const other = begin("agent:main:other", otherGatewayContext);
      const finalizing = begin("agent:main:finalizing");
      finalizing.freezeAbort();
      const markerEntered = createDeferredCore();
      const markerCommitted = createDeferredCore();
      const receivedWork = new AbortController();
      const order: string[] = [];
      setShutdownHook(async () => {
        order.push("hook");
      });
      const cancelReceivedWork = vi.fn((reason?: Error) => {
        order.push("cancel");
        receivedWork.abort(reason);
      });
      const observed: boolean[] = [];
      let finalizingWasPreserved = false;
      const markMainSessionsAbortedForRestart = vi.fn<MarkMainSessionsAbortedForRestart>(
        async () => {
          markerEntered.resolve(undefined);
          await markerCommitted.promise;
          order.push("marker");
          if (markerFails) {
            throw new Error("marker write failed");
          }
        },
      );
      const close = createClose({
        getPendingReplyCount: () => Number(!owned.abortSignal.aborted),
        markMainSessionsAbortedForRestart,
        cancelReceivedWork,
        channelIds: ["telegram"],
        stopChannel: async () => {
          observed.push(owned.abortSignal.aborted && receivedWork.signal.aborted);
          finalizingWasPreserved = !finalizing.abortSignal.aborted && finalizing.result === null;
          // Captured owners finish their real cleanup even when cancellation is refused.
          finalizing.complete();
          reboundDuringAbort.complete();
        },
        disposeAllCodeModeRuns: () => {
          order.push("dispose");
          observed.push(owned.abortSignal.aborted && receivedWork.signal.aborted);
        },
        resolveGatewayContext,
      });
      try {
        const closing = close({ restartExpectedMs: 123, drainTimeoutMs: 0 });
        await markerEntered.promise;
        expect(owned.abortSignal.aborted).toBe(false);
        expect(cancelReceivedWork).not.toHaveBeenCalled();
        replaced.complete();
        const replacement = begin(replaced.key);
        markerCommitted.resolve(undefined);
        const result = await closing;

        expect(markMainSessionsAbortedForRestart).toHaveBeenCalledWith(
          expect.objectContaining({ activeRuns: [], reason: "gateway restart shutdown" }),
        );
        expect(observed).toEqual([true, true]);
        expect(order).toEqual(["marker", "cancel", "hook", "dispose"]);
        expect(cancelReceivedWork).toHaveBeenCalledOnce();
        expect(isAgentRunRestartAbortReason(receivedWork.signal.reason)).toBe(true);
        expect(isAgentRunRestartAbortReason(owned.abortSignal.reason)).toBe(true);
        expect(other.abortSignal.aborted).toBe(false);
        expect(reboundDuringAbort.abortSignal.aborted).toBe(false);
        expect(replacement.abortSignal.aborted).toBe(false);
        expect(finalizing.abortSignal.aborted).toBe(false);
        expect(finalizingWasPreserved).toBe(true);
        expect(result.warnings.includes("restart-main-session-marker")).toBe(markerFails);
      } finally {
        markerCommitted.resolve(undefined);
        for (const operation of operations) {
          operation.complete();
        }
      }
    },
  );
}
