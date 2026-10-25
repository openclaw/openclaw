import assert from "node:assert/strict";
import { AsyncResource } from "node:async_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { queryObjects } from "node:v8";
import { expect, it } from "vitest";
import { withinTest } from "../../test/helpers/promise.js";
import {
  readOperatorToolGatewayAuthority,
  runWithOperatorToolGatewayAuthority,
} from "../gateway/operator-tool-gateway-authority.js";
import { createSyntheticPluginRuntimeClient } from "../gateway/server-plugin-runtime-client.js";
import { createGatewayRequestContext } from "../gateway/server-request-context.js";
import { makeContextParams } from "../gateway/server-request-context.test-support.js";
import {
  createSqliteReadOnlyWorkerScope,
  readOnlyWorkerScope,
} from "../infra/sqlite-readonly-worker-context.js";
import { createAuthRateLimiter } from "../plugin-sdk/webhook-ingress.js";
import { trackAsyncWork } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { registerPluginHttpRoute } from "./http-registry.js";
import {
  getBoundLegacyPluginSdkResourceHost,
  LegacyPluginSdkResourceHost,
} from "./legacy-sdk-resource-host.js";
import {
  bindPluginMetadataSnapshotCache,
  createPluginCache,
  retirePluginCache,
  withPluginCache,
} from "./plugin-cache.js";
import { pluginInstanceInvocation } from "./plugin-instance-invocation.js";
import { PluginInstance } from "./plugin-instance.js";
import { createEmptyPluginMetadataSnapshot } from "./plugin-metadata-empty.test-support.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import {
  isPluginRegistryPreparing,
  withPluginRegistryPreparationScope,
} from "./registry-lifecycle.js";
import { bindPluginRegistryRuntime } from "./registry-runtime-binding.js";
import {
  bindGatewayContextResolver,
  getInProcessGatewayRequestContext,
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayRequestScope,
} from "./runtime/gateway-request-scope.js";
import { withPluginRuntimeGenerationScope } from "./runtime/generation-scope.js";
import { createPluginRuntime } from "./runtime/index.js";
import { resolvePluginServiceScheduler } from "./service-scheduler-binding.js";
import type { PluginServiceSchedulerV1 } from "./service-scheduler.types.js";
import { getPluginServiceCleanupSettlement, startPluginServices } from "./services.js";
import { createServiceRegistration } from "./services.test-support.js";
import { createPluginRecord } from "./status.test-helpers.js";

