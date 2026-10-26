import { expect, it, vi } from "vitest";
import { GatewayConnectionWork } from "../../gateway/server-connection-work.js";
import type { GatewayServer } from "../../gateway/server-public.js";
import { GATEWAY_SERVICE_STOP_TIMEOUT_MS } from "../../infra/gateway-shutdown-budget.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  createActiveWorkSnapshot,
  setPlatform,
  withLifecycleClock,
  type UpdateRespawnFixtures,
} from "./run-loop.test-support.js";

const delay = (ms?: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
const systemdResult = (timeoutMs: number | "unavailable") => ({
  code: timeoutMs === "unavailable" ? 1 : 0,
  stdout:
    timeoutMs === "unavailable" ? "" : `LoadState=loaded\nTimeoutStopUSec=${timeoutMs / 1_000}s`,
  stderr: timeoutMs === "unavailable" ? "manager unavailable" : "",
});

export function registerShutdownBudgetTests(f: UpdateRespawnFixtures) {
  it.each([
    ["SIGTERM", undefined, 30_000, 330_000, 500],
    ["SIGTERM", undefined, 330_000, 30_000, 500],
    ["SIGTERM", undefined, 30_000, "unavailable", 500],
    ["SIGUSR2", 0, undefined, undefined, 0],
  ] as const)(
    "joins cleanup through the refreshed %s deadline (%s, %s, %s, %s)",
    async (signal, waitMs, installedStopMs, shutdownStopMs, inspectionMs) => {
      const stopTimeoutMs =
        (typeof shutdownStopMs === "number" ? shutdownStopMs : installedStopMs) ??
        GATEWAY_SERVICE_STOP_TIMEOUT_MS;
      process.env.OPENCLAW_SYSTEMD_UNIT = "openclaw-gateway.service";
      setPlatform("linux");
      if (installedStopMs !== undefined) {
        f.systemctl.mockResolvedValue(systemdResult(installedStopMs));
      }
      if (waitMs !== undefined) {
        f.consumeGatewayRestartIntent.mockReturnValueOnce({ waitMs });
      }
      const provider = createDeferredCore();
      const connectionWork = new GatewayConnectionWork();
      void connectionWork.track(() => provider.promise);
      const close = vi.fn<GatewayServer["close"]>(async () => {
        // Load the same module generation as the run-loop fixture.
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
      await f.withRunningGateway(
        async ({ captureSignal, runtime, start }) => {
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
          await withLifecycleClock(async () => {
            try {
              if (shutdownStopMs !== undefined) {
                const result = systemdResult(shutdownStopMs);
                f.systemctl.mockResolvedValue(result).mockImplementationOnce(async () => {
                  await delay(inspectionMs);
                  return result;
                });
              }
              captureSignal(signal)();
              await vi.advanceTimersByTimeAsync(stopTimeoutMs - 5_000 - 1);
              expect(connectionWork.signal.aborted).toBe(true);
              expect(runtime.exit).not.toHaveBeenCalled();
              await vi.advanceTimersByTimeAsync(1);
              expect(runtime.exit).not.toHaveBeenCalled();
              provider.resolve();
              await vi.advanceTimersByTimeAsync(0);
              expect(runtime.exit).toHaveBeenCalledExactlyOnceWith(0);
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
              vi.clearAllTimers();
            }
          });
        },
        false,
        { close },
      );
    },
  );
}
