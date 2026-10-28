import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import { resolveGlobalMap } from "../../shared/global-singleton.js";
import {
  createLifecycleGate,
  expectStopCloseCall,
  expectUncalled,
  type UpdateRespawnFixtures,
} from "./run-loop.test-support.js";

export function registerExternalHandoffShutdownTests(f: UpdateRespawnFixtures): void {
  it.each([
    { fails: true, trigger: "signal" },
    { fails: false, trigger: "commit" },
    { fails: false, trigger: "persisted-intent" },
  ])("joins external cleanup ($trigger, failed=$fails)", async ({ fails, trigger }) => {
    await f.withRunningGateway(async ({ captureSignal, close, start, runtime, exited }) => {
      const host = start.mock.calls[0]?.[0]?.hostLifecycle;
      const cleanup = createLifecycleGate();
      close.mockImplementationOnce(cleanup.wait);
      f.consumeGatewaySuspendHandoff.mockImplementationOnce((owner) => {
        expect(owner).toBe(host?.externalRestart);
        expect(owner?.isCurrent()).toBe(true);
        expect(f.isGatewayWorkAdmissionClosed()).toBe(false);
        return { ok: true, value: true };
      });
      try {
        const sigterm = captureSignal("SIGTERM");
        if (trigger === "persisted-intent") {
          f.consumeGatewayRestartIntentPayload.mockResolvedValueOnce({
            reason: "gateway.restart",
            force: true,
            waitMs: 30_000,
          });
        }
        if (trigger === "commit") {
          if (!host?.externalRestart?.commitStop) {
            throw new Error("Missing committed stop capability");
          }
          host.externalRestart.commitStop();
          expect(f.isGatewayWorkAdmissionClosed()).toBe(true);
        } else {
          sigterm();
        }
        await cleanup.entered;
        expect(close).toHaveBeenCalledOnce();
        sigterm();
        expect(host?.externalRestart?.isCurrent()).toBe(false);
        expectUncalled(f.waitForGatewayActiveWork, runtime.exit, f.cancelShutdownHardExitWatchdog);
      } finally {
        if (fails) {
          cleanup.reject(new Error("external cleanup failed"));
        } else {
          cleanup.release();
        }
      }
      await expect(exited).resolves.toBe(fails ? 1 : 0);
      expect(start).toHaveBeenCalledOnce();
      expectUncalled(
        f.restartGatewayProcessWithFreshPid,
        f.respawnGatewayProcessForUpdate,
        f.writeGatewayRestartHandoff,
      );
      expect(f.cancelShutdownHardExitWatchdog).toHaveBeenCalledTimes(fails ? 0 : 1);
    }, true);
  });

  it.each([
    { marker: "OPENCLAW_SUPERVISOR_MODE", value: "external", exitCode: undefined },
    { marker: "OPENCLAW_WINDOWS_TASK_NAME", value: "OpenClaw Gateway", exitCode: 75 },
  ])(
    "publishes after close, retains shared state, and releases the lock before supervised exit $exitCode",
    async ({ marker, value, exitCode }) => {
      process.env[marker] = value;
      f.restartGatewayProcessWithFreshPid.mockReturnValueOnce({ mode: "supervised", exitCode });
      const lockRelease = vi.fn(async () => {});
      f.acquireGatewayLock.mockResolvedValueOnce({ release: lockRelease });
      const closeGate = createLifecycleGate();
      const handoffGate = createLifecycleGate();
      const write = f.writeGatewayRestartHandoff.getMockImplementation()!;
      f.writeGatewayRestartHandoff.mockImplementationOnce(async (...args) => {
        await handoffGate.wait();
        return write(...args);
      });
      const sharedState = resolveGlobalMap<string, boolean>(Symbol("handoff"), "shared-state");
      sharedState.set("live", true);
      await f.withRunningGateway(async ({ captureSignal, close, runtime, exited, loopPromise }) => {
        close.mockImplementationOnce(closeGate.wait);
        captureSignal("SIGUSR2")();
        try {
          await awaitGateBeforeSettlement(closeGate.entered, loopPromise, "exit before close");
          expect(f.writeGatewayRestartHandoff).not.toHaveBeenCalled();
          closeGate.release();
          await awaitGateBeforeSettlement(handoffGate.entered, loopPromise, "exit before handoff");
          expect(sharedState.get("live")).toBe(true);
          expect(runtime.exit).not.toHaveBeenCalled();
        } finally {
          closeGate.release();
          handoffGate.release();
          await Promise.allSettled([loopPromise]);
        }
        await loopPromise;
        await expect(exited).resolves.toBe(exitCode ?? 0);
        expect(sharedState.size).toBe(0);
        expect(lockRelease).toHaveBeenCalledOnce();
        expect(lockRelease).toHaveBeenCalledBefore(runtime.exit);
        expect(f.writeGatewayRestartHandoff).toHaveBeenCalledOnce();
      });
    },
  );

  it("keeps the ordinary drain when a handoff refuses late terminal persistence", async () => {
    await f.withRunningGateway(async ({ captureSignal, close, exited }) => {
      const error = "gateway terminal persistence is still pending";
      f.consumeGatewaySuspendHandoff.mockReturnValueOnce({ ok: false, error });
      captureSignal("SIGTERM")();
      await expect(exited).resolves.toBe(0);
      expect(f.waitForGatewayActiveWork).toHaveBeenCalledWith(20_000, expect.any(Object));
      expectStopCloseCall(close);
      expect(f.gatewayLog.warn).toHaveBeenCalledWith(`external restart handoff refused: ${error}`);
    }, true);
  });
}
