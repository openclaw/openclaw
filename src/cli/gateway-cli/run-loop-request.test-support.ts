/** Shutdown request reasons and installation-replacement handoff cases share the run-loop fixture. */
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, it, vi } from "vitest";
import { withTimeout } from "../../infra/fs-safe.js";
import type { GatewayActiveWorkSnapshot } from "../../infra/gateway-active-work.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { registerGatewayForcedRestartTests } from "./run-loop-force.test-support.js";
import type { RequestFixtures } from "./run-loop-request-fixtures.test-support.js";
import {
  createActiveWorkSnapshot,
  createCloseMock,
  createRuntimeWithExitSignal,
  createSignaledStart,
  waitForStart,
  waitForLoopCondition,
  withIsolatedSignals,
} from "./run-loop.test-support.js";

export function registerGatewayRequestTests({
  createSignaledLoopHarness,
  createGatewayActiveWorkSnapshot,
  abortActiveCronTaskRuns,
  acquireGatewayLock,
  reloadTaskRuntimeStateFromStore,
  runLoopWithStart,
  waitForGatewayActiveWork,
  restartGatewayProcessWithFreshPid,
  respawnGatewayProcessForUpdate,
  captureForegroundUpdateHandoffStop,
  readCgroup,
  systemctl,
  armShutdownHardExitWatchdog,
  cancelShutdownHardExitWatchdog,
  consumeGatewayRestartIntent,
  consumeGatewayRestartIntentPayloadSync,
  peekGatewayRestartReason,
  managedUpdateSuccessorOwner,
  commitManagedServiceUpdateHandoff,
  waitForSystemServiceUpdateHandoffs,
  isGatewayWorkAdmissionClosed,
  gatewayLog,
}: RequestFixtures): void {
  const idleActiveWorkSnapshot = createActiveWorkSnapshot();
  registerGatewayForcedRestartTests({
    createSignaledLoopHarness,
    createGatewayActiveWorkSnapshot,
    abortActiveCronTaskRuns,
    runLoopWithStart,
    waitForGatewayActiveWork,
    consumeGatewayRestartIntent,
    consumeGatewayRestartIntentPayloadSync,
    isGatewayWorkAdmissionClosed,
    gatewayLog,
    readCgroup,
    systemctl,
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
        const { classifyGatewayStaleInstall } = await import("../../gateway/stale-install.js");
        classifyGatewayStaleInstall(
          Object.assign(new Error("replaced runtime while updater is held"), {
            code: "ENOENT",
            path: fileURLToPath(new URL("../../gateway/missing-runtime.js", import.meta.url)),
          }),
        );
        expect(isGatewayWorkAdmissionClosed()).toBe(true);
        expect(captureForegroundUpdateHandoffStop).toHaveBeenCalledOnce();
        expect(settle).toHaveBeenCalledOnce();
        expect(close).not.toHaveBeenCalled();
        expect(runtime.exit).not.toHaveBeenCalled();
        expect(restartGatewayProcessWithFreshPid).not.toHaveBeenCalled();
        expect(respawnGatewayProcessForUpdate).not.toHaveBeenCalled();
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
          const { classifyGatewayStaleInstall } = await import("../../gateway/stale-install.js");
          classifyGatewayStaleInstall(
            Object.assign(new Error("package replaced while updater is finalizing"), {
              code: "ENOENT",
              path: fileURLToPath(new URL("../../gateway/missing-runtime.js", import.meta.url)),
            }),
          );
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

  it("does not start a replaced runtime after awaited beginBoot", async () => {
    const entered = createDeferredCore();
    const resume = createDeferredCore();
    const beginBoot = vi.fn(async () => {
      entered.resolve();
      await resume.promise;
    });
    await withIsolatedSignals(async ({ captureSignal }) => {
      const { start } = createSignaledStart(createCloseMock());
      const { runtime, exited } = createRuntimeWithExitSignal();
      const completeBoot = vi.fn();
      await runLoopWithStart({ start, runtime, beginBoot, completeBoot });
      await entered.promise;
      try {
        const { classifyGatewayStaleInstall } = await import("../../gateway/stale-install.js");
        classifyGatewayStaleInstall(
          Object.assign(new Error("installation replaced during boot preparation"), {
            code: "ENOENT",
            path: fileURLToPath(new URL("../../gateway/missing-runtime.js", import.meta.url)),
          }),
        );
        expect(start).not.toHaveBeenCalled();
        expect(runtime.exit).not.toHaveBeenCalled();
        resume.resolve();
        await expect(exited).resolves.toBe(1);
        expect(beginBoot).toHaveBeenCalledOnce();
        expect(start).not.toHaveBeenCalled();
        expect(acquireGatewayLock).toHaveBeenCalledOnce();
        expect(runtime.exit).toHaveBeenCalledExactlyOnceWith(1);
        expect(completeBoot).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            reason: expect.stringContaining("gateway.installation_replaced"),
          }),
        );
      } finally {
        resume.resolve();
        if (!runtime.exit.mock.calls.length) {
          captureSignal("SIGINT")();
          await exited;
        }
      }
    });
  });

  it.each([
    { phase: "lock", pendingStop: false },
    { phase: "restart-cleanup", pendingStop: false },
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
        await runLoopWithStart({
          start,
          runtime,
          completeBoot,
          beginBoot:
            phase === "beginBoot"
              ? async () => {
                  reached.resolve();
                  await resume.promise;
                }
              : undefined,
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
        } else if (phase === "restart-cleanup") {
          reloadTaskRuntimeStateFromStore.mockImplementationOnce(async () => {
            reached.resolve();
            await resume.promise;
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
          const { classifyGatewayStaleInstall } = await import("../../gateway/stale-install.js");
          classifyGatewayStaleInstall(
            Object.assign(new Error("replaced runtime"), {
              code: "ENOENT",
              path: fileURLToPath(new URL("../../gateway/missing-runtime.js", import.meta.url)),
            }),
          );
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
          await waitForLoopCondition(
            () => start.mock.calls.length > 1 || runtime.exit.mock.calls.length > 0,
            "replacement did not settle the old process",
          );
          await expect(withTimeout(exited, 4_000)).resolves.toBe(1);
          await new Promise<void>((resolve) => {
            setImmediate(resolve);
          });
          expect(start).toHaveBeenCalledTimes(phase === "beginBoot" ? 0 : 1);
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
  it.each([
    "systemd",
    "foreground",
    "failed-handoff",
    "existing-restart",
    "existing-stop",
    "managed-update",
    "failed-close",
  ] as const)(
    "settles an own-chunk failure before handing over a replaced installation (%s)",
    async (mode) => {
      const supervised = ["systemd", "failed-handoff", "managed-update", "failed-close"].includes(
        mode,
      );
      if (supervised) {
        process.env.OPENCLAW_SYSTEMD_UNIT = "openclaw-gateway.service";
      }
      restartGatewayProcessWithFreshPid.mockReturnValue(
        mode === "failed-close"
          ? { mode: "supervised", exitCode: 131071 }
          : mode === "systemd"
            ? { mode: "supervised" }
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
        const { classifyGatewayStaleInstall } = await import("../../gateway/stale-install.js");
        const missingChunk = fileURLToPath(
          new URL("../../gateway/missing-runtime.js", import.meta.url),
        );
        try {
          if (mode === "managed-update") {
            consumeGatewayRestartIntent.mockReturnValueOnce({
              reason: "update.run",
              successorOwner: managedUpdateSuccessorOwner,
            });
          }
          if (
            mode === "existing-restart" ||
            mode === "existing-stop" ||
            mode === "managed-update"
          ) {
            captureSignal(mode === "existing-stop" ? "SIGINT" : "SIGUSR2")();
            await drainStarted.promise;
          }
          classifyGatewayStaleInstall(
            Object.assign(new Error("Cannot find module"), {
              code: "ERR_MODULE_NOT_FOUND",
              url: pathToFileURL(missingChunk).href,
            }),
          );
          expect(isGatewayWorkAdmissionClosed()).toBe(true);
          expect(close).not.toHaveBeenCalled();
          expect(runtime.exit).not.toHaveBeenCalled();
          drain.resolve({ drained: true, snapshot: idleActiveWorkSnapshot });
          await expect(exited).resolves.toBe(
            mode === "failed-close"
              ? 131071
              : mode === "systemd" || mode === "existing-stop" || mode === "managed-update"
                ? 0
                : 1,
          );
          expect(close).toHaveBeenCalledOnce();
          expect(start).toHaveBeenCalledOnce();
          expect(completeBoot).toHaveBeenCalledWith(
            expect.objectContaining({
              outcome:
                mode === "failed-close"
                  ? "forced_stop"
                  : mode === "existing-stop"
                    ? "clean_stop"
                    : "planned_restart",
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

  it.each([
    { signal: "SIGTERM", restartReason: undefined, reason: "stop (SIGTERM)" },
    { signal: "SIGINT", restartReason: undefined, reason: "stop (SIGINT)" },
    { signal: "SIGUSR2", restartReason: undefined, reason: "restart (SIGUSR2)" },
    {
      signal: "SIGUSR2",
      restartReason: "config reload: gateway.bind",
      reason: "restart (SIGUSR2: config reload: gateway.bind)",
    },
    {
      signal: "SIGTERM",
      restartReason: "update.run",
      reason: "restart (SIGTERM: update.run)",
    },
  ] as const)("names the shutdown trigger: $reason", async ({ signal, restartReason, reason }) => {
    vi.clearAllMocks();
    if (signal === "SIGTERM" && restartReason) {
      consumeGatewayRestartIntentPayloadSync.mockReturnValueOnce({ reason: restartReason });
    } else {
      peekGatewayRestartReason.mockReturnValueOnce(restartReason);
    }
    await withIsolatedSignals(async ({ captureSignal }) => {
      const close = createCloseMock();
      const { start, started } = createSignaledStart(close);
      const { runtime, exited } = createRuntimeWithExitSignal();
      const completeBoot = vi.fn();
      await runLoopWithStart({ start, runtime, completeBoot });
      await waitForStart(started);
      captureSignal(signal)();
      if (signal === "SIGUSR2") {
        await waitForLoopCondition(() => start.mock.calls.length === 2, "restart did not finish");
        captureSignal("SIGINT")();
      }
      await expect(exited).resolves.toBe(0);
      expect(gatewayLog.info).toHaveBeenCalledWith(`admission closed: ${reason}`);
      expect(gatewayLog.info).not.toHaveBeenCalledWith("admission closed: restart drain");
      expect(completeBoot).toHaveBeenCalledWith({
        outcome: reason.startsWith("restart") ? "planned_restart" : "clean_stop",
        reason,
      });
    });
  });
}
