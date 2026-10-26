import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { classifyChildRuntimeFailure } from "../../infra/child-runtime-viability.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  advanceWithoutCalls,
  createActiveWorkSnapshot,
  createLifecycleGate,
  expectUncalled,
  systemdReply,
  withLifecycleClock,
  type UpdateRespawnFixtures,
} from "./run-loop.test-support.js";

export function registerGatewayForcedRestartTests(f: UpdateRespawnFixtures): void {
  const freshProcessIntent = () => ({ force: true, waitMs: 0, requireFreshProcess: true });
  it.each(["unavailable", "disabled", "failed"] as const)(
    "refuses %s in-process recovery",
    async (mode) => {
      const unavailable = mode === "unavailable";
      const execPath = process.execPath;
      f.restartGatewayProcessWithFreshPid.mockReturnValue({
        mode: mode === "unavailable" ? "failed" : mode,
      });
      if (!unavailable) {
        f.consumeGatewayRestartIntent.mockReturnValueOnce(freshProcessIntent());
      }
      try {
        await f.withRunningGateway(async ({ captureSignal, close, start, exited }) => {
          if (unavailable) {
            process.execPath = `/fixture/unavailable-${randomUUID()}/node`;
            classifyChildRuntimeFailure({
              stderr: "dyld[123]: Library not loaded: /fixture/libnode.dylib",
            });
          }
          captureSignal("SIGUSR2")();
          await expect(exited).resolves.toBe(1);
          expect(close).toHaveBeenCalledOnce();
          expect(start).toHaveBeenCalledOnce();
          const subject = unavailable ? "unavailable child runtime" : "unsettled native worker";
          expect(f.gatewayLog.error).toHaveBeenCalledWith(
            expect.stringContaining(`${subject} cannot recover in-process`),
          );
        });
      } finally {
        process.execPath = execPath;
      }
    },
  );

  it("records native recovery before watchdogs and retains its forced close budget", async () => {
    const recording = createLifecycleGate();
    const closing = createLifecycleGate();
    const completeBoot = vi.fn(recording.wait);
    process.env.OPENCLAW_SYSTEMD_UNIT = "openclaw-fixture.service";
    f.peekGatewayRestartReason.mockReturnValue("gateway.native-worker-unsettled");
    f.consumeGatewayRestartIntent.mockReturnValueOnce(freshProcessIntent());
    // A durable operator intent cannot downgrade the current recovery requirement.
    f.consumeGatewayRestartIntentPayload.mockResolvedValueOnce({ waitMs: 60_000 });
    f.restartGatewayProcessWithFreshPid.mockReturnValue({ mode: "supervised" });
    await f.withRunningGateway(
      async ({ captureSignal, close, exited, loopPromise, start }) => {
        close.mockImplementationOnce(closing.wait);
        const before = f.armShutdownHardExitWatchdog.mock.calls.length;
        try {
          captureSignal("SIGUSR2")();
          expect(
            await Promise.race([
              recording.entered.then(() => "recording"),
              closing.entered.then(() => "closing"),
            ]),
          ).toBe("recording");
          expect(completeBoot).toHaveBeenCalledExactlyOnceWith({
            outcome: "planned_restart",
            reason: "restart (SIGUSR2: gateway.native-worker-unsettled)",
          });
          expect(f.armShutdownHardExitWatchdog).toHaveBeenCalledTimes(before);
          expect(close).not.toHaveBeenCalled();
          recording.release();
          await closing.entered;
          expect(f.isGatewayWorkAdmissionClosed()).toBe(true);
          expectUncalled(f.restartGatewayProcessWithFreshPid);
          const watchdogs = f.armShutdownHardExitWatchdog.mock.calls;
          expect(watchdogs.length).toBeGreaterThan(before);
          expect(watchdogs.at(-1)?.[0].delayMs).toBeGreaterThan(2_000);
          expect(watchdogs.at(-1)?.[0].delayMs).toBeLessThanOrEqual(12_000);
          expect(f.cancelShutdownHardExitWatchdog).toHaveBeenCalledTimes(watchdogs.length - 1);
        } finally {
          recording.release();
          closing.release();
          if (!close.mock.calls.length) {
            captureSignal("SIGINT")();
          }
          await loopPromise;
        }
        await expect(exited).resolves.toBe(0);
        expect(start).toHaveBeenCalledOnce();
      },
      true,
      { completeBoot },
    );
  });

  it.each(["deferred", "caller-budget"] as const)(
    "preserves forced drain and hard deadlines for a %s restart",
    async (mode) => {
      const deferred = mode === "deferred";
      const active = createActiveWorkSnapshot({
        agentRuns: 1,
        cronRuns: 1,
        ...(deferred ? { embeddedRuns: 1 } : {}),
      });
      const drain = createDeferredCore<{ drained: boolean; snapshot: typeof active }>();
      const closing = createDeferredCore();
      const completeBoot = vi.fn();
      const nativeReply = systemdReply(deferred ? "90s" : "330s");
      let deadline: ReturnType<typeof setTimeout> | undefined;
      f.readCgroup.mockResolvedValue("0::/system.slice/openclaw-gateway.service\n");
      f.systemctl.mockResolvedValue(nativeReply);
      f.createGatewayActiveWorkSnapshot.mockReturnValueOnce(active);
      f.waitForGatewayActiveWork.mockImplementationOnce((timeoutMs) => {
        if (!deferred && timeoutMs !== undefined) {
          deadline = setTimeout(
            () => drain.resolve({ drained: false, snapshot: active }),
            timeoutMs,
          );
        }
        return drain.promise;
      });
      if (!deferred) {
        f.consumeGatewayRestartIntent.mockReturnValueOnce({ force: true });
      }
      await f.withRunningGateway(
        async ({ captureSignal, close, start, runtime, exited }) => {
          const restart = deferred
            ? await vi.importActual<typeof import("../../infra/restart.js")>(
                "../../infra/restart.js",
              )
            : undefined;
          close.mockImplementationOnce(() => closing.promise);
          await withLifecycleClock(async () => {
            const deferral = restart?.deferGatewayRestartUntilIdle({
              getPendingCount: () => 1,
              maxWaitMs: 300_000,
              timeoutIntent: { force: true, reason: "config reload forced restart" },
              emitHooks: {
                emitRestart: (_reason, intent) => {
                  f.consumeGatewayRestartIntent.mockReturnValueOnce(intent ?? null);
                  captureSignal("SIGUSR2")();
                  return { status: "emitted" };
                },
              },
            });
            try {
              if (deferred) {
                await advanceWithoutCalls(300_000, close, f.abortActiveCronTaskRuns, runtime.exit);
                captureSignal("SIGINT")();
                expect(f.waitForGatewayActiveWork).toHaveBeenCalledOnce();
                await advanceWithoutCalls(75_000, close, f.abortActiveCronTaskRuns);
                drain.resolve({ drained: false, snapshot: active });
                await vi.advanceTimersByTimeAsync(0);
              } else {
                f.systemctl.mockImplementationOnce(
                  () =>
                    new Promise((resolve) => {
                      setTimeout(() => resolve(nativeReply), 10_000);
                    }),
                );
                captureSignal("SIGUSR2")();
                await advanceWithoutCalls(44_999, close, f.abortActiveCronTaskRuns, completeBoot);
                await vi.advanceTimersByTimeAsync(1);
                expectUncalled(completeBoot, runtime.exit);
              }
              expect(close).toHaveBeenCalledOnce();
              await advanceWithoutCalls(9_999, runtime.exit, ...(deferred ? [] : [completeBoot]));
              await advanceWithoutCalls(1, runtime.exit);
              closing.resolve();
              await vi.advanceTimersByTimeAsync(0);
              expect(runtime.exit).toHaveBeenCalledExactlyOnceWith(1);
              expect(start).toHaveBeenCalledOnce();
              if (!deferred) {
                expect(completeBoot).toHaveBeenCalledExactlyOnceWith({
                  outcome: "forced_stop",
                  reason:
                    "restart drain budget 35000ms exhausted; cutting short cronRuns=1 agentRuns=1; gateway.restart_shutdown_timeout",
                });
              }
            } finally {
              deferral?.cancel();
              restart?.resetGatewayRestartStateForInProcessRestart();
              clearTimeout(deadline);
              drain.resolve({ drained: true, snapshot: createActiveWorkSnapshot() });
              closing.resolve();
              await vi.advanceTimersByTimeAsync(0);
              if (runtime.exit.mock.calls.length === 0) {
                captureSignal("SIGINT")();
                await vi.advanceTimersByTimeAsync(0);
              }
              await exited;
            }
          });
        },
        false,
        { completeBoot },
      );
    },
  );
}
