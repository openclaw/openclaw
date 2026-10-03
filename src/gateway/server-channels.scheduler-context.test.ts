import { expect, it } from "vitest";
import type { ChannelGatewayContextV2 } from "../channels/plugins/types.adapters.js";
import { createSubsystemLogger, runtimeForLogger } from "../logging/subsystem.js";
import { createAuthRateLimiter } from "../plugin-sdk/webhook-ingress.js";
import { registerPluginHttpRoute } from "../plugins/http-registry.js";
import { pluginInstanceInvocation } from "../plugins/plugin-instance-invocation.js";
import { PluginInstance } from "../plugins/plugin-instance.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { bindPluginRegistryRuntime } from "../plugins/registry-runtime-binding.js";
import {
  bindGatewayContextResolver,
  getInProcessGatewayRequestContext,
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayRequestScope,
} from "../plugins/runtime/gateway-request-scope.js";
import { createPluginRuntime } from "../plugins/runtime/index.js";
import { resolvePluginServiceScheduler } from "../plugins/service-scheduler-binding.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import {
  readOperatorToolGatewayAuthority,
  runWithOperatorToolGatewayAuthority,
} from "./operator-tool-gateway-authority.js";
import { createChannelManager } from "./server-channels.js";
import { createTestPlugin, type TestAccount } from "./server-channels.test-support.js";
import { createSyntheticPluginRuntimeClient } from "./server-plugin-runtime-client.js";
import { createGatewayRequestContext } from "./server-request-context.js";
import { makeContextParams } from "./server-request-context.test-support.js";

it.each([true, false])(
  "owns account ticks and HTTP routes with Gateway binding=%s",
  async (gatewayBound) => {
    const context = createGatewayRequestContext(makeContextParams());
    const registry = createEmptyPluginRegistry();
    if (gatewayBound) {
      const runtime = createPluginRuntime();
      bindGatewayContextResolver(runtime, () => context);
      bindPluginRegistryRuntime(registry, runtime);
    }
    const record = createPluginRecord({ id: "scheduled-account", origin: "bundled" });
    registry.plugins.push(record);
    const instance = new PluginInstance(record.id, { record, registry });
    const clock = createGatewaySchedulerClock();
    const gatewayScheduler = createTestGatewayScheduler(clock.clock);
    const started = createDeferredCore<ChannelGatewayContextV2<TestAccount>>();
    const observations: Array<{
      liveInstance: boolean;
      gateway: boolean;
      request: boolean;
      operator: boolean;
    }> = [];
    const observe = async () => {
      await Promise.resolve();
      if (!gatewayBound) {
        const limiter = createAuthRateLimiter();
        limiter.dispose();
      }
      observations.push({
        liveInstance:
          pluginInstanceInvocation.getStore()?.instance === instance && instance.hasActiveCall,
        gateway: getInProcessGatewayRequestContext() === context,
        request: getPluginRuntimeGatewayRequestScope()?.client !== undefined,
        operator: readOperatorToolGatewayAuthority() !== undefined,
      });
      registerPluginHttpRoute({
        path: `/scheduled-account/${observations.length}`,
        auth: "plugin",
        handler: async () => true,
        pluginId: record.id,
        throwOnFailure: true,
      });
    };
    const plugin = instance.wrap(
      createTestPlugin({
        startAccount: async (account) => {
          resolvePluginServiceScheduler().schedule({ id: "startup", delayMs: 1, run: observe });
          started.resolve(account);
          await new Promise<void>((resolve) => {
            account.abortSignal.addEventListener("abort", () => resolve(), { once: true });
          });
        },
      }),
    );
    registry.channels.push({
      pluginId: record.id,
      source: record.source,
      origin: "bundled",
      plugin,
    });
    const log = createSubsystemLogger("gateway/scheduled-account-test");
    const manager = createChannelManager({
      scheduler: gatewayScheduler,
      getRuntimeConfig: () => ({}),
      getPluginRegistry: () => registry,
      channelLogs: { discord: log },
      channelRuntimeEnvs: { discord: runtimeForLogger(log) },
    });
    const runFromRequest = async <T>(run: () => T | Promise<T>): Promise<T> => {
      const caller = new AbortController();
      try {
        return await runWithOperatorToolGatewayAuthority(
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
        );
      } finally {
        caller.abort(new Error("Caller completed"));
      }
    };
    try {
      await runFromRequest(async () => {
        await manager.startChannel("discord");
        await started.promise;
      });
      const account = await started.promise;
      await clock.advanceBy(1);
      await runFromRequest(() =>
        instance.run(() => {
          account.scheduler.schedule({ id: "later-request", delayMs: 1, run: observe });
        }),
      );
      await clock.advanceBy(1);
      expect(observations).toEqual([
        { liveInstance: true, gateway: gatewayBound, request: false, operator: false },
        { liveInstance: true, gateway: gatewayBound, request: false, operator: false },
      ]);
      expect(registry.httpRoutes.map((route) => route.path)).toEqual([
        "/scheduled-account/1",
        "/scheduled-account/2",
      ]);
      account.scheduler.schedule({ id: "retired", delayMs: 1, run: observe });
      await manager.stopChannel("discord");
      await clock.advanceBy(1);
      expect(observations).toHaveLength(2);
      expect(account.scheduler.signal.aborted).toBe(true);
      expect(registry.httpRoutes).toHaveLength(0);
    } finally {
      await manager.stopChannel("discord");
      await gatewayScheduler.stop();
      await instance.dispose();
    }
  },
);
