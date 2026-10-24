import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import { resolveGlobalMap } from "../../shared/global-singleton.js";
import { withEnvAsync } from "../../test-utils/env.js";
import {
  createLifecycleGate,
  expectRestartCloseCall,
  expectStopCloseCall,
  expectUncalled,
  type UpdateRespawnFixtures,
} from "./run-loop.test-support.js";

export function registerExternalHandoffShutdownTests({
  consumeGatewaySuspendHandoff,
  consumeGatewayRestartIntentPayload,
  acquireGatewayLock,
  withRunningGateway,
  waitForGatewayActiveWork,
  restartGatewayProcessWithFreshPid,
  respawnGatewayProcessForUpdate,
  writeGatewayRestartHandoff,
  cancelShutdownHardExitWatchdog,
  gatewayLog,
  isGatewayWorkAdmissionClosed,
}: UpdateRespawnFixtures): void {
  const holdHandoff = () => {
    const gate = createLifecycleGate();
    const write = writeGatewayRestartHandoff.getMockImplementation()!;
    writeGatewayRestartHandoff.mockImplementationOnce(async (...args) => {
      await gate.wait();
      return write(...args);
    });
    return gate;
  };
  const supervise = (code?: number, key = "OPENCLAW_SUPERVISOR_MODE", value = "external") => {
    process.env[key] = value;
    restartGatewayProcessWithFreshPid.mockReturnValueOnce({ mode: "supervised", exitCode: code });
  };
  it.each([
    { fails: true, trigger: "signal" },
    { fails: false, trigger: "commit" },
    { fails: false, trigger: "persisted-intent" },
  ])("joins external cleanup ($trigger, failed=$fails)", async ({ fails, trigger }) => {
    await withRunningGateway(async ({ captureSignal, close, start, runtime, exited }) => {
      const host = start.mock.calls[0]?.[0]?.hostLifecycle;
      const cleanup = createLifecycleGate();
      close.mockImplementationOnce(cleanup.wait);
      consumeGatewaySuspendHandoff.mockImplementationOnce((owner) => {
        expect(owner).toBe(host?.externalRestart);
        expect(owner?.isCurrent()).toBe(true);
        expect(isGatewayWorkAdmissionClosed()).toBe(false);
        return { ok: true, value: true };
      });
      try {
        const sigterm = captureSignal("SIGTERM");
        if (trigger === "persisted-intent") {
          consumeGatewayRestartIntentPayload.mockResolvedValueOnce({
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
          expect(isGatewayWorkAdmissionClosed()).toBe(true);
        } else {
          sigterm();
        }
        await cleanup.entered;
        expect(close).toHaveBeenCalledOnce();
        sigterm();
        expect(host?.externalRestart?.isCurrent()).toBe(false);
        expectRestartCloseCall(close, 0);
        expectUncalled(waitForGatewayActiveWork, runtime.exit, cancelShutdownHardExitWatchdog);
      } finally {
        if (fails) {
          cleanup.reject(new Error("external cleanup failed"));
        } else {
          cleanup.release();
        }
      }
      await expect(exited).resolves.toBe(fails ? 1 : 0);
      expect(consumeGatewaySuspendHandoff).toHaveBeenCalledOnce();
      expect(start).toHaveBeenCalledOnce();
      expectUncalled(
        restartGatewayProcessWithFreshPid,
        respawnGatewayProcessForUpdate,
        writeGatewayRestartHandoff,
      );
      expect(cancelShutdownHardExitWatchdog).toHaveBeenCalledOnce();
    }, true);
  });

  it.each([
    { marker: "OPENCLAW_SUPERVISOR_MODE", value: "external", exitCode: undefined },
    { marker: "OPENCLAW_WINDOWS_TASK_NAME", value: "OpenClaw Gateway", exitCode: 75 },
  ])(
    "publishes after close, retains shared state, and releases the lock before supervised exit $exitCode",
    async ({ marker, value, exitCode }) => {
      supervise(exitCode, marker, value);
      const lockRelease = vi.fn(async () => {});
      acquireGatewayLock.mockResolvedValueOnce({ release: lockRelease });
      const closeGate = createLifecycleGate();
      const handoffGate = holdHandoff();
      const sharedState = resolveGlobalMap<string, boolean>(Symbol("handoff"), "shared-state");
      sharedState.set("live", true);
      await withEnvAsync({ OPENCLAW_GATEWAY_RESTART_TRACE: "1" }, () =>
        withRunningGateway(async ({ captureSignal, close, runtime, exited, loopPromise }) => {
          close.mockImplementationOnce(closeGate.wait);
          captureSignal("SIGUSR2")();
          try {
            await awaitGateBeforeSettlement(closeGate.entered, loopPromise, "exit before close");
            expect(close).toHaveBeenCalledWith(
              expect.objectContaining({ retainSharedState: true }),
            );
            expect(writeGatewayRestartHandoff).not.toHaveBeenCalled();
            closeGate.release();
            await awaitGateBeforeSettlement(
              handoffGate.entered,
              loopPromise,
              "exit before handoff",
            );
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
          expect(runtime.exit).toHaveBeenCalledExactlyOnceWith(exitCode ?? 0);
          expect(lockRelease).toHaveBeenCalledOnce();
          expect(lockRelease).toHaveBeenCalledBefore(runtime.exit);
          const [respawnOpts] = restartGatewayProcessWithFreshPid.mock.calls[0] ?? [];
          expect(respawnOpts?.env).toMatchObject({
            OPENCLAW_GATEWAY_RESTART_TRACE_STARTED_AT_MS: expect.stringMatching(/^\d/u),
            OPENCLAW_GATEWAY_RESTART_TRACE_LAST_AT_MS: expect.stringMatching(/^\d/u),
          });
          expect(writeGatewayRestartHandoff).toHaveBeenCalledOnce();
        }),
      );
    },
  );

  it("keeps the ordinary drain when a handoff refuses late terminal persistence", async () => {
    await withRunningGateway(async ({ captureSignal, close, exited }) => {
      const error = "gateway terminal persistence is still pending";
      consumeGatewaySuspendHandoff.mockReturnValueOnce({ ok: false, error });
      captureSignal("SIGTERM")();
      await expect(exited).resolves.toBe(0);
      expect(waitForGatewayActiveWork).toHaveBeenCalledWith(20_000, expect.any(Object));
      expectStopCloseCall(close);
      expect(gatewayLog.warn).toHaveBeenCalledWith(`external restart handoff refused: ${error}`);
    }, true);
  });
}
