import { AsyncResource } from "node:async_hooks";
import { setImmediate } from "node:timers/promises";
import { queryObjects } from "node:v8";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPluginRuntimeCapabilityLease } from "./capability-lease.js";
import {
  adoptPluginHttpRouteHandoffs as adoptHandoffs,
  createPluginHttpRouteHandoff as createHandoff,
  registerPluginHttpRoute as registerRoute,
  withPluginHttpRouteRegistry as withHttpRegistry,
} from "./http-registry.js";
import { PluginInstance } from "./plugin-instance.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { markPluginRegistryActive, markPluginRegistryRetired } from "./registry-lifecycle.js";
import { createTestPluginRegistry } from "./registry-runtime.test-helpers.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "./runtime.js";
import { withPluginRuntimeRegistryScope as withGatewayRegistry } from "./runtime/gateway-request-scope.js";
import { createPluginRecord } from "./status.test-fixtures.js";

type Registry = ReturnType<typeof createEmptyPluginRegistry>;
type RouteParams = Omit<Parameters<typeof registerRoute>[0], "auth" | "handler"> &
  Partial<Pick<Parameters<typeof registerRoute>[0], "auth" | "handler">>;

function registerHttp(params: RouteParams) {
  return registerRoute({ auth: "plugin", handler: vi.fn(), throwOnFailure: true, ...params });
}

function expectRoutes(registry: Registry, ...routes: Partial<Registry["httpRoutes"][number]>[]) {
  expect(registry.httpRoutes).toMatchObject(routes);
}

function expectReleased(registry: Registry, ...owners: ReturnType<typeof createLease>[]) {
  expect(registry.httpRoutes).toEqual([]);
  expect(owners.map((owner) => owner.cleanups.size)).toEqual(owners.map(() => 0));
}

function park(owner: ReturnType<typeof createLease>) {
  const handoff = createHandoff();
  handoff.park(owner.lease);
  owner.revoke();
  return handoff;
}

function expectDenied(
  register: (params: RouteParams) => unknown,
  params: RouteParams,
  kind?: "reuse" | "replacement" | "overlap",
) {
  expect(() => register({ ...params, throwOnFailure: true })).toThrow(
    kind ? `plugin: route ${kind} denied` : undefined,
  );
}

const sharedRoute = { path: "/plugins/shared", pluginId: "demo", source: "shared-route" };
const handoffRoute = { path: "/plugins/handoff", pluginId: "demo", source: "account" };

function routeHarness(defaults: RouteParams = {}, registry = createEmptyPluginRegistry()) {
  const logs: string[] = [];
  const register = (params: RouteParams = {}, owner?: ReturnType<typeof createLease>) => {
    const run = () =>
      registerHttp({ ...defaults, ...params, registry, log: (msg) => logs.push(msg) });
    return owner ? withHttpRegistry(registry, run, owner.lease) : run();
  };
  return { registry, logs, register };
}

function registerLeasedRoute(
  registry: Registry,
  owner: ReturnType<typeof createLease>,
  params: RouteParams,
) {
  return withHttpRegistry(registry, () => registerHttp(params), owner.lease);
}

