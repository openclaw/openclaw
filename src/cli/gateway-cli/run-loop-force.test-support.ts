import { performance } from "node:perf_hooks";
import { expect, it, vi } from "vitest";
import type { GatewayActiveWorkSnapshot } from "../../infra/gateway-active-work.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  createActiveWorkSnapshot,
  createCloseMock,
  createRuntimeWithExitSignal,
  createSignaledStart,
  expectRestartCloseCall,
  waitForStart,
  withIsolatedSignals,
  type UpdateRespawnFixtures,
} from "./run-loop.test-support.js";

export function registerGatewayForcedRestartTests({
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
}: UpdateRespawnFixtures): void {
  const idleActiveWorkSnapshot = createActiveWorkSnapshot();
  it.each([true, false])(
    "preserves the native drain and hard deadline after deferral expires (work settles=%s)",
    async (settles) => {
      readCgroup.mockResolvedValue("0::/system.slice/openclaw-gateway.service\n");
      systemctl.mockResolvedValue({
        code: 0,
        stdout: "LoadState=loaded\nTimeoutStopUSec=90s",
        stderr: "",
      });
      const active = createActiveWorkSnapshot({ agentRuns: 1, embeddedRuns: 1, cronRuns: 1 });
      createGatewayActiveWorkSnapshot.mockReturnValueOnce(active);
      const drain = createDeferredCore<{ drained: boolean; snapshot: typeof active }>();
      waitForGatewayActiveWork.mockImplementationOnce(() => drain.promise);

      await withIsolatedSignals(async ({ captureSignal }) => {
        const { close, start, runtime, exited } = await createSignaledLoopHarness();
        const restartSignal = captureSignal("SIGUSR2");
        const restart =
          await vi.importActual<typeof import("../../infra/restart.js")>("../../infra/restart.js");
        const closing = createDeferredCore();
        if (!settles) {
          close.mockImplementationOnce(() => closing.promise);
        }
        vi.useFakeTimers();
        const clock = vi.spyOn(performance, "now").mockImplementation(() => Date.now());
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
          await vi.advanceTimersByTimeAsync(300_000);
          expect(waitForGatewayActiveWork).toHaveBeenCalledExactlyOnceWith(
            75_000,
            expect.any(Object),
          );
          expect(close).not.toHaveBeenCalled();
          expect(abortActiveCronTaskRuns).not.toHaveBeenCalled();
          expect(runtime.exit).not.toHaveBeenCalled();

          await vi.advanceTimersByTimeAsync(settles ? 1_000 : 75_000);
          expect(close).not.toHaveBeenCalled();
          expect(abortActiveCronTaskRuns).not.toHaveBeenCalled();
          drain.resolve({ drained: settles, snapshot: settles ? idleActiveWorkSnapshot : active });
          await vi.advanceTimersByTimeAsync(0);
          expectRestartCloseCall(close, settles ? 74_000 : 0);
          if (settles) {
            expect(start).toHaveBeenCalledTimes(2);
          } else {
            expect(abortActiveCronTaskRuns).toHaveBeenCalledWith("Gateway restarting.");
            await vi.advanceTimersByTimeAsync(9_999);
            expect(runtime.exit).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(1);
            expect(runtime.exit).toHaveBeenCalledExactlyOnceWith(1);
            expect(start).toHaveBeenCalledOnce();
          }
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
          clock.mockRestore();
          vi.useRealTimers();
        }
      });
    },
  );

  it.each([
    { signal: "SIGTERM", waitMs: undefined, budget: 45_000 },
    { signal: "SIGUSR2", waitMs: 180_000, budget: 180_000 },
  ] as const)(
    "drains admitted work before a forced $signal restart (budget=$budget)",
    async ({ signal, waitMs, budget }) => {
      (signal === "SIGTERM"
        ? consumeGatewayRestartIntentPayloadSync
        : consumeGatewayRestartIntent
      ).mockReturnValueOnce({ force: true, ...(waitMs === undefined ? {} : { waitMs }) });
      createGatewayActiveWorkSnapshot.mockReturnValueOnce(
        createActiveWorkSnapshot({ agentRuns: 1, embeddedRuns: 1 }, [
          {
            kind: "agent-run",
            count: 1,
            message: "taskId=task-force runId=run-force status=running runtime=cron label=forced",
          },
          { kind: "embedded-run", count: 1, message: "1 active embedded run(s)" },
        ]),
      );
      const drain = createDeferredCore<{ drained: boolean; snapshot: GatewayActiveWorkSnapshot }>();
      waitForGatewayActiveWork.mockImplementationOnce(() => drain.promise);
      await withIsolatedSignals(async ({ captureSignal }) => {
        const { close, start, exited } = await createSignaledLoopHarness();
        const sigint = captureSignal("SIGINT");
        vi.useFakeTimers();
        const clock = vi.spyOn(performance, "now").mockImplementation(() => Date.now());
        try {
          captureSignal(signal)();
          await vi.advanceTimersByTimeAsync(0);
          expect(isGatewayWorkAdmissionClosed()).toBe(true);
          expect(close).not.toHaveBeenCalled();
          expect(waitForGatewayActiveWork).toHaveBeenCalledWith(budget, expect.any(Object));
          expect(abortActiveCronTaskRuns).not.toHaveBeenCalled();
          expect(gatewayLog.info.mock.calls.flat().join("\n")).not.toContain("task-force");
          drain.resolve({ drained: true, snapshot: idleActiveWorkSnapshot });
          await vi.advanceTimersByTimeAsync(0);
          expectRestartCloseCall(close, budget);
          expect(start).toHaveBeenCalledTimes(signal === "SIGTERM" ? 1 : 2);
        } finally {
          drain.resolve({ drained: true, snapshot: idleActiveWorkSnapshot });
          await vi.advanceTimersByTimeAsync(0);
          sigint();
          await vi.advanceTimersByTimeAsync(0);
          await expect(exited).resolves.toBe(0);
          clock.mockRestore();
          vi.useRealTimers();
        }
      });
    },
  );

  it.each([
    { waitMs: undefined, refreshMs: 10_000, stallClose: true },
    { waitMs: 0, refreshMs: 0, stallClose: false },
    { waitMs: 180_000, refreshMs: 0, stallClose: false },
  ])(
    "records cut work only when the forced caller drain budget expires (waitMs=$waitMs, refresh=$refreshMs, stalled close=$stallClose)",
    async ({ waitMs, refreshMs, stallClose }) => {
      const budget = waitMs ?? 45_000;
      const active = createActiveWorkSnapshot({ agentRuns: 1, cronRuns: 1 });
      const drain = createDeferredCore<{ drained: boolean; snapshot: GatewayActiveWorkSnapshot }>();
      let deadline: ReturnType<typeof setTimeout> | undefined;
      const nativeReply = { code: 0, stdout: "LoadState=loaded\nTimeoutStopUSec=330s", stderr: "" };
      if (refreshMs) {
        readCgroup.mockResolvedValue("0::/system.slice/openclaw-gateway.service\n");
        systemctl.mockResolvedValue(nativeReply);
      }
      consumeGatewayRestartIntent.mockReturnValueOnce({
        force: true,
        ...(waitMs === undefined ? {} : { waitMs }),
      });
      createGatewayActiveWorkSnapshot.mockReturnValueOnce(active);
      waitForGatewayActiveWork.mockImplementationOnce((timeoutMs) => {
        if (timeoutMs !== undefined) {
          deadline = setTimeout(
            () => drain.resolve({ drained: false, snapshot: active }),
            timeoutMs,
          );
        }
        return drain.promise;
      });
      await withIsolatedSignals(async ({ captureSignal }) => {
        const closing = createDeferredCore();
        const close = createCloseMock();
        if (stallClose) {
          close.mockImplementationOnce(() => closing.promise);
        }
        const { start, started } = createSignaledStart(close);
        const { runtime, exited } = createRuntimeWithExitSignal();
        const completeBoot = vi.fn();
        await runLoopWithStart({ start, runtime, completeBoot });
        await waitForStart(started);
        vi.useFakeTimers();
        const clock = vi.spyOn(performance, "now").mockImplementation(() => Date.now());
        if (refreshMs) {
          systemctl.mockImplementationOnce(
            () =>
              new Promise((resolve) => {
                setTimeout(() => resolve(nativeReply), refreshMs);
              }),
          );
        }
        try {
          captureSignal("SIGUSR2")();
          if (budget > 0) {
            await vi.advanceTimersByTimeAsync(budget - 1);
            expect(close).not.toHaveBeenCalled();
            expect(abortActiveCronTaskRuns).not.toHaveBeenCalled();
            expect(completeBoot).not.toHaveBeenCalled();
          }
          await vi.advanceTimersByTimeAsync(budget > 0 ? 1 : 0);
          expect(abortActiveCronTaskRuns).toHaveBeenCalledWith("Gateway restarting.");
          expectRestartCloseCall(close, 0);
          const warning = `restart drain budget ${budget - refreshMs}ms exhausted; cutting short cronRuns=1 agentRuns=1`;
          expect(gatewayLog.warn).toHaveBeenCalledWith(warning);
          if (stallClose) {
            expect(start).toHaveBeenCalledOnce();
            expect(completeBoot).not.toHaveBeenCalled();
            expect(runtime.exit).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(9_999);
            expect(completeBoot).not.toHaveBeenCalled();
            expect(runtime.exit).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(1);
            expect(runtime.exit).toHaveBeenCalledExactlyOnceWith(1);
            expect(completeBoot).toHaveBeenCalledExactlyOnceWith({
              outcome: "forced_stop",
              reason: `${warning}; gateway.restart_shutdown_timeout`,
            });
            expect(start).toHaveBeenCalledOnce();
          } else {
            expect(start).toHaveBeenCalledTimes(2);
            expect(completeBoot).toHaveBeenCalledExactlyOnceWith({
              outcome: "planned_restart",
              reason: `${warning}; restart (SIGUSR2)`,
            });
          }
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
          clock.mockRestore();
          vi.useRealTimers();
        }
      });
    },
  );
}
