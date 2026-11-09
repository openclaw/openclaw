import { expect, it } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { runLoopFixture } from "./run-loop-mocks.test-support.js";

it.each([
  "drained",
  "embedded",
  "undrained",
  "service-failed",
  "retained-failed",
  "finalizer-failed",
  "receipt-failed",
])("requests a settled bound only for clean process-owned cleanup: %s", async (mode) => {
  const { createGatewayRunCleanup } = await import("./run-loop-cleanup.js");
  const cleanup = createGatewayRunCleanup(
    mode !== "embedded",
    {
      stopActiveManagedProviderLocalServices: async () => {
        if (mode === "service-failed") {
          throw new Error(mode);
        }
      },
    },
    runLoopFixture.gatewayLog,
    () => false,
  );
  const retained = createDeferred();
  cleanup.retain(retained.promise);
  const finalizers = {
    getExitCode: () => 0,
    retireSignals() {},
    drainSignals: async () => {},
    closeTerminalServer: async () => {},
    retireHost: () => undefined,
    closeSharedState: async () => {
      if (mode === "finalizer-failed") {
        throw new Error(mode);
      }
    },
    releaseLock: async () => {},
    clearStartupWatchdog() {},
    requestWatchdogs: new Set<() => void>(),
    cleanupSignals: () => cleanup.releaseProcessLifetime(),
    onSettled: () => {
      if (mode === "receipt-failed") {
        throw new Error(mode);
      }
    },
  };
  try {
    if (mode !== "undrained") {
      await cleanup.drainProcessResources();
    }
    const settling = cleanup.settleFinalResources(finalizers);
    await Promise.resolve();
    expect(runLoopFixture.requestSettledExitWatchdog).not.toHaveBeenCalled();
    if (mode === "retained-failed") {
      retained.reject(new Error(mode));
    } else {
      retained.resolve();
    }
    if (mode === "finalizer-failed" || mode === "receipt-failed") {
      await expect(settling).rejects.toThrow(mode);
    } else {
      expect(await settling).toBe(mode.endsWith("failed") ? 1 : 0);
    }
    if (mode === "drained") {
      expect(runLoopFixture.requestSettledExitWatchdog).toHaveBeenCalledExactlyOnceWith(10_000);
    } else {
      expect(runLoopFixture.requestSettledExitWatchdog).not.toHaveBeenCalled();
    }
  } finally {
    retained.resolve();
    cleanup.releaseProcessLifetime();
  }
});
