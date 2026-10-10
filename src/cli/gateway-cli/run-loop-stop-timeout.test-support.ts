import { expect, it } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  createActiveWorkSnapshot,
  withIsolatedSignals,
  type UpdateRespawnFixtures,
} from "./run-loop.test-support.js";

export function registerTimedOutGatewayStopTests({
  createSignaledLoopHarness,
  waitForGatewayActiveWork,
  gatewayLog,
}: Pick<
  UpdateRespawnFixtures,
  "createSignaledLoopHarness" | "waitForGatewayActiveWork" | "gatewayLog"
>) {
  it.each([
    { drained: false, ownsProcessLifecycle: true },
    { drained: false, ownsProcessLifecycle: false },
  ])(
    "routes a timed-out process stop through database close (drained=$drained, process owner=$ownsProcessLifecycle)",
    async ({ drained, ownsProcessLifecycle }) => {
      await withIsolatedSignals(async ({ captureSignal }) => {
        const { close, runtime, exited } = await createSignaledLoopHarness(
          undefined,
          ownsProcessLifecycle,
        );
        const enteredClose = createDeferredCore();
        const releaseClose = createDeferredCore();
        const snapshot = drained
          ? createActiveWorkSnapshot()
          : createActiveWorkSnapshot({
              pendingReplies: 5,
              sessionAdmissions: 23,
              rootRequests: 165,
            });
        waitForGatewayActiveWork.mockResolvedValueOnce({ drained, snapshot });
        close.mockImplementationOnce(async () => {
          enteredClose.resolve();
          await releaseClose.promise;
        });
        try {
          captureSignal("SIGTERM")();
          await enteredClose.promise;
          expect(runtime.exit).not.toHaveBeenCalled();
          const options = close.mock.calls[0]?.[0];
          expect(options).toMatchObject({ reason: "gateway stopping", restartExpectedMs: null });
          // Only a process-owning stop may leave native watcher release to exit.
          expect(options?.exitAfterClose).toBe(ownsProcessLifecycle ? true : undefined);
          if (!drained && ownsProcessLifecycle) {
            expect(options?.onProcessExitReady).toEqual(expect.any(Function));
            await options?.onProcessExitReady?.();
            await expect(exited).resolves.toBe(0);
            expect(gatewayLog.warn).toHaveBeenCalledWith(
              "gateway active-work drain timeout reached; proceeding with shutdown: pendingReplies=5 rootRequests=165 sessionAdmissions=23",
            );
          } else {
            expect(options?.onProcessExitReady).toBeUndefined();
          }
        } finally {
          releaseClose.resolve();
          await exited;
        }
      });
    },
  );
}
