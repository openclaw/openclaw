import { expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import {
  hasGatewayCleanupRetainedError,
  isGatewayCleanupRetainedError,
  resolveGatewayShutdownNotice,
  runGatewayCloseSteps,
} from "./server-shutdown.js";

it("omits invalid restart metadata and normalizes the reason", () => {
  expect(
    resolveGatewayShutdownNotice({ reason: "  upgrade  ", restartExpectedMs: Number.NaN }),
  ).toEqual({ reason: "upgrade" });
  expect(resolveGatewayShutdownNotice({ restartExpectedMs: -2 })).toEqual({
    reason: "gateway stopping",
    restartExpectedMs: 0,
  });
});

it.for([false, true])(
  "bounds a held sidecar and preserves fatal close status (%s)",
  async (fatal) => {
    vi.useFakeTimers();
    const sidecar = createDeferredCore();
    const close = vi.fn(async () => {
      if (fatal) {
        throw new Error("synthetic persistence failure");
      }
    });
    const onError = vi.fn();
    const noWork = async () => undefined;
    const closing = runGatewayCloseSteps({
      owner: {
        connectionWork: { drain: noWork },
        stopConnectionDependentSidecars: noWork,
        stopRegisteredGatewayLifetimeSidecars: () => sidecar.promise,
        stopRegisteredPostReadySidecars: noWork,
        runClosePrelude: noWork,
        sealAndJoinRegisteredSidecarStops: noWork,
      },
      exitAfterClose: true,
      close,
      onError,
    }).catch((error: unknown) => error);
    try {
      await vi.advanceTimersByTimeAsync(5_000);
      expect(close).toHaveBeenCalledOnce();
      const failure = await closing;
      expect(hasGatewayCleanupRetainedError(failure)).toBe(true);
      expect(isGatewayCleanupRetainedError(failure)).toBe(!fatal);
      expect(onError).toHaveBeenCalledWith(
        expect.stringMatching(
          /^gateway lifetime sidecars cleanup exceeded 5000ms; resources remain; pending: shutdown\.gateway-lifetime-sidecars=\d+ms$/,
        ),
      );
    } finally {
      sidecar.resolve();
      await closing;
      vi.useRealTimers();
    }
  },
);