it("owns service callbacks after startup and reload callers finish", async () => {
  class CallerFacts {
    readonly owner = "service-start-caller";
  }
  const context = createGatewayRequestContext(makeContextParams());
  const runtime = createPluginRuntime();
  bindGatewayContextResolver(runtime, () => context);
  const registry = createEmptyPluginRegistry();
  bindPluginRegistryRuntime(registry, runtime);
  const record = createPluginRecord({ id: "scheduled-context", origin: "bundled" });
  registry.plugins.push(record);
  const instance = new PluginInstance(record.id, { record, registry });
  const clock = createGatewaySchedulerClock();
  const gatewayScheduler = createTestGatewayScheduler(clock.clock);
  const scopes: PluginServiceSchedulerV1[] = [];
  const resources: AsyncResource[] = [];
  const firstConfig = { browser: { enabled: false } };
  const nextConfig = { browser: { enabled: true } };
  const configs: unknown[] = [];
  const observations: Array<{
    liveInstance: boolean;
    gateway: boolean;
    request: boolean;
    operator: boolean;
  }> = [];
  const observe = async () => {
    await Promise.resolve();
    expect(readOnlyWorkerScope.getStore()?.active).toBe(true);
    observations.push({
      liveInstance:
        pluginInstanceInvocation.getStore()?.instance === instance && instance.hasActiveCall,
      gateway: getInProcessGatewayRequestContext() === context,
      request: getPluginRuntimeGatewayRequestScope()?.client !== undefined,
      operator: readOperatorToolGatewayAuthority() !== undefined,
    });
    registerPluginHttpRoute({
      path: `/scheduled-context/${observations.length}`,
      auth: "plugin",
      handler: async () => true,
      pluginId: record.id,
      throwOnFailure: true,
    });
  };
  registry.services.push({
    id: "scheduled-context",
    pluginId: record.id,
    source: record.source,
    origin: record.origin,
    service: {
      apiVersion: 2,
      id: "scheduled-context",
      start({ scheduler, config }) {
        scopes.push(scheduler);
        configs.push(config);
        resources.push(new AsyncResource("service-start", { requireManualDestroy: true }));
        expect(isPluginRegistryPreparing(registry)).toBe(true);
        registerPluginHttpRoute({
          path: `/scheduled-start/${scopes.length}`,
          auth: "plugin",
          handler: async () => true,
          pluginId: record.id,
          throwOnFailure: true,
        });
        resolvePluginServiceScheduler().schedule({ id: "startup", delayMs: 1, run: observe });
      },
      stop() {
        expect(readOnlyWorkerScope.getStore()?.active).toBe(true);
      },
    },
  });
  const runFromRequest = async <T>(run: () => T | Promise<T>): Promise<T> => {
    const caller = new AbortController();
    const readers = createSqliteReadOnlyWorkerScope();
    const facts = new CallerFacts();
    const cache = Object.assign(createPluginCache(), { facts });
    const metadataSnapshot = Object.assign(createEmptyPluginMetadataSnapshot(), { facts });
    const callerRegistry = Object.assign(createEmptyPluginRegistry(), { facts });
    const callerInstance = new PluginInstance("service-start-caller", { cache });
    bindPluginMetadataSnapshotCache(metadataSnapshot, cache);
    try {
      return await withPluginCache(cache, () =>
        withPluginRuntimeGenerationScope({ metadataSnapshot, pluginRegistry: callerRegistry }, () =>
          callerInstance.run(() =>
            runWithOperatorToolGatewayAuthority(
              {
                signal: caller.signal,
                scopes: ["operator.read"],
                operatorRoleActor: { kind: "system" },
              },
              () =>
                withPluginRuntimeGatewayRequestScope(
                  {
                    context,
                    client: createSyntheticPluginRuntimeClient({ scopes: ["operator.read"] }),
                    signal: caller.signal,
                    isWebchatConnect: () => false,
                  },
                  () => readers.run(run),
                ),
            ),
          ),
        ),
      );
    } finally {
      caller.abort(new Error("Caller completed"));
      await callerInstance.dispose();
      await retirePluginCache(cache);
      await readers.close();
    }
  };
  const services = await runFromRequest(() =>
    withPluginRegistryPreparationScope(registry, () =>
      startPluginServices({ registry, config: firstConfig, scheduler: gatewayScheduler }),
    ),
  );
  try {
    await clock.advanceBy(1);
    await runFromRequest(() =>
      scopes[0]!.schedule({ id: "later-request", delayMs: 1, run: observe }),
    );
    await clock.advanceBy(1);
    expect(registry.httpRoutes.map((route) => route.path)).toEqual([
      "/scheduled-start/1",
      "/scheduled-context/1",
      "/scheduled-context/2",
    ]);
    await runFromRequest(() =>
      withPluginRegistryPreparationScope(registry, () =>
        services.reload(nextConfig, new Set(["scheduled-context"])),
      ),
    );
    await clock.advanceBy(1);
    await nextTurn();
    expect(queryObjects(CallerFacts)).toBe(0);
    expect(configs).toEqual([firstConfig, nextConfig]);
    resources[1]!.runInAsyncScope(() => {
      expect(getInProcessGatewayRequestContext()).toBe(context);
      expect(getPluginRuntimeGatewayRequestScope()?.client).toBeUndefined();
      expect(getPluginRuntimeGatewayRequestScope()?.pluginRegistry).toBe(registry);
      expect(resolvePluginServiceScheduler()).toBe(scopes[1]);
      expect(readOperatorToolGatewayAuthority()).toBeUndefined();
    });
    expect(observations).toEqual([
      { liveInstance: true, gateway: true, request: false, operator: false },
      { liveInstance: true, gateway: true, request: false, operator: false },
      { liveInstance: true, gateway: true, request: false, operator: false },
    ]);
    expect(scopes[0]!.signal.aborted).toBe(true);
    expect(scopes[1]!.signal.aborted).toBe(false);
    expect(() => scopes[0]!.schedule({ id: "retired", delayMs: 0, run: observe })).toThrow(
      "closed",
    );
    expect(registry.httpRoutes.map((route) => route.path)).toEqual([
      "/scheduled-start/2",
      "/scheduled-context/3",
    ]);
    await services.stop();
    expect(registry.httpRoutes).toHaveLength(0);
  } finally {
    for (const resource of resources) {
      resource.emitDestroy();
    }
    await services.stop();
    await gatewayScheduler.stop();
    await instance.dispose();
  }
});

it("keeps standalone scheduled services free of an unbound Gateway resolver", async () => {
  const registry = createEmptyPluginRegistry();
  const clock = createGatewaySchedulerClock();
  const gatewayScheduler = createTestGatewayScheduler(clock.clock);
  const resourceHost = new LegacyPluginSdkResourceHost();
  resourceHost.bindScheduler(gatewayScheduler);
  let opened = false;
  registry.services.push({
    id: "standalone",
    pluginId: "standalone",
    source: "synthetic",
    origin: "workspace",
    service: {
      apiVersion: 2,
      id: "standalone",
      start({ scheduler }) {
        scheduler.schedule({
          id: "legacy-resource",
          delayMs: 1,
          run: () => {
            expect(getBoundLegacyPluginSdkResourceHost()).toBe(resourceHost);
            const limiter = createAuthRateLimiter();
            limiter.dispose();
            opened = true;
          },
        });
      },
    },
  });
  const readers = createSqliteReadOnlyWorkerScope();
  const services = await resourceHost.run(() =>
    readers.run(() => startPluginServices({ registry, config: {}, scheduler: gatewayScheduler })),
  );
  await readers.close();
  try {
    await clock.advanceBy(1);
    expect(opened).toBe(true);
  } finally {
    await services.stop();
    await gatewayScheduler.stop();
    await resourceHost.close();
  }
});