function registerStaticRoute(
  record: ReturnType<typeof createPluginRecord>,
  params: RouteParams & { path: string },
) {
  const harness = createTestPluginRegistry();
  harness.registry.plugins.push(record);
  harness.createApi(record, { config: {} }).registerHttpRoute({
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

function createLease() {
  const lease = createPluginRuntimeCapabilityLease("test owner");
  const cleanups = new Set<() => void>();
  const retain = vi.fn((cleanup: () => void) => {
    const tracked = () => {
      cleanups.delete(tracked);
      cleanup();
    };
    const release = lease.retain(tracked);
    cleanups.add(tracked);
    return release;
  });
  return { lease: { ...lease, retain }, cleanups, revoke: lease.revoke };
}

describe("registerPluginHttpRoute", () => {
  afterEach(resetPluginRuntimeStateForTest);

  it("transfers retry ingress while retired holders release their leases", () => {
    const previous = createEmptyPluginRegistry();
    const next = createEmptyPluginRegistry();
    const retired = createLease();
    const current = createLease();
    const unregisterOld = registerLeasedRoute(previous, retired, handoffRoute);
    const handoff = park(retired);
    expect(retired.cleanups.size).toBe(0);
    adoptHandoffs(previous, next);
    expect(previous.httpRoutes).toHaveLength(0);
    expect(next.httpRoutes).toHaveLength(1);
    const handler = vi.fn();
    registerLeasedRoute(next, current, { ...handoffRoute, handler });
    unregisterOld();
    handoff.release();
    expect(next.httpRoutes.map((entry) => entry.handler)).toEqual([handler]);
    current.revoke();
    expectReleased(next, current);
  });

  it.each([{ pluginId: "other" }, { source: "other-account" }, { auth: "gateway" as const }])(
    "preserves retry ingress when a successor changes ownership: %j",
    (changed) => {
      const registry = createEmptyPluginRegistry();
      const retired = createLease();
      registerLeasedRoute(registry, retired, handoffRoute);
      const handoff = park(retired);
      const placeholder = registry.httpRoutes[0];
      expectDenied(registerHttp, { ...handoffRoute, ...changed, registry });
      expect(registry.httpRoutes).toEqual([placeholder]);
      const next = createEmptyPluginRegistry();
      registerHttp({
        ...handoffRoute,
        ...changed,
        registry: next,
      });
      expect(() => adoptHandoffs(registry, next)).toThrow();
      expect(registry.httpRoutes).toEqual([placeholder]);
      handoff.release();
      expect(registry.httpRoutes).toHaveLength(0);
    },
  );

  it.each([false, true])(
    "keeps sibling handoffs across successor claims (registry swap: %s)",
    (swapRegistry) => {
      const registry = createEmptyPluginRegistry();
      const first = createLease();
      const second = createLease();
      for (const owner of [first, second]) {
        registerLeasedRoute(registry, owner, {
          ...sharedRoute,
          reuseExistingSameOwner: true,
        });
      }
      const firstHandoff = park(first);
      const secondHandoff = park(second);
      expect(registry.httpRoutes.map((entry) => entry.handoff)).toEqual([true]);
      const next = swapRegistry ? createEmptyPluginRegistry() : registry;
      const handler = vi.fn();
      const unregister = registerHttp({
        ...sharedRoute,
        registry: next,
        handler,
      });
      if (swapRegistry) {
        adoptHandoffs(registry, next);
      }
      firstHandoff.release();
      expect(next.httpRoutes.map((entry) => entry.handler)).toEqual([handler]);
      unregister();
      expect(next.httpRoutes.map((entry) => entry.handoff)).toEqual([true]);
      const secondHandler = vi.fn();
      const unregisterSecond = registerHttp({
        ...sharedRoute,
        registry: next,
        handler: secondHandler,
      });
      secondHandoff.release();
      expect(next.httpRoutes.map((entry) => entry.handler)).toEqual([secondHandler]);
      unregisterSecond();
      expect(next.httpRoutes).toHaveLength(0);
    },
  );

  it("marks gateway method dispatch entitlement only for plugins declaring the contract", () => {
    const pluginRegistry = createTestPluginRegistry();
    for (const record of [
      createPluginRecord({ id: "plain-http", source: "/plugins/plain-http/index.ts" }),
      createPluginRecord({
        id: "admin-http",
        source: "/plugins/admin-http/index.ts",
        contracts: { gatewayMethodDispatch: ["authenticated-request"] },
      }),
    ]) {
      pluginRegistry.registry.plugins.push(record);
      pluginRegistry.createApi(record, { config: {} }).registerHttpRoute({
        path: `/${record.id}`,
        auth: "gateway",
        handler: vi.fn(),
      });
    }
    expectRoutes(
      pluginRegistry.registry,
      { pluginId: "plain-http" },
      { pluginId: "admin-http", gatewayMethodDispatchAllowed: true },
    );
    expect(pluginRegistry.registry.httpRoutes[0]?.gatewayMethodDispatchAllowed).toBeUndefined();
  });

  it.each([false, true])("rejects a missing path (strict: %s)", (throwOnFailure) => {
    const { registry, logs, register } = routeHarness({
      path: "",
      accountId: "default",
    });
    const registerMissingPath = () => register({ throwOnFailure });

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
    const { registry, logs, register } = routeHarness(sharedRoute);
    const firstOwner = createLease();
    const secondOwner = createLease();
    const firstHandler = vi.fn();
    const unregisterFirst = register({ handler: firstHandler }, firstOwner);
    const unregisterSecond = register(
      {
        path: "/PLUGINS//SHARED/",
        reuseExistingSameOwner: true,
      },
      secondOwner,
    );

    expectRoutes(registry, { handler: firstHandler });
    expect(logs.at(-1)).toContain("reusing existing webhook path");

    const handoff = park(firstOwner);
    handoff.release();
    expectRoutes(registry, { handler: firstHandler });
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
      const owner = createLease();
      const unregister = registerLeasedRoute(registry, owner, {
        path: "/PLUGINS//SHARED/",
        pluginId: record.id,
        source: record.source,
        reuseExistingSameOwner: true,
      });

      (cleanup === "unregister" ? unregister : owner.revoke)();
      expectRoutes(registry, { handler });
      unregister();
      owner.revoke();
    },
  );

  it.each([
    { pluginId: "other", source: "shared-route" },
    { pluginId: "demo", source: "other-route" },
  ])("rejects route reuse by $pluginId/$source", ({ pluginId, source }) => {
    const { registry, register } = routeHarness(sharedRoute);
    const firstHandler = vi.fn();
    register({ handler: firstHandler });

    expectDenied(register, { pluginId, source, reuseExistingSameOwner: true }, "reuse");
    expectRoutes(registry, { handler: firstHandler });
  });

  it("finds a canonical exact alias behind an earlier prefix overlap", () => {
    const { registry, register } = routeHarness({
      pluginId: "sms",
      source: "sms-exact",
    });
    register({ path: "/webhooks", match: "prefix", source: "prefix" });
    register({ path: "/Webhooks/SMS/" });
    register({
      path: "/webhooks/sms",
      replaceExisting: true,
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

    expectDenied(
      registerHttp,
      {
        path: "/mattermost/interactions/default",
        registry,
        pluginId: "mattermost",
        source: "mattermost-interactions",
        replaceExisting: true,
      },
      "replacement",
    );

    expectRoutes(registry, {
      handler: slashHandler,
      pluginId: "mattermost",
      source: "/plugins/mattermost/index.js",
    });
  });

  it.each([false, true])("preserves shipped replacement (anonymous: %s)", (anonymous) => {
    const nextSource = anonymous ? "new-anonymous" : undefined;
    const { registry, logs, register } = routeHarness({
      path: anonymous ? "/plugins/demo" : "/plugins/synology",
      accountId: anonymous ? undefined : "default",
      pluginId: anonymous ? undefined : "synology-chat",
      source: anonymous ? "old-anonymous" : undefined,
    });
    const secondHandler = vi.fn();
    const unregisterFirst = register();
    const unregisterSecond = register({
      replaceExisting: true,
      handler: secondHandler,
      source: nextSource,
      throwOnFailure: anonymous,
    });
    expectRoutes(registry, { handler: secondHandler, source: nextSource });
    if (!anonymous) {
      expect(logs).toContain(
        'plugin: replacing stale webhook path /plugins/synology (exact) for account "default" (synology-chat)',
      );
    }
    unregisterFirst();
    expectRoutes(registry, { handler: secondHandler });
    unregisterSecond();
    expect(registry.httpRoutes).toHaveLength(0);
  });

  it.each([
    ["source-less to sourced", "demo", undefined, "demo", "demo-webhook"],
    ["sourced to source-less", "demo", "demo-webhook", "demo", undefined],
    ["different plugin", "demo-a", undefined, "demo-b", undefined],
    ["owned to anonymous", "demo-a", undefined, undefined, undefined],
    ["anonymous to owned", undefined, undefined, "demo-a", undefined],
  ])("rejects %s replacement", (_name, oldId, oldSource, pluginId, source) => {
    const { registry, register } = routeHarness({ path: "/plugins/demo" });
    const existing = { pluginId: oldId, source: oldSource };
    const existingHandler = vi.fn();
    register({
      handler: existingHandler,
      ...existing,
    });

    expectDenied(register, { pluginId, source, replaceExisting: true }, "replacement");
    expectRoutes(registry, { handler: existingHandler, ...existing });
  });

  it("finds a mixed-auth overlap behind an earlier same-auth prefix", () => {
    const { registry, register } = routeHarness();
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

    expectDenied(
      register,
      {
        path: "/PLUGIN/secure/report/",
        match: "exact",
        pluginId: "demo-plugin",
      },
      "overlap",
    );
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
        const resource = withHttpRegistry(
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
              registerHttp({
                path: "/retired-webhook",
                handler: () => true,
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
    { name: "HTTP", withScope: withHttpRegistry },
    { name: "Gateway", withScope: withGatewayRegistry },
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
          registerHttp({
            path: "/adopted-webhook",
            handler,
          }),
        );
        expect(currentRegistry.httpRoutes).toEqual([
          {
            path: "/adopted-webhook",
            auth: "plugin",
            match: "exact",
            handler: expect.any(Function),
          },
        ]);
        unregister();
      } finally {
        resource.emitDestroy();
        await instance.dispose();
      }
    },
  );

  it("tracks exact scoped route cleanup without removing unrelated routes", () => {
    const registry = createEmptyPluginRegistry();
    const owner = createLease();
    registerHttp({ path: "/unrelated-webhook", registry });

    const cleanup = withHttpRegistry(
      registry,
      () => [
        registerHttp({ path: "/leased-anonymous-webhook" }),
        registerHttp({
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
    ["anonymous", undefined, false, false],
    ["plugin-owned", "demo", false, false],
    ["explicit registry", undefined, true, false],
    ["nested scope", undefined, false, true],
  ] as const)(
    "rejects late %s route registration after its async service lease expires",
    async (_name, pluginId, explicitRegistry, nestedScope) => {
      const registry = createEmptyPluginRegistry();
      const owner = createLease();
      const { promise: continuation, resolve: releaseContinuation } = Promise.withResolvers<void>();

      const lateRegistration = withHttpRegistry(
        registry,
        async () => {
          await continuation;
          const register = () =>
            registerHttp({
              path: "/late-webhook",
              ...(pluginId ? { pluginId } : {}),
              ...(explicitRegistry ? { registry } : {}),
            });
          if (nestedScope) {
            withHttpRegistry(registry, register);
          } else {
            register();
          }
        },
        owner.lease,
      );

      owner.revoke();
      releaseContinuation();

      await expect(lateRegistration).rejects.toThrow(
        "plugin runtime HTTP route lease is no longer active",
      );
      expectReleased(registry, owner);
    },
  );

  it.each([
    { name: "a different nested registry", childLease: false, expiredOwner: "parent" },
    { name: "a supplied replacement lease", childLease: true, expiredOwner: "parent" },
    { name: "an expired child under an active parent", childLease: true, expiredOwner: "child" },
  ])("rejects expired ambient route authority through $name", ({ childLease, expiredOwner }) => {
    const parentRegistry = createEmptyPluginRegistry();
    const nestedRegistry = createEmptyPluginRegistry();
    const parent = createLease();
    const child = createLease();
    (expiredOwner === "parent" ? parent : child).revoke();

    expect(() =>
      withHttpRegistry(
        parentRegistry,
        () =>
          withHttpRegistry(
            nestedRegistry,
            () => registerHttp({ path: "/independent-webhook" }),
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
    const parent = createLease();
    const child = createLease();

    const unregister = withHttpRegistry(
      parentRegistry,
      () =>
        registerLeasedRoute(nestedRegistry, child, {
          path: "/nested-webhook",
        }),
      parent.lease,
    );

    expect(parent.cleanups.size).toBe(1);
    expect(child.cleanups.size).toBe(1);
    parent.revoke();

    expectReleased(nestedRegistry, parent, child);
    unregister();
    child.revoke();
  });
});
