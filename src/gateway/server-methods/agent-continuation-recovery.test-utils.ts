import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import {
  resetGatewaySuspendCoordinatorForLifecycleRestart,
  resumeGatewaySuspend,
} from "../../infra/gateway-suspend-coordinator.js";
import {
  getActiveGatewayRootWorkCount,
  resetGatewayWorkAdmission,
} from "../../process/gateway-work-admission.js";
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
  it("recovers a continuation release after reporting a durable write failure", async () => {
    vi.useFakeTimers();
    resetGatewaySuspendCoordinatorForLifecycleRestart();
    resetGatewayWorkAdmission();
    try {
      mocks.agentCommand.mockClear();
      const { sessionKey, store } = setupCronContinuationReleaseFixture();
      const context = makeContext();
      let releaseAttempts = 0;
      mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
        if (
          expectDefined(store[sessionKey], "store[sessionKey] test invariant").cronRunContinuation
            ?.phase === "continuing"
        ) {
          releaseAttempts += 1;
          if (releaseAttempts <= 3) {
            throw new Error("disk unavailable");
          }
        }
        return await updater(store);
      });
      mocks.agentCommand.mockResolvedValue({ payloads: [{ text: "continued" }], meta: {} });
      const request = {
        message: "media completion",
        sessionKey,
        internalEvents: [cronMediaCompletionEvent()],
        idempotencyKey: "cron-media-release-fails",
      };

      const respond = await invokeAgent(request, {
        reqId: "cron-media-release-fails",
        client: cronContinuationGatewayClient(),
        context,
        flushDispatch: false,
      });
      await vi.advanceTimersByTimeAsync(10);

      expect(releaseAttempts).toBe(3);
      expect(
        expectDefined(store[sessionKey], "store[sessionKey] test invariant").cronRunContinuation,
      ).toMatchObject({
        phase: "continuing",
        ownerRunId: "cron-media-release-fails",
      });
      expect(respond).toHaveBeenLastCalledWith(
        false,
        expect.objectContaining({
          status: "error",
          summary: "failed to persist cron continuation settlement",
        }),
        expect.objectContaining({ code: ErrorCodes.UNAVAILABLE }),
        expect.objectContaining({ runId: "cron-media-release-fails" }),
      );
      const busyPrepare = await invokeGatewaySuspendPrepare(context, "cron-media-release-backoff");
      expect(busyPrepare).toHaveBeenCalledWith(
        true,
        expect.objectContaining({
          status: "busy",
          reason: "active-work",
          blockers: expect.arrayContaining([expect.objectContaining({ kind: "root-request" })]),
        }),
      );

      await vi.advanceTimersByTimeAsync(250);

      expect(releaseAttempts).toBe(4);
      expect(
        expectDefined(store[sessionKey], "store[sessionKey] test invariant").cronRunContinuation,
      ).toEqual({
        lifecycleRevision: "revision-1",
        phase: "ready",
        basePersisted: true,
      });
      await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
      const readyPrepare = await invokeGatewaySuspendPrepare(
        context,
        "cron-media-release-recovered",
      );
      const readyPayload = readyPrepare.mock.calls.at(-1)?.[1] as
        | { status?: string; suspensionId?: string }
        | undefined;
      expect(readyPayload).toMatchObject({ status: "ready" });
      expect(resumeGatewaySuspend(readyPayload?.suspensionId ?? "missing")).toMatchObject({
        ok: true,
        status: "running",
      });
      const retryRespond = await invokeAgent(request, {
        reqId: "cron-media-release-retry",
        client: cronContinuationGatewayClient(),
        context,
      });
      expect(retryRespond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ status: "ok", summary: "completed" }),
        undefined,
        { cached: true },
      );
      expect(mocks.agentCommand).toHaveBeenCalledOnce();
    } finally {
      resetGatewaySuspendCoordinatorForLifecycleRestart();
      resetGatewayWorkAdmission();
      vi.useRealTimers();
    }
  });

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
