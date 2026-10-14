import { expect, it } from "vitest";
import { withinTest } from "../../test/helpers/promise.js";
import { trackAsyncWork } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { createEmptyPluginRegistry } from "./registry.js";
import type { PluginServiceSchedulerV1 } from "./service-scheduler.types.js";
import { getPluginServiceCleanupSettlement, startPluginServices } from "./services.js";

it("starts service stop before joining scheduled work and preserves sibling scheduling", async ({
  signal,
}) => {
  const clock = createGatewaySchedulerClock();
  const siblingRearmed = createDeferredCore();
  const scheduler = createTestGatewayScheduler({
    ...clock.clock,
    arm(run, delayMs) {
      const cancel = clock.clock.arm(run, delayMs);
      if (clock.armedAtMs === 2) {
        siblingRearmed.resolve();
      }
      return cancel;
    },
  });
  const entered = createDeferredCore();
  const stopCalled = createDeferredCore();
  const physicalWork = createDeferredCore();
  const stopFlush = createDeferredCore();
  const admitted = createDeferredCore<PluginServiceSchedulerV1>();
  let siblingTicks = 0;
  const registry = createEmptyPluginRegistry();
  registry.services.push(
    {
      pluginId: "first",
      id: "first",
      source: "synthetic",
      origin: "workspace",
      service: {
        apiVersion: 2,
        id: "first",
        start(context) {
          admitted.resolve(context.scheduler);
          context.scheduler.scope().schedule({
            id: "tick",
            delayMs: 1,
            everyMs: 1,
            run: () => {
              void trackAsyncWork(async () => {
                entered.resolve();
                await stopCalled.promise;
                await physicalWork.promise;
              });
            },
          });
        },
        async stop() {
          stopCalled.resolve();
          await stopFlush.promise;
        },
      },
    },
    {
      pluginId: "second",
      id: "second",
      source: "synthetic",
      origin: "workspace",
      service: {
        apiVersion: 2,
        id: "second",
        start(context) {
          context.scheduler.schedule({
            id: "tick",
            delayMs: 1,
            everyMs: 1,
            run: () => {
              siblingTicks += 1;
            },
          });
        },
      },
    },
  );
  const services = await startPluginServices({ registry, config: {}, scheduler });
  const retained = await admitted.promise;
  const running = clock.advanceBy(1);
  let retired = false;
  const stopping = services.stop({ strict: true, pluginIds: new Set(["first"]) }).then(() => {
    retired = true;
  });
  try {
    await withinTest(entered.promise, signal);
    await withinTest(stopCalled.promise, signal);
    expect(retired).toBe(false);
    expect(retained.signal.aborted).toBe(true);
    expect(() => retained.schedule({ id: "late", delayMs: 0, run() {} })).toThrow("closed");
    await withinTest(siblingRearmed.promise, signal);
    await clock.advanceBy(1);
    expect(siblingTicks).toBe(2);
    physicalWork.resolve();
    await running;
    expect(retired).toBe(false);
    stopFlush.resolve();
    await stopping;
    await clock.advanceBy(1);
    expect(siblingTicks).toBe(3);
  } finally {
    physicalWork.resolve();
    stopFlush.resolve();
    await Promise.allSettled([running, stopping]);
    await services.stop();
    await scheduler.stop();
  }
});

it.for([false, true])(
  "retains a tracked child after a strict stop deadline, synchronous hook failure=%s",
  async (failStop, { signal }) => {
    const clock = createGatewaySchedulerClock();
    const gatewayScheduler = createTestGatewayScheduler(clock.clock);
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const failure = new Error("synchronous stop failed");
    let completed = false;
    let stopCalls = 0;
    const registry = createEmptyPluginRegistry();
    registry.services.push({
      pluginId: "tracked-child",
      id: "tracked-child",
      source: "synthetic",
      origin: "workspace",
      service: {
        apiVersion: 2,
        id: "tracked-child",
        start({ scheduler }) {
          scheduler.scope().schedule({
            id: "work",
            delayMs: 1,
            run() {
              void trackAsyncWork(async () => {
                entered.resolve();
                await release.promise;
                completed = true;
              });
            },
          });
        },
        stop() {
          stopCalls += 1;
          if (failStop) {
            throw failure;
          }
        },
      },
    });
    const services = await startPluginServices({
      registry,
      config: {},
      scheduler: gatewayScheduler,
    });
    const ticking = clock.advanceBy(1);
    try {
      await withinTest(entered.promise, signal);
      const outcome = await services
        .stop({ strict: true, deadlineAtMs: Date.now() })
        .catch((error: unknown) => error);
      const pending = getPluginServiceCleanupSettlement(outcome);
      expect(pending).toBeDefined();
      expect(completed).toBe(false);
      expect(stopCalls).toBe(1);
      if (!pending) {
        throw new Error("Strict stop did not retain its pending cleanup");
      }
      release.resolve();
      const settled = withinTest(pending.settled, signal);
      if (failStop) {
        await expect(settled).rejects.toMatchObject({ errors: [failure] });
      } else {
        await expect(settled).resolves.toBeUndefined();
      }
      await ticking;
      expect(completed).toBe(true);
      expect(stopCalls).toBe(1);
    } finally {
      release.resolve();
      await Promise.allSettled([ticking, services.stop(), gatewayScheduler.stop()]);
    }
  },
);
