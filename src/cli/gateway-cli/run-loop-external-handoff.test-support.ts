/** Registers external handoff shutdown contracts in the shared run-loop fixture. */
import { expect, it, type Mock } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  expectRestartCloseCall,
  waitForLoopCondition,
  withIsolatedSignals,
  type UpdateRespawnFixtures,
} from "./run-loop.test-support.js";

export function registerExternalHandoffShutdownTests(
  {
    consumeGatewaySuspendHandoff,
    createSignaledLoopHarness,
    waitForGatewayActiveWork,
    restartGatewayProcessWithFreshPid,
    respawnGatewayProcessForUpdate,
    writeGatewayRestartHandoffSync,
    cancelShutdownHardExitWatchdog,
    gatewayLog,
    isGatewayWorkAdmissionClosed,
  }: Pick<
    UpdateRespawnFixtures,
    | "createSignaledLoopHarness"
    | "waitForGatewayActiveWork"
    | "restartGatewayProcessWithFreshPid"
    | "respawnGatewayProcessForUpdate"
    | "writeGatewayRestartHandoffSync"
    | "gatewayLog"
    | "isGatewayWorkAdmissionClosed"
  > & {
    consumeGatewaySuspendHandoff: Mock<
      typeof import("../../infra/gateway-suspend-coordinator.js").consumeGatewaySuspendHandoff
    >;
    cancelShutdownHardExitWatchdog: Mock;
  },
  restartDeferralTimeoutMs: number,
): void {
  it.each([
    { fails: false, trigger: "signal" },
    { fails: true, trigger: "signal" },
    { fails: false, trigger: "commit" },
  ])(
    "joins external restart cleanup without a successor ($trigger, close failure: $fails)",
    async ({ fails, trigger }) => {
      await withIsolatedSignals(async ({ captureSignal }) => {
        const { close, start, runtime, exited } = await createSignaledLoopHarness(undefined, true);
        const host = start.mock.calls[0]?.[0]?.hostLifecycle;
        const joined = createDeferredCore();
        close.mockImplementationOnce(async () => {
          await joined.promise;
          if (fails) {
            throw new Error("external cleanup failed");
          }
        });
        consumeGatewaySuspendHandoff.mockImplementationOnce((owner) => {
          expect(owner).toBe(host?.externalRestart);
          expect(owner?.isCurrent()).toBe(true);
          expect(isGatewayWorkAdmissionClosed()).toBe(false);
          return { ok: true, value: true };
        });
        try {
          const sigterm = captureSignal("SIGTERM");
          if (trigger === "commit") {
            if (!host?.externalRestart?.commitStop) {
              throw new Error("Missing committed stop capability");
            }
            host.externalRestart.commitStop();
            expect(isGatewayWorkAdmissionClosed()).toBe(true);
          } else {
            sigterm();
          }
          await waitForLoopCondition(
            () => close.mock.calls.length === 1,
            "external cleanup did not begin",
          );
          sigterm();
          expect(host?.externalRestart?.isCurrent()).toBe(false);
          expectRestartCloseCall(close, restartDeferralTimeoutMs);
          expect(waitForGatewayActiveWork).toHaveBeenCalledOnce();
          expect(runtime.exit).not.toHaveBeenCalled();
        } finally {
          joined.resolve();
        }
        await expect(exited).resolves.toBe(fails ? 1 : 0);
        expect(consumeGatewaySuspendHandoff).toHaveBeenCalledOnce();
        expect(start).toHaveBeenCalledOnce();
        expect(restartGatewayProcessWithFreshPid).not.toHaveBeenCalled();
        expect(respawnGatewayProcessForUpdate).not.toHaveBeenCalled();
        expect(writeGatewayRestartHandoffSync).not.toHaveBeenCalled();
        expect(cancelShutdownHardExitWatchdog).toHaveBeenCalled();
      });
    },
  );

  it("keeps the ordinary drain when a handoff refuses late terminal persistence", async () => {
    await withIsolatedSignals(async ({ captureSignal }) => {
      const { close, exited } = await createSignaledLoopHarness(undefined, true);
      consumeGatewaySuspendHandoff.mockReturnValueOnce({
        ok: false,
        error: "gateway terminal persistence is still pending",
      });
      captureSignal("SIGTERM")();
      await expect(exited).resolves.toBe(0);
      expect(waitForGatewayActiveWork).toHaveBeenCalledWith(315_000, expect.any(Object));
      expect(close).toHaveBeenCalledWith({ reason: "gateway stopping", restartExpectedMs: null });
      expect(gatewayLog.warn).toHaveBeenCalledWith(
        "external restart handoff refused: gateway terminal persistence is still pending",
      );
    });
  });
}
