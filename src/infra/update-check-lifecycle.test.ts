import { describe, expect, it, vi } from "vitest";
import { trackAsyncWork } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { createGatewayUpdateLifecycle } from "./update-check-lifecycle.js";

describe("Gateway update lifecycle", () => {
  it.each(["scheduled", "manual"] as const)(
    "fences %s discovery at Gateway close and joins its admitted work",
    async (entry) => {
      const time = createGatewaySchedulerClock();
      const scheduler = createTestGatewayScheduler(time.clock);
      const lifecycle = createGatewayUpdateLifecycle(scheduler);
      const entered = createDeferredCore<AbortSignal>();
      const release = createDeferredCore<number>();
      const returned = createDeferredCore();
      const tail = createDeferredCore();
      const lateWork = vi.fn(async () => undefined);
      const stopped = vi.fn();
      const work = async (signal: AbortSignal) => {
        entered.resolve(signal);
        void trackAsyncWork(() => tail.promise);
        const nextDelay = await release.promise;
        returned.resolve();
        return nextDelay;
      };
      let running: Promise<unknown> | void;
      if (entry === "scheduled") {
        lifecycle.schedule("update.check", () => work(lifecycle.signal));
        running = time.wake();
      } else {
        running = lifecycle.run(work);
      }
      try {
        const signal = await entered.promise;
        scheduler.beginClose();
        expect(signal.aborted).toBe(true);
        await expect(lifecycle.run(lateWork)).rejects.toThrow();
        expect(lateWork).not.toHaveBeenCalled();

        const stopping = lifecycle.stop().then(stopped);
        release.resolve(100);
        await returned.promise;
        expect(stopped).not.toHaveBeenCalled();
        tail.resolve();
        await Promise.all([running, stopping]);
        expect(stopped).toHaveBeenCalledOnce();
        expect(scheduler.nextWakeAtMs).toBeNull();
      } finally {
        release.resolve(100);
        tail.resolve();
        await Promise.all([running, lifecycle.stop(), scheduler.stop()]);
      }
    },
  );
});
