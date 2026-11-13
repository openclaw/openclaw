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

it.for([
  { kind: "lifetime", fails: false },
  { kind: "post-ready", fails: false },
  { kind: "lifetime", fails: true },
  { kind: "post-ready", fails: true },
])(
  "uses the final sidecar join after $kind cleanup exceeds its grace (fails=$fails)",
  async ({ kind, fails }) => {
    vi.useFakeTimers();
    const release = createDeferredCore();
    const sidecars = createGatewaySidecarStopOwner();
    sidecars.publish({ name: "held-sidecar", stop: () => release.promise });
    const noWork = async () => undefined;
    const close = vi.fn(noWork);
    const onError = vi.fn();
    const closing = runGatewayCloseSteps({
      owner: {
        connectionWork: { drain: noWork },
        stopConnectionDependentSidecars: noWork,
        stopRegisteredGatewayLifetimeSidecars: kind === "lifetime" ? sidecars.stop : noWork,
        stopRegisteredPostReadySidecars: kind === "post-ready" ? sidecars.stop : noWork,
        runClosePrelude: noWork,
        sealAndJoinRegisteredSidecarStops: sidecars.sealAndJoin,
      },
      exitAfterClose: true,
      close,
      onError,
    }).catch((error: unknown) => error);
    try {
      await vi.advanceTimersByTimeAsync(5_001);
      expect(onError).toHaveBeenCalledWith(expect.stringContaining("cleanup exceeded 5000ms"));
      expect(close).not.toHaveBeenCalled();
      if (fails) {
        release.reject(new Error("sidecar stop failed"));
        expect(await closing).toHaveProperty(
          "message",
          expect.stringContaining("sidecar stop failed"),
        );
        expect(close).not.toHaveBeenCalled();
        expect(sidecars.snapshot()).toHaveLength(1);
      } else {
        release.resolve();
        expect(await closing).toBeUndefined();
        expect(close).toHaveBeenCalledOnce();
        expect(sidecars.snapshot()).toEqual([]);
      }
    } finally {
      release.resolve();
      await closing;
      vi.useRealTimers();
    }
  },
);

it.for(["optional", "fatal", "required", "required-close"])(
  "joins required work and preserves fatal close status (%s)",
  async (mode) => {
    const fatal = mode === "fatal";
    const required = mode.startsWith("required");
    const requiredClose = mode === "required-close";
    vi.useFakeTimers();
    const sidecar = createDeferredCore();
    const sidecars = createGatewaySidecarStopOwner();
    sidecars.publish({ name: "synthetic-held-worker", stop: () => sidecar.promise });
    const close = vi.fn(async () => {
      if (requiredClose) {
        await sidecars.stop();
      }
      if (fatal) {
        throw new Error("synthetic persistence failure");
      }
    });
    const onError = vi.fn();
    const noWork = async () => undefined;
    const closing = runGatewayCloseSteps({
      owner: {
        connectionWork: { drain: required && !requiredClose ? sidecars.stop : noWork },
        stopConnectionDependentSidecars: noWork,
        stopRegisteredGatewayLifetimeSidecars: noWork,
        stopRegisteredPostReadySidecars: noWork,
        runClosePrelude: noWork,
        sealAndJoinRegisteredSidecarStops: noWork,
      },
      exitAfterClose: true,
      runStopHooks: required ? noWork : sidecars.stop,
      close,
      onError,
    }).catch((error: unknown) => error);
    try {
      await vi.advanceTimersByTimeAsync(requiredClose ? 10_000 : 5_000);
      expect(close).toHaveBeenCalledTimes(required && !requiredClose ? 0 : 1);
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
        expect.stringMatching(
          /cleanup exceeded (5000|10000)ms; resources remain; pending: shutdown\./,
        ),
      );
    } finally {
      sidecar.resolve();
      await closing;
      vi.useRealTimers();
    }
  },
);
