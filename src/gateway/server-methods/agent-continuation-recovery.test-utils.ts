import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import {
  resetGatewaySuspendCoordinatorForLifecycleRestart,
  resumeGatewaySuspend,
} from "../../infra/gateway-suspend-coordinator.js";
import {
  getActiveGatewayRootWorkCount,
  resetGatewayWorkAdmission,
} from "../../process/gateway-work-admission.js";
import { registerCronContinuationRecoveryCase } from "./agent.task-settlement.test-utils.js";
import {
  getAgentTestMocks,
  makeContext,
  setupCronContinuationReleaseFixture,
  invokeGatewaySuspendPrepare,
  cronMediaCompletionEvent,
  cronContinuationGatewayClient,
  invokeAgent,
} from "./agent.test-harness.js";

export function registerAgentContinuationRecoveryTests() {
  const mocks = getAgentTestMocks();
  registerCronContinuationRecoveryCase();

  it("releases suspension admission after continuation recovery exhausts", async () => {
    vi.useFakeTimers();
    resetGatewaySuspendCoordinatorForLifecycleRestart();
    resetGatewayWorkAdmission();
    try {
      const { sessionKey, store } = setupCronContinuationReleaseFixture();
      const context = makeContext();
      let releaseAttempts = 0;
      mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
        if (
          expectDefined(store[sessionKey], "store[sessionKey] test invariant").cronRunContinuation
            ?.phase === "continuing"
        ) {
          releaseAttempts += 1;
          throw new Error("disk unavailable");
        }
        return await updater(store);
      });
      mocks.agentCommand.mockResolvedValue({ payloads: [{ text: "continued" }], meta: {} });

      await invokeAgent(
        {
          message: "media completion",
          sessionKey,
          internalEvents: [cronMediaCompletionEvent()],
          idempotencyKey: "cron-media-release-exhausts",
        },
        {
          reqId: "cron-media-release-exhausts",
          client: cronContinuationGatewayClient(),
          context,
          flushDispatch: false,
        },
      );
      await vi.advanceTimersByTimeAsync(10);

      expect(releaseAttempts).toBe(3);
      const busyPrepare = await invokeGatewaySuspendPrepare(
        context,
        "cron-media-release-exhaustion-backoff",
      );
      expect(busyPrepare).toHaveBeenCalledWith(
        true,
        expect.objectContaining({
          status: "busy",
          blockers: expect.arrayContaining([expect.objectContaining({ kind: "root-request" })]),
        }),
      );

      for (const delayMs of [250, 1_000, 4_000, 15_000]) {
        await vi.advanceTimersByTimeAsync(delayMs);
      }

      expect(releaseAttempts).toBe(15);
      expect(context.logGateway.warn).toHaveBeenCalledWith(
        "cron continuation release recovery exhausted for cron-media-release-exhausts",
      );
      await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
      const readyPrepare = await invokeGatewaySuspendPrepare(
        context,
        "cron-media-release-exhausted",
      );
      const readyPayload = readyPrepare.mock.calls.at(-1)?.[1] as
        | { status?: string; suspensionId?: string }
        | undefined;
      expect(readyPayload).toMatchObject({ status: "ready" });
      expect(resumeGatewaySuspend(readyPayload?.suspensionId ?? "missing")).toMatchObject({
        ok: true,
        status: "running",
      });
    } finally {
      resetGatewaySuspendCoordinatorForLifecycleRestart();
      resetGatewayWorkAdmission();
      vi.useRealTimers();
    }
  });
}