it("settles scheduled callbacks before the disposal that stops their service", async () => {
  const registry = createEmptyPluginRegistry();
  const record = createPluginRecord({ id: "scheduled-disposal", origin: "bundled" });
  registry.plugins.push(record);
  const instance = new PluginInstance(record.id, { record, registry });
  const clock = createGatewaySchedulerClock();
  const gatewayScheduler = createTestGatewayScheduler(clock.clock);
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const events: string[] = [];
  instance.lifecycle.onDispose(() => {
    events.push("disposed");
  });
  registry.services.push({
    id: record.id,
    pluginId: record.id,
    source: record.source,
    origin: record.origin,
    service: {
      apiVersion: 2,
      id: record.id,
      start({ scheduler }) {
        scheduler.schedule({
          id: "held",
          delayMs: 1,
          run: async () => {
            entered.resolve();
            await release.promise;
            events.push("callback");
          },
        });
      },
      stop() {
        events.push("stopped");
      },
    },
  });
  const services = await startPluginServices({ registry, config: {}, scheduler: gatewayScheduler });
  const tick = clock.advanceBy(1);
  await entered.promise;
  const disposal = instance.dispose(async () => {
    await services.stop();
  });
  try {
    expect(instance.acceptingCalls).toBe(false);
    release.resolve();
    const [result] = await Promise.all([disposal, tick]);
    expect(result.errors).toEqual([]);
    expect(events).toEqual(["callback", "stopped", "disposed"]);
  } finally {
    release.resolve();
    await Promise.allSettled([tick, disposal, services.stop(), gatewayScheduler.stop()]);
  }
});

const registration = (service: Parameters<typeof createServiceRegistration>[0]) =>
  createServiceRegistration(service, { pluginId: service.id, source: "synthetic" });

it("stops before joining work and preserves siblings", async ({ signal }) => {
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
  const tick = { id: "tick", delayMs: 1, everyMs: 1 };
  const registry = createEmptyPluginRegistry();
  registry.services.push(
    registration({
      apiVersion: 2,
      id: "first",
      start(context) {
        admitted.resolve(context.scheduler);
        context.scheduler.scope().schedule({
          ...tick,
          run: () =>
            void trackAsyncWork(async () => {
              entered.resolve();
              await stopCalled.promise;
              await physicalWork.promise;
            }),
        });
      },
      async stop() {
        stopCalled.resolve();
        await stopFlush.promise;
      },
    }),
    registration({
      apiVersion: 2,
      id: "second",
      start(context) {
        context.scheduler.schedule({
          ...tick,
          run: () => {
            siblingTicks += 1;
          },
        });
      },
    }),
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
  "retains child past deadline; stop throws=%s",
  async (failStop, { signal }) => {
    const clock = createGatewaySchedulerClock();
    const scheduler = createTestGatewayScheduler(clock.clock);
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const failure = new Error("synchronous stop failed");
    let completed = false;
    let stopCalls = 0;
    const registry = createEmptyPluginRegistry();
    registry.services.push(
      registration({
        apiVersion: 2,
        id: "tracked-child",
        start({ scheduler: serviceScheduler }) {
          serviceScheduler.scope().schedule({
            id: "work",
            delayMs: 1,
            run: () =>
              void trackAsyncWork(async () => {
                entered.resolve();
                await release.promise;
                completed = true;
              }),
          });
        },
        stop() {
          stopCalls += 1;
          if (failStop) {
            throw failure;
          }
        },
      }),
    );
    const services = await startPluginServices({ registry, config: {}, scheduler });
    const ticking = clock.advanceBy(1);
    try {
      await withinTest(entered.promise, signal);
      const outcome = await services
        .stop({ strict: true, deadlineAtMs: Date.now() })
        .catch((error: unknown) => error);
      const pending = getPluginServiceCleanupSettlement(outcome);
      assert(pending, "Strict stop did not retain its pending cleanup");
      expect({ completed, stopCalls }).toEqual({ completed: false, stopCalls: 1 });
      release.resolve();
      const settled = withinTest(pending.settled, signal);
      if (failStop) {
        await expect(settled).rejects.toMatchObject({ errors: [failure] });
      } else {
        await expect(settled).resolves.toBeUndefined();
      }
      await ticking;
      expect({ completed, stopCalls }).toEqual({ completed: true, stopCalls: 1 });
    } finally {
      release.resolve();
      await Promise.allSettled([ticking, services.stop(), scheduler.stop()]);
    }
  },
);
