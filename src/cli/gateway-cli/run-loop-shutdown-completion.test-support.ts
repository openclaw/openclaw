/** Registers shutdown completion deadlines in the original run-loop signal fixture. */
import { performance } from "node:perf_hooks";
import { expect, it, vi, type Mock } from "vitest";
import { LAUNCH_AGENT_EXIT_TIMEOUT_SECONDS } from "../../daemon/launchd-plist.js";
import {
  setPlatform,
  withIsolatedSignals,
  type UpdateRespawnFixtures,
} from "./run-loop.test-support.js";

export function registerShutdownCompletionTests({
  hasManagedProviderLocalServices,
  stopManagedProviderLocalServices,
  createSignaledLoopHarness,
  consumeGatewayRestartIntent,
  managedUpdateSuccessorOwner,
  cancelManagedServiceUpdateHandoff,
  commitManagedServiceUpdateHandoff,
  requestManagedServiceUpdateHandoffPark,
  writeGatewayRestartHandoffSync,
  flushLogger,
  restartGatewayProcessWithFreshPid,
  gatewayLog,
  armShutdownHardExitWatchdog,
  cancelShutdownHardExitWatchdog,
  writeDiagnosticStabilityBundleForFailureSync,
}: Pick<
  UpdateRespawnFixtures,
  | "hasManagedProviderLocalServices"
  | "stopManagedProviderLocalServices"
  | "createSignaledLoopHarness"
  | "consumeGatewayRestartIntent"
  | "managedUpdateSuccessorOwner"
  | "cancelManagedServiceUpdateHandoff"
  | "commitManagedServiceUpdateHandoff"
  | "requestManagedServiceUpdateHandoffPark"
  | "writeGatewayRestartHandoffSync"
  | "flushLogger"
  | "restartGatewayProcessWithFreshPid"
> & {
  gatewayLog: { error: Mock; warn: Mock };
  armShutdownHardExitWatchdog: Mock;
  cancelShutdownHardExitWatchdog: Mock;
  writeDiagnosticStabilityBundleForFailureSync: Mock;
}): void {
  it("reports failure when foreground provider service cleanup times out after server close", async () => {
    vi.clearAllMocks();
    hasManagedProviderLocalServices.mockReturnValue(true);
    stopManagedProviderLocalServices.mockReturnValue(new Promise<void>(() => {}));
    await withIsolatedSignals(async ({ captureSignal }) => {
      const { close, runtime } = await createSignaledLoopHarness();
      vi.useFakeTimers();
      try {
        captureSignal("SIGTERM")();
        await vi.advanceTimersByTimeAsync(324_999);
        expect(close).toHaveBeenCalledOnce();
        expect(stopManagedProviderLocalServices).toHaveBeenCalledOnce();
        expect(runtime.exit).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(runtime.exit).toHaveBeenCalledExactlyOnceWith(1);
        expect(writeDiagnosticStabilityBundleForFailureSync).toHaveBeenCalledWith(
          "gateway.stop_shutdown_timeout",
          undefined,
        );
      } finally {
        vi.clearAllTimers();
        vi.useRealTimers();
      }
    });
  });

  it.each(["systemd", "launchd"] as const)(
    "preserves a recorded close failure when %s final cleanup crosses the deadline",
    async (supervisor) => {
      vi.clearAllMocks();
      const deadlineMs =
        supervisor === "launchd" ? LAUNCH_AGENT_EXIT_TIMEOUT_SECONDS * 1_000 - 5_000 : 325_000;
      if (supervisor === "systemd") {
        process.env.OPENCLAW_SYSTEMD_UNIT = "openclaw-gateway.service";
        setPlatform("linux");
      } else {
        process.env.OPENCLAW_LAUNCHD_LABEL = "ai.openclaw.gateway";
        setPlatform("darwin");
      }
      hasManagedProviderLocalServices.mockReturnValue(true);
      stopManagedProviderLocalServices.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            setTimeout(resolve, 2_000);
          }),
      );
      await withIsolatedSignals(async ({ captureSignal }) => {
        const { close, runtime } = await createSignaledLoopHarness();
        close.mockImplementationOnce(async () => {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, deadlineMs - 1_000);
          });
          throw new Error("close owner failed");
        });
        vi.useFakeTimers();
        const clock = vi.spyOn(performance, "now").mockImplementation(() => Date.now());
        try {
          captureSignal("SIGTERM")();
          await vi.advanceTimersByTimeAsync(deadlineMs - 1);
          expect(gatewayLog.error).toHaveBeenCalledWith(
            "shutdown step failed (gateway server close): close owner failed",
          );
          expect(stopManagedProviderLocalServices).toHaveBeenCalledOnce();
          expect(runtime.exit).not.toHaveBeenCalled();
          await vi.advanceTimersByTimeAsync(1);
          expect(runtime.exit).toHaveBeenCalledExactlyOnceWith(1);
          expect(writeDiagnosticStabilityBundleForFailureSync).toHaveBeenLastCalledWith(
            "gateway.stop_shutdown_timeout",
            expect.objectContaining({ message: "close owner failed" }),
            { shutdownStep: "gateway-server-close" },
          );
        } finally {
          clock.mockRestore();
          vi.clearAllTimers();
          vi.useRealTimers();
        }
      });
    },
  );

  it.each([true, false])(
    "bounds abandoned cleanup after managed parking (restore commit=%s)",
    async (restoreCommitted) => {
      vi.clearAllMocks();
      process.env.OPENCLAW_SYSTEMD_UNIT = "openclaw-gateway.service";
      setPlatform("linux");
      consumeGatewayRestartIntent.mockReturnValueOnce({
        force: true,
        reason: "update.run",
        successorOwner: managedUpdateSuccessorOwner,
      });
      cancelManagedServiceUpdateHandoff
        .mockResolvedValueOnce("restart-after-exit")
        .mockResolvedValue("restored-in-process");
      commitManagedServiceUpdateHandoff.mockResolvedValueOnce(restoreCommitted);
      await withIsolatedSignals(async ({ captureSignal }) => {
        const { close, start, runtime } = await createSignaledLoopHarness();
        close.mockReturnValue(new Promise<void>(() => {}));
        vi.useFakeTimers();
        try {
          captureSignal("SIGUSR2")();
          await vi.advanceTimersByTimeAsync(9_999);
          expect(requestManagedServiceUpdateHandoffPark).toHaveBeenCalledWith(
            managedUpdateSuccessorOwner,
          );
          expect(close).toHaveBeenCalledOnce();
          expect(runtime.exit).not.toHaveBeenCalled();
          await vi.advanceTimersByTimeAsync(1);
          expect(runtime.exit).toHaveBeenCalledExactlyOnceWith(0);
          expect(start).toHaveBeenCalledOnce();
          expect(commitManagedServiceUpdateHandoff).toHaveBeenCalledWith(
            managedUpdateSuccessorOwner,
            "restore",
          );
          expect(writeDiagnosticStabilityBundleForFailureSync).toHaveBeenCalledWith(
            "gateway.restart_shutdown_timeout",
            undefined,
          );
        } finally {
          vi.clearAllTimers();
          vi.useRealTimers();
        }
      });
    },
  );

  it("retains external supervisor recovery when timeout prevents a restart handoff", async () => {
    vi.clearAllMocks();
    process.env.OPENCLAW_SUPERVISOR_MODE = "external";
    consumeGatewayRestartIntent.mockReturnValueOnce({ force: true });
    await withIsolatedSignals(async ({ captureSignal }) => {
      const { close, runtime } = await createSignaledLoopHarness();
      close.mockReturnValue(new Promise<void>(() => {}));
      vi.useFakeTimers();
      try {
        captureSignal("SIGUSR2")();
        await vi.advanceTimersByTimeAsync(325_000);
        expect(writeGatewayRestartHandoffSync).not.toHaveBeenCalled();
        expect(runtime.exit).toHaveBeenCalledExactlyOnceWith(1);
      } finally {
        vi.clearAllTimers();
        vi.useRealTimers();
      }
    });
  });

  it.each([
    { signal: "SIGTERM", timeoutMs: 4_000 },
    { signal: "SIGUSR2", timeoutMs: 1_000 },
  ] as const)("bounds the file-log flush before a $signal exit", async ({ signal, timeoutMs }) => {
    vi.clearAllMocks();

    await withIsolatedSignals(async ({ captureSignal }) => {
      const { close, runtime, exited } = await createSignaledLoopHarness();
      if (signal === "SIGUSR2") {
        close.mockRejectedValueOnce(new Error("close owner failed"));
      }
      const signalExit = captureSignal(signal);
      flushLogger.mockReturnValueOnce(new Promise<void>(() => {}));
      vi.useFakeTimers();
      try {
        signalExit();
        await vi.advanceTimersByTimeAsync(timeoutMs);

        await expect(exited).resolves.toBe(signal === "SIGUSR2" ? 1 : 0);
        expect(runtime.exit).toHaveBeenCalledWith(signal === "SIGUSR2" ? 1 : 0);
        expect(gatewayLog.warn).toHaveBeenCalledWith(
          `log flush did not settle within ${timeoutMs}ms; continuing shutdown`,
        );
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("retains the restart deadline when a managed update arrives after final cleanup fails", async () => {
    vi.clearAllMocks();
    process.env.OPENCLAW_SUPERVISOR_MODE = "external";
    consumeGatewayRestartIntent.mockReturnValueOnce({ force: true });
    restartGatewayProcessWithFreshPid.mockReturnValueOnce({ mode: "supervised" });
    await withIsolatedSignals(async ({ captureSignal }) => {
      const { close, start, runtime, exited } = await createSignaledLoopHarness(undefined, true);
      flushLogger.mockRejectedValueOnce(new Error("shutdown cleanup failed"));
      const restartSignal = captureSignal("SIGUSR2");
      vi.useFakeTimers();
      try {
        restartSignal();
        await vi.advanceTimersByTimeAsync(10_000);
        expect(close).toHaveBeenCalledOnce();
        expect(gatewayLog.error).toHaveBeenCalledWith(
          "gateway lifecycle completion failed: shutdown cleanup failed",
        );
        consumeGatewayRestartIntent.mockReturnValueOnce({
          force: true,
          reason: "update.run",
          successorOwner: managedUpdateSuccessorOwner,
        });
        restartSignal();
        await vi.advanceTimersByTimeAsync(314_999);
        expect(runtime.exit).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(runtime.exit).toHaveBeenCalledExactlyOnceWith(1);
        await expect(exited).resolves.toBe(1);
        expect(cancelManagedServiceUpdateHandoff).toHaveBeenCalledExactlyOnceWith(
          managedUpdateSuccessorOwner,
        );
        expect(requestManagedServiceUpdateHandoffPark).not.toHaveBeenCalled();
        expect(start).toHaveBeenCalledOnce();
        expect(armShutdownHardExitWatchdog).toHaveBeenCalledOnce();
        expect(cancelShutdownHardExitWatchdog).not.toHaveBeenCalled();
      } finally {
        vi.clearAllTimers();
        vi.useRealTimers();
      }
    });
  });

  it.each([
    { signal: "SIGTERM", failure: "exit handler" },
    { signal: "SIGTERM", failure: "log flush" },
    { signal: "SIGUSR2", failure: "exit handler" },
    { signal: "SIGUSR2", failure: "log flush" },
  ] as const)(
    "retains $signal deadlines when $failure throws after server close",
    async ({ signal, failure }) => {
      vi.clearAllMocks();
      process.env.OPENCLAW_SUPERVISOR_MODE = "external";
      restartGatewayProcessWithFreshPid.mockReturnValueOnce({ mode: "supervised" });
      await withIsolatedSignals(async ({ captureSignal }) => {
        const { close, runtime, exited } = await createSignaledLoopHarness(undefined, true);
        const error = new TypeError("shutdown cleanup failed");
        if (failure === "exit handler") {
          runtime.exit.mockImplementationOnce(() => {
            throw error;
          });
        } else {
          flushLogger.mockRejectedValueOnce(error);
        }
        vi.useFakeTimers();
        try {
          captureSignal(signal)();
          await vi.advanceTimersByTimeAsync(0);
          expect(close).toHaveBeenCalledOnce();
          expect(gatewayLog.error).toHaveBeenCalledWith(
            "gateway lifecycle completion failed: shutdown cleanup failed",
          );
          expect(armShutdownHardExitWatchdog).toHaveBeenCalledOnce();
          expect(cancelShutdownHardExitWatchdog).not.toHaveBeenCalled();
          await vi.advanceTimersByTimeAsync(625_000);
          await expect(exited).resolves.toBe(1);
        } finally {
          vi.clearAllTimers();
          vi.useRealTimers();
        }
      });
    },
  );
}
