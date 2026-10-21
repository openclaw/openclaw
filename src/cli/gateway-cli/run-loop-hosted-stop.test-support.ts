import { once } from "node:events";
import { expect, it, vi, type MockInstance } from "vitest";
import { withTimeout } from "../../infra/fs-safe.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  expectUncalled,
  waitForLoopCondition,
  withIsolatedSignals,
  type UpdateRespawnFixtures,
} from "./run-loop.test-support.js";

export function registerHostedUpdateStopTests(f: UpdateRespawnFixtures) {
  it("joins the accepted hosted Stop through overlapping foreground update parking and settlement", async () => {
    const waitForCall = (mock: MockInstance) =>
      waitForLoopCondition(() => mock.mock.calls.length === 1, "hosted Stop lifecycle stalled");
    const joined = createDeferredCore<boolean>();
    const disposed = createDeferredCore();
    const settle = vi.fn(() => joined.promise);
    let onPark: ((identity: typeof f.managedUpdateSuccessorOwner) => void) | undefined;
    let parkReady = false;
    f.captureForegroundUpdateHandoffStop.mockImplementationOnce((callbacks) => {
      onPark = callbacks.onPark;
      return { settle, canPark: () => parkReady };
    });
    f.isForegroundUpdateHandoff.mockReturnValue(true);
    f.completeForegroundUpdateHandoffAfterClose.mockImplementationOnce(async () => {
      await joined.promise;
      return { respawn: false };
    });
    f.hostedStopPrepare.mockImplementationOnce(async (_owner, assertCurrent, signal) => {
      assertCurrent();
      f.hostedStopExecute.mockImplementationOnce(async (assertStopCurrent) => {
        assertStopCurrent();
        await once(signal, "abort");
        throw new Error("native stop interrupted", { cause: signal.reason });
      });
      return { execute: f.hostedStopExecute, dispose: f.hostedStopDispose };
    });
    f.hostedStopDispose.mockImplementationOnce(() => disposed.promise);
    await withIsolatedSignals(async ({ captureSignal }) => {
      const { close, start, runtime, exited } = await f.createSignaledLoopHarness(undefined, true);
      const host = start.mock.calls[0]?.[0]?.hostLifecycle;
      try {
        await expect(host!.request("stop", () => {})).resolves.toMatchObject({ ok: true });
        expect(settle).toHaveBeenCalledOnce();
        expect(f.isGatewayWorkAdmissionClosed()).toBe(true);
        expectUncalled(close, f.hostedStopExecute, f.hostedStopDispose);
        await expect(host!.request("stop", () => {})).resolves.toMatchObject({ ok: false });
        expect(f.hostedStopPrepare).toHaveBeenCalledOnce();
        parkReady = true;
        onPark!(f.managedUpdateSuccessorOwner);
        await waitForCall(f.completeForegroundUpdateHandoffAfterClose);
        expect(close).toHaveBeenCalledOnce();
        expectUncalled(f.hostedStopExecute, f.hostedStopDispose);
        captureSignal("SIGINT")();
        expect(settle).toHaveBeenCalledOnce();
        expect(runtime.exit).not.toHaveBeenCalled();
        joined.resolve(true);
        await waitForCall(f.hostedStopExecute);
        captureSignal("SIGTERM")();
        await waitForCall(f.hostedStopDispose);
        expect(f.hostedStopExecute).toHaveBeenCalledOnce();
        expect(runtime.exit).not.toHaveBeenCalled();
        const intentReads = f.consumeGatewayRestartIntentPayload.mock.calls.length;
        captureSignal("SIGTERM")();
        expect(f.consumeGatewayRestartIntentPayload).toHaveBeenCalledTimes(intentReads);
        disposed.resolve();
        await expect(withTimeout(exited, 4_000)).resolves.toBe(0);
        expect(runtime.exit).toHaveBeenCalledExactlyOnceWith(0);
        expect(close).toHaveBeenCalledOnce();
        expect(start).toHaveBeenCalledOnce();
        expect(f.respawnGatewayProcessForUpdate).not.toHaveBeenCalled();
      } finally {
        joined.resolve(true);
        disposed.resolve();
        if (!runtime.exit.mock.calls.length) {
          captureSignal("SIGTERM")();
        }
        await withTimeout(exited, 4_000);
      }
    });
  });
}
