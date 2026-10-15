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
    { drained: true, ownsProcessLifecycle: true },
    { drained: true, ownsProcessLifecycle: false },
    { drained: false, ownsProcessLifecycle: true },
    { drained: false, ownsProcessLifecycle: false },
  ])(
    "joins full server close before stopping (drained=$drained, process owner=$ownsProcessLifecycle)",
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
          expect(options).not.toHaveProperty("onProcessExitReady");
          expect(options).not.toHaveProperty("exitAfterClose");
          if (!drained) {
            expect(gatewayLog.warn).toHaveBeenCalledWith(
              "gateway active-work drain timeout reached; proceeding with shutdown: pendingReplies=5 rootRequests=165 sessionAdmissions=23",
            );
          }
        } finally {
          releaseClose.resolve();
          await exited;
        }
      });
    },
  );
}
