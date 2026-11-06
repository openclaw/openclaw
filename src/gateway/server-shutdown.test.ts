import { expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import {
  hasGatewayCleanupRetainedError,
  isGatewayCleanupRetainedError,
  resolveGatewayShutdownNotice,
  runGatewayCloseSteps,
} from "./server-shutdown.js";
import { createGatewaySidecarStopOwner } from "./server-sidecar-owners.js";

it("omits invalid restart metadata and normalizes the reason", () => {
  expect(
    resolveGatewayShutdownNotice({ reason: "  upgrade  ", restartExpectedMs: Number.NaN }),
  ).toEqual({
    reason: "upgrade",
  });
  expect(resolveGatewayShutdownNotice({ restartExpectedMs: -2 })).toEqual({
    reason: "gateway stopping",
    restartExpectedMs: 0,
  });
});

it.for(["optional", "fatal", "required"])(
  "joins required work and preserves fatal close status (%s)",
  async (mode) => {
    const fatal = mode === "fatal";
    const required = mode === "required";
    vi.useFakeTimers();
    const sidecar = createDeferredCore();
    const sidecars = createGatewaySidecarStopOwner();
    sidecars.publish({ name: "synthetic-held-worker", stop: () => sidecar.promise });
    const close = vi.fn(async () => {
      if (fatal) {
        throw new Error("synthetic persistence failure");
      }
    });
    const onError = vi.fn();
    const noWork = async () => undefined;
    const closing = runGatewayCloseSteps({
      owner: {
        connectionWork: { drain: required ? sidecars.stop : noWork },
        stopConnectionDependentSidecars: noWork,
        stopRegisteredGatewayLifetimeSidecars: required ? noWork : sidecars.stop,
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
      expect(close).toHaveBeenCalledTimes(required ? 0 : 1);
      sidecar.resolve();
      const failure = await closing;
      if (required) {
        expect(failure).toBeUndefined();
        expect(close).toHaveBeenCalledOnce();
      } else {
        expect(hasGatewayCleanupRetainedError(failure)).toBe(true);
        expect(isGatewayCleanupRetainedError(failure)).toBe(!fatal);
        expect(failure).toHaveProperty("message", expect.stringContaining("synthetic-held-worker"));
      }
      expect(onError).toHaveBeenCalledWith(
        expect.stringMatching(/cleanup exceeded 5000ms; resources remain; pending: shutdown\./),
      );
    } finally {
      sidecar.resolve();
      await closing;
      vi.useRealTimers();
    }
  },
);
