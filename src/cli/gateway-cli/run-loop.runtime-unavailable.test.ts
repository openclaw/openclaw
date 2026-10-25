import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { readGatewayServiceState } from "../../daemon/service-state.js";
import {
  classifyChildRuntimeFailure,
  readChildRuntimeViability,
} from "../../infra/child-runtime-viability.js";
import { resolveTestNodeExecPath } from "../../test-utils/node-process.js";
import { gatewayWorkAdmissionActual, runLoopFixture as f } from "./run-loop-mocks.test-support.js";
import {
  createLifecycleGate,
  createActiveWorkSnapshot,
  expectUncalled,
} from "./run-loop.test-support.js";

// mock-isolation: Runtime recovery must inspect fixture service state, never the host service.
vi.mock("../../daemon/service-state.js", () => ({ readGatewayServiceState: vi.fn() }));
// mock-isolation: The fixture's systemd capability is independent of the host native addon.
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
  // Each loop owns a distinct retained executable; its replacement remains a real Node.
  process.execPath = `/fixture/unavailable-${randomUUID()}/node`;
  classifyChildRuntimeFailure({ stderr: "dyld[123]: Library not loaded: /fixture/libnode.dylib" });
}

it("closes admission and drains active work before handing runtime recovery to the supervisor", async () => {
  process.env.OPENCLAW_SYSTEMD_UNIT = "openclaw-fixture.service";
  vi.mocked(readGatewayServiceState).mockResolvedValue({
    installed: true,
    loadState: { status: "loaded" },
    running: true,
    env: {},
    command: { programArguments: [serviceNodeExecPath, "/fixture/openclaw.mjs", "gateway", "run"] },
  });
  f.restartGatewayProcessWithFreshPid.mockReturnValue({ mode: "supervised" });
  const drain = createLifecycleGate();
  f.createGatewayActiveWorkSnapshot.mockReturnValue(createActiveWorkSnapshot({ embeddedRuns: 1 }));
  f.waitForGatewayActiveWork.mockImplementation(async () => {
    await drain.wait();
    return { drained: true, snapshot: createActiveWorkSnapshot() };
  });
  await f.withRunningGateway(async ({ captureSignal, close, start, exited, loopPromise }) => {
    f.requestGatewayRestartWithSignalAdmission.mockImplementation((reason) => {
      f.peekGatewayRestartReason.mockReturnValue(reason);
      captureSignal("SIGUSR2")();
      return { status: "emitted" };
    });
    try {
      diagnose();
      await vi.dynamicImportSettled();
      expect(f.requestGatewayRestartWithSignalAdmission).toHaveBeenCalledExactlyOnceWith(
        "gateway.runtime-unavailable",
      );
      await drain.entered;
      expect(gatewayWorkAdmissionActual.isGatewayWorkAdmissionClosed()).toBe(true);
      expectUncalled(close, f.restartGatewayProcessWithFreshPid);
      drain.release();
      await expect(exited).resolves.toBe(0);
      expect(close).toHaveBeenCalledOnce();
      expect(f.restartGatewayProcessWithFreshPid).toHaveBeenCalledOnce();
      expect(close.mock.invocationCallOrder[0]).toBeLessThan(
        f.restartGatewayProcessWithFreshPid.mock.invocationCallOrder[0]!,
      );
      expect(start).toHaveBeenCalledOnce();
      expect(f.writeGatewayRestartHandoff.mock.calls[0]?.[0]).toMatchObject({
        reason: "gateway.runtime-unavailable",
        restartKind: "full-process",
      });
      expect(readChildRuntimeViability()).toEqual({ execPath: process.execPath, available: false });
    } finally {
      drain.release();
      if (!close.mock.calls.length) {
        captureSignal("SIGINT")();
      }
      await loopPromise;
    }
  }, true);
});

it("finishes cleanup instead of restarting in-process when a fresh-process handoff fails", async () => {
  f.restartGatewayProcessWithFreshPid.mockReturnValue({
    mode: "failed",
    detail: "fixture handoff refused",
  });
  await f.withRunningGateway(async ({ captureSignal, close, start, exited }) => {
    diagnose();
    captureSignal("SIGUSR2")();
    await expect(exited).resolves.toBe(1);
    expect(close).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledOnce();
    expect(f.gatewayLog.error).toHaveBeenCalledWith(
      expect.stringContaining("cannot recover in-process"),
    );
  });
});

it.each(["disabled", "failed"] as const)(
  "exits instead of restarting in-process when a native-worker handoff is %s",
  async (mode) => {
    f.restartGatewayProcessWithFreshPid.mockReturnValue({ mode });
    f.consumeGatewayRestartIntent.mockReturnValueOnce({
      force: true,
      waitMs: 0,
      requireFreshProcess: true,
    });
    await f.withRunningGateway(async ({ captureSignal, close, start, exited }) => {
      expect(readChildRuntimeViability().available).toBe(true);
      captureSignal("SIGUSR2")();
      await expect(exited).resolves.toBe(1);
      expect(close).toHaveBeenCalledOnce();
      expect(start).toHaveBeenCalledOnce();
      expect(f.acquireGatewayLock).toHaveBeenCalledOnce();
      expect(f.gatewayLog.error).toHaveBeenCalledWith(
        expect.stringContaining("unsettled native worker cannot recover in-process"),
      );
    });
  },
);

