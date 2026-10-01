import { AsyncLocalStorage } from "node:async_hooks";
import { describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import { getPluginExecutionFrame } from "../plugin-instance-invocation.js";
import { pluginInvocationContext } from "../plugin-instance-scope.js";
import { PluginInstance } from "../plugin-instance.js";
import { createEmptyPluginRegistry } from "../registry-empty.js";
import { adoptPluginRegistryRecords } from "../registry-lifecycle.js";
import { createPluginRecord } from "../status.test-helpers.js";
import { capturePluginBackgroundContext } from "./background-context.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayRequestScope,
} from "./gateway-request-scope.js";

function createOwner() {
  const record = createPluginRecord({ id: "background-owner" });
  const registry = createEmptyPluginRegistry();
  registry.plugins.push(record);
  return { record, registry, instance: new PluginInstance(record.id, { record, registry }) };
}

describe("plugin background admission", () => {
  it("preserves the Gateway binding without restoring foreground or retained-consumer authority", async () => {
    const { instance, registry } = createOwner();
    const resolveGatewayContext = vi.fn(() => undefined);
    const inheritedAdmission = vi.fn();
    const controller = new AbortController();
    const { run, staleContext } = withPluginRuntimeGatewayRequestScope(
      {
        isWebchatConnect: () => true,
        resolveGatewayContext,
        signal: controller.signal,
        hasCurrentClientAuthority: () => true,
        gatewayMethodDispatchAllowed: true,
      },
      () =>
        instance.run(() => ({
          run: capturePluginBackgroundContext(),
          staleContext: AsyncLocalStorage.snapshot(),
        })),
    );
    try {
      const observed = staleContext(() =>
        pluginInvocationContext.run(
          {
            lookup: () => ({
              run: (callback) => {
                inheritedAdmission();
                return callback();
              },
              wrap: (value) => value,
            }),
          },
          () =>
            run(() => ({
              scope: getPluginRuntimeGatewayRequestScope(),
              frame: getPluginExecutionFrame(),
              consumerScope: pluginInvocationContext.getStore(),
              current: instance.hasActiveCall,
            })),
        ),
      );
      expect(observed.scope).toMatchObject({ pluginRegistry: registry, resolveGatewayContext });
      expect(observed.scope?.isWebchatConnect(null)).toBe(false);
      expect(observed.scope?.signal).toBeUndefined();
      expect(observed.scope?.hasCurrentClientAuthority).toBeUndefined();
      expect(observed.scope?.gatewayMethodDispatchAllowed).toBeUndefined();
      expect(observed.frame?.cacheScope).toBeUndefined();
      expect(observed.frame?.metadataScope).toBeUndefined();
      expect(observed.consumerScope).toBeUndefined();
      expect(observed.current).toBe(true);
      expect(inheritedAdmission).not.toHaveBeenCalled();
      instance.quiesce();
      expect(() => staleContext(() => run(() => "late work"))).toThrow("reloaded or disabled");
    } finally {
      await instance.dispose();
    }
  });

  it("pins admitted work through adoption and lets disposal join its callback without a cleanup cycle", async () => {
    const { instance, record, registry } = createOwner();
    const run = instance.run(() => capturePluginBackgroundContext());
    const release = createDeferredCore();
    const callback = run(async () => {
      await release.promise;
      return instance.run(() => getPluginRuntimeGatewayRequestScope()?.pluginRegistry);
    });
    let cleanedUp = false;
    instance.lifecycle.onDispose(async () => {
      await callback;
      cleanedUp = true;
    });
    const replacement = createEmptyPluginRegistry();
    replacement.plugins.push(record);
    adoptPluginRegistryRecords(replacement);
    expect(run(() => getPluginRuntimeGatewayRequestScope()?.pluginRegistry)).toBe(replacement);
    const disposing = instance.dispose();
    try {
      expect(cleanedUp).toBe(false);
      expect(() => run(() => undefined)).toThrow("reloaded or disabled");
      release.resolve();
      expect(await callback).toBe(registry);
      expect(await disposing).toEqual({ errors: [] });
      expect(cleanedUp).toBe(true);
    } finally {
      release.resolve();
      await Promise.allSettled([callback, disposing]);
    }
  });
});
