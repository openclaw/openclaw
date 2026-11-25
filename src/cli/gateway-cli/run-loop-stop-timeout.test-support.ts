import { expect, it } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import { withIsolatedSignals, type UpdateRespawnFixtures } from "./run-loop.test-support.js";

export function registerTimedOutGatewayStopTests({
  createSignaledLoopHarness,
  abortActiveCronTaskRuns,
}: Pick<UpdateRespawnFixtures, "createSignaledLoopHarness" | "abortActiveCronTaskRuns">) {
  it.each([true, false])(
    "joins server close before stopping (process owner=%s)",
    async (ownsProcessLifecycle) => {
      await withIsolatedSignals(async ({ captureSignal }) => {
        const { close, runtime, exited } = await createSignaledLoopHarness(
          undefined,
          ownsProcessLifecycle,
        );
        const enteredClose = createDeferredCore();
        const releaseClose = createDeferredCore();
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
          expect(options?.exitAfterClose).toBe(ownsProcessLifecycle);
          expect(abortActiveCronTaskRuns).toHaveBeenCalledExactlyOnceWith(undefined);
        } finally {
          releaseClose.resolve();
          await exited;
        }
      });
    },
  );
}
