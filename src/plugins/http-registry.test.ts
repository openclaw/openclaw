/** Verifies plugin HTTP route registration, collision detection, and metadata capture. */
import { AsyncResource } from "node:async_hooks";
import { setImmediate } from "node:timers/promises";
import { queryObjects } from "node:v8";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginRuntimeCapabilityLease } from "./capability-lease.js";
import {
  adoptPluginHttpRouteHandoffs,
  createPluginHttpRouteHandoff,
  registerPluginHttpRoute as registerRoute,
  withPluginHttpRouteRegistry,
} from "./http-registry.js";
import { PluginInstance } from "./plugin-instance.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { markPluginRegistryActive, markPluginRegistryRetired } from "./registry-lifecycle.js";
import { createTestPluginRegistry } from "./registry-runtime.test-helpers.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "./runtime.js";
import { withPluginRuntimeRegistryScope } from "./runtime/gateway-request-scope.js";
import { createPluginRecord } from "./status.test-fixtures.js";

type Registry = ReturnType<typeof createEmptyPluginRegistry>;
type RouteParams = Omit<Parameters<typeof registerRoute>[0], "auth" | "handler"> &
  Partial<Pick<Parameters<typeof registerRoute>[0], "auth" | "handler">>;

function registerPluginHttpRoute(params: RouteParams) {
  return registerRoute({ auth: "plugin", handler: vi.fn(), ...params });
}

function expectRegisteredRouteShape(registry: Registry, params: RouteParams) {
  expect(registry.httpRoutes).toHaveLength(1);
  expect(registry.httpRoutes[0]).toEqual({
    path: params.path,
    handler: params.handler ?? registry.httpRoutes[0]?.handler,
    auth: params.auth ?? "plugin",
    match: params.match ?? "exact",
    pluginId: params.pluginId,
    source: params.source,
  });
}

function createLoggedRouteHarness() {
  const registry = createEmptyPluginRegistry();
  const logs: string[] = [];
  return {
    registry,
    logs,
    register: (params: Omit<RouteParams, "registry" | "log">) =>
      registerPluginHttpRoute({
        ...params,
        registry,
        log: (msg) => logs.push(msg),
      }),
  };
}

function registerLeasedRoute(
  registry: Registry,
  owner: ReturnType<typeof createTrackedRouteLease>,
  params: RouteParams,
) {
  return withPluginHttpRouteRegistry(registry, () => registerPluginHttpRoute(params), owner.lease);
}

function registerStaticRoute(
  record: ReturnType<typeof createPluginRecord>,
  params: RouteParams & { path: string },
) {
  const harness = createTestPluginRegistry();
  harness.registry.plugins.push(record);
  harness.createApi(record, { config: {} as OpenClawConfig }).registerHttpRoute({
    auth: "plugin",
    handler: vi.fn(),
    ...params,
  });
  return harness.registry;
}

function registryWithService(Service: new () => { id: string; start: () => void }) {
  const registry = createEmptyPluginRegistry();
  const service = new Service();
  registry.services.push({
    id: service.id,
    pluginId: "retained-plugin",
    service,
    source: "retention-test",
    origin: "config",
  });
  return registry;
}

function createTrackedRouteLease() {
  let active = true;
  const cleanups = new Set<() => void>();
  const lease = {
    isActive: () => active,
    retain: vi.fn((cleanup: () => void) => {
      const release = () => {
        if (cleanups.delete(release)) {
          cleanup();
        }
      };
      cleanups.add(release);
      return release;
    }),
  };
  return {
    lease,
    cleanups,
    revoke: () => {
      active = false;
      for (const cleanup of cleanups) {
        cleanup();
      }
    },
  };
}

