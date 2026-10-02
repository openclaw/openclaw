// Darwin launchd-supervised run-loop cases.
import { performance } from "node:perf_hooks";
import { describe, expect, it, vi } from "vitest";
import { runLoopFixture } from "./run-loop-mocks.test-support.js";
import {
  originalPlatformDescriptor,
  setPlatform,
  withIsolatedSignals,
} from "./run-loop.test-support.js";

const {
  readLaunchdStopTimeout,
  acquireGatewayLock,
  consumeGatewayRestartIntentPayloadSync,
  peekGatewayRestartReason,
  restartGatewayProcessWithFreshPid,
  respawnGatewayProcessForUpdate,
  gatewayLog,
  writeDiagnosticStabilityBundleForFailureSync,
  hasManagedProviderLocalServices,
  stopManagedProviderLocalServices,
  createSignaledLoopHarness,
  expectRestartHandoffCall,
} = runLoopFixture;

const reloadTaskRuntimeStateFromStore = vi.fn();
vi.mock("../../tasks/runtime-internal.js", () => ({
  reloadTaskRuntimeStateFromStore: () => reloadTaskRuntimeStateFromStore(),
}));

describe("runGatewayLoop darwin launchd supervision", () => {
  it("waits briefly before exiting on launchd supervised restart", async () => {
    vi.clearAllMocks();
    peekGatewayRestartReason.mockReturnValue(undefined);
    try {
      setPlatform("darwin");
      process.env.OPENCLAW_LAUNCHD_LABEL = "ai.openclaw.gateway";
      restartGatewayProcessWithFreshPid.mockReturnValueOnce({
        mode: "supervised",
        handoffSpawned: Promise.resolve(true),
      });

      await withIsolatedSignals(async ({ captureSignal }) => {
        const { runtime, exited } = await createSignaledLoopHarness();
        const restartSignal = captureSignal("SIGUSR2");

        vi.useFakeTimers();
        restartSignal();
        await vi.advanceTimersByTimeAsync(1499);
        expect(runtime.exit).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);

        await expect(exited).resolves.toBe(0);
        expect(runtime.exit).toHaveBeenCalledWith(0);
        expectRestartHandoffCall({
          restartKind: "full-process",
          reason: undefined,
          supervisorMode: "launchd",
        });
      });
    } finally {
      vi.useRealTimers();
      delete process.env.OPENCLAW_LAUNCHD_LABEL;
      if (originalPlatformDescriptor) {
        Object.defineProperty(process, "platform", originalPlatformDescriptor);
      }
    }
  });

  it("falls back in-process when the launchd restart handoff fails to spawn", async () => {
    vi.clearAllMocks();
    peekGatewayRestartReason.mockReturnValue(undefined);
    try {
      setPlatform("darwin");
      process.env.OPENCLAW_LAUNCHD_LABEL = "ai.openclaw.gateway";
      restartGatewayProcessWithFreshPid.mockReturnValueOnce({
        mode: "supervised",
        handoffSpawned: Promise.resolve(false),
      });

      await withIsolatedSignals(async ({ captureSignal }) => {
        const { start, runtime, exited } = await createSignaledLoopHarness();
        const restartSignal = captureSignal("SIGUSR2");
        const sigint = captureSignal("SIGINT");

        vi.useFakeTimers();
        restartSignal();
        await vi.advanceTimersByTimeAsync(1500);

        expect(start).toHaveBeenCalledTimes(2);
        expect(runtime.exit).not.toHaveBeenCalled();
        expect(acquireGatewayLock).toHaveBeenCalledTimes(2);
        expect(gatewayLog.warn).toHaveBeenCalledWith(
          "launchd restart handoff failed to spawn; falling back to in-process restart",
        );

        sigint();
        await expect(exited).resolves.toBe(0);
      });
    } finally {
      vi.useRealTimers();
      delete process.env.OPENCLAW_LAUNCHD_LABEL;
      if (originalPlatformDescriptor) {
        Object.defineProperty(process, "platform", originalPlatformDescriptor);
      }
    }
  });

  it("leaves the successor to launchd after a SIGTERM restart intent", async () => {
    vi.clearAllMocks();
    consumeGatewayRestartIntentPayloadSync.mockReturnValueOnce({ reason: "gateway.restart" });
    setPlatform("darwin");
    process.env.OPENCLAW_LAUNCHD_LABEL = "ai.openclaw.gateway";
    restartGatewayProcessWithFreshPid.mockReturnValueOnce({
      mode: "supervised",
      handoffSpawned: Promise.resolve(true),
    });

    await withIsolatedSignals(async ({ captureSignal }) => {
      const { start, exited } = await createSignaledLoopHarness();
      captureSignal("SIGTERM")();
      await expect(exited).resolves.toBe(0);
      expect(start).toHaveBeenCalledOnce();
      expect(restartGatewayProcessWithFreshPid).not.toHaveBeenCalled();
      expect(respawnGatewayProcessForUpdate).not.toHaveBeenCalled();
    });
  });

  // The stop budget refresh is the reason darwin reads the launchd job at all, so prove
  // the job deadline it reports is what bounds the stop and arms the force exit.
  it("bounds a launchd-supervised stop on the deadline the printed job reports", async () => {
    vi.clearAllMocks();
    try {
      setPlatform("darwin");
      process.env.OPENCLAW_LAUNCHD_LABEL = "ai.openclaw.gateway";
      readLaunchdStopTimeout.mockResolvedValue({
        stop: { timeoutMs: 30_000, source: "launchd system/ai.openclaw.gateway exit timeout" },
      });
      hasManagedProviderLocalServices.mockReturnValue(true);
      stopManagedProviderLocalServices.mockReturnValue(new Promise<void>(() => {}));

      await withIsolatedSignals(async ({ captureSignal }) => {
        const { close, runtime } = await createSignaledLoopHarness();

        vi.useFakeTimers();
        const clock = vi.spyOn(performance, "now").mockImplementation(() => Date.now());
        try {
          captureSignal("SIGTERM")();
          await vi.advanceTimersByTimeAsync(24_999);

          expect(close).toHaveBeenCalledOnce();
          expect(stopManagedProviderLocalServices).toHaveBeenCalledOnce();
          expect(runtime.exit).not.toHaveBeenCalled();
          await vi.advanceTimersByTimeAsync(1);

          // launchd owns the successor, so an abandoned drain still exits 0 for the job.
          expect(runtime.exit).toHaveBeenCalledExactlyOnceWith(0);
          expect(writeDiagnosticStabilityBundleForFailureSync).toHaveBeenCalledWith(
            "gateway.stop_shutdown_timeout",
            undefined,
          );
          expect(gatewayLog.info).toHaveBeenCalledWith(
            "shutdown budget at shutdown: drain=15000ms shutdown=25000ms reserve=10000ms exitMargin=5000ms; source=launchd system/ai.openclaw.gateway exit timeout=30000ms",
          );
        } finally {
          clock.mockRestore();
          vi.clearAllTimers();
          vi.useRealTimers();
        }
      });
    } finally {
      delete process.env.OPENCLAW_LAUNCHD_LABEL;
      if (originalPlatformDescriptor) {
        Object.defineProperty(process, "platform", originalPlatformDescriptor);
      }
    }
  });
});
