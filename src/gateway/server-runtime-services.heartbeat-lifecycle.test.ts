import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { HeartbeatWakeHandler } from "../infra/heartbeat-wake-contracts.js";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  createLog,
  createTestCronReconciliation,
  createTestCronState,
  resetRuntimeServiceMocks,
  runtimeServiceMocks,
} from "./server-runtime-services.test-harness.js";

const cfg: OpenClawConfig = {
  agents: {
    entries: { main: {} },
    defaults: { heartbeat: { every: "30m" } },
  },
};

beforeEach(() => {
  // Each case owns a cold loader so the lifecycle change can precede its settlement.
  vi.resetModules();
  vi.useFakeTimers();
  resetGatewayWorkAdmission();
  resetRuntimeServiceMocks();
  runtimeServiceMocks.runHeartbeatOnce
    .mockReset()
    .mockResolvedValue({ status: "ran", durationMs: 1 });
});

afterEach(() => {
  vi.doMock("../infra/heartbeat-runner-run.js", () => ({
    runHeartbeatOnce: runtimeServiceMocks.runHeartbeatOnce,
  }));
  vi.useRealTimers();
  resetGatewayWorkAdmission();
});

describe("scheduled heartbeat execution loading", { concurrent: false }, () => {
  it.each(["continue", "stop", "replace"] as const)(
    "settles a wake when the service lifecycle chooses to %s during loading",
    async (action) => {
      const loading = createDeferredCore();
      const release = createDeferredCore();
      vi.doMock("../infra/heartbeat-runner-run.js", async () => {
        loading.resolve();
        await release.promise;
        return { runHeartbeatOnce: runtimeServiceMocks.runHeartbeatOnce };
      });
      const { activateGatewayScheduledServices } = await import("./server-runtime-services.js");
      const { requestHeartbeatAndWait, setHeartbeatWakeHandler } =
        await import("../infra/heartbeat-wake.js");
      const services = activateGatewayScheduledServices({
        minimalTestGateway: false,
        cfgAtStart: cfg,
        deps: {} as never,
        sessionDeliveryRecoveryMaxEnqueuedAt: 123,
        cronState: createTestCronState(),
        cronReconciliation: createTestCronReconciliation(),
        startCron: false,
        logCron: { error: vi.fn() },
        log: createLog(),
        resolveGatewayContext: () => undefined,
      });
      const replacement = vi
        .fn<HeartbeatWakeHandler>()
        .mockResolvedValue({ status: "ran", durationMs: 77 });
      let disposeWake: (() => void) | undefined;
      try {
        const runOnce = runtimeServiceMocks.startHeartbeatRunner.mock.calls[0]?.[0].runOnce;
        if (!runOnce) {
          throw new Error("Expected the Gateway-owned heartbeat callback");
        }
        // Exercise the callback with the real wake generation/abort context.
        // Scheduler dispatch has separate owner-boundary coverage.
        disposeWake = setHeartbeatWakeHandler((wake) =>
          runOnce({ cfg, agentId: "main", source: wake.source, intent: wake.intent }),
        );
        const result = requestHeartbeatAndWait({
          source: "manual",
          intent: "manual",
          agentId: "main",
          coalesceMs: 0,
        });
        await vi.advanceTimersByTimeAsync(1);
        expect(runtimeServiceMocks.runHeartbeatOnce).not.toHaveBeenCalled();
        await loading.promise;

        if (action === "stop") {
          services.heartbeatRunner.stop();
        } else if (action === "replace") {
          disposeWake = setHeartbeatWakeHandler(replacement);
          await vi.advanceTimersByTimeAsync(250);
          await expect(result).resolves.toEqual({ status: "ran", durationMs: 77 });
        }
        release.resolve();
        await vi.dynamicImportSettled();
        if (action === "continue") {
          await expect(result).resolves.toEqual({ status: "ran", durationMs: 1 });
          expect(runtimeServiceMocks.runHeartbeatOnce).toHaveBeenCalledExactlyOnceWith({
            cfg,
            agentId: "main",
            source: "manual",
            intent: "manual",
          });
        } else {
          if (action === "stop") {
            await expect(result).resolves.toEqual({ status: "skipped", reason: "disabled" });
          }
          expect(runtimeServiceMocks.runHeartbeatOnce).not.toHaveBeenCalled();
          expect(replacement).toHaveBeenCalledTimes(action === "replace" ? 1 : 0);
        }
      } finally {
        release.resolve();
        services.heartbeatRunner.stop();
        disposeWake?.();
        await vi.dynamicImportSettled();
        await services.stopDeliveryRecovery();
        const disposeDrain = setHeartbeatWakeHandler(async () => ({
          status: "skipped",
          reason: "disabled",
        }));
        await vi.advanceTimersByTimeAsync(250);
        disposeDrain();
      }
    },
  );
});
