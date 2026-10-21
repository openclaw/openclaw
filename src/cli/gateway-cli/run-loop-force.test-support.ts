import { expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  advanceWithoutCalls,
  createActiveWorkSnapshot,
  expectRestartCloseCall,
  expectUncalled,
  systemdReply,
  withLifecycleClock,
  type UpdateRespawnFixtures,
} from "./run-loop.test-support.js";

export function registerGatewayForcedRestartTests(f: UpdateRespawnFixtures): void {
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
                expect(f.waitForGatewayActiveWork).toHaveBeenCalledExactlyOnceWith(
                  75_000,
                  expect.any(Object),
                );
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
                expect(start).toHaveBeenCalledOnce();
                expectUncalled(completeBoot, runtime.exit);
              }
              expectRestartCloseCall(close, 0);
              expect(f.abortActiveCronTaskRuns).toHaveBeenCalledWith(undefined);
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
