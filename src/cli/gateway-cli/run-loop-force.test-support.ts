import { performance } from "node:perf_hooks";
import { expect, it, vi } from "vitest";
import type { GatewayActiveWorkSnapshot } from "../../infra/gateway-active-work.js";
import { createDeferredCore } from "../../shared/deferred.js";
import type { RequestFixtures } from "./run-loop-request-fixtures.test-support.js";
import {
  createActiveWorkSnapshot,
  createCloseMock,
  createRuntimeWithExitSignal,
  createSignaledStart,
  expectRestartCloseCall,
  waitForStart,
  withIsolatedSignals,
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
}: Pick<
  RequestFixtures,
  | "createSignaledLoopHarness"
  | "createGatewayActiveWorkSnapshot"
  | "abortActiveCronTaskRuns"
  | "runLoopWithStart"
  | "waitForGatewayActiveWork"
  | "consumeGatewayRestartIntent"
  | "consumeGatewayRestartIntentPayloadSync"
  | "isGatewayWorkAdmissionClosed"
  | "gatewayLog"
  | "readCgroup"
  | "systemctl"
>): void {
  const idleActiveWorkSnapshot = createActiveWorkSnapshot();
  it.each(
    (["SIGTERM", "SIGUSR2"] as const).flatMap((signal) =>
      [undefined, 180_000].map((waitMs) => ({ signal, waitMs, budget: waitMs ?? 45_000 })),
    ),
  )(
    "drains admitted work before a forced $signal restart (budget=$budget)",
    async ({ signal, waitMs, budget }) => {
      (signal === "SIGTERM"
        ? consumeGatewayRestartIntentPayloadSync
        : consumeGatewayRestartIntent
      ).mockReturnValueOnce({ force: true, ...(waitMs === undefined ? {} : { waitMs }) });
      createGatewayActiveWorkSnapshot.mockReturnValueOnce(
        createActiveWorkSnapshot({ activeTasks: 1, embeddedRuns: 1 }, [
          {
            kind: "task",
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
    { waitMs: undefined, refreshMs: 0, stallClose: false },
    { waitMs: undefined, refreshMs: 10_000, stallClose: false },
    { waitMs: 0, refreshMs: 0, stallClose: false },
    { waitMs: 180_000, refreshMs: 0, stallClose: false },
    { waitMs: undefined, refreshMs: 0, stallClose: true },
    { waitMs: undefined, refreshMs: 10_000, stallClose: true },
    { waitMs: 180_000, refreshMs: 0, stallClose: true },
  ])(
    "records cut work only when the forced caller drain budget expires (waitMs=$waitMs, refresh=$refreshMs, stalled close=$stallClose)",
    async ({ waitMs, refreshMs, stallClose }) => {
      const budget = waitMs ?? 45_000;
      const active = createActiveWorkSnapshot({ activeTasks: 1, cronRuns: 1 });
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
          const warning = `restart drain budget ${budget - refreshMs}ms exhausted; cutting short cronRuns=1 activeTasks=1`;
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
