import { expect, it, vi } from "vitest";
import { GatewayConnectionWork } from "../../gateway/server-connection-work.js";
import type { GatewayServer } from "../../gateway/server-public.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  setPlatform,
  systemdReply,
  withLifecycleClock,
  type UpdateRespawnFixtures,
} from "./run-loop.test-support.js";

export function registerShutdownBudgetTests(f: UpdateRespawnFixtures) {
  it("joins pending connection cleanup through a shortened native stop deadline", async () => {
    process.env.OPENCLAW_SYSTEMD_UNIT = "openclaw-gateway.service";
    setPlatform("linux");
    f.systemctl.mockResolvedValue(systemdReply("330s"));
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
        await withLifecycleClock(async () => {
          try {
            f.systemctl.mockImplementationOnce(async () => {
              await new Promise<void>((resolve) => {
                setTimeout(resolve, 500);
              });
              return systemdReply("30s");
            });
            captureSignal("SIGTERM")();
            await vi.advanceTimersByTimeAsync(24_999);
            expect(connectionWork.signal.aborted).toBe(true);
            expect(runtime.exit).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(1);
            expect(runtime.exit).not.toHaveBeenCalled();
            expect(f.writeDiagnosticStabilityBundleForFailureSync).toHaveBeenCalledWith(
              "gateway.stop_shutdown_timeout",
              undefined,
            );
            provider.resolve();
            await vi.advanceTimersByTimeAsync(0);
            expect(runtime.exit).toHaveBeenCalledExactlyOnceWith(0);
            expect(start).toHaveBeenCalledOnce();
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
  });
}
