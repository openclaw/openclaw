import { expect, it, vi } from "vitest";
import {
  gatewayWorkAdmissionActual,
  runLoopFixture as mocks,
} from "./run-loop-mocks.test-support.js";

export function registerExternalRestartSignalTests(waitForLoopTurn: () => Promise<void>): void {
  it.each([
    { allowed: false, publicationFails: false },
    { allowed: true, publicationFails: false },
    { allowed: true, publicationFails: true },
  ])(
    "acknowledges external SIGUSR2 only after scheduling (allowed: $allowed, publication fails: $publicationFails)",
    async ({ allowed, publicationFails }) => {
      const publishExternalRestartReceipt = vi.fn(async () => {
        if (publicationFails) {
          throw new Error("receipt unavailable");
        }
      });
      mocks.acquireGatewayLock.mockImplementationOnce(async () => ({
        release: vi.fn(async () => {}),
        publishExternalRestartReceipt,
      }));
      mocks.consumeGatewayRestartAuthorization.mockReturnValueOnce(false);
      mocks.isGatewayRestartExternallyAllowed.mockReturnValueOnce(allowed);
      await mocks.withRunningGateway(async ({ captureSignal, close, start }) => {
        const restartDrainSignal = gatewayWorkAdmissionActual.getGatewayRestartDrainSignal();
        captureSignal("SIGUSR2")();
        await waitForLoopTurn();
        expect(mocks.markGatewayRestartHandled).toHaveBeenCalledOnce();
        expect(close).not.toHaveBeenCalled();
        expect(start).toHaveBeenCalledOnce();
        if (allowed) {
          expect(mocks.scheduleGatewayRestart).toHaveBeenCalledWith({
            delayMs: 0,
            reason: "SIGUSR2",
          });
          expect(mocks.markGatewayRestartHandled.mock.invocationCallOrder[0]).toBeLessThan(
            mocks.scheduleGatewayRestart.mock.invocationCallOrder[0] ?? 0,
          );
          expect(publishExternalRestartReceipt).toHaveBeenCalledOnce();
          expect(mocks.scheduleGatewayRestart.mock.invocationCallOrder[0]).toBeLessThan(
            publishExternalRestartReceipt.mock.invocationCallOrder[0] ?? 0,
          );
          expect(mocks.scheduleGatewayRestart).toHaveBeenCalledOnce();
          expect(mocks.gatewayLog.error).not.toHaveBeenCalled();
        } else {
          expect(mocks.scheduleGatewayRestart).not.toHaveBeenCalled();
          expect(publishExternalRestartReceipt).not.toHaveBeenCalled();
          expect(restartDrainSignal.aborted).toBe(false);
          expect(gatewayWorkAdmissionActual.isGatewayRestartDraining()).toBe(false);
          expect(mocks.gatewayLog.warn.mock.calls).toEqual([
            ["SIGUSR2 restart ignored (not authorized; commands.restart=false)."],
            [
              "An unauthorized SIGUSR2 restart signal was received and ignored. " +
                "If a pending gateway restart needs to be applied, run `openclaw gateway restart` " +
                "or restart the gateway through your service manager.",
            ],
          ]);
        }
      });
    },
  );
}
