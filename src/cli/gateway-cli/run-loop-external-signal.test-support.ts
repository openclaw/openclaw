import { expect, it, vi } from "vitest";
import {
  gatewayWorkAdmissionActual,
  runLoopFixture as mocks,
} from "./run-loop-mocks.test-support.js";
import { withLifecycleClock } from "./run-loop.test-support.js";

export function registerExternalRestartSignalTests(waitForLoopTurn: () => Promise<void>): void {
  it.each([true, false])(
    "uses the external SIGUSR2 policy when the intent read times out (allowed: %s)",
    async (allowed) => {
      const intent = Promise.withResolvers<{ force: true }>();
      mocks.consumeGatewayRestartIntentPayload.mockReturnValueOnce(intent.promise);
      mocks.consumeGatewayRestartAuthorization.mockReturnValueOnce(false);
      mocks.isGatewayRestartExternallyAllowed.mockReturnValueOnce(allowed);
      await mocks.withRunningGateway(({ captureSignal, close }) =>
        withLifecycleClock(async () => {
          captureSignal("SIGUSR2")();
          await vi.advanceTimersByTimeAsync(1_000);
          expect(mocks.scheduleGatewayRestart).toHaveBeenCalledTimes(allowed ? 1 : 0);
          intent.resolve({ force: true });
          await vi.advanceTimersByTimeAsync(0);
          expect(close).not.toHaveBeenCalled();
        }),
      );
    },
  );

  it("accepts another SIGUSR2 after scheduling a timed-out signal throws", async () => {
    const intent = Promise.withResolvers<null>();
    mocks.consumeGatewayRestartIntentPayload.mockReturnValueOnce(intent.promise);
    mocks.consumeGatewayRestartAuthorization.mockReturnValueOnce(false).mockReturnValueOnce(false);
    mocks.isGatewayRestartExternallyAllowed.mockReturnValueOnce(true).mockReturnValueOnce(true);
    mocks.scheduleGatewayRestart.mockImplementationOnce(() => {
      throw new Error("scheduler unavailable");
    });
    await mocks.withRunningGateway(({ captureSignal }) =>
      withLifecycleClock(async () => {
        const restart = captureSignal("SIGUSR2");
        restart();
        await vi.advanceTimersByTimeAsync(1_000);
        intent.resolve(null);
        restart();
        await vi.advanceTimersByTimeAsync(0);
        expect(mocks.scheduleGatewayRestart).toHaveBeenCalledTimes(2);
        expect(gatewayWorkAdmissionActual.isGatewayWorkAdmissionClosed()).toBe(false);
      }),
    );
  });

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
