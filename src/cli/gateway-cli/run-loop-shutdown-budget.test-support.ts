import { performance } from "node:perf_hooks";
import { expect, it, vi } from "vitest";
import { buildSystemdUnit } from "../../daemon/systemd-unit.js";
import { GatewayConnectionWork } from "../../gateway/server-connection-work.js";
import type { GatewayServer } from "../../gateway/server-public.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  createActiveWorkSnapshot,
  createRuntimeWithExitSignal,
  createSignaledStart,
  setPlatform,
  waitForStart,
  withIsolatedSignals,
  type UpdateRespawnFixtures,
} from "./run-loop.test-support.js";

const delay = (ms?: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
const nativeBudget = (timeoutMs: number) => ({
  timeoutMs,
  reserveMs: 10_000,
  nativeStopBudget: true,
});
const systemdResult = (timeoutMs: number | "unavailable") => ({
  code: timeoutMs === "unavailable" ? 1 : 0,
  stdout:
    timeoutMs === "unavailable" ? "" : `LoadState=loaded\nTimeoutStopUSec=${timeoutMs / 1_000}s`,
  stderr: timeoutMs === "unavailable" ? "manager unavailable" : "",
});

const shutdownBudgetCases = [
  ["SIGTERM", undefined, 30_000, 330_000, 500],
  ["SIGTERM", undefined, 330_000, 30_000, 500],
  ["SIGTERM", undefined, 30_000, "unavailable", 500],
  ["SIGUSR2", 0, undefined, undefined, 0],
] as const;

export function registerShutdownBudgetTests(f: UpdateRespawnFixtures) {
  it.each(shutdownBudgetCases)(
    "bounds systemd %s cleanup (wait=%s, installedStop=%s, shutdownStop=%s, inspection=%s)",
    async (signal, waitMs, installedStopMs, shutdownStopMs, inspectionMs) => {
      const unit = buildSystemdUnit({ programArguments: ["openclaw", "gateway", "run"] });
      const stopTimeoutMs =
        (typeof shutdownStopMs === "number" ? shutdownStopMs : installedStopMs) ??
        Number(unit.match(/^TimeoutStopSec=(\d+)$/m)?.[1]) * 1_000;
      const successStatuses = unit
        .match(/^SuccessExitStatus=(.+)$/m)?.[1]
        ?.split(" ")
        .map(Number);
      process.env.OPENCLAW_SYSTEMD_UNIT = "openclaw-gateway.service";
      setPlatform("linux");
      if (installedStopMs !== undefined) {
        f.systemctl.mockResolvedValue(systemdResult(installedStopMs));
      }
      if (waitMs !== undefined) {
        f.consumeGatewayRestartIntent.mockReturnValueOnce({ waitMs });
      }
      await withIsolatedSignals(async ({ captureSignal }) => {
        const provider = createDeferredCore();
        const connectionWork = new GatewayConnectionWork();
        void connectionWork.track(() => provider.promise);
        const close = vi.fn<GatewayServer["close"]>(async () => {
          // The run-loop fixture reloads its module generation before every invocation.
          const { runGatewayCloseSteps } = await import("../../gateway/server-shutdown.js");
          await runGatewayCloseSteps({
            owner: {
              connectionWork,
              stopConnectionDependentSidecars() {},
              stopRegisteredGatewayLifetimeSidecars() {},
              stopRegisteredPostReadySidecars() {},
              runClosePrelude() {},
              sealAndJoinRegisteredSidecarStops() {},
            },
            close() {},
            onError: (message) => {
              throw new Error(message);
            },
          });
        });
        const { start, started } = createSignaledStart(close);
        const { runtime } = createRuntimeWithExitSignal();
        await f.runLoopWithStart({ start, runtime });
        await waitForStart(started);
        const host = start.mock.calls[0]?.[0]?.hostLifecycle;
        const active = createActiveWorkSnapshot({ embeddedRuns: 1, rootRequests: 1 }, [
          {
            kind: "root-request",
            count: 1,
            message: "1 active gateway request(s): heartbeat:wake",
          },
        ]);
        f.createGatewayActiveWorkSnapshot.mockReturnValue(active);
        f.waitForGatewayActiveWork.mockImplementationOnce(async (timeoutMs, options) => {
          options?.onSnapshot?.(active);
          await delay(timeoutMs);
          return { drained: false, snapshot: active };
        });
        vi.useFakeTimers();
        const clock = vi.spyOn(performance, "now").mockImplementation(() => Date.now());
        try {
          if (shutdownStopMs !== undefined) {
            const result = systemdResult(shutdownStopMs);
            f.systemctl.mockResolvedValue(result).mockImplementationOnce(async () => {
              await delay(inspectionMs);
              return result;
            });
          }
          if (installedStopMs !== undefined) {
            const probes = f.systemctl.mock.calls.length;
            expect(host?.getShutdownBudget?.()).toEqual(nativeBudget(installedStopMs - 5_000));
            expect(f.systemctl.mock.calls).toHaveLength(probes);
          }
          captureSignal(signal)();
          await vi.advanceTimersByTimeAsync(inspectionMs);
          if (installedStopMs !== undefined) {
            expect(host?.getShutdownBudget?.()).toEqual(
              nativeBudget(stopTimeoutMs - 5_000 - inspectionMs),
            );
            expect(f.waitForGatewayActiveWork).toHaveBeenCalledWith(
              Math.min(20_000, stopTimeoutMs - 15_000 - inspectionMs),
              expect.any(Object),
            );
            if (shutdownStopMs === "unavailable") {
              expect(f.gatewayLog.warn).toHaveBeenCalledWith(
                expect.stringContaining("Unable to read systemd stop timeout"),
              );
            }
          }
          const deadlineMs = stopTimeoutMs - 5_000;
          await vi.advanceTimersByTimeAsync(deadlineMs - inspectionMs - 1);
          expect(connectionWork.signal.aborted).toBe(true);
          expect(runtime.exit).not.toHaveBeenCalled();
          await vi.advanceTimersByTimeAsync(1);
          expect(runtime.exit).not.toHaveBeenCalled();
          provider.resolve();
          await vi.advanceTimersByTimeAsync(0);
          expect(runtime.exit).toHaveBeenCalledExactlyOnceWith(0);
          expect(successStatuses).toContain(runtime.exit.mock.calls[0]?.[0]);
          expect(start).toHaveBeenCalledOnce();
          expect(f.gatewayLog.warn).toHaveBeenCalledWith(
            expect.stringMatching(
              /shutdown deadline reached; waiting for unfinished cleanup and active work.*embeddedRuns=1.*pending owners: 1 active gateway request\(s\): heartbeat:wake.*pending close steps: shutdown.received-connection-work=\d+ms/,
            ),
          );
          expect(f.writeDiagnosticStabilityBundleForFailureSync).toHaveBeenCalledWith(
            signal === "SIGTERM"
              ? "gateway.stop_shutdown_timeout"
              : "gateway.restart_shutdown_timeout",
            undefined,
          );
        } finally {
          provider.resolve();
          await vi.advanceTimersByTimeAsync(0);
          await Promise.allSettled(close.mock.results.map((result) => result.value));
          clock.mockRestore();
          vi.clearAllTimers();
          vi.useRealTimers();
        }
      });
    },
  );
}