it("keeps the process hard-exit watchdog armed while native-worker close is unsettled", async () => {
  process.env.OPENCLAW_SYSTEMD_UNIT = "openclaw-fixture.service";
  vi.mocked(readGatewayServiceState).mockResolvedValue({
    installed: true,
    loadState: { status: "loaded" },
    running: true,
    env: {},
    command: { programArguments: [serviceNodeExecPath, "/fixture/openclaw.mjs", "gateway", "run"] },
  });
  f.restartGatewayProcessWithFreshPid.mockReturnValue({ mode: "supervised" });
  const closing = createLifecycleGate();
  // A pending operator intent cannot downgrade the process owner's recovery requirement.
  f.consumeGatewayRestartIntentPayload.mockResolvedValueOnce({ waitMs: 60_000 });
  await f.withRunningGateway(async ({ captureSignal, close, start, exited, loopPromise }) => {
    close.mockImplementationOnce(() => closing.wait());
    f.requestGatewayRestartWithSignalAdmission.mockImplementation((reason, intent) => {
      f.peekGatewayRestartReason.mockReturnValue(reason);
      f.consumeGatewayRestartIntent.mockReturnValueOnce(intent ?? null);
      captureSignal("SIGUSR2")();
      return { status: "emitted" };
    });
    try {
      // Let the shared lifecycle fixture install its partial restart mocks before
      // loading this owner, whose imports also reach the restart module.
      const { requestGatewayNativeWorkerRecovery } = await import("../../infra/process-respawn.js");
      const recovery = await requestGatewayNativeWorkerRecovery({ isCurrent: () => true });
      expect(recovery.status, recovery.reason).toBe("restart-requested");
      await closing.entered;
      expect(gatewayWorkAdmissionActual.isGatewayWorkAdmissionClosed()).toBe(true);
      expect(start).toHaveBeenCalledOnce();
      expect(f.restartGatewayProcessWithFreshPid).not.toHaveBeenCalled();
      const watchdog = f.armShutdownHardExitWatchdog.mock.calls.at(-1)?.[0];
      expect(watchdog?.delayMs).toBeLessThanOrEqual(12_000);
      expect(watchdog?.delayMs).toBeGreaterThan(2_000);
      // The startup-budget watchdog is replaced by the forced-restart budget.
      expect(f.cancelShutdownHardExitWatchdog).toHaveBeenCalledTimes(
        f.armShutdownHardExitWatchdog.mock.calls.length - 1,
      );
    } finally {
      closing.release();
      if (!close.mock.calls.length) {
        captureSignal("SIGINT")();
      }
      await loopPromise;
    }
    await expect(exited).resolves.toBe(0);
    expect(start).toHaveBeenCalledOnce();
  }, true);
});

it("records accepted native recovery before arming a forced-exit watchdog", async () => {
  process.env.OPENCLAW_SYSTEMD_UNIT = "openclaw-fixture.service";
  const recording = createLifecycleGate();
  const closing = createLifecycleGate();
  const completeBoot = vi.fn(() => recording.wait());
  f.peekGatewayRestartReason.mockReturnValue("gateway.native-worker-unsettled");
  f.consumeGatewayRestartIntent.mockReturnValueOnce({
    force: true,
    waitMs: 0,
    requireFreshProcess: true,
  });
  f.restartGatewayProcessWithFreshPid.mockReturnValue({ mode: "supervised" });
  await f.withRunningGateway(
    async ({ captureSignal, close, loopPromise }) => {
      close.mockImplementationOnce(() => closing.wait());
      const watchdogsBefore = f.armShutdownHardExitWatchdog.mock.calls.length;
      try {
        captureSignal("SIGUSR2")();
        // The native close may never settle. Boot history must finish before either
        // watchdog can kill this process without running later completion callbacks.
        const first = await Promise.race([
          recording.entered.then(() => "recording"),
          closing.entered.then(() => "closing"),
        ]);
        expect(first).toBe("recording");
        expect(completeBoot).toHaveBeenCalledExactlyOnceWith({
          outcome: "planned_restart",
          reason: "restart (SIGUSR2: gateway.native-worker-unsettled)",
        });
        expect(f.armShutdownHardExitWatchdog).toHaveBeenCalledTimes(watchdogsBefore);
        expect(close).not.toHaveBeenCalled();
        recording.release();
        await closing.entered;
        expect(f.armShutdownHardExitWatchdog.mock.calls.length).toBeGreaterThan(watchdogsBefore);
      } finally {
        recording.release();
        closing.release();
        if (!close.mock.calls.length) {
          captureSignal("SIGINT")();
        }
        await loopPromise;
      }
    },
    true,
    { completeBoot },
  );
});
