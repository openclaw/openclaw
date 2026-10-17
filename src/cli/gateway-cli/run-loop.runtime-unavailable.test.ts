import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { readGatewayServiceState } from "../../daemon/service-state.js";
import {
  classifyChildRuntimeFailure,
  readChildRuntimeViability,
} from "../../infra/child-runtime-viability.js";
import { resolveTestNodeExecPath } from "../../test-utils/node-process.js";
import { runLoopFixture as fixture } from "./run-loop-mocks.test-support.js";
import { createLifecycleGate, createActiveWorkSnapshot } from "./run-loop.test-support.js";

// mock-isolation: Runtime recovery must inspect fixture service state, never the host service.
vi.mock("../../daemon/service-state.js", () => ({ readGatewayServiceState: vi.fn() }));

const originalExecPath = process.execPath;
const serviceNodeExecPath = resolveTestNodeExecPath();
afterEach(() => {
  process.execPath = originalExecPath;
  fixture.requestGatewayRestartWithSignalAdmission
    .mockReset()
    .mockReturnValue({ status: "emitted" });
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
  fixture.restartGatewayProcessWithFreshPid.mockReturnValue({ mode: "supervised" });
  const drain = createLifecycleGate();
  const snapshot = createActiveWorkSnapshot({ embeddedRuns: 1 });
  fixture.createGatewayActiveWorkSnapshot.mockReturnValue(snapshot);
  fixture.waitForGatewayActiveWork.mockImplementation(async () => {
    await drain.wait();
    return { drained: true, snapshot: createActiveWorkSnapshot() };
  });
  await fixture.withRunningGateway(async ({ captureSignal, close, start, exited, loopPromise }) => {
    fixture.requestGatewayRestartWithSignalAdmission.mockImplementation((reason) => {
      fixture.peekGatewayRestartReason.mockReturnValue(reason);
      captureSignal("SIGUSR2")();
      return { status: "emitted" };
    });
    try {
      diagnose();
      await vi.dynamicImportSettled();
      expect(fixture.requestGatewayRestartWithSignalAdmission).toHaveBeenCalledExactlyOnceWith(
        "gateway.runtime-unavailable",
      );
      await drain.entered;
      const { isGatewayWorkAdmissionClosed } =
        await import("../../process/gateway-work-admission.js");
      expect(isGatewayWorkAdmissionClosed()).toBe(true);
      expect(close).not.toHaveBeenCalled();
      expect(fixture.restartGatewayProcessWithFreshPid).not.toHaveBeenCalled();
      drain.release();
      await expect(exited).resolves.toBe(0);
      await loopPromise;
      expect(close).toHaveBeenCalledOnce();
      expect(fixture.restartGatewayProcessWithFreshPid).toHaveBeenCalledOnce();
      expect(close.mock.invocationCallOrder[0]).toBeLessThan(
        fixture.restartGatewayProcessWithFreshPid.mock.invocationCallOrder[0]!,
      );
      expect(start).toHaveBeenCalledOnce();
      expect(fixture.writeGatewayRestartHandoff.mock.calls[0]?.[0]).toMatchObject({
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
  fixture.restartGatewayProcessWithFreshPid.mockReturnValue({
    mode: "failed",
    detail: "fixture handoff refused",
  });
  await fixture.withRunningGateway(async ({ captureSignal, close, start, exited, loopPromise }) => {
    diagnose();
    captureSignal("SIGUSR2")();
    await expect(exited).resolves.toBe(1);
    await loopPromise;
    expect(close).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledOnce();
    expect(fixture.gatewayLog.error).toHaveBeenCalledWith(
      expect.stringContaining("cannot recover in-process"),
    );
  });
});
