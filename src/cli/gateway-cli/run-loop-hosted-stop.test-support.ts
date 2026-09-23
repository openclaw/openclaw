import { expect, it, vi, type Mock } from "vitest";
import type { HostedGatewayStop } from "../../daemon/hosted-stop.js";
import { withTimeout } from "../../infra/fs-safe.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  waitForLoopCondition,
  withIsolatedSignals,
  type UpdateRespawnFixtures,
} from "./run-loop.test-support.js";

export function registerHostedUpdateStopTests({
  captureForegroundUpdateHandoffStop,
  isForegroundUpdateHandoff,
  completeForegroundUpdateHandoffAfterClose,
  hostedStopPrepare,
  hostedStopExecute,
  hostedStopDispose,
  createSignaledLoopHarness,
  managedUpdateSuccessorOwner,
  respawnGatewayProcessForUpdate,
  isGatewayWorkAdmissionClosed,
}: Pick<
  UpdateRespawnFixtures,
  | "captureForegroundUpdateHandoffStop"
  | "isForegroundUpdateHandoff"
  | "completeForegroundUpdateHandoffAfterClose"
  | "hostedStopPrepare"
  | "createSignaledLoopHarness"
  | "managedUpdateSuccessorOwner"
  | "respawnGatewayProcessForUpdate"
  | "isGatewayWorkAdmissionClosed"
> & {
  hostedStopExecute: Mock<HostedGatewayStop["execute"]>;
  hostedStopDispose: Mock<HostedGatewayStop["dispose"]>;
}) {
  it.each([false, true])(
    "joins the accepted hosted Stop through foreground update settlement (park overlap: %s)",
    async (parkOverlap) => {
      const joined = createDeferredCore<boolean>();
      const disposed = createDeferredCore();
      const settle = vi.fn(() => joined.promise);
      let onPark: ((identity: typeof managedUpdateSuccessorOwner) => void) | undefined;
      let parkReady = false;
      captureForegroundUpdateHandoffStop.mockImplementationOnce((callbacks) => {
        onPark = callbacks.onPark;
        return { settle, canPark: () => parkReady };
      });
      isForegroundUpdateHandoff.mockReturnValue(true);
      completeForegroundUpdateHandoffAfterClose.mockImplementationOnce(async () => {
        await joined.promise;
        return { respawn: false };
      });
      hostedStopPrepare.mockImplementationOnce(async (_owner, assertCurrent, signal) => {
        assertCurrent();
        hostedStopExecute.mockImplementationOnce(
          (assertStopCurrent) =>
            new Promise((_resolve, reject) => {
              assertStopCurrent();
              signal.addEventListener(
                "abort",
                () => reject(new Error("native stop interrupted", { cause: signal.reason })),
                { once: true },
              );
            }),
        );
        return { execute: hostedStopExecute, dispose: hostedStopDispose };
      });
      hostedStopDispose.mockImplementationOnce(() => disposed.promise);
      await withIsolatedSignals(async ({ captureSignal }) => {
        const { close, start, runtime, exited } = await createSignaledLoopHarness(undefined, true);
        const host = start.mock.calls[0]?.[0]?.hostLifecycle;
        try {
          await expect(host!.request("stop", () => {})).resolves.toMatchObject({ ok: true });
          expect(settle).toHaveBeenCalledOnce();
          expect(isGatewayWorkAdmissionClosed()).toBe(true);
          expect(close).not.toHaveBeenCalled();
          expect(hostedStopExecute).not.toHaveBeenCalled();
          expect(hostedStopDispose).not.toHaveBeenCalled();
          await expect(host!.request("stop", () => {})).resolves.toMatchObject({ ok: false });
          expect(hostedStopPrepare).toHaveBeenCalledOnce();
          if (parkOverlap) {
            parkReady = true;
            onPark!(managedUpdateSuccessorOwner);
            await waitForLoopCondition(
              () => completeForegroundUpdateHandoffAfterClose.mock.calls.length === 1,
              "captured updater did not finish parking",
            );
            expect(close).toHaveBeenCalledOnce();
            expect(hostedStopExecute).not.toHaveBeenCalled();
            expect(hostedStopDispose).not.toHaveBeenCalled();
          }
          captureSignal("SIGINT")();
          expect(settle).toHaveBeenCalledOnce();
          expect(runtime.exit).not.toHaveBeenCalled();
          joined.resolve(true);
          await waitForLoopCondition(
            () => hostedStopExecute.mock.calls.length === 1,
            "accepted hosted Stop did not execute after helper settlement",
          );
          captureSignal("SIGTERM")();
          await waitForLoopCondition(
            () => hostedStopDispose.mock.calls.length === 1,
            "accepted hosted Stop did not join native disposal",
          );
          expect(hostedStopExecute).toHaveBeenCalledOnce();
          expect(runtime.exit).not.toHaveBeenCalled();
          disposed.resolve();
          await expect(withTimeout(exited, 4_000)).resolves.toBe(0);
          expect(runtime.exit).toHaveBeenCalledExactlyOnceWith(0);
          expect(close).toHaveBeenCalledOnce();
          expect(start).toHaveBeenCalledOnce();
          expect(respawnGatewayProcessForUpdate).not.toHaveBeenCalled();
        } finally {
          joined.resolve(true);
          disposed.resolve();
          if (!runtime.exit.mock.calls.length) {
            captureSignal("SIGTERM")();
          }
          await withTimeout(exited, 4_000);
        }
      });
    },
  );
}
