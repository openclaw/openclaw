import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../../test/helpers/promise.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { gatewayWorkAdmissionActual, runLoopFixture as f } from "./run-loop-mocks.test-support.js";
import {
  createLifecycleGate,
  advanceWithoutCalls,
  expectUncalled,
  createCloseMock,
  createGatewayServer,
  createRuntimeWithExitSignal,
  createSignaledStart,
  runGatewayLoop,
  systemdReply,
  withLifecycleClock,
  waitForStart,
  withIsolatedSignals,
} from "./run-loop.test-support.js";

function useSystemdSupervisor() {
  process.env.OPENCLAW_SYSTEMD_UNIT = "openclaw-gateway.service";
  f.systemctl.mockResolvedValue(systemdReply());
}

async function blockHostRetirement(gate: ReturnType<typeof createLifecycleGate>) {
  let block = false;
  const hostModule = await import("./host-lifecycle.js");
  const createHost = hostModule.createGatewayHostLifecycle;
  const factory = vi
    .spyOn(hostModule, "createGatewayHostLifecycle")
    .mockImplementation((params) => {
      const owner = createHost(params);
      return {
        ...owner,
        retire: async () => {
          await owner.retire();
          if (block) {
            block = false;
            await gate.wait();
          }
        },
      };
    });
  f.restartGatewayProcessWithFreshPid.mockImplementationOnce(() => {
    block = true;
    return { mode: "disabled" };
  });
  return () => factory.mockRestore();
}

async function withPhaseClock(
  gate: ReturnType<typeof createLifecycleGate>,
  run: () => Promise<void>,
) {
  await withLifecycleClock(async () => {
    try {
      await run();
    } finally {
      gate.release();
      await vi.advanceTimersByTimeAsync(0);
    }
  });
}