describe("registerPluginHttpRoute", () => {
  afterEach(() => {
    resetPluginRuntimeStateForTest();
  });

  it("transfers retry ingress while retired holders release their leases", () => {
    const previous = createEmptyPluginRegistry();
    const next = createEmptyPluginRegistry();
    const retired = createTrackedRouteLease();
    const current = createTrackedRouteLease();
    const route = {
      path: "/plugins/handoff",
      auth: "plugin" as const,
      pluginId: "demo",
      source: "account",
    };
    const unregisterOld = registerLeasedRoute(previous, retired, {
      ...route,
      handler: vi.fn(),
      throwOnFailure: true,
    });
    const handoff = createPluginHttpRouteHandoff();
    handoff.park(retired.lease);
    retired.revoke();
    expect(retired.cleanups.size).toBe(0);
    adoptPluginHttpRouteHandoffs(previous, next);
    expect(previous.httpRoutes).toHaveLength(0);
    expect(next.httpRoutes).toHaveLength(1);
    const handler = vi.fn();
    registerLeasedRoute(next, current, { ...route, handler, throwOnFailure: true });
    unregisterOld();
    handoff.release();
    expect(next.httpRoutes.map((entry) => entry.handler)).toEqual([handler]);
    current.revoke();
    expect(next.httpRoutes).toHaveLength(0);
    expect(current.cleanups.size).toBe(0);
  });

  it.each([{ pluginId: "other" }, { source: "other-account" }, { auth: "gateway" as const }])(
    "preserves retry ingress when a successor changes ownership: %j",
    (changed) => {
      const registry = createEmptyPluginRegistry();
      const retired = createTrackedRouteLease();
      const route = {
        path: "/plugins/handoff",
        auth: "plugin" as const,
        pluginId: "demo",
        source: "account",
      };
      registerLeasedRoute(registry, retired, { ...route, handler: vi.fn(), throwOnFailure: true });
      const handoff = createPluginHttpRouteHandoff();
      handoff.park(retired.lease);
      retired.revoke();
      const placeholder = registry.httpRoutes[0];
      expect(() =>
        registerPluginHttpRoute({
          ...route,
          ...changed,
          registry,
          throwOnFailure: true,
        }),
      ).toThrow();
      expect(registry.httpRoutes).toEqual([placeholder]);
      const next = createEmptyPluginRegistry();
      registerPluginHttpRoute({
        ...route,
        ...changed,
        registry: next,
        throwOnFailure: true,
      });
      expect(() => adoptPluginHttpRouteHandoffs(registry, next)).toThrow();
      expect(registry.httpRoutes).toEqual([placeholder]);
      handoff.release();
      expect(registry.httpRoutes).toHaveLength(0);
    },
  );

  it.each([false, true])(
    "keeps sibling handoffs across successor claims (registry swap: %s)",
    (swapRegistry) => {
      const registry = createEmptyPluginRegistry();
      const first = createTrackedRouteLease();
      const second = createTrackedRouteLease();
      const firstHandoff = createPluginHttpRouteHandoff();
      const secondHandoff = createPluginHttpRouteHandoff();
      const route = {
        path: "/plugins/shared",
        auth: "plugin" as const,
        pluginId: "demo",
        source: "shared",
      };
      for (const owner of [first, second]) {
        registerLeasedRoute(registry, owner, {
          ...route,
          reuseExistingSameOwner: true,
          throwOnFailure: true,
        });
      }
      firstHandoff.park(first.lease);
      first.revoke();
      secondHandoff.park(second.lease);
      second.revoke();
      expect(registry.httpRoutes.map((entry) => entry.handoff)).toEqual([true]);
      const next = swapRegistry ? createEmptyPluginRegistry() : registry;
      const handler = vi.fn();
      const unregister = registerPluginHttpRoute({
        ...route,
        registry: next,
        handler,
        throwOnFailure: true,
      });
      if (swapRegistry) {
        adoptPluginHttpRouteHandoffs(registry, next);
      }
      firstHandoff.release();
      expect(next.httpRoutes.map((entry) => entry.handler)).toEqual([handler]);
      unregister();
      expect(next.httpRoutes.map((entry) => entry.handoff)).toEqual([true]);
      const secondHandler = vi.fn();
      const unregisterSecond = registerPluginHttpRoute({
        ...route,
        registry: next,
        handler: secondHandler,
        throwOnFailure: true,
      });
      secondHandoff.release();
      expect(next.httpRoutes.map((entry) => entry.handler)).toEqual([secondHandler]);
      unregisterSecond();
      expect(next.httpRoutes).toHaveLength(0);
    },
  );

  it("marks gateway method dispatch entitlement only for plugins declaring the contract", () => {
    const pluginRegistry = createTestPluginRegistry();
    const config = {} as OpenClawConfig;
    const plainRecord = createPluginRecord({
      id: "plain-http",
      source: "/plugins/plain-http/index.ts",
    });
    const adminRecord = createPluginRecord({
      id: "admin-http",
      source: "/plugins/admin-http/index.ts",
      contracts: { gatewayMethodDispatch: ["authenticated-request"] },
    });

    pluginRegistry.registry.plugins.push(plainRecord, adminRecord);
    pluginRegistry.createApi(plainRecord, { config }).registerHttpRoute({
      path: "/plain",
      auth: "gateway",
      handler: vi.fn(),
    });
    pluginRegistry.createApi(adminRecord, { config }).registerHttpRoute({
      path: "/admin",
      auth: "gateway",
      handler: vi.fn(),
    });

    const plainRoute = pluginRegistry.registry.httpRoutes.find(
      (route) => route.pluginId === "plain-http",
    );
    const adminRoute = pluginRegistry.registry.httpRoutes.find(
      (route) => route.pluginId === "admin-http",
    );

    expect(plainRoute?.gatewayMethodDispatchAllowed).toBeUndefined();
    expect(adminRoute?.gatewayMethodDispatchAllowed).toBe(true);
  });

  it.each([false, true])("rejects a missing path (strict: %s)", (throwOnFailure) => {
    const { registry, logs, register } = createLoggedRouteHarness();
    const registerMissingPath = () =>
      register({
        path: "",
        accountId: "default",
        throwOnFailure,
      });

    let unregister: (() => void) | undefined;
    if (throwOnFailure) {
      expect(registerMissingPath).toThrow('plugin: webhook path missing for account "default"');
    } else {
      unregister = registerMissingPath();
    }
    expect(registry.httpRoutes).toHaveLength(0);
    expect(logs).toEqual(['plugin: webhook path missing for account "default"']);
    if (!throwOnFailure) {
      expect(unregister).toBeTypeOf("function");
    }
    unregister?.();
  });

  it("keeps a reused same-owner route until its last lease releases", () => {
    const { registry, logs, register } = createLoggedRouteHarness();
    const firstOwner = createTrackedRouteLease();
    const secondOwner = createTrackedRouteLease();
    const firstHandler = vi.fn();
    const secondHandler = vi.fn();
    const unregisterFirst = withPluginHttpRouteRegistry(
      registry,
      () =>
        register({
          path: "/plugins/shared",
          handler: firstHandler,
          pluginId: "demo",
          source: "shared-route",
        }),
      firstOwner.lease,
    );

    const unregisterSecond = withPluginHttpRouteRegistry(
      registry,
      () =>
        register({
          path: "/PLUGINS//SHARED/",
          handler: secondHandler,
          pluginId: "demo",
          source: "shared-route",
          reuseExistingSameOwner: true,
          throwOnFailure: true,
        }),
      secondOwner.lease,
    );

    expect(registry.httpRoutes).toHaveLength(1);
    expect(registry.httpRoutes[0]?.handler).toBe(firstHandler);
    expect(logs.at(-1)).toContain("reusing existing webhook path");

    const handoff = createPluginHttpRouteHandoff();
    handoff.park(firstOwner.lease);
    firstOwner.revoke();
    handoff.release();
    expect(registry.httpRoutes).toHaveLength(1);
    expect(registry.httpRoutes[0]?.handler).toBe(firstHandler);
    expect(secondOwner.cleanups).toHaveLength(1);

    unregisterSecond();
    expect(registry.httpRoutes).toHaveLength(0);
    unregisterFirst();
  });

  it.each(["unregister", "revoke"] as const)(
    "preserves a static plugin route when a dynamic holder calls %s",
    (cleanup) => {
      const record = createPluginRecord({ id: "demo", source: "/plugins/demo/index.js" });
      const handler = vi.fn();
      const registry = registerStaticRoute(record, {
        path: "/plugins/shared",
        handler,
      });
      const owner = createTrackedRouteLease();
      const unregister = registerLeasedRoute(registry, owner, {
        path: "/PLUGINS//SHARED/",
        pluginId: record.id,
        source: record.source,
        reuseExistingSameOwner: true,
        throwOnFailure: true,
      });

      (cleanup === "unregister" ? unregister : owner.revoke)();
      expect(registry.httpRoutes).toHaveLength(1);
      expect(registry.httpRoutes[0]?.handler).toBe(handler);
      unregister();
      owner.revoke();
    },
  );

  it.each([
    { pluginId: "other", source: "shared-route" },
    { pluginId: "demo", source: "other-route" },
  ])("rejects route reuse by $pluginId/$source", ({ pluginId, source }) => {
    const { registry, register } = createLoggedRouteHarness();
    const firstHandler = vi.fn();
    register({
      path: "/plugins/shared",
      handler: firstHandler,
      pluginId: "demo",
      source: "shared-route",
    });

    expect(() =>
      register({
        path: "/plugins/shared",
        pluginId,
        source,
        reuseExistingSameOwner: true,
        throwOnFailure: true,
      }),
    ).toThrow("plugin: route reuse denied");
    expect(registry.httpRoutes).toHaveLength(1);
    expect(registry.httpRoutes[0]?.handler).toBe(firstHandler);
  });

  it("finds a canonical exact alias behind an earlier prefix overlap", () => {
    const { registry, register } = createLoggedRouteHarness();
    register({
      path: "/webhooks",
      match: "prefix",
      pluginId: "sms",
      source: "prefix",
    });
    register({
      path: "/Webhooks/SMS/",
      pluginId: "sms",
      source: "sms-exact",
    });

    register({
      path: "/webhooks/sms",
      pluginId: "sms",
      source: "sms-exact",
      replaceExisting: true,
      throwOnFailure: true,
    });

    expect(registry.httpRoutes.map((route) => route.source)).toEqual(["prefix", "sms-exact"]);
  });

  it("rejects replacement when a distinct route source owns the same plugin path", () => {
    const record = createPluginRecord({
      id: "mattermost",
      source: "/plugins/mattermost/index.js",
    });
    const slashHandler = vi.fn();
    const registry = registerStaticRoute(record, {
      path: "/Mattermost//Interactions/default/",
      handler: slashHandler,
    });

    expect(() =>
      registerPluginHttpRoute({
        path: "/mattermost/interactions/default",
        registry,
        pluginId: "mattermost",
        source: "mattermost-interactions",
        replaceExisting: true,
        throwOnFailure: true,
      }),
    ).toThrow("plugin: route replacement denied");

    expect(registry.httpRoutes).toHaveLength(1);
    expect(registry.httpRoutes[0]).toMatchObject({
      handler: slashHandler,
      pluginId: "mattermost",
      source: "/plugins/mattermost/index.js",
    });
  });

  it("preserves shipped same-plugin source-less replacement", () => {
    const { registry, logs, register } = createLoggedRouteHarness();
    const firstHandler = vi.fn();
    const secondHandler = vi.fn();

    const unregisterFirst = register({
      path: "/plugins/synology",
      handler: firstHandler,
      accountId: "default",
      pluginId: "synology-chat",
    });

    const unregisterSecond = register({
      path: "/plugins/synology",
      replaceExisting: true,
      handler: secondHandler,
      accountId: "default",
      pluginId: "synology-chat",
    });

    expect(registry.httpRoutes).toHaveLength(1);
    expect(registry.httpRoutes[0]?.handler).toBe(secondHandler);
    expect(registry.httpRoutes[0]?.source).toBeUndefined();
    expect(logs).toContain(
      'plugin: replacing stale webhook path /plugins/synology (exact) for account "default" (synology-chat)',
    );

    // Old unregister must not remove the replacement route.
    unregisterFirst();
    expect(registry.httpRoutes).toHaveLength(1);
    expect(registry.httpRoutes[0]?.handler).toBe(secondHandler);

    unregisterSecond();
    expect(registry.httpRoutes).toHaveLength(0);
  });

  it.each([
    {
      name: "source-aware replacement cannot evict a source-less route",
      existing: { pluginId: "demo", source: undefined },
      replacement: { pluginId: "demo", source: "demo-webhook" },
    },
    {
      name: "source-less replacement cannot evict a source-aware route",
      existing: { pluginId: "demo", source: "demo-webhook" },
      replacement: { pluginId: "demo", source: undefined },
    },
    {
      name: "throws when strict registration cannot replace another plugin's route",
      existing: { pluginId: "demo-a", source: undefined },
      replacement: { pluginId: "demo-b", source: undefined },
    },
    {
      name: "anonymous replacement cannot evict an owned route",
      existing: { pluginId: "demo-a", source: undefined },
      replacement: { pluginId: undefined, source: undefined },
    },
    {
      name: "an owned replacement cannot evict an anonymous route",
      existing: { pluginId: undefined, source: undefined },
      replacement: { pluginId: "demo-a", source: undefined },
    },
  ])("$name", ({ existing, replacement }) => {
    const { registry, register } = createLoggedRouteHarness();
    const existingHandler = vi.fn();
    register({
      path: "/plugins/demo",
      handler: existingHandler,
      ...existing,
    });

    expect(() =>
      register({
        path: "/plugins/demo",
        ...replacement,
        replaceExisting: true,
        throwOnFailure: true,
      }),
    ).toThrow("plugin: route replacement denied");
    expect(registry.httpRoutes).toHaveLength(1);
    expect(registry.httpRoutes[0]?.handler).toBe(existingHandler);
    expect(registry.httpRoutes[0]?.pluginId).toBe(existing.pluginId);
    expect(registry.httpRoutes[0]?.source).toBe(existing.source);
  });

  it("preserves shipped anonymous-to-anonymous lifecycle replacement", () => {
    const { registry, register } = createLoggedRouteHarness();
    register({
      path: "/plugins/demo",
      source: "old-anonymous",
    });

    register({
      path: "/plugins/demo",
      replaceExisting: true,
      throwOnFailure: true,
      source: "new-anonymous",
    });

    expect(registry.httpRoutes).toHaveLength(1);
    expect(registry.httpRoutes[0]?.source).toBe("new-anonymous");
  });

  it("finds a mixed-auth overlap behind an earlier same-auth prefix", () => {
    const { registry, register } = createLoggedRouteHarness();
    register({
      path: "/plugin",
      match: "prefix",
      pluginId: "demo-plugin",
    });
    registry.httpRoutes.push({
      path: "/plugin/secure/report",
      handler: vi.fn(),
      auth: "gateway",
      match: "exact",
      pluginId: "demo-gateway",
      source: "preloaded-gateway-route",
    });

    expect(() =>
      register({
        path: "/PLUGIN/secure/report/",
        match: "exact",
        pluginId: "demo-plugin",
        throwOnFailure: true,
      }),
    ).toThrow("plugin: route overlap denied");
    expect(registry.httpRoutes).toHaveLength(2);
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
        const registry = registryWithService(RetainedService);
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
        const registry = registryWithService(RetainedService);
        const record = createPluginRecord({ id: "adopted-plugin" });
        registry.plugins.push(record);
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

  it("tracks exact scoped route cleanup without removing unrelated routes", () => {
    const registry = createEmptyPluginRegistry();
    const owner = createTrackedRouteLease();
    registerPluginHttpRoute({
      path: "/unrelated-webhook",
      registry,
    });

    const cleanup = withPluginHttpRouteRegistry(
      registry,
      () => [
        registerPluginHttpRoute({
          path: "/leased-anonymous-webhook",
        }),
        registerPluginHttpRoute({
          path: "/leased-owned-webhook",
          pluginId: "demo",
        }),
      ],
      owner.lease,
    );

    expect(owner.cleanups.size).toBe(2);
    cleanup[0]?.();
    expect(owner.cleanups.size).toBe(1);
    expect(registry.httpRoutes.map((route) => route.path)).toEqual([
      "/unrelated-webhook",
      "/leased-owned-webhook",
    ]);
    owner.revoke();
    cleanup[0]?.();
    cleanup[1]?.();
    owner.revoke();
    expect(owner.cleanups.size).toBe(0);
    expect(registry.httpRoutes.map((route) => route.path)).toEqual(["/unrelated-webhook"]);
  });

  it.each([
    { name: "anonymous", pluginId: undefined, explicitRegistry: false, nestedScope: false },
    { name: "plugin-owned", pluginId: "demo", explicitRegistry: false, nestedScope: false },
    {
      name: "anonymous with an explicit registry",
      pluginId: undefined,
      explicitRegistry: true,
      nestedScope: false,
    },
    {
      name: "anonymous through a nested scope",
      pluginId: undefined,
      explicitRegistry: false,
      nestedScope: true,
    },
  ])(
    "rejects late $name route registration after its async service lease expires",
    async ({ pluginId, explicitRegistry, nestedScope }) => {
      const registry = createEmptyPluginRegistry();
      const cleanups: Array<() => void> = [];
      let active = true;
      let releaseContinuation: (() => void) | undefined;
      const continuation = new Promise<void>((resolve) => {
        releaseContinuation = resolve;
      });

      const lateRegistration = withPluginHttpRouteRegistry(
        registry,
        async () => {
          await continuation;
          const register = () =>
            registerPluginHttpRoute({
              path: "/late-webhook",
              throwOnFailure: true,
              ...(pluginId ? { pluginId } : {}),
              ...(explicitRegistry ? { registry } : {}),
            });
          if (nestedScope) {
            withPluginHttpRouteRegistry(registry, register);
          } else {
            register();
          }
        },
        {
          isActive: () => active,
          retain: (unregister) => {
            cleanups.push(unregister);
            return unregister;
          },
        },
      );

      active = false;
      releaseContinuation?.();

      await expect(lateRegistration).rejects.toThrow(
        "plugin runtime HTTP route lease is no longer active",
      );
      expect(registry.httpRoutes).toHaveLength(0);
      expect(cleanups).toHaveLength(0);
    },
  );

  it.each([
    { name: "a different nested registry", childLease: false, expiredOwner: "parent" },
    { name: "a supplied replacement lease", childLease: true, expiredOwner: "parent" },
    { name: "an expired child under an active parent", childLease: true, expiredOwner: "child" },
  ])("rejects expired ambient route authority through $name", ({ childLease, expiredOwner }) => {
    const parentRegistry = createEmptyPluginRegistry();
    const nestedRegistry = createEmptyPluginRegistry();
    const parent = createTrackedRouteLease();
    const child = createTrackedRouteLease();
    (expiredOwner === "parent" ? parent : child).revoke();

    expect(() =>
      withPluginHttpRouteRegistry(
        parentRegistry,
        () =>
          withPluginHttpRouteRegistry(
            nestedRegistry,
            () => registerPluginHttpRoute({ path: "/independent-webhook", throwOnFailure: true }),
            childLease ? child.lease : undefined,
          ),
        parent.lease,
      ),
    ).toThrow("plugin runtime HTTP route lease is no longer active");

    expect(parentRegistry.httpRoutes).toHaveLength(0);
    expect(nestedRegistry.httpRoutes).toHaveLength(0);
    expect(parent.lease.retain).not.toHaveBeenCalled();
    expect(child.lease.retain).not.toHaveBeenCalled();
  });

  it("releases nested routes from every ambient lease when any owner revokes", () => {
    const parentRegistry = createEmptyPluginRegistry();
    const nestedRegistry = createEmptyPluginRegistry();
    const parent = createTrackedRouteLease();
    const child = createTrackedRouteLease();

    const unregister = withPluginHttpRouteRegistry(
      parentRegistry,
      () =>
        registerLeasedRoute(nestedRegistry, child, {
          path: "/nested-webhook",
          throwOnFailure: true,
        }),
      parent.lease,
    );

    expect(parent.cleanups.size).toBe(1);
    expect(child.cleanups.size).toBe(1);
    parent.revoke();

    expect(nestedRegistry.httpRoutes).toHaveLength(0);
    expect(parent.cleanups.size).toBe(0);
    expect(child.cleanups.size).toBe(0);
    unregister();
    child.revoke();
  });
});
