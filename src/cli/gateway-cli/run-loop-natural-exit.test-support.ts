import { performance } from "node:perf_hooks";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../../test/helpers/promise.js";
import type { GatewayServer } from "../../gateway/server-public.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { gatewayWorkAdmissionActual, runLoopFixture } from "./run-loop-mocks.test-support.js";
import {
  createCloseMock,
  createGatewayServer,
  createRuntimeWithExitSignal,
  createSignaledStart,
  waitForStart,
  withIsolatedSignals,
} from "./run-loop.test-support.js";

const {
  acquireGatewayLock,
  waitForGatewayActiveWork,
  idleActiveWorkSnapshot,
  flushLogger,
  createSignaledLoopHarness,
  gatewayLog,
  systemctl,
  restartGatewayProcessWithFreshPid,
  waitForActiveCronTaskRuns,
} = runLoopFixture;

export function registerNaturalExitTests(waitForLoopTurn: () => Promise<void>) {
  it("preserves startup and final retirement failures after every cleanup owner settles", async () => {
    const startupFailure = new Error("fixture boot failed");
    const releaseFailure = new Error("fixture lock retirement failed");
    const release = vi.fn(async () => {
      throw releaseFailure;
    });
    const receipt = vi.fn();
    acquireGatewayLock.mockResolvedValueOnce({ release });
    await withIsolatedSignals(async () => {
      const { runGatewayLoop } = await import("./run-loop.js");
      await expect(
        runGatewayLoop({
          ownsProcessLifecycle: true,
          beginBoot: async () => {
            throw startupFailure;
          },
          start: async () => createGatewayServer(createCloseMock()),
          onProcessResourcesSettled: receipt,
        }),
      ).rejects.toMatchObject({
        name: "AggregateError",
        errors: [startupFailure, releaseFailure],
        cause: startupFailure,
      });
      expect(release).toHaveBeenCalledOnce();
      expect(receipt).toHaveBeenCalledExactlyOnceWith("retained");
    });
  });

  it("joins a late startup handle and final cleanup before returning the terminal code", async ({
    signal,
  }) => {
    await withIsolatedSignals(async ({ captureSignal }) => {
      const entered = createDeferredCore();
      const started = createDeferredCore<GatewayServer>();
      const draining = createDeferredCore();
      const closing = createDeferredCore();
      const closed = createDeferredCore();
      const flushing = createDeferredCore();
      const flushed = createDeferredCore();
      const order: string[] = [];
      const drained = vi.fn();
      const close = vi.fn(async () => {
        order.push("close");
        closing.resolve();
        await closed.promise;
      });
      acquireGatewayLock.mockResolvedValueOnce({
        release: vi.fn(async () => {
          order.push("release");
        }),
      });
      waitForGatewayActiveWork.mockImplementationOnce(async () => {
        draining.resolve();
        return { drained: true, snapshot: idleActiveWorkSnapshot };
      });
      flushLogger.mockImplementationOnce(async () => {
        order.push("flush");
        flushing.resolve();
        await flushed.promise;
      });
      const { runGatewayLoop } = await import("./run-loop.test-support.js");
      const { runtime } = createRuntimeWithExitSignal();
      const loop = runGatewayLoop({
        runtime,
        onProcessResourcesSettled: drained,
        start: async () => {
          entered.resolve();
          return started.promise;
        },
      });
      let settled = false;
      void loop.then(() => {
        settled = true;
      });
      try {
        await entered.promise;
        captureSignal("SIGTERM")();
        await draining.promise;
        await waitForLoopTurn();
        expect(flushLogger).not.toHaveBeenCalled();
        expect(close).not.toHaveBeenCalled();
        started.resolve(createGatewayServer(close));
        await withinTest(closing.promise, signal);
        expect(flushLogger).not.toHaveBeenCalled();
        expect(settled).toBe(false);
        closed.resolve();
        await flushing.promise;
        expect(settled).toBe(false);
        expect(drained).not.toHaveBeenCalled();
        flushed.resolve();
        await expect(withinTest(loop, signal)).resolves.toBe(0);
        expect(close).toHaveBeenCalledOnce();
        expect(order).toEqual(["close", "release", "flush"]);
        expect(drained).toHaveBeenCalledExactlyOnceWith("drained");
      } finally {
        started.resolve(createGatewayServer(close));
        closed.resolve();
        flushed.resolve();
      }
    });
  });

  it("owns output failure without a stdin lifeline until Gateway cleanup joins", async () => {
    const previousCode = process.exitCode;
    const { exitAfterSignalExitBarriers, registerSignalExitOwner } =
      await import("../signal-exit-barrier.js");
    const closing = createDeferredCore();
    const closed = createDeferredCore();
    try {
      await withIsolatedSignals(async () => {
        const { close, runtime, exited } = await createSignaledLoopHarness(undefined, true);
        close.mockImplementationOnce(async () => {
          closing.resolve();
          await closed.promise;
        });
        exitAfterSignalExitBarriers(7);
        await closing.promise;
        expect(runtime.exit).not.toHaveBeenCalled();
        expect(process.exitCode).toBe(previousCode);
        closed.resolve();
        await expect(exited).resolves.toBe(7);
        expect(close).toHaveBeenCalledOnce();
        // The native process owner is released only after the loop actually returns.
        const release = registerSignalExitOwner(() => {});
        release();
      });
    } finally {
      closed.resolve();
      process.exitCode = previousCode;
    }
  });

  it("joins native watchdog cancellation before terminal completion", async () => {
    const cancelling = createDeferredCore();
    const cancelled = createDeferredCore();
    runLoopFixture.cancelShutdownHardExitWatchdog.mockImplementationOnce(async () => {
      cancelling.resolve();
      await cancelled.promise;
    });
    await withIsolatedSignals(async ({ captureSignal }) => {
      const { runtime, exited } = await createSignaledLoopHarness(undefined, true);
      try {
        captureSignal("SIGTERM")();
        await cancelling.promise;
        expect(runtime.exit).not.toHaveBeenCalled();
        cancelled.resolve();
        await expect(exited).resolves.toBe(0);
      } finally {
        cancelled.resolve();
      }
    });
  });

  it("joins the request watchdog after deadline cleanup eventually settles", async () => {
    process.env.OPENCLAW_SYSTEMD_UNIT = "openclaw-gateway.service";
    systemctl.mockResolvedValue({
      code: 0,
      stdout: "LoadState=loaded\nTimeoutStopUSec=30s",
      stderr: "",
    });
    const closing = createDeferredCore();
    const closed = createDeferredCore();
    const cancelling = createDeferredCore();
    const cancelled = createDeferredCore();
    await withIsolatedSignals(async ({ captureSignal }) => {
      const { close, runtime, exited } = await createSignaledLoopHarness(undefined, true);
      close.mockImplementationOnce(async () => {
        closing.resolve();
        await closed.promise;
      });
      vi.useFakeTimers();
      const clock = vi.spyOn(performance, "now").mockImplementation(() => Date.now());
      try {
        captureSignal("SIGTERM")();
        await vi.advanceTimersByTimeAsync(0);
        await closing.promise;
        runLoopFixture.cancelShutdownHardExitWatchdog.mockClear();
        runLoopFixture.cancelShutdownHardExitWatchdog.mockImplementationOnce(async () => {
          cancelling.resolve();
          await cancelled.promise;
        });
        await vi.advanceTimersByTimeAsync(25_000);
        expect(runtime.exit).not.toHaveBeenCalled();
        expect(runLoopFixture.cancelShutdownHardExitWatchdog).not.toHaveBeenCalled();
        closed.resolve();
        await vi.advanceTimersByTimeAsync(0);
        await awaitGateBeforeSettlement(
          cancelling.promise,
          exited,
          "Gateway returned while its deadline watchdog was still armed",
        );
        expect(runtime.exit).not.toHaveBeenCalled();
        cancelled.resolve();
        await vi.advanceTimersByTimeAsync(0);
        await expect(exited).resolves.toBe(0);
        expect(runLoopFixture.cancelShutdownHardExitWatchdog).toHaveBeenCalledOnce();
      } finally {
        closed.resolve();
        cancelled.resolve();
        await vi.advanceTimersByTimeAsync(0);
        await exited;
        clock.mockRestore();
        vi.useRealTimers();
      }
    });
  });

  it("retains a rejected watchdog retirement after the terminal zero decision", async () => {
    const cancelling = createDeferredCore();
    const cancelled = createDeferredCore();
    const failure = new Error("native watchdog retirement failed");
    const drained = vi.fn();
    runLoopFixture.cancelShutdownHardExitWatchdog.mockImplementationOnce(async () => {
      cancelling.resolve();
      await cancelled.promise;
    });
    await withIsolatedSignals(async ({ captureSignal }) => {
      const { start, started } = createSignaledStart(createCloseMock());
      const { runtime } = createRuntimeWithExitSignal();
      const { runGatewayLoop } = await import("./run-loop.test-support.js");
      const loop = runGatewayLoop({
        start,
        runtime,
        ownsProcessLifecycle: true,
        onProcessResourcesSettled: drained,
      });
      await waitForStart(started);
      try {
        captureSignal("SIGTERM")();
        await cancelling.promise;
        expect(runtime.exit).not.toHaveBeenCalled();
        cancelled.reject(failure);
        await expect(loop).resolves.toBe(1);
        expect(drained).toHaveBeenCalledExactlyOnceWith("retained");
        expect(gatewayLog.error).toHaveBeenCalledWith(
          "gateway lifecycle completion failed: native watchdog retirement failed",
        );
      } finally {
        cancelled.resolve();
      }
    });
  });

  it.each(["close", "restart-startup"] as const)(
    "does not report success when %s fails after a supervised zero-status deadline",
    async (phase) => {
      process.env.OPENCLAW_SYSTEMD_UNIT = "openclaw-gateway.service";
      systemctl.mockResolvedValue({
        code: 0,
        stdout: "LoadState=loaded\nTimeoutStopUSec=30s",
        stderr: "",
      });
      const failure = new Error("late owned cleanup failed");
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const drained = vi.fn();
      const close = createCloseMock();
      if (phase === "close") {
        close.mockImplementationOnce(async () => {
          entered.resolve();
          await release.promise;
        });
      }
      const { start, started } = createSignaledStart(close);
      const startedInitial = createDeferredCore();
      if (phase === "restart-startup") {
        start.mockImplementationOnce(async () => {
          startedInitial.resolve();
          return createGatewayServer(close);
        });
        start.mockImplementationOnce(async () => {
          entered.resolve();
          await release.promise;
          return createGatewayServer(close);
        });
      }
      const { runtime } = createRuntimeWithExitSignal();
      const { runGatewayLoop } = await import("./run-loop.test-support.js");
      await withIsolatedSignals(async ({ captureSignal }) => {
        const loop = runGatewayLoop({ start, runtime, onProcessResourcesSettled: drained });
        const outcome = loop.then(
          (code) => ({ code }),
          (error: unknown) => ({ error }),
        );
        await waitForStart(phase === "close" ? started : startedInitial.promise);
        if (phase === "restart-startup") {
          captureSignal("SIGUSR2")();
          await entered.promise;
        }
        vi.useFakeTimers();
        const clock = vi.spyOn(performance, "now").mockImplementation(() => Date.now());
        try {
          captureSignal("SIGTERM")();
          await vi.advanceTimersByTimeAsync(25_000);
          expect(runtime.exit).not.toHaveBeenCalled();
          release.reject(failure);
          await vi.advanceTimersByTimeAsync(0);
          await expect(outcome).resolves.toEqual(
            phase === "close" ? { code: 1 } : { error: failure },
          );
          expect(drained).toHaveBeenCalledExactlyOnceWith(
            phase === "close" ? "retained" : "drained",
          );
        } finally {
          release.resolve();
          await vi.advanceTimersByTimeAsync(0);
          clock.mockRestore();
          vi.useRealTimers();
        }
      });
    },
  );

  it.each(["host-retirement", "restart-preparation", "begin-boot"] as const)(
    "does not acquire another generation after a terminal decision during %s",
    async (phase) => {
      process.env.OPENCLAW_SYSTEMD_UNIT = "openclaw-gateway.service";
      systemctl.mockResolvedValue({
        code: 0,
        stdout: "LoadState=loaded\nTimeoutStopUSec=30s",
        stderr: "",
      });
      const entered = createDeferredCore();
      const release = createDeferredCore();
      let blockRetirement = false;
      let retirementBlocked = false;
      const hostModule = await import("./host-lifecycle.js");
      const createHost = hostModule.createGatewayHostLifecycle;
      const hostFactory = vi
        .spyOn(hostModule, "createGatewayHostLifecycle")
        .mockImplementation((params) => {
          const owner = createHost(params);
          return {
            ...owner,
            retire: async () => {
              await owner.retire();
              if (phase === "host-retirement" && blockRetirement && !retirementBlocked) {
                retirementBlocked = true;
                entered.resolve();
                await release.promise;
              }
            },
          };
        });
      if (phase === "host-retirement") {
        restartGatewayProcessWithFreshPid.mockImplementationOnce(() => {
          blockRetirement = true;
          return { mode: "disabled" };
        });
      }
      if (phase === "restart-preparation") {
        waitForActiveCronTaskRuns.mockImplementationOnce(async () => {
          entered.resolve();
          await release.promise;
          return { drained: true, active: 0 };
        });
      }
      const beginBoot = vi.fn(async () => {
        if (phase === "begin-boot") {
          entered.resolve();
          await release.promise;
        }
      });
      const { start, started } = createSignaledStart(createCloseMock());
      const { runtime } = createRuntimeWithExitSignal();
      const completeBoot = vi.fn();
      const { runGatewayLoop } = await import("./run-loop.test-support.js");
      try {
        await withIsolatedSignals(async ({ captureSignal }) => {
          const loop = runGatewayLoop({ start, runtime, beginBoot, completeBoot });
          if (phase !== "begin-boot") {
            await waitForStart(started);
            captureSignal("SIGUSR2")();
          }
          await entered.promise;
          vi.useFakeTimers();
          const clock = vi.spyOn(performance, "now").mockImplementation(() => Date.now());
          try {
            captureSignal("SIGUSR2")();
            await vi.advanceTimersByTimeAsync(25_000);
            expect(completeBoot).toHaveBeenCalledWith(
              expect.objectContaining({ outcome: "forced_stop" }),
            );
            release.resolve();
            await vi.advanceTimersByTimeAsync(0);
            await expect(loop).resolves.toBe(1);
            expect(start).toHaveBeenCalledTimes(phase === "begin-boot" ? 0 : 1);
            expect(beginBoot).toHaveBeenCalledOnce();
            expect(hostFactory).toHaveBeenCalledTimes(phase === "restart-preparation" ? 2 : 1);
            expect(gatewayWorkAdmissionActual.isGatewayWorkAdmissionClosed()).toBe(true);
          } finally {
            release.resolve();
            await vi.advanceTimersByTimeAsync(0);
            clock.mockRestore();
            vi.useRealTimers();
          }
        });
      } finally {
        release.resolve();
        hostFactory.mockRestore();
      }
    },
  );
}
