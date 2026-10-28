import { setImmediate } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { withTimeout } from "../../infra/fs-safe.js";
import type { GatewayActiveWorkSnapshot } from "../../infra/gateway-active-work.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { expectCallCount, withRunLoopCleanup } from "./run-loop-cleanup.test-support.js";
import { registerGatewayForcedRestartTests } from "./run-loop-force.test-support.js";
import { gatewayWorkAdmissionActual as admission } from "./run-loop-mocks.test-support.js";
import {
  createActiveWorkSnapshot,
  createCloseMock,
  createLifecycleGate,
  createRuntimeWithExitSignal,
  createSignaledStart,
  advanceWithoutCalls,
  systemdReply,
  waitForStart,
  waitForLoopCondition,
  withIsolatedSignals,
  withLifecycleClock,
  type UpdateRespawnFixtures,
} from "./run-loop.test-support.js";

function deferredCall<T = void>() {
  const entered = createDeferredCore();
  const result = createDeferredCore<T>();
  return {
    ...result,
    entered: entered.promise,
    call: () => {
      entered.resolve();
      return result.promise;
    },
  };
}

const nativeReply = systemdReply("90s");

function shutdownBudget(start: ReturnType<typeof createSignaledStart>["start"]) {
  const budget = start.mock.calls[0]?.[0]?.hostLifecycle?.getShutdownBudget?.();
  if (!budget) {
    throw new Error("Gateway fixture did not publish its shutdown budget");
  }
  return budget;
}

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
    createSignaledLoopHarness: createLoop,
    withRunningGateway,
    acquireGatewayLock,
    runLoopWithStart: runLoop,
    waitForGatewayActiveWork: waitActive,
    waitForActiveCronTaskRuns: waitCron,
    restartGatewayProcessWithFreshPid: restartProcess,
    respawnGatewayProcessForUpdate: respawnUpdate,
    captureForegroundUpdateHandoffStop: captureStop,
    readCgroup,
    systemctl,
    armShutdownHardExitWatchdog: armWatchdog,
    cancelShutdownHardExitWatchdog: cancelWatchdog,
    consumeGatewayRestartIntent: consumeSyncIntent,
    consumeGatewayRestartIntentPayload: consumeIntent,
    consumeGatewayRestartAuthorization: authorizeRestart,
    writeGatewayRestartHandoff: writeHandoff,
    managedUpdateSuccessorOwner,
    commitManagedServiceUpdateHandoff: commitUpdate,
    waitForSystemServiceUpdateHandoffs: waitUpdateHelpers,
    isGatewayWorkAdmissionClosed: admissionClosed,
    gatewayLog,
  } = fixtures;
  const idleActiveWorkSnapshot = createActiveWorkSnapshot();
  const replacementReason = expect.stringContaining("gateway.installation_replaced");
  registerGatewayForcedRestartTests(fixtures);
  async function withReplacement(
    release: () => void,
    assertion: (
      context: Awaited<ReturnType<typeof createLoop>> & {
        signal: Parameters<Parameters<typeof withIsolatedSignals>[0]>[0]["captureSignal"];
        boot: ReturnType<typeof vi.fn>;
        replace: Awaited<ReturnType<typeof loadInstallationReplacement>>;
      },
    ) => Promise<void>,
    close = createCloseMock(),
  ) {
    await withIsolatedSignals(async ({ captureSignal }) => {
      const boot = vi.fn();
      const loop = await createLoop(undefined, false, { close, completeBoot: boot });
      const replace = await loadInstallationReplacement();
      try {
        await assertion({ ...loop, signal: captureSignal, boot, replace });
      } finally {
        release();
        if (!loop.runtime.exit.mock.calls.length) {
          captureSignal("SIGINT")();
        }
        await loop.exited;
      }
    });
  }

  it.each(["SIGTERM", "SIGUSR2"] as const)(
    "fences root admission before %s returns",
    async (signal) => {
      const consumed = createDeferredCore<null>();
      consumeIntent.mockReturnValueOnce(consumed.promise);
      await withRunningGateway(async ({ captureSignal, close, exited }) => {
        restartProcess.mockReturnValue({ mode: "supervised" });
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
    authorizeRestart.mockReturnValueOnce(false);
    consumeIntent.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    await withRunningGateway(async ({ captureSignal, exited }) => {
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

  it("joins FIFO signal consumption through close and keeps a queued Stop over a later update", async () => {
    process.env.OPENCLAW_SUPERVISOR_MODE = "external";
    const first = createDeferredCore<null>();
    const second = createDeferredCore<null>();
    const drainEntered = createDeferredCore();
    const closing = createLifecycleGate();
    consumeIntent
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockResolvedValueOnce({ reason: "update.run" });
    authorizeRestart.mockReturnValueOnce(true).mockReturnValueOnce(false);
    waitActive.mockImplementationOnce(async () => {
      drainEntered.resolve();
      return { drained: true, snapshot: idleActiveWorkSnapshot };
    });
    restartProcess.mockReturnValue({ mode: "supervised" });
    await withRunningGateway(async ({ captureSignal, close, runtime, exited }) => {
      close.mockImplementationOnce(closing.wait);
      try {
        captureSignal("SIGUSR2")();
        captureSignal("SIGTERM")();
        expect(consumeIntent).toHaveBeenCalledOnce();
        expect(admissionClosed()).toBe(true);
        first.resolve(null);
        await drainEntered.promise;
        expectCallCount(0, close, runtime.exit);
        second.resolve(null);
        await closing.entered;
        captureSignal("SIGUSR2")();
        expect(consumeIntent).toHaveBeenCalledTimes(2);
      } finally {
        first.resolve(null);
        second.resolve(null);
        closing.release();
        await expect(exited).resolves.toBe(0);
      }
      // The Stop queued behind the restart ends it; the later durable update cannot revive it.
      expect(consumeIntent).toHaveBeenCalledTimes(3);
      expectCallCount(0, restartProcess, writeHandoff);
    });
  });

  it("bounds signal storage settlement and refuses its result after forced exit", async () => {
    const consumed = createDeferredCore<{ reason: string } | null>();
    consumeIntent.mockReturnValueOnce(consumed.promise);
    await withRunningGateway(async ({ captureSignal, close, start, runtime, exited }) => {
      const budget = shutdownBudget(start);
      vi.useFakeTimers();
      try {
        captureSignal("SIGTERM")();
        await vi.advanceTimersByTimeAsync(budget.timeoutMs);
        expect(runtime.exit).not.toHaveBeenCalled();
        consumed.resolve({ reason: "gateway.restart" });
        await vi.advanceTimersByTimeAsync(0);
        await expect(exited).resolves.toBe(1);
        expect(close).toHaveBeenCalledExactlyOnceWith({
          retainSharedState: true,
          reason: "gateway stopping",
        });
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
    systemctl.mockResolvedValue(nativeReply);
    const consumed = createDeferredCore<null>();
    const closing = createDeferredCore();
    consumeIntent.mockReturnValueOnce(consumed.promise);
    await withRunningGateway(async ({ captureSignal, close, start, runtime, exited }) => {
      close.mockImplementationOnce(() => closing.promise);
      const budget = shutdownBudget(start);
      const consumedMs = 10_000;
      await withLifecycleClock(async () => {
        try {
          captureSignal("SIGTERM")();
          await vi.advanceTimersByTimeAsync(consumedMs);
          consumed.reject(new Error("restart intent worker unavailable"));
          await vi.advanceTimersByTimeAsync(0);
          expect(close).toHaveBeenCalledOnce();
          await advanceWithoutCalls(budget.timeoutMs - consumedMs - 1, runtime.exit);
          await advanceWithoutCalls(1, runtime.exit);
          closing.resolve();
          await vi.advanceTimersByTimeAsync(0);
          await expect(exited).resolves.toBe(0);
        } finally {
          consumed.resolve(null);
          closing.resolve();
          await vi.advanceTimersByTimeAsync(0);
        }
      });
    });
  });

  it("settles a queued Stop when restart preparation fails before reopening storage", async () => {
    const preparation = deferredCall<{ drained: boolean; active: number }>();
    waitCron.mockImplementationOnce(preparation.call);
    await withRunningGateway(async ({ captureSignal, close, start, exited }) => {
      try {
        captureSignal("SIGUSR2")();
        await preparation.entered;
        const consumed = consumeIntent.mock.calls.length;
        captureSignal("SIGTERM")();
        expect(consumeIntent).toHaveBeenCalledTimes(consumed);
        preparation.reject(new Error("restart preparation failed"));
        await expect(exited).resolves.toBe(0);
        expect(consumeIntent).toHaveBeenCalledTimes(consumed + 1);
        expectCallCount(1, start, close);
      } finally {
        preparation.resolve({ drained: true, active: 0 });
      }
    });
  });

  it("keeps a captured pre-park Stop ahead of native budget refresh and drain completion", async () => {
    readCgroup.mockResolvedValue("0::/system.slice/setup_and_run_blacksmith.service\n");
    systemctl.mockResolvedValue(nativeReply);
    const refreshed = deferredCall<typeof nativeReply>();
    const drained = createLifecycleGate();
    const closing = createDeferredCore();
    const joined = createDeferredCore<boolean>();
    const settle = vi.fn(() => joined.promise);
    captureStop.mockReturnValueOnce({ settle, canPark: () => false });
    consumeSyncIntent.mockReturnValueOnce({ reason: "gateway.restart" });
    waitActive.mockImplementationOnce(async () => {
      await drained.wait();
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
      await runLoop({ start, runtime, ownsProcessLifecycle: true });
      await waitForStart(started);
      systemctl.mockImplementationOnce(refreshed.call);
      vi.useFakeTimers();
      try {
        captureSignal("SIGUSR2")();
        await refreshed.entered;
        expect(armWatchdog).toHaveBeenCalledOnce();
        captureSignal("SIGINT")();
        expectCallCount(1, settle, cancelWatchdog);
        expect(admissionClosed()).toBe(true);
        expect(close).not.toHaveBeenCalled();

        refreshed.resolve(nativeReply);
        await drained.entered;
        expect.soft(armWatchdog, "native reread rearmed the watchdog").toHaveBeenCalledOnce();
        expect(runtime.exit).not.toHaveBeenCalled();

        drained.release();
        await closing.promise;
        expect.soft(armWatchdog, "post-drain fallback rearmed the watchdog").toHaveBeenCalledOnce();
        expect.soft(cleanupBudget).toBeUndefined();
        expect(runtime.exit).not.toHaveBeenCalled();
        expect(settle).toHaveBeenCalledOnce();
        joined.resolve(true);
        await vi.advanceTimersByTimeAsync(0);
        await expect(exited).resolves.toBe(0);
        expectCallCount(1, close, start);
      } finally {
        refreshed.resolve(nativeReply);
        drained.release();
        joined.resolve(true);
        await vi.advanceTimersByTimeAsync(0);
        vi.useRealTimers();
        await waitForLoopCondition(
          () => runtime.exit.mock.calls.length > 0,
          "Stop did not settle after release",
        );
        await exited;
      }
    });
  });

  it("keeps replacement shutdown behind an owned pre-park Stop settlement", async () => {
    const joined = createDeferredCore<boolean>();
    const settle = vi.fn(() => joined.promise);
    captureStop.mockReturnValueOnce({ settle, canPark: () => false });
    await withReplacement(
      () => joined.resolve(true),
      async ({ signal, close, start, runtime, exited, boot, replace }) => {
        signal("SIGINT")();
        await waitForLoopCondition(
          () => settle.mock.calls.length === 1,
          "Stop did not join update owner",
        );
        replace("replaced runtime while updater is held");
        expect(admissionClosed()).toBe(true);
        expectCallCount(1, captureStop, settle);
        expectCallCount(0, close, runtime.exit);
        joined.resolve(true);
        await expect(exited).resolves.toBe(0);
        expectCallCount(1, close, start, acquireGatewayLock);
        expectCallCount(0, restartProcess, respawnUpdate);
        expect(boot).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ outcome: "clean_stop", reason: replacementReason }),
        );
      },
    );
  });

  it.each(["settled", "rejected", "retired"] as const)(
    "joins the system-service helper until %s",
    async (outcome) => {
      process.env.OPENCLAW_SYSTEMD_UNIT = "openclaw-gateway.service";
      restartProcess.mockReturnValue({ mode: "supervised" });
      const helper = createLifecycleGate();
      const closing = createDeferredCore<"closed">();
      const nextHelper = createLifecycleGate();
      waitUpdateHelpers.mockImplementationOnce(helper.wait);
      if (outcome === "settled") {
        waitUpdateHelpers.mockImplementationOnce(nextHelper.wait);
      }
      await withReplacement(
        () => {
          helper.release();
          nextHelper.release();
        },
        async ({ signal, close, runtime, exited, replace }) => {
          replace("package replaced while updater is finalizing");
          expect(
            await Promise.race([helper.entered.then(() => "helper"), closing.promise]),
            "Gateway closed before helper joined",
          ).toBe("helper");
          expectCallCount(0, close, runtime.exit);
          expect(admissionClosed()).toBe(false);
          if (outcome === "settled") {
            helper.release();
            await nextHelper.entered;
            expectCallCount(0, close, runtime.exit);
            nextHelper.release();
            await expect(exited).resolves.toBe(0);
            expectCallCount(1, restartProcess, close);
          } else if (outcome === "rejected") {
            const logged = createDeferredCore();
            gatewayLog.error.mockImplementationOnce(() => logged.resolve());
            helper.reject(new Error("helper exit is unconfirmed"));
            await logged.promise;
            expectCallCount(0, close, runtime.exit);
            expect(admissionClosed()).toBe(false);
          } else {
            signal("SIGINT")();
            await exited;
            helper.release();
            await helper.wait();
            expectCallCount(1, waitUpdateHelpers, runtime.exit);
            expect(restartProcess).not.toHaveBeenCalled();
          }
        },
        createCloseMock().mockImplementation(async () => closing.resolve("closed")),
      );
    },
  );

  it.each(["lock", "beginBoot"] as const)(
    "fences replaced %s behind captured Stop",
    async (phase) => {
      await withIsolatedSignals(async ({ captureSignal }) => {
        const { start, started } = createSignaledStart(createCloseMock());
        const { runtime, exited } = createRuntimeWithExitSignal();
        const completeBoot = vi.fn();
        const startup = createLifecycleGate();
        const joined = createDeferredCore<boolean>();
        const settle = vi.fn(() => joined.promise);
        captureStop.mockReturnValueOnce({ settle, canPark: () => false });
        const beginBoot = vi.fn(startup.wait);
        await runLoop({
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
            await startup.wait();
            return { release: vi.fn(async () => {}) };
          });
        }
        await withRunLoopCleanup(
          async () => {
            if (phase !== "beginBoot") {
              captureSignal("SIGUSR2")();
            }
            await withTimeout(startup.entered, 4_000);
            captureSignal("SIGINT")();
            await waitForLoopCondition(
              () => settle.mock.calls.length === 1,
              "Stop did not capture update",
            );
            const replaceInstallation = await loadInstallationReplacement();
            replaceInstallation("replaced runtime");
            expect(start).toHaveBeenCalledTimes(phase === "beginBoot" ? 0 : 1);
            expect(runtime.exit).not.toHaveBeenCalled();
            startup.release();
            await waitForLoopCondition(
              () =>
                gatewayLog.error.mock.calls.some(([message]) =>
                  String(message).includes("Cannot continue in this process"),
                ),
              "continuation missed replacement fence",
            );
            await setImmediate();
            expect(admissionClosed()).toBe(true);
            expectCallCount(0, runtime.exit, completeBoot);
            expectCallCount(1, captureStop, settle);
            joined.resolve(true);
            await expect(withTimeout(exited, 4_000)).resolves.toBe(1);
            await setImmediate();
            expect(start).toHaveBeenCalledTimes(phase === "beginBoot" ? 0 : 1);
            expect(completeBoot).toHaveBeenCalledExactlyOnceWith(
              expect.objectContaining({ reason: replacementReason }),
            );
            expect(respawnUpdate).not.toHaveBeenCalled();
          },
          async () => {
            startup.release();
            joined.resolve(true);
            if (!runtime.exit.mock.calls.length) {
              captureSignal("SIGINT")();
            }
            await withTimeout(exited, 4_000);
            await setImmediate();
          },
          "Replacement Stop assertion and cleanup failed",
        );
      });
    },
  );
  it.each([
    ["failed-handoff", true, { mode: "failed", detail: "handoff unavailable" }, 1],
    ["existing-restart", false, { mode: "disabled", detail: "unmanaged" }, 1],
    ["managed-update", true, { mode: "disabled", detail: "unmanaged" }, 0],
    ["failed-close", true, { mode: "supervised", exitCode: 131071 }, 131071],
  ] as const)(
    "drains replaced installation before %s handoff",
    async (mode, supervised, restart, exitCode) => {
      if (supervised) {
        process.env.OPENCLAW_SYSTEMD_UNIT = "openclaw-gateway.service";
      }
      restartProcess.mockReturnValue(restart);
      const drain = deferredCall<{ drained: boolean; snapshot: GatewayActiveWorkSnapshot }>();
      waitActive.mockImplementationOnce(drain.call);
      const close = createCloseMock();
      if (mode === "failed-close") {
        close.mockRejectedValueOnce(new Error("old plugin chunk unavailable during close"));
      }
      await withReplacement(
        () => drain.resolve({ drained: true, snapshot: idleActiveWorkSnapshot }),
        async ({ signal, start, runtime, exited, boot, replace }) => {
          if (mode === "managed-update") {
            consumeSyncIntent.mockReturnValueOnce({
              reason: "update.run",
              successorOwner: managedUpdateSuccessorOwner,
            });
          }
          if (mode === "existing-restart" || mode === "managed-update") {
            signal("SIGUSR2")();
            await drain.entered;
          }
          replace("Cannot find module", "ERR_MODULE_NOT_FOUND");
          expect(admissionClosed()).toBe(true);
          expectCallCount(0, close, runtime.exit);
          drain.resolve({ drained: true, snapshot: idleActiveWorkSnapshot });
          await expect(exited).resolves.toBe(exitCode);
          expectCallCount(1, close, start);
          expect(boot).toHaveBeenCalledWith(
            expect.objectContaining({
              outcome: mode === "failed-close" ? "forced_stop" : "planned_restart",
              reason: replacementReason,
            }),
          );
          if (!supervised) {
            expect(gatewayLog.error).toHaveBeenCalledWith(
              expect.stringContaining("openclaw gateway run"),
            );
          }
          if (mode === "managed-update") {
            expect(commitUpdate).toHaveBeenCalledWith(managedUpdateSuccessorOwner, "update");
            expect(restartProcess).not.toHaveBeenCalled();
          }
        },
        close,
      );
    },
  );
}
