import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { readGatewayServiceState } from "../../daemon/service-state.js";
import { classifyChildRuntimeFailure } from "../../infra/child-runtime-viability.js";
import { resolveTestNodeExecPath } from "../../test-utils/node-process.js";
import { expectCallCount } from "./run-loop-cleanup.test-support.js";
import { gatewayWorkAdmissionActual, runLoopFixture as f } from "./run-loop-mocks.test-support.js";
import { createLifecycleGate, expectUncalled } from "./run-loop.test-support.js";

// mock-isolation: Recovery must inspect fixture service state, never the host service.
vi.mock("../../daemon/service-state.js", () => ({ readGatewayServiceState: vi.fn() }));
// mock-isolation: Fixture systemd capability is independent of the host native addon.
vi.mock("@openclaw/proc-safe/systemd", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openclaw/proc-safe/systemd")>()),
  isSupported: () => true,
}));

const originalExecPath = process.execPath;
const serviceNodeExecPath = resolveTestNodeExecPath();
afterEach(() => {
  process.execPath = originalExecPath;
  f.requestGatewayRestartWithSignalAdmission.mockReset().mockReturnValue({ status: "emitted" });
});
function diagnose() {
  process.execPath = `/fixture/unavailable-${randomUUID()}/node`;
  classifyChildRuntimeFailure({ stderr: "dyld[123]: Library not loaded: /fixture/libnode.dylib" });
}
function superviseRecovery() {
  process.env.OPENCLAW_SYSTEMD_UNIT = "openclaw-fixture.service";
  vi.mocked(readGatewayServiceState).mockResolvedValue({
    installed: true,
    loadState: { status: "loaded" },
    running: true,
    env: {},
    command: { programArguments: [serviceNodeExecPath, "/fixture/openclaw.mjs", "gateway", "run"] },
  });
  f.restartGatewayProcessWithFreshPid.mockReturnValue({ mode: "supervised" });
}
function emitRecovery(captureSignal: (signal: "SIGUSR2") => () => void) {
  f.requestGatewayRestartWithSignalAdmission.mockImplementation((reason, intent) => {
    f.peekGatewayRestartReason.mockReturnValue(reason);
    f.consumeGatewayRestartIntent.mockReturnValueOnce(intent ?? null);
    captureSignal("SIGUSR2")();
    return { status: "emitted" };
  });
}

it.each([
  { mode: "failed", unavailable: true },
  { mode: "disabled", unavailable: false },
  { mode: "failed", unavailable: false },
] as const)(
  "does not reuse the process after $mode recovery (unavailable=$unavailable)",
  async ({ mode, unavailable }) => {
    f.restartGatewayProcessWithFreshPid.mockReturnValue({ mode });
    if (!unavailable) {
      f.consumeGatewayRestartIntent.mockReturnValueOnce({
        force: true,
        waitMs: 0,
        requireFreshProcess: true,
      });
    }
    await f.withRunningGateway(async ({ captureSignal, close, start, exited }) => {
      if (unavailable) {
        diagnose();
      }
      captureSignal("SIGUSR2")();
      await expect(exited).resolves.toBe(1);
      expectCallCount(1, close, start);
      expect(f.gatewayLog.error).toHaveBeenCalledWith(
        expect.stringContaining(
          unavailable
            ? "unavailable child runtime cannot recover in-process"
            : "unsettled native worker cannot recover in-process",
        ),
      );
    });
  },
);

it("records native recovery before close and keeps its forced-exit watchdog armed", async () => {
  superviseRecovery();
  const recording = createLifecycleGate();
  const closing = createLifecycleGate();
  const completeBoot = vi.fn(recording.wait);
  // A pending operator intent must not downgrade the native worker's recovery requirement.
  f.consumeGatewayRestartIntentPayload.mockResolvedValueOnce({ waitMs: 60_000 });
  await f.withRunningGateway(
    async ({ captureSignal, close, start, exited, loopPromise }) => {
      close.mockImplementationOnce(closing.wait);
      emitRecovery(captureSignal);
      const watchdogsBefore = f.armShutdownHardExitWatchdog.mock.calls.length;
      try {
        const { requestGatewayNativeWorkerRecovery } =
          await import("../../infra/gateway-native-worker-recovery.js");
        const recovery = await requestGatewayNativeWorkerRecovery({ isCurrent: () => true });
        expect(recovery.status, recovery.reason).toBe("restart-requested");
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
        expect(f.armShutdownHardExitWatchdog).toHaveBeenCalledTimes(watchdogsBefore);
        expect(close).not.toHaveBeenCalled();
        recording.release();
        await closing.entered;
        expect(gatewayWorkAdmissionActual.isGatewayWorkAdmissionClosed()).toBe(true);
        expectUncalled(f.restartGatewayProcessWithFreshPid);
        const watchdog = f.armShutdownHardExitWatchdog.mock.calls.at(-1)?.[0];
        expect(watchdog?.delayMs).toBeLessThanOrEqual(12_000);
        expect(watchdog?.delayMs).toBeGreaterThan(2_000);
        expect(f.armShutdownHardExitWatchdog.mock.calls.length).toBeGreaterThan(watchdogsBefore);
        expect(f.cancelShutdownHardExitWatchdog).toHaveBeenCalledTimes(
          f.armShutdownHardExitWatchdog.mock.calls.length - 1,
        );
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
