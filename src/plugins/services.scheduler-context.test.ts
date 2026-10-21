import { AsyncResource } from "node:async_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { queryObjects } from "node:v8";
import { expect, it } from "vitest";
import {
  readOperatorToolGatewayAuthority,
  runWithOperatorToolGatewayAuthority,
} from "../gateway/operator-tool-gateway-authority.js";
import { createSyntheticPluginRuntimeClient } from "../gateway/server-plugin-runtime-client.js";
import { createGatewayRequestContext } from "../gateway/server-request-context.js";
import { makeContextParams } from "../gateway/server-request-context.test-support.js";
import { createAuthRateLimiter } from "../plugin-sdk/webhook-ingress.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { registerPluginHttpRoute } from "./http-registry.js";
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
import { startPluginServices } from "./services.js";
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
    },
  });
  const runFromRequest = async <T>(run: () => T | Promise<T>): Promise<T> => {
    const caller = new AbortController();
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
                  run,
                ),
            ),
          ),
        ),
      );
    } finally {
      caller.abort(new Error("Caller completed"));
      await callerInstance.dispose();
      await retirePluginCache(cache);
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
            const limiter = createAuthRateLimiter();
            limiter.dispose();
            opened = true;
          },
        });
      },
    },
  });
  const services = await startPluginServices({ registry, config: {}, scheduler: gatewayScheduler });
  try {
    await clock.advanceBy(1);
    expect(opened).toBe(true);
  } finally {
    await services.stop();
    await gatewayScheduler.stop();
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
