import { expect, it, vi } from "vitest";
import {
  gatewayWorkAdmissionActual,
  runLoopFixture as mocks,
} from "./run-loop-mocks.test-support.js";
import { createGatewayRunSignals } from "./run-loop-signals.js";
import { withIsolatedSignals, withLifecycleClock } from "./run-loop.test-support.js";

export function registerExternalRestartSignalTests(waitForLoopTurn: () => Promise<void>): void {
  async function withExternalSignalHarness(
    options: {
      consumeIntent: () => Promise<{ force: true } | null>;
      externalAllowed: boolean;
    },
    run: (harness: {
      request: ReturnType<typeof vi.fn>;
      restart: () => void;
      signals: ReturnType<typeof createGatewayRunSignals>;
    }) => Promise<void>,
  ) {
    await withIsolatedSignals(({ captureSignal }) =>
      withLifecycleClock(async () => {
        const iteration = {};
        const request = vi.fn();
        const signals = createGatewayRunSignals({
          lifecycle: {
            prepareGatewayRestartIntentConsumption: () => options.consumeIntent,
            consumeGatewayRestartAuthorization: () => false,
            consumeGatewayRestartIntent: () => null,
            peekGatewayRestartReason: () => undefined,
            markGatewayRestartHandled: mocks.markGatewayRestartHandled,
            rollbackGatewayRestartSignalAdmission: mocks.rollbackGatewayRestartSignalAdmission,
            isGatewayRestartExternallyAllowed: () => options.externalAllowed,
            abortPendingChannelReloads: mocks.abortPendingChannelReloads,
            scheduleGatewayRestart: mocks.scheduleGatewayRestart,
          },
          logger: mocks.gatewayLog,
          timeoutMs: 1_000,
          getIteration: () => iteration,
          isTerminal: () => false,
          isForcedExitStarted: () => false,
          isForegroundUpdateClosed: () => false,
          getRequest: () => null,
          isRuntimeResetPending: () => false,
          isShuttingDown: () => false,
          getExternalRestartOwner: () => undefined,
          publishExternalRestartReceipt: async () => {},
          getTerminalHostedStop: () => undefined,
          updateSuccessor: { stop: vi.fn(), stopRequested: false },
          request,
        });
        try {
          await run({ request, restart: captureSignal("SIGUSR2"), signals });
        } finally {
          signals.close();
          gatewayWorkAdmissionActual.resetGatewayWorkAdmission();
        }
      }),
    );
  }

  it("accepts another SIGUSR2 after successful-read scheduling throws", async () => {
    mocks.scheduleGatewayRestart.mockImplementationOnce(() => {
      throw new Error("scheduler unavailable");
    });
    await withExternalSignalHarness(
      { consumeIntent: async () => null, externalAllowed: true },
      async ({ restart, signals }) => {
        restart();
        await vi.advanceTimersByTimeAsync(0);
        await Promise.resolve();
        restart();
        await vi.advanceTimersByTimeAsync(0);
        await Promise.resolve();
        await signals.pending;
        expect(mocks.scheduleGatewayRestart).toHaveBeenCalledTimes(2);
        expect(gatewayWorkAdmissionActual.isGatewayWorkAdmissionClosed()).toBe(false);
      },
    );
  });

  it.each([true, false])(
    "does not use the external SIGUSR2 policy when the intent read times out (allowed: %s)",
    async (allowed) => {
      const intent = Promise.withResolvers<{ force: true }>();
      await withExternalSignalHarness(
        { consumeIntent: () => intent.promise, externalAllowed: allowed },
        async ({ request, restart, signals }) => {
          restart();
          await vi.advanceTimersByTimeAsync(1_000);
          expect(mocks.scheduleGatewayRestart).not.toHaveBeenCalled();
          intent.resolve({ force: true });
          await vi.advanceTimersByTimeAsync(0);
          await Promise.resolve();
          await Promise.resolve();
          await signals.pending;
          expect(mocks.scheduleGatewayRestart).not.toHaveBeenCalled();
          expect(request).not.toHaveBeenCalled();
        },
      );
    },
  );

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