export function registerNaturalExitTests(waitForLoopTurn: () => Promise<void>) {
  it("preserves startup and final retirement failures after every cleanup owner settles", async () => {
    const startupFailure = new Error("fixture boot failed");
    const releaseFailure = new Error("fixture lock retirement failed");
    const release = vi.fn().mockRejectedValue(releaseFailure);
    const receipt = vi.fn();
    f.acquireGatewayLock.mockResolvedValueOnce({ release });
    await withIsolatedSignals(async () => {
      const actual = await import("./run-loop.js");
      await expect(
        actual.runGatewayLoop({
          ownsProcessLifecycle: true,
          beginBoot: vi.fn().mockRejectedValue(startupFailure),
          start: async () => createGatewayServer(createCloseMock()),
          onProcessResourcesSettled: receipt,
        }),
      ).rejects.toMatchObject({
        name: "AggregateError",
        errors: [startupFailure, releaseFailure],
        cause: startupFailure,
      });
      expect(receipt).toHaveBeenCalledExactlyOnceWith("retained");
    });
  });

  it("joins a late startup handle and final cleanup before returning the terminal code", async ({
    signal,
  }) => {
    await withIsolatedSignals(async ({ captureSignal }) => {
      const startup = createLifecycleGate();
      const draining = createDeferredCore();
      const order: string[] = [];
      const closeGate = createLifecycleGate(() => order.push("close"));
      const flushGate = createLifecycleGate(() => order.push("flush"));
      const drained = vi.fn();
      const close = vi.fn(closeGate.wait);
      f.acquireGatewayLock.mockResolvedValueOnce({
        release: vi.fn(async () => {
          order.push("release");
        }),
      });
      f.waitForGatewayActiveWork.mockImplementationOnce(async () => {
        draining.resolve();
        return { drained: true, snapshot: f.idleActiveWorkSnapshot };
      });
      f.flushLogger.mockImplementationOnce(flushGate.wait);
      const { runtime } = createRuntimeWithExitSignal();
      const loop = runGatewayLoop({
        runtime,
        onProcessResourcesSettled: drained,
        start: async () => {
          await startup.wait();
          return createGatewayServer(close);
        },
      });
      const settled = vi.fn();
      void loop.then(settled);
      try {
        await startup.entered;
        captureSignal("SIGTERM")();
        await draining.promise;
        await waitForLoopTurn();
        expectUncalled(f.flushLogger, close);
        startup.release();
        await withinTest(closeGate.entered, signal);
        expectUncalled(f.flushLogger, settled);
        closeGate.release();
        await flushGate.entered;
        expectUncalled(settled, drained);
        flushGate.release();
        await expect(withinTest(loop, signal)).resolves.toBe(0);
        expect(order).toEqual(["close", "release", "flush"]);
        expect(drained).toHaveBeenCalledExactlyOnceWith("drained");
      } finally {
        startup.release();
        closeGate.release();
        flushGate.release();
      }
    });
  });

  it("joins Gateway cleanup without feeding broken output back into shutdown", async () => {
    const previousCode = process.exitCode;
    const { exitAfterSignalExitBarriers, registerSignalExitOwner } =
      await import("../signal-exit-barrier.js");
    const closeGate = createLifecycleGate();
    try {
      await f.withRunningGateway(async ({ close, runtime, exited }) => {
        close.mockImplementationOnce(closeGate.wait);
        let outputFailures = 0;
        let feedbackLoop = false;
        f.gatewayLog.info.mockImplementation(() => {
          // A closed pipe reports another failure for each attempted shutdown log.
          // Bound the fixture so the original feedback loop can finish and fail.
          if (++outputFailures > 20) {
            feedbackLoop = true;
            return;
          }
          exitAfterSignalExitBarriers(7);
        });
        exitAfterSignalExitBarriers(0);
        await closeGate.entered;
        expect(runtime.exit).not.toHaveBeenCalled();
        expect(process.exitCode).toBe(previousCode);
        closeGate.release();
        await expect(exited).resolves.toBe(7);
        expect(feedbackLoop).toBe(false);
        const release = registerSignalExitOwner(() => {});
        release();
      }, true);
    } finally {
      f.gatewayLog.info.mockReset();
      closeGate.release();
      process.exitCode = previousCode;
    }
  });

  it.each(["running", "restarting", "stopping", "updating-close", "updating-handoff"] as const)(
    "records an unhandled rejection stop reason while %s",
    async (phase) => {
      const { exitAfterSignalExitBarriers } = await import("../signal-exit-barrier.js");
      const closeGate = createLifecycleGate();
      const handoffEntered = createDeferredCore();
      const handoffFinished = createDeferredCore<{ respawn: boolean }>();
      const completeBoot = vi.fn();
      const updating = phase === "updating-close" || phase === "updating-handoff";
      if (updating) {
        f.consumeGatewayRestartIntent.mockReturnValueOnce({
          reason: "update.run",
          successorOwner: {
            kind: "managed-update-handoff",
            handoffId: "stop-reason-test",
            installRoot: "/openclaw/install",
          },
        });
        f.isForegroundUpdateHandoff.mockReturnValue(true);
        f.completeForegroundUpdateHandoffAfterClose.mockImplementationOnce(() => {
          handoffEntered.resolve();
          return handoffFinished.promise;
        });
      }
      try {
        await withIsolatedSignals(async ({ captureSignal }) => {
          const { exited } = await f.createSignaledLoopHarness(undefined, true, {
            close: createCloseMock().mockImplementationOnce(closeGate.wait),
            completeBoot,
          });
          if (phase !== "running") {
            captureSignal(phase === "stopping" ? "SIGTERM" : "SIGUSR2")();
            await closeGate.entered;
          }
          if (phase === "updating-handoff") {
            closeGate.release();
            await handoffEntered.promise;
          }
          exitAfterSignalExitBarriers(1, "unhandled rejection");
          await closeGate.entered;
          closeGate.release();
          handoffFinished.resolve({ respawn: true });
          await expect(exited).resolves.toBe(1);
          expect(completeBoot).toHaveBeenCalledWith({
            outcome: "clean_stop",
            reason: "stop (process exit: unhandled rejection)",
          });
        });
      } finally {
        closeGate.release();
        handoffFinished.resolve({ respawn: false });
      }
    },
  );

  it.each([
    { deadline: false, failed: false },
    { deadline: true, failed: false },
    { deadline: false, failed: true },
  ])(
    "joins watchdog retirement before completion (deadline=$deadline, rejected=$failed)",
    async ({ deadline, failed }) => {
      const cancelGate = createLifecycleGate();
      const closeGate = createLifecycleGate();
      const failure = new Error("native watchdog retirement failed");
      const drained = vi.fn();
      const watchdog = f.cancelShutdownHardExitWatchdog;
      if (deadline) {
        useSystemdSupervisor();
      } else {
        watchdog.mockImplementationOnce(cancelGate.wait);
      }
      await f.withRunningGateway(
        async ({ captureSignal, close, runtime, exited }) => {
          if (deadline) {
            close.mockImplementationOnce(closeGate.wait);
          }
          const retire = async () => {
            try {
              captureSignal("SIGTERM")();
              if (deadline) {
                await vi.advanceTimersByTimeAsync(0);
                await closeGate.entered;
                watchdog.mockClear().mockImplementationOnce(cancelGate.wait);
                await advanceWithoutCalls(25_000, runtime.exit, watchdog);
                closeGate.release();
                await vi.advanceTimersByTimeAsync(0);
                await awaitGateBeforeSettlement(
                  cancelGate.entered,
                  exited,
                  "Gateway returned while its deadline watchdog was still armed",
                );
              } else {
                await cancelGate.entered;
              }
              expect(runtime.exit).not.toHaveBeenCalled();
              if (failed) {
                cancelGate.reject(failure);
              } else {
                cancelGate.release();
              }
              if (deadline) {
                await vi.advanceTimersByTimeAsync(0);
              }
              await expect(exited).resolves.toBe(failed ? 1 : 0);
              if (failed) {
                expect(drained).toHaveBeenCalledExactlyOnceWith("retained");
              }
            } finally {
              closeGate.release();
              cancelGate.release();
              if (deadline) {
                await vi.advanceTimersByTimeAsync(0);
                await exited;
              }
            }
          };
          await (deadline ? withLifecycleClock(retire) : retire());
        },
        true,
        failed ? { onProcessResourcesSettled: drained } : {},
      );
    },
  );

  it.each(["close", "restart-startup"] as const)(
    "does not report success when %s fails after a supervised zero-status deadline",
    async (phase) => {
      useSystemdSupervisor();
      const failure = new Error("late owned cleanup failed");
      const phaseGate = createLifecycleGate();
      const drained = vi.fn();
      const close = createCloseMock();
      if (phase === "close") {
        close.mockImplementationOnce(phaseGate.wait);
      }
      const initial = createSignaledStart(close);
      const start = initial.start;
      if (phase === "restart-startup") {
        // Vitest reuses existing mocks; queue the implementation, not the mock itself.
        const initialStart = start.getMockImplementation()!;
        start.mockImplementationOnce(initialStart).mockImplementationOnce(async () => {
          await phaseGate.wait();
          return createGatewayServer(close);
        });
      }
      const { runtime } = createRuntimeWithExitSignal();
      await withIsolatedSignals(async ({ captureSignal }) => {
        const loop = runGatewayLoop({ start, runtime, onProcessResourcesSettled: drained });
        const outcome = loop.then(
          (code) => ({ code }),
          (error: unknown) => ({ error }),
        );
        await waitForStart(initial.started);
        if (phase === "restart-startup") {
          captureSignal("SIGUSR2")();
          await phaseGate.entered;
        }
        await withPhaseClock(phaseGate, async () => {
          captureSignal("SIGTERM")();
          await advanceWithoutCalls(25_000, runtime.exit);
          phaseGate.reject(failure);
          await vi.advanceTimersByTimeAsync(0);
          await expect(outcome).resolves.toEqual(
            phase === "close" ? { code: 1 } : { error: failure },
          );
          expect(drained).toHaveBeenCalledExactlyOnceWith(
            phase === "close" ? "retained" : "drained",
          );
        });
      });
    },
  );

  it.each(["host-retirement", "restart-preparation", "begin-boot"] as const)(
    "does not acquire another generation after a terminal decision during %s",
    async (phase) => {
      useSystemdSupervisor();
      const phaseGate = createLifecycleGate();
      const restoreHost =
        phase === "host-retirement" ? await blockHostRetirement(phaseGate) : () => {};
      if (phase === "restart-preparation") {
        f.waitForActiveCronTaskRuns.mockImplementationOnce(async () => {
          await phaseGate.wait();
          return { drained: true, active: 0 };
        });
      }
      const beginBoot = vi.fn(async () => {
        if (phase === "begin-boot") {
          await phaseGate.wait();
        }
      });
      const { start, started } = createSignaledStart(createCloseMock());
      const { runtime } = createRuntimeWithExitSignal();
      const completeBoot = vi.fn();
      try {
        await withIsolatedSignals(async ({ captureSignal }) => {
          const loop = runGatewayLoop({ start, runtime, beginBoot, completeBoot });
          if (phase !== "begin-boot") {
            await waitForStart(started);
            captureSignal("SIGUSR2")();
          }
          await phaseGate.entered;
          await withPhaseClock(phaseGate, async () => {
            captureSignal("SIGUSR2")();
            await vi.advanceTimersByTimeAsync(25_000);
            expect(completeBoot).toHaveBeenCalledWith(
              expect.objectContaining({ outcome: "forced_stop" }),
            );
            phaseGate.release();
            await vi.advanceTimersByTimeAsync(0);
            await expect(loop).resolves.toBe(1);
            expect(start).toHaveBeenCalledTimes(phase === "begin-boot" ? 0 : 1);
            expect(beginBoot).toHaveBeenCalledOnce();
            expect(gatewayWorkAdmissionActual.isGatewayWorkAdmissionClosed()).toBe(true);
          });
        });
      } finally {
        phaseGate.release();
        restoreHost();
      }
    },
  );
}
