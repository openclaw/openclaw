import { describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import {
  cancelCronRunAdmissionWaiters,
  runWithCronAdmission,
  tryAcquireCronRunSlots,
} from "./run-admission-capacity.js";
import { createCronServiceState } from "./state.js";

describe("cron shared execution capacity", () => {
  it.each([undefined, 1, 12])(
    "shares configured limit %s across scheduled and direct runs",
    async (maxConcurrentRuns) => {
      const state = createCronServiceState({
        scheduler: createTestGatewayScheduler(),
        storePath: "unused",
        cronEnabled: true,
        cronConfig: { maxConcurrentRuns },
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        enqueueSystemEvent: vi.fn(),
        requestHeartbeat: vi.fn(),
        runIsolatedAgentJob: vi.fn(),
      });
      const limit = maxConcurrentRuns ?? 8;
      const scheduled = tryAcquireCronRunSlots(state, limit + 1);
      expect(scheduled).toHaveLength(limit);
      const entered = createDeferredCore();
      const finish = createDeferredCore();
      const direct = runWithCronAdmission(state, async () => {
        entered.resolve();
        await finish.promise;
      });
      expect(state.runAdmission.waiters).toHaveLength(1);
      expect(tryAcquireCronRunSlots(state, 1)).toHaveLength(0);
      scheduled[0]!();
      await entered.promise;
      expect(state.runAdmission.active).toBe(limit);
      scheduled[0]!();
      expect(state.runAdmission.active).toBe(limit);
      const cancelled = runWithCronAdmission(state, vi.fn());
      state.stopped = true;
      cancelCronRunAdmissionWaiters(state);
      expect(await cancelled).toEqual({ kind: "stopped" });
      finish.resolve();
      await direct;
      for (const release of scheduled.slice(1)) {
        release();
      }
      expect(state.runAdmission.active).toBe(0);
      state.stopped = false;
      const failing = runWithCronAdmission(state, async () => {
        throw new Error("run failed");
      });
      await expect(failing).rejects.toThrow("run failed");
      expect(tryAcquireCronRunSlots(state, limit)).toHaveLength(limit);
    },
  );
});
