/** Shutdown request reasons and installation-replacement handoff cases share the run-loop fixture. */
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { withTimeout } from "../../infra/fs-safe.js";
import type { GatewayActiveWorkSnapshot } from "../../infra/gateway-active-work.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { registerGatewayForcedRestartTests } from "./run-loop-force.test-support.js";
import {
  createActiveWorkSnapshot,
  createCloseMock,
  createRuntimeWithExitSignal,
  createSignaledStart,
  waitForStart,
  waitForLoopCondition,
  withIsolatedSignals,
  type UpdateRespawnFixtures,
} from "./run-loop.test-support.js";

async function loadInstallationReplacement() {
  const { classifyGatewayStaleInstall } = await import("../../gateway/stale-install.js");
  return (message: string, code: "ENOENT" | "ERR_MODULE_NOT_FOUND" = "ENOENT") => {
    const missingChunk = new URL("../../gateway/missing-runtime.js", import.meta.url);
    classifyGatewayStaleInstall(
      Object.assign(new Error(message), {
        code,
        ...(code === "ENOENT" ? { path: fileURLToPath(missingChunk) } : { url: missingChunk.href }),
      }),
    );
  };
}

export function registerGatewayRequestTests(fixtures: UpdateRespawnFixtures): void {
  const {
    createSignaledLoopHarness,
    acquireGatewayLock,
    runLoopWithStart,
    waitForGatewayActiveWork,
    waitForActiveCronTaskRuns,
    restartGatewayProcessWithFreshPid,
    respawnGatewayProcessForUpdate,
    captureForegroundUpdateHandoffStop,
    readCgroup,
    systemctl,
    armShutdownHardExitWatchdog,
    cancelShutdownHardExitWatchdog,
    consumeGatewayRestartIntent,
    consumeGatewayRestartIntentPayload,
    consumeGatewayRestartAuthorization,
    writeGatewayRestartHandoff,
    managedUpdateSuccessorOwner,
    commitManagedServiceUpdateHandoff,
    waitForSystemServiceUpdateHandoffs,
    isGatewayWorkAdmissionClosed,
    gatewayLog,
  } = fixtures;
  const idleActiveWorkSnapshot = createActiveWorkSnapshot();
  registerGatewayForcedRestartTests(fixtures);

  it.each(["SIGTERM", "SIGUSR2"] as const)(
    "closes root admission before the %s listener returns",
    async (signal) => {
      const consumed = createDeferredCore<null>();
      consumeGatewayRestartIntentPayload.mockReturnValueOnce(consumed.promise);
      await withIsolatedSignals(async ({ captureSignal }) => {
        const { close, exited } = await createSignaledLoopHarness();
        const admission = await vi.importActual<
          typeof import("../../process/gateway-work-admission.js")
        >("../../process/gateway-work-admission.js");
        restartGatewayProcessWithFreshPid.mockReturnValue({ mode: "supervised" });
        expect(admission.isGatewayWorkAdmissionClosed()).toBe(false);

        captureSignal(signal)();
        const late = admission.tryBeginGatewayRootWorkAdmission("test:after-shutdown-signal");
        try {
          expect(late).toBeNull();
          expect(close).not.toHaveBeenCalled();
        } finally {
          late?.release();
          consumed.resolve(null);
          await expect(exited).resolves.toBe(0);
        }
      });
    },
  );

  it("keeps admission fenced between a refused restart and its queued Stop", async () => {
    const first = createDeferredCore<null>();
    const second = createDeferredCore<null>();
    consumeGatewayRestartAuthorization.mockReturnValueOnce(false);
    consumeGatewayRestartIntentPayload
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    await withIsolatedSignals(async ({ captureSignal }) => {
      const { exited } = await createSignaledLoopHarness();
      const admission = await vi.importActual<
        typeof import("../../process/gateway-work-admission.js")
      >("../../process/gateway-work-admission.js");
      captureSignal("SIGUSR2")();
      captureSignal("SIGTERM")();
      const lateRoot = admission.beginGatewayRootWorkAdmissionWhenOpen("test:queued-stop").then(
        (lease) => {
          lease.release();
          return "admitted";
        },
        () => "refused",
      );
      first.resolve(null);
      second.resolve(null);
      await expect(exited).resolves.toBe(0);
      await expect(lateRoot).resolves.toBe("refused");
    });
  });

  it("joins FIFO signal consumption and defers durable restart upgrades through close", async () => {
    process.env.OPENCLAW_SUPERVISOR_MODE = "external";
    const first = createDeferredCore<null>();
    const second = createDeferredCore<null>();
    const drainEntered = createDeferredCore();
    const closeEntered = createDeferredCore();
    const releaseClose = createDeferredCore();
    consumeGatewayRestartIntentPayload
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockResolvedValueOnce({ reason: "update.run" });
    consumeGatewayRestartAuthorization.mockReturnValueOnce(true).mockReturnValueOnce(false);
    waitForGatewayActiveWork.mockImplementationOnce(async () => {
      drainEntered.resolve();
      return { drained: true, snapshot: idleActiveWorkSnapshot };
    });
    restartGatewayProcessWithFreshPid.mockReturnValue({ mode: "supervised" });
    await withIsolatedSignals(async ({ captureSignal }) => {
      const { close, runtime, exited } = await createSignaledLoopHarness();
      close.mockImplementationOnce(async () => {
        closeEntered.resolve();
        await releaseClose.promise;
      });
      try {
        captureSignal("SIGUSR2")();
        captureSignal("SIGTERM")();
        expect(consumeGatewayRestartIntentPayload).toHaveBeenCalledOnce();
        expect(isGatewayWorkAdmissionClosed()).toBe(true);
        first.resolve(null);
        await drainEntered.promise;
        expect(close).not.toHaveBeenCalled();
        expect(runtime.exit).not.toHaveBeenCalled();
        second.resolve(null);
        await closeEntered.promise;
        captureSignal("SIGUSR2")();
        expect(consumeGatewayRestartIntentPayload).toHaveBeenCalledTimes(2);
      } finally {
        first.resolve(null);
        second.resolve(null);
        releaseClose.resolve();
        await expect(exited).resolves.toBe(0);
      }
      expect(close).toHaveBeenCalledOnce();
      expect(writeGatewayRestartHandoff).toHaveBeenCalledWith(
        expect.objectContaining({ reason: "update.run" }),
        expect.any(Function),
      );
    });
  });

  it("bounds signal storage settlement and refuses its result after forced exit", async () => {
    const consumed = createDeferredCore<{ reason: string } | null>();
    consumeGatewayRestartIntentPayload.mockReturnValueOnce(consumed.promise);
    await withIsolatedSignals(async ({ captureSignal }) => {
      const { close, start, runtime, exited } = await createSignaledLoopHarness();
      const budget = start.mock.calls[0]?.[0]?.hostLifecycle?.getShutdownBudget?.();
      if (!budget) {
        throw new Error("Gateway fixture did not publish its shutdown budget");
      }
      vi.useFakeTimers();
      try {
        captureSignal("SIGTERM")();
        await vi.advanceTimersByTimeAsync(budget.timeoutMs);
        await expect(exited).resolves.toBe(1);
        consumed.resolve({ reason: "gateway.restart" });
        await vi.advanceTimersByTimeAsync(0);
        expect(runtime.exit).toHaveBeenCalledExactlyOnceWith(1);
        expect(close).not.toHaveBeenCalled();
        expect(start).toHaveBeenCalledOnce();
      } finally {
        consumed.resolve(null);
        await vi.advanceTimersByTimeAsync(0);
        vi.useRealTimers();
      }
    });
  });

  it("keeps the original SIGTERM deadline after delayed intent consumption fails", async () => {
    process.env.OPENCLAW_SYSTEMD_UNIT = "openclaw-gateway.service";
    systemctl.mockResolvedValue({
      code: 0,
      stdout: "LoadState=loaded\nTimeoutStopUSec=90s",
      stderr: "",
    });
    const consumed = createDeferredCore<null>();
    const closing = createDeferredCore();
    consumeGatewayRestartIntentPayload.mockReturnValueOnce(consumed.promise);
    await withIsolatedSignals(async ({ captureSignal }) => {
      const { close, start, runtime, exited } = await createSignaledLoopHarness();
      close.mockImplementationOnce(() => closing.promise);
      const budget = start.mock.calls[0]?.[0]?.hostLifecycle?.getShutdownBudget?.();
      if (!budget) {
        throw new Error("Gateway fixture did not publish its shutdown budget");
      }
      const consumedMs = 10_000;
      vi.useFakeTimers();
      const clock = vi.spyOn(performance, "now").mockImplementation(() => Date.now());
      try {
        captureSignal("SIGTERM")();
        await vi.advanceTimersByTimeAsync(consumedMs);
        consumed.reject(new Error("restart intent worker unavailable"));
        await vi.advanceTimersByTimeAsync(0);
        expect(close).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(budget.timeoutMs - consumedMs - 1);
        expect(runtime.exit).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(runtime.exit).toHaveBeenCalledExactlyOnceWith(0);
        await expect(exited).resolves.toBe(0);
      } finally {
        consumed.resolve(null);
        closing.resolve();
        await vi.advanceTimersByTimeAsync(0);
        clock.mockRestore();
        vi.useRealTimers();
      }
    });
  });

  it("settles a queued Stop when restart preparation fails before reopening storage", async () => {
    const preparing = createDeferredCore();
    const preparation = createDeferredCore<{ drained: boolean; active: number }>();
    waitForActiveCronTaskRuns.mockImplementationOnce(() => {
      preparing.resolve();
      return preparation.promise;
    });
    await withIsolatedSignals(async ({ captureSignal }) => {
      const { close, start, runtime, exited } = await createSignaledLoopHarness();
      try {
        captureSignal("SIGUSR2")();
        await preparing.promise;
        const consumed = consumeGatewayRestartIntentPayload.mock.calls.length;
        captureSignal("SIGTERM")();
        expect(consumeGatewayRestartIntentPayload).toHaveBeenCalledTimes(consumed);
        preparation.reject(new Error("restart preparation failed"));
        await expect(exited).resolves.toBe(0);
        expect(consumeGatewayRestartIntentPayload).toHaveBeenCalledTimes(consumed + 1);
        expect(runtime.exit).toHaveBeenCalledExactlyOnceWith(0);
        expect(start).toHaveBeenCalledOnce();
        expect(close).toHaveBeenCalledOnce();
      } finally {
        preparation.resolve({ drained: true, active: 0 });
      }
    });
  });

  it("keeps a captured pre-park Stop ahead of native budget refresh and drain completion", async () => {
    const nativeReply = {
      code: 0,
      stdout: "LoadState=loaded\nTimeoutStopUSec=90s",
      stderr: "",
    };
    readCgroup.mockResolvedValue("0::/system.slice/setup_and_run_blacksmith.service\n");
    systemctl.mockResolvedValue(nativeReply);
    const probing = createDeferredCore();
    const refreshed = createDeferredCore<typeof nativeReply>();
    const draining = createDeferredCore();
    const drained = createDeferredCore();
    const closing = createDeferredCore();
    const joined = createDeferredCore<boolean>();
    const settle = vi.fn(() => joined.promise);
    captureForegroundUpdateHandoffStop.mockReturnValueOnce({ settle, canPark: () => false });
    consumeGatewayRestartIntent.mockReturnValueOnce({ reason: "gateway.restart" });
    waitForGatewayActiveWork.mockImplementationOnce(async () => {
      draining.resolve();
      await drained.promise;
      return { drained: true, snapshot: idleActiveWorkSnapshot };
    });
    await withIsolatedSignals(async ({ captureSignal }) => {
      let cleanupBudget: ReturnType<
        typeof import("../../process/supervisor/cleanup-budget.js").getProcessCleanupBudget
      >;
      const close = createCloseMock().mockImplementationOnce(async () => {
        const { getProcessCleanupBudget } =
          await import("../../process/supervisor/cleanup-budget.js");
        cleanupBudget = getProcessCleanupBudget();
        closing.resolve();
      });
      const { start, started } = createSignaledStart(close);
      const { runtime, exited } = createRuntimeWithExitSignal();
      await runLoopWithStart({ start, runtime, ownsProcessLifecycle: true });
      await waitForStart(started);
      systemctl.mockImplementationOnce(() => {
        probing.resolve();
        return refreshed.promise;
      });
      vi.useFakeTimers();
      try {
        captureSignal("SIGUSR2")();
        await probing.promise;
        expect(armShutdownHardExitWatchdog).toHaveBeenCalledOnce();
        captureSignal("SIGINT")();
        expect(settle).toHaveBeenCalledOnce();
        expect(cancelShutdownHardExitWatchdog).toHaveBeenCalledOnce();
        expect(isGatewayWorkAdmissionClosed()).toBe(true);
        expect(close).not.toHaveBeenCalled();

        refreshed.resolve(nativeReply);
        await draining.promise;
        expect
          .soft(armShutdownHardExitWatchdog, "native reread rearmed the watchdog")
          .toHaveBeenCalledOnce();
        expect(runtime.exit).not.toHaveBeenCalled();

        drained.resolve();
        await closing.promise;
        expect
          .soft(armShutdownHardExitWatchdog, "post-drain fallback rearmed the watchdog")
          .toHaveBeenCalledOnce();
        expect.soft(cleanupBudget).toBeUndefined();
        expect(runtime.exit).not.toHaveBeenCalled();
        expect(settle).toHaveBeenCalledOnce();
        joined.resolve(true);
        await vi.advanceTimersByTimeAsync(0);
        await expect(exited).resolves.toBe(0);
        expect(close).toHaveBeenCalledOnce();
        expect(start).toHaveBeenCalledOnce();
      } finally {
        refreshed.resolve(nativeReply);
        drained.resolve();
        joined.resolve(true);
        await vi.advanceTimersByTimeAsync(0);
        vi.useRealTimers();
        await waitForLoopCondition(
          () => runtime.exit.mock.calls.length > 0,
          "captured Stop fixture did not settle after releasing its owned work",
        );
        await exited;
      }
    });
  });

  it("keeps replacement shutdown behind an owned pre-park Stop settlement", async () => {
    const joined = createDeferredCore<boolean>();
    const settle = vi.fn(() => joined.promise);
    captureForegroundUpdateHandoffStop.mockReturnValueOnce({ settle, canPark: () => false });
    await withIsolatedSignals(async ({ captureSignal }) => {
      const close = createCloseMock();
      const { start, started } = createSignaledStart(close);
      const { runtime, exited } = createRuntimeWithExitSignal();
      const completeBoot = vi.fn();
      await runLoopWithStart({ start, runtime, completeBoot });
      await waitForStart(started);
      try {
        captureSignal("SIGINT")();
        await waitForLoopCondition(
          () => settle.mock.calls.length === 1,
          "Stop did not join its foreground update owner",
        );
        const replaceInstallation = await loadInstallationReplacement();
        replaceInstallation("replaced runtime while updater is held");
        expect(isGatewayWorkAdmissionClosed()).toBe(true);
        expect(captureForegroundUpdateHandoffStop).toHaveBeenCalledOnce();
        expect(settle).toHaveBeenCalledOnce();
        expect(close).not.toHaveBeenCalled();
        expect(runtime.exit).not.toHaveBeenCalled();
        joined.resolve(true);
        await expect(exited).resolves.toBe(0);
        expect(close).toHaveBeenCalledOnce();
        expect(start).toHaveBeenCalledOnce();
        expect(acquireGatewayLock).toHaveBeenCalledOnce();
        expect(runtime.exit).toHaveBeenCalledExactlyOnceWith(0);
        expect(restartGatewayProcessWithFreshPid).not.toHaveBeenCalled();
        expect(respawnGatewayProcessForUpdate).not.toHaveBeenCalled();
        expect(completeBoot).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            outcome: "clean_stop",
            reason: expect.stringContaining("gateway.installation_replaced"),
          }),
        );
      } finally {
        joined.resolve(true);
        await exited;
      }
    });
  });

  it.each(["settled", "rejected", "retired"] as const)(
    "holds installation replacement behind its system-service helper (%s)",
    async (outcome) => {
      process.env.OPENCLAW_SYSTEMD_UNIT = "openclaw-gateway.service";
      restartGatewayProcessWithFreshPid.mockReturnValue({ mode: "supervised" });
      const helper = createDeferredCore();
      const helperObserved = createDeferredCore<"helper">();
      const closing = createDeferredCore<"closed">();
      const nextHelper = createDeferredCore();
      const nextHelperObserved = createDeferredCore();
      waitForSystemServiceUpdateHandoffs.mockImplementationOnce(() => {
        helperObserved.resolve("helper");
        return helper.promise;
      });
      if (outcome === "settled") {
        waitForSystemServiceUpdateHandoffs.mockImplementationOnce(() => {
          nextHelperObserved.resolve();
          return nextHelper.promise;
        });
      }
      await withIsolatedSignals(async ({ captureSignal }) => {
        const close = createCloseMock().mockImplementation(async () => {
          closing.resolve("closed");
        });
        const { start, started } = createSignaledStart(close);
        const { runtime, exited } = createRuntimeWithExitSignal();
        await runLoopWithStart({ start, runtime });
        await waitForStart(started);
        try {
          const replaceInstallation = await loadInstallationReplacement();
          replaceInstallation("package replaced while updater is finalizing");
          expect(
            await Promise.race([helperObserved.promise, closing.promise]),
            "Gateway closed before joining its system-service update helper",
          ).toBe("helper");
          expect(close).not.toHaveBeenCalled();
          expect(runtime.exit).not.toHaveBeenCalled();
          expect(isGatewayWorkAdmissionClosed()).toBe(false);
          if (outcome === "settled") {
            helper.resolve();
            await nextHelperObserved.promise;
            expect(close).not.toHaveBeenCalled();
            expect(runtime.exit).not.toHaveBeenCalled();
            nextHelper.resolve();
            await expect(exited).resolves.toBe(0);
            expect(restartGatewayProcessWithFreshPid).toHaveBeenCalledOnce();
            expect(close).toHaveBeenCalledOnce();
          } else if (outcome === "rejected") {
            const logged = createDeferredCore();
            gatewayLog.error.mockImplementationOnce(() => logged.resolve());
            helper.reject(new Error("helper exit is unconfirmed"));
            await logged.promise;
            expect(gatewayLog.error).toHaveBeenCalledWith(
              expect.stringContaining("system-service update settlement failed"),
            );
            expect(close).not.toHaveBeenCalled();
            expect(runtime.exit).not.toHaveBeenCalled();
            expect(isGatewayWorkAdmissionClosed()).toBe(false);
          } else {
            captureSignal("SIGINT")();
            await exited;
            helper.resolve();
            await helper.promise;
            expect(waitForSystemServiceUpdateHandoffs).toHaveBeenCalledOnce();
            expect(restartGatewayProcessWithFreshPid).not.toHaveBeenCalled();
            expect(runtime.exit).toHaveBeenCalledOnce();
          }
        } finally {
          helper.resolve();
          nextHelper.resolve();
          if (!runtime.exit.mock.calls.length) {
            captureSignal("SIGINT")();
            await exited;
          }
        }
      });
    },
  );

  it.each([
    { phase: "lock", pendingStop: true },
    { phase: "beginBoot", pendingStop: true },
  ] as const)(
    "does not resume a replaced runtime during $phase (pending Stop: $pendingStop)",
    async ({ phase, pendingStop }) => {
      await withIsolatedSignals(async ({ captureSignal }) => {
        const { start, started } = createSignaledStart(createCloseMock());
        const { runtime, exited } = createRuntimeWithExitSignal();
        const completeBoot = vi.fn();
        const reached = createDeferredCore();
        const resume = createDeferredCore();
        const joined = createDeferredCore<boolean>();
        const settle = vi.fn(() => joined.promise);
        if (pendingStop) {
          captureForegroundUpdateHandoffStop.mockReturnValueOnce({ settle, canPark: () => false });
        }
        const beginBoot = vi.fn(async () => {
          reached.resolve();
          await resume.promise;
        });
        await runLoopWithStart({
          start,
          runtime,
          completeBoot,
          beginBoot: phase === "beginBoot" ? beginBoot : undefined,
        });
        if (phase !== "beginBoot") {
          await waitForStart(started);
        }
        if (phase === "lock") {
          acquireGatewayLock.mockImplementationOnce(async () => {
            reached.resolve();
            await resume.promise;
            return { release: vi.fn(async () => {}) };
          });
        }
        const failures: unknown[] = [];
        try {
          if (phase !== "beginBoot") {
            captureSignal("SIGUSR2")();
          }
          await withTimeout(reached.promise, 4_000);
          if (pendingStop) {
            captureSignal("SIGINT")();
            await waitForLoopCondition(
              () => settle.mock.calls.length === 1,
              "Stop did not capture the unsettled foreground update",
            );
          }
          const replaceInstallation = await loadInstallationReplacement();
          replaceInstallation(
            phase === "beginBoot" && !pendingStop
              ? "installation replaced during boot preparation"
              : "replaced runtime",
          );
          expect(start).toHaveBeenCalledTimes(phase === "beginBoot" ? 0 : 1);
          expect(runtime.exit).not.toHaveBeenCalled();
          resume.resolve();
          if (pendingStop) {
            await waitForLoopCondition(
              () =>
                gatewayLog.error.mock.calls.some(([message]) =>
                  String(message).includes("Cannot continue in this process"),
                ),
              "resumed continuation did not reach the installation-replacement fence",
            );
            await new Promise<void>((resolve) => {
              setImmediate(resolve);
            });
            expect(isGatewayWorkAdmissionClosed()).toBe(true);
            expect(runtime.exit).not.toHaveBeenCalled();
            expect(completeBoot).not.toHaveBeenCalled();
            expect(captureForegroundUpdateHandoffStop).toHaveBeenCalledOnce();
            expect(settle).toHaveBeenCalledOnce();
            joined.resolve(true);
          }
          await expect(withTimeout(exited, 4_000)).resolves.toBe(1);
          await new Promise<void>((resolve) => {
            setImmediate(resolve);
          });
          expect(start).toHaveBeenCalledTimes(phase === "beginBoot" ? 0 : 1);
          expect(acquireGatewayLock).toHaveBeenCalledTimes(phase === "beginBoot" ? 1 : 2);
          expect(beginBoot).toHaveBeenCalledTimes(phase === "beginBoot" ? 1 : 0);
          expect(runtime.exit).toHaveBeenCalledExactlyOnceWith(1);
          expect(completeBoot).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({
              reason: expect.stringContaining("gateway.installation_replaced"),
            }),
          );
          expect(respawnGatewayProcessForUpdate).not.toHaveBeenCalled();
        } catch (error) {
          failures.push(error);
        }
        try {
          resume.resolve();
          joined.resolve(true);
          if (!runtime.exit.mock.calls.length) {
            captureSignal("SIGINT")();
          }
          await withTimeout(exited, 4_000);
          await new Promise<void>((resolve) => {
            setImmediate(resolve);
          });
        } catch (error) {
          failures.push(error);
        }
        if (failures.length > 1) {
          throw new AggregateError(failures, "Replacement Stop assertion and cleanup failed", {
            cause: failures[0],
          });
        }
        if (failures.length === 1) {
          throw failures[0];
        }
      });
    },
  );
  it.each(["failed-handoff", "existing-restart", "managed-update", "failed-close"] as const)(
    "settles an own-chunk failure before handing over a replaced installation (%s)",
    async (mode) => {
      const supervised = ["failed-handoff", "managed-update", "failed-close"].includes(mode);
      if (supervised) {
        process.env.OPENCLAW_SYSTEMD_UNIT = "openclaw-gateway.service";
      }
      restartGatewayProcessWithFreshPid.mockReturnValue(
        mode === "failed-close"
          ? { mode: "supervised", exitCode: 131071 }
          : mode === "failed-handoff"
            ? { mode: "failed", detail: "handoff unavailable" }
            : { mode: "disabled", detail: "unmanaged" },
      );
      const drainStarted = createDeferredCore();
      const drain = createDeferredCore<{ drained: boolean; snapshot: GatewayActiveWorkSnapshot }>();
      waitForGatewayActiveWork.mockImplementationOnce(() => {
        drainStarted.resolve();
        return drain.promise;
      });
      await withIsolatedSignals(async ({ captureSignal }) => {
        const close = createCloseMock();
        if (mode === "failed-close") {
          close.mockRejectedValueOnce(new Error("old plugin chunk unavailable during close"));
        }
        const { start, started } = createSignaledStart(close);
        const { runtime, exited } = createRuntimeWithExitSignal();
        const completeBoot = vi.fn();
        await runLoopWithStart({ start, runtime, completeBoot });
        await waitForStart(started);
        const replaceInstallation = await loadInstallationReplacement();
        try {
          if (mode === "managed-update") {
            consumeGatewayRestartIntent.mockReturnValueOnce({
              reason: "update.run",
              successorOwner: managedUpdateSuccessorOwner,
            });
          }
          if (mode === "existing-restart" || mode === "managed-update") {
            captureSignal("SIGUSR2")();
            await drainStarted.promise;
          }
          replaceInstallation("Cannot find module", "ERR_MODULE_NOT_FOUND");
          expect(isGatewayWorkAdmissionClosed()).toBe(true);
          expect(close).not.toHaveBeenCalled();
          expect(runtime.exit).not.toHaveBeenCalled();
          drain.resolve({ drained: true, snapshot: idleActiveWorkSnapshot });
          await expect(exited).resolves.toBe(
            mode === "failed-close" ? 131071 : mode === "managed-update" ? 0 : 1,
          );
          expect(close).toHaveBeenCalledOnce();
          expect(start).toHaveBeenCalledOnce();
          expect(completeBoot).toHaveBeenCalledWith(
            expect.objectContaining({
              outcome: mode === "failed-close" ? "forced_stop" : "planned_restart",
              reason: expect.stringContaining("gateway.installation_replaced"),
            }),
          );
          if (!supervised) {
            expect(gatewayLog.error).toHaveBeenCalledWith(
              expect.stringContaining("openclaw gateway run"),
            );
          }
          if (mode === "managed-update") {
            expect(commitManagedServiceUpdateHandoff).toHaveBeenCalledWith(
              managedUpdateSuccessorOwner,
              "update",
            );
            expect(restartGatewayProcessWithFreshPid).not.toHaveBeenCalled();
          }
        } finally {
          drain.resolve({ drained: true, snapshot: idleActiveWorkSnapshot });
          if (!runtime.exit.mock.calls.length) {
            captureSignal("SIGINT")();
            await exited;
          }
        }
      });
    },
  );
}
