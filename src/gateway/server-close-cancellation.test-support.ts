import { expect, it } from "vitest";
import { isAgentRunRestartAbortReason } from "../agents/run-termination.js";
import { bindGatewayContextResolver } from "../plugins/runtime/gateway-request-scope.js";
import type { ReplyOperation } from "../sessions/session-controller.contracts.js";
import { captureSessionTarget } from "../sessions/session-controller.lifecycle.js";
import { createReplyOperation } from "../sessions/session-controller.operation.js";
import { createDeferredCore } from "../shared/deferred.js";
import type {
  createGatewayCloseTestHandlerFactory,
  GatewayCloseParams,
} from "./server-close.test-support.js";
import type { createRpcSourceForTest } from "./test-helpers.rpc-source.js";

export function registerGatewayCancellationTests({
  createClose,
  createSource,
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
  it("records running sessions before aborting work and running shutdown hooks", async () => {
    const { source } = await createSource("queued-1", {}, { phase: "waiting" });
    const order: string[] = [];
    source.input.abortSignal.addEventListener("abort", () => order.push("source"), { once: true });
    setShutdownHook(async () => {
      order.push("hook");
    });
    await createClose({
      persistRunningSessionsForRestart: async () => {
        expect(source.input.abortSignal.aborted).toBe(false);
        order.push("marker");
      },
      cancelReceivedWork: (reason) => {
        expect(isAgentRunRestartAbortReason(reason)).toBe(true);
        order.push("received");
      },
    })();
    expect(order).toEqual(["marker", "source", "received", "hook"]);
    expect(source.input.abortSignal.aborted).toBe(true);
  });

  it.each([false, true])(
    "preserves foreign and replacement work at shutdown (marker fails: %s)",
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
      const markerEntered = createDeferredCore();
      const markerCommitted = createDeferredCore();
      const receivedWork = new AbortController();
      const markerFailure = new Error("marker write failed");
      const close = createClose({
        persistRunningSessionsForRestart: async () => {
          markerEntered.resolve();
          await markerCommitted.promise;
          if (markerFails) {
            throw markerFailure;
          }
        },
        cancelReceivedWork: (reason) => receivedWork.abort(reason),
        channelIds: ["telegram"],
        stopChannel: async () => {
          expect(reboundDuringAbort.abortSignal.aborted).toBe(false);
          reboundDuringAbort.complete();
        },
        resolveGatewayContext,
      });
      const closing = close({ restartExpectedMs: 123 });
      const outcome = closing.then(
        () => undefined,
        (error: unknown) => error,
      );
      try {
        await markerEntered.promise;
        expect(owned.abortSignal.aborted).toBe(false);
        expect(receivedWork.signal.aborted).toBe(false);
        replaced.complete();
        const replacement = begin(replaced.key);
        markerCommitted.resolve();
        if (markerFails) {
          expect(await outcome).toBe(markerFailure);
        } else {
          expect(await outcome).toBeUndefined();
        }
        expect(isAgentRunRestartAbortReason(receivedWork.signal.reason)).toBe(true);
        expect(isAgentRunRestartAbortReason(owned.abortSignal.reason)).toBe(true);
        expect(other.abortSignal.aborted).toBe(false);
        expect(reboundDuringAbort.abortSignal.aborted).toBe(false);
        expect(replacement.abortSignal.aborted).toBe(false);
      } finally {
        markerCommitted.resolve();
        for (const operation of operations) {
          operation.complete();
        }
        await outcome;
      }
    },
  );
}
