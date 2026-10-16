import { expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  advanceWithoutCalls,
  createActiveWorkSnapshot,
  expectRestartCloseCall,
  expectUncalled,
  systemdReply,
  withIsolatedSignals,
  withLifecycleClock,
  type UpdateRespawnFixtures,
} from "./run-loop.test-support.js";

export function registerGatewayForcedRestartTests({
  createSignaledLoopHarness,
  withRunningGateway,
  createGatewayActiveWorkSnapshot,
  abortActiveCronTaskRuns,
  waitForGatewayActiveWork,
  consumeGatewayRestartIntent,
  readCgroup,
  systemctl,
}: UpdateRespawnFixtures): void {
  const idleActiveWorkSnapshot = createActiveWorkSnapshot();
  it("preserves the native drain and hard deadline after deferral expires", async () => {
    readCgroup.mockResolvedValue("0::/system.slice/openclaw-gateway.service\n");
    systemctl.mockResolvedValue(systemdReply("90s"));
    const active = createActiveWorkSnapshot({ agentRuns: 1, embeddedRuns: 1, cronRuns: 1 });
    createGatewayActiveWorkSnapshot.mockReturnValueOnce(active);
    const drain = createDeferredCore<{ drained: boolean; snapshot: typeof active }>();
    waitForGatewayActiveWork.mockImplementationOnce(() => drain.promise);

    await withRunningGateway(async ({ captureSignal, close, start, runtime, exited }) => {
      const restartSignal = captureSignal("SIGUSR2");
      const restart =
        await vi.importActual<typeof import("../../infra/restart.js")>("../../infra/restart.js");
      const closing = createDeferredCore();
      close.mockImplementationOnce(() => closing.promise);
      await withLifecycleClock(async () => {
        const deferral = restart.deferGatewayRestartUntilIdle({
          getPendingCount: () => 1,
          maxWaitMs: 300_000,
          timeoutIntent: { force: true, reason: "config reload forced restart" },
          emitHooks: {
            emitRestart: (_reason, intent) => {
              consumeGatewayRestartIntent.mockReturnValueOnce(intent ?? null);
              restartSignal();
              return { status: "emitted" };
            },
          },
        });
        try {
          await advanceWithoutCalls(300_000, close, abortActiveCronTaskRuns, runtime.exit);
          expect(waitForGatewayActiveWork).toHaveBeenCalledExactlyOnceWith(
            75_000,
            expect.any(Object),
          );
          captureSignal("SIGINT")();
          expect(waitForGatewayActiveWork).toHaveBeenCalledOnce();

          await advanceWithoutCalls(75_000, close, abortActiveCronTaskRuns);
          drain.resolve({ drained: false, snapshot: active });
          await vi.advanceTimersByTimeAsync(0);
          expectRestartCloseCall(close, 0);
          expect(abortActiveCronTaskRuns).toHaveBeenCalledWith(undefined);
          await advanceWithoutCalls(9_999, runtime.exit);
          await advanceWithoutCalls(1, runtime.exit);
          closing.resolve();
          await vi.advanceTimersByTimeAsync(0);
          expect(runtime.exit).toHaveBeenCalledExactlyOnceWith(1);
          expect(start).toHaveBeenCalledOnce();
        } finally {
          deferral.cancel();
          restart.resetGatewayRestartStateForInProcessRestart();
          drain.resolve({ drained: true, snapshot: idleActiveWorkSnapshot });
          closing.resolve();
          await vi.advanceTimersByTimeAsync(0);
          if (runtime.exit.mock.calls.length === 0) {
            captureSignal("SIGINT")();
            await vi.advanceTimersByTimeAsync(0);
          }
          await exited;
        }
      });
    });
  });

  it("records cut work only when the forced caller drain budget expires", async () => {
    const budget = 45_000;
    const refreshMs = 10_000;
    const active = createActiveWorkSnapshot({ agentRuns: 1, cronRuns: 1 });
    const drain = createDeferredCore<{ drained: boolean; snapshot: typeof active }>();
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const nativeReply = systemdReply("330s");
    readCgroup.mockResolvedValue("0::/system.slice/openclaw-gateway.service\n");
    systemctl.mockResolvedValue(nativeReply);
    consumeGatewayRestartIntent.mockReturnValueOnce({ force: true });
    createGatewayActiveWorkSnapshot.mockReturnValueOnce(active);
    waitForGatewayActiveWork.mockImplementationOnce((timeoutMs) => {
      if (timeoutMs !== undefined) {
        deadline = setTimeout(() => drain.resolve({ drained: false, snapshot: active }), timeoutMs);
      }
      return drain.promise;
    });
    await withIsolatedSignals(async ({ captureSignal }) => {
      const closing = createDeferredCore();
      const completeBoot = vi.fn();
      const { close, start, runtime, exited } = await createSignaledLoopHarness(undefined, false, {
        completeBoot,
      });
      close.mockImplementationOnce(() => closing.promise);
      await withLifecycleClock(async () => {
        systemctl.mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              setTimeout(() => resolve(nativeReply), refreshMs);
            }),
        );
        try {
          captureSignal("SIGUSR2")();
          await advanceWithoutCalls(budget - 1, close, abortActiveCronTaskRuns, completeBoot);
          await vi.advanceTimersByTimeAsync(1);
          expect(abortActiveCronTaskRuns).toHaveBeenCalledWith(undefined);
          expectRestartCloseCall(close, 0);
          const warning = `restart drain budget ${budget - refreshMs}ms exhausted; cutting short cronRuns=1 agentRuns=1`;
          expect(start).toHaveBeenCalledOnce();
          expectUncalled(completeBoot, runtime.exit);
          await advanceWithoutCalls(9_999, completeBoot, runtime.exit);
          await advanceWithoutCalls(1, runtime.exit);
          closing.resolve();
          await vi.advanceTimersByTimeAsync(0);
          expect(runtime.exit).toHaveBeenCalledExactlyOnceWith(1);
          expect(completeBoot).toHaveBeenCalledExactlyOnceWith({
            outcome: "forced_stop",
            reason: `${warning}; gateway.restart_shutdown_timeout`,
          });
          expect(start).toHaveBeenCalledOnce();
        } finally {
          clearTimeout(deadline);
          drain.resolve({ drained: true, snapshot: idleActiveWorkSnapshot });
          closing.resolve();
          await vi.advanceTimersByTimeAsync(0);
          if (runtime.exit.mock.calls.length === 0) {
            captureSignal("SIGINT")();
            await vi.advanceTimersByTimeAsync(0);
          }
          await exited;
        }
      });
    });
  });
}
