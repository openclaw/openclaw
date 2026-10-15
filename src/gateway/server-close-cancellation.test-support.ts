import { expect, it, vi } from "vitest";
import { isAgentRunRestartAbortReason } from "../agents/run-termination.js";
import {
  createReplyOperation,
  type ReplyOperation,
} from "../auto-reply/reply/reply-run-registry.js";
import { bindGatewayContextResolver } from "../plugins/runtime/gateway-request-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import type {
  createGatewayCloseTestHandlerFactory,
  GatewayCloseParams,
} from "./server-close.test-support.js";

type MarkMainSessionsAbortedForRestart = NonNullable<
  GatewayCloseParams["markMainSessionsAbortedForRestart"]
>;

export function registerGatewayCancellationTests({
  createClose,
  setShutdownHook,
}: {
  createClose: (
    overrides?: Partial<GatewayCloseParams>,
  ) => ReturnType<ReturnType<typeof createGatewayCloseTestHandlerFactory>>;
  setShutdownHook: (hook: () => Promise<void>) => void;
}) {
  it("records recovery before canceling received work and running ordinary shutdown hooks", async () => {
    const order: string[] = [];
    const marker = vi.fn(() => {
      order.push("marker");
    });
    setShutdownHook(async () => {
      order.push("hook");
    });
    const close = createClose({
      cancelReceivedWork: (reason) => {
        expect(isAgentRunRestartAbortReason(reason)).toBe(true);
        order.push("cancel");
      },
      markMainSessionsAbortedForRestart: marker,
      disposeAllCodeModeRuns: () => {
        order.push("dispose");
      },
    });
    await close();
    expect(order).toEqual(["marker", "cancel", "hook", "dispose"]);
    expect(marker).toHaveBeenCalledOnce();
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
        });
        operation.setPhase("running");
        bindGatewayContextResolver(operation, resolver);
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
      const cancelReceivedWork = vi.fn((reason?: Error) => receivedWork.abort(reason));
      const observed: boolean[] = [];
      const markMainSessionsAbortedForRestart = vi.fn<MarkMainSessionsAbortedForRestart>(
        async () => {
          markerEntered.resolve(undefined);
          await markerCommitted.promise;
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
        },
        disposeAllCodeModeRuns: () => {
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
        expect(cancelReceivedWork).toHaveBeenCalledOnce();
        expect(isAgentRunRestartAbortReason(receivedWork.signal.reason)).toBe(true);
        expect(isAgentRunRestartAbortReason(owned.abortSignal.reason)).toBe(true);
        expect(other.abortSignal.aborted).toBe(false);
        expect(reboundDuringAbort.abortSignal.aborted).toBe(false);
        expect(replacement.abortSignal.aborted).toBe(false);
        expect(finalizing.abortSignal.aborted).toBe(false);
        expect(finalizing.result).toBeNull();
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
