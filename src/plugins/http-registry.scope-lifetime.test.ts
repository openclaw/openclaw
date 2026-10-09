/** Verifies HTTP registry scope lifetime across deferred callbacks and instance adoption. */
import { AsyncResource } from "node:async_hooks";
import { setImmediate } from "node:timers/promises";
import { queryObjects } from "node:v8";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPluginRuntimeCapabilityLease } from "./capability-lease.js";
import { registerPluginHttpRoute, withPluginHttpRouteRegistry } from "./http-registry.js";
import { PluginInstance } from "./plugin-instance.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { markPluginRegistryActive, markPluginRegistryRetired } from "./registry-lifecycle.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "./runtime.js";
import { withPluginRuntimeRegistryScope } from "./runtime/gateway-request-scope.js";
import { createPluginRecord } from "./status.test-fixtures.js";

function expectRegisteredRouteShape(
  registry: ReturnType<typeof createEmptyPluginRegistry>,
  params: {
    path: string;
    handler?: unknown;
    auth: "plugin" | "gateway";
    match?: "exact" | "prefix";
    pluginId?: string;
    source?: string;
  },
) {
  expect(registry.httpRoutes).toHaveLength(1);
  expect(registry.httpRoutes[0]).toEqual({
    path: params.path,
    handler: params.handler ?? registry.httpRoutes[0]?.handler,
    auth: params.auth,
    match: params.match ?? "exact",
    pluginId: params.pluginId,
    source: params.source,
  });
}

describe("registerPluginHttpRoute scope lifetime", () => {
  afterEach(() => {
    resetPluginRuntimeStateForTest();
  });

  it("prefers the live scoped route registry after deferred startup", async () => {
    const scopedRegistry = createEmptyPluginRegistry();
    const pinnedRegistry = createEmptyPluginRegistry();

    setActivePluginRegistry(pinnedRegistry);

    const unregister = await withPluginHttpRouteRegistry(scopedRegistry, async () => {
      await setImmediate();
      return registerPluginHttpRoute({
        path: "/scoped-webhook",
        auth: "plugin",
        handler: vi.fn(),
      });
    });

    expectRegisteredRouteShape(scopedRegistry, {
      path: "/scoped-webhook",
      auth: "plugin",
    });
    expect(pinnedRegistry.httpRoutes).toHaveLength(0);

    unregister();
    expect(scopedRegistry.httpRoutes).toHaveLength(0);
  });

  it.each([false, true])(
    "releases retired registry graphs captured by async resources (leased: %s)",
    async (leased) => {
      class RetainedService {
        id = "retained-service";
        start() {}
      }
      const lease = leased ? createPluginRuntimeCapabilityLease("retention test") : undefined;
      const resources = Array.from({ length: 24 }, () => {
        const registry = createEmptyPluginRegistry();
        registry.services.push({
          id: "retained-service",
          pluginId: "retained-plugin",
          service: new RetainedService(),
          source: "retention-test",
          origin: "config",
        });
        const resource = withPluginHttpRouteRegistry(
          registry,
          () => new AsyncResource("plugin-http-retention"),
          lease,
        );
        markPluginRegistryRetired(registry);
        return resource;
      });
      const currentRegistry = createEmptyPluginRegistry();
      setActivePluginRegistry(currentRegistry);
      try {
        // Weak references keep targets alive until the creating job ends.
        await setImmediate();
        expect(queryObjects(RetainedService)).toBe(0);
        for (const resource of resources) {
          expect(() =>
            resource.runInAsyncScope(() =>
              registerPluginHttpRoute({
                path: "/retired-webhook",
                auth: "plugin",
                handler: () => true,
                throwOnFailure: true,
              }),
            ),
          ).toThrow("plugin HTTP route owner is no longer active");
        }
        expect(currentRegistry.httpRoutes).toHaveLength(0);
      } finally {
        lease?.revoke();
        for (const resource of resources) {
          resource.emitDestroy();
        }
      }
    },
  );

  it.each([
    { name: "HTTP", withScope: withPluginHttpRouteRegistry },
    { name: "Gateway", withScope: withPluginRuntimeRegistryScope },
  ])(
    "registers through an adopted instance after its captured $name registry is collected",
    async ({ withScope }) => {
      class RetainedService {
        id = "retired-service";
        start() {}
      }
      const currentRegistry = createEmptyPluginRegistry();
      const { resource, instance, handler } = (() => {
        const registry = createEmptyPluginRegistry();
        const record = createPluginRecord({ id: "adopted-plugin" });
        registry.plugins.push(record);
        registry.services.push({
          id: "retired-service",
          pluginId: "retired-plugin",
          service: new RetainedService(),
          source: "retention-test",
          origin: "config",
        });
        const adoptedInstance = new PluginInstance(record.id, { record, registry });
        const adoptedHandler = adoptedInstance.wrap(() => true);
        const capturedResource = withScope(
          registry,
          () => new AsyncResource("plugin-http-adoption"),
        );
        currentRegistry.plugins.push(record);
        markPluginRegistryActive(currentRegistry);
        markPluginRegistryRetired(registry);
        return { resource: capturedResource, instance: adoptedInstance, handler: adoptedHandler };
      })();
      try {
        await setImmediate();
        expect(queryObjects(RetainedService)).toBe(0);
        const unregister = resource.runInAsyncScope(() =>
          registerPluginHttpRoute({
            path: "/adopted-webhook",
            auth: "plugin",
            handler,
            throwOnFailure: true,
          }),
        );
        expectRegisteredRouteShape(currentRegistry, { path: "/adopted-webhook", auth: "plugin" });
        unregister();
      } finally {
        resource.emitDestroy();
        await instance.dispose();
      }
    },
  );
});
