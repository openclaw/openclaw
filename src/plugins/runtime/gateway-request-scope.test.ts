import assert from "node:assert/strict";
import { AsyncLocalStorage, AsyncResource } from "node:async_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import { expectCollected, expectLiveObjects } from "../../test-utils/retention.js";
import { createPluginMetadataSnapshotFixture } from "../plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../registry-empty.js";
import { markPluginRegistryRetired } from "../registry-lifecycle.js";
import {
  requireActivePluginRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../runtime.js";
import { prepareGatewayContextBindingOwner } from "./gateway-context-binding-owner.js";
import * as runtimeScope from "./gateway-request-scope.js";
import type { PluginRuntimeGatewayRequestScope } from "./gateway-request-scope.test-fixtures.js";

const TEST_SCOPE: PluginRuntimeGatewayRequestScope = {
  context: {} as PluginRuntimeGatewayRequestScope["context"],
  isWebchatConnect: (() => false) as PluginRuntimeGatewayRequestScope["isWebchatConnect"],
};

function serviceRegistry(service: { id: string; start(): void }) {
  const registry = createEmptyPluginRegistry();
  const { id } = service;
  registry.services.push({ id, pluginId: id, source: id, origin: "config", service });
  return registry;
}

function expectExpiredRegistry() {
  expect(requireActivePluginRegistry).toThrow("Plugin registry scope is no longer available");
}

function serviceType(id: string, references: WeakRef<object>[]) {
  return class {
    id = id;
    constructor() {
      references.push(new WeakRef(this));
    }
    start() {}
  };
}

describe("gateway request scope", () => {
  afterEach(resetPluginRuntimeStateForTest);
  async function withTestGatewayScope<T>(run: () => Promise<T>) {
    return await runtimeScope.withPluginRuntimeGatewayRequestScope(TEST_SCOPE, run);
  }

  function expectGatewayScope(expected: PluginRuntimeGatewayRequestScope) {
    expect(runtimeScope.getPluginRuntimeGatewayRequestScope()).toEqual(expected);
  }

  it("enters a repeated Gateway scope once in the same store", () => {
    const entries = vi.spyOn(AsyncLocalStorage.prototype, "enterWith");
    const runs = vi.spyOn(AsyncLocalStorage.prototype, "run");
    try {
      runtimeScope.withPluginRuntimeGatewayRequestScope(TEST_SCOPE, () =>
        runtimeScope.withPluginRuntimeGatewayRequestScope(TEST_SCOPE, () =>
          expect(runtimeScope.getPluginRuntimeGatewayRequestScope()).toBe(TEST_SCOPE),
        ),
      );
      expect(entries).toHaveBeenCalledTimes(1);
      expect(runs).not.toHaveBeenCalled();
    } finally {
      entries.mockRestore();
      runs.mockRestore();
    }
    expect(runtimeScope.getPluginRuntimeGatewayRequestScope()).toBeUndefined();
  });

  it("keeps Gateway routing bound to the exact owner across wrappers and cleanup", async () => {
    const owner = Object.freeze(prepareGatewayContextBindingOwner({}));
    const resolver = vi.fn(() => TEST_SCOPE.context!);
    const copiedPreparation = Object.defineProperties({}, Object.getOwnPropertyDescriptors(owner));
    expect(() => runtimeScope.bindGatewayContextResolver(copiedPreparation, resolver)).toThrow();
    expect(runtimeScope.clearGatewayContextResolver(copiedPreparation)).toBe(false);
    runtimeScope.bindGatewayContextResolver(owner, resolver);
    const shared = runtimeScope.getSharedGatewayContextResolver([owner]);
    const forged = {};
    const reminted = {};
    const forgedReader = vi.fn(() => resolver);
    for (const key of Object.getOwnPropertySymbols(owner)) {
      const value = Object.getOwnPropertyDescriptor(owner, key)?.value;
      const Issuer = value.constructor;
      if (typeof Issuer === "function" && typeof Issuer.set === "function") {
        const minted = new Issuer(reminted);
        Issuer.set(minted, resolver);
        Object.defineProperty(reminted, key, { value: minted });
      }
      Object.defineProperty(forged, key, {
        value: Object.assign(Object.create(Object.getPrototypeOf(value)), {
          owns: forgedReader,
          get: forgedReader,
          read: forgedReader,
        }),
      });
    }

    expect(runtimeScope.getGatewayContextResolver(owner)).toBe(resolver);
    expect(shared?.()).toBe(TEST_SCOPE.context);
    expect(runtimeScope.getCanonicalGatewayContextResolver(shared!)).toBe(resolver);
    for (const copy of [
      { ...owner },
      Object.create(owner),
      Object.defineProperties({}, Object.getOwnPropertyDescriptors(owner)),
      structuredClone(owner),
      forged,
      reminted,
    ]) {
      expect(runtimeScope.getGatewayContextResolver(copy)).toBeUndefined();
    }
    expect(forgedReader).not.toHaveBeenCalled();

    expect(runtimeScope.clearGatewayContextResolver(owner)).toBe(true);
    expect(runtimeScope.clearGatewayContextResolver(owner)).toBe(false);
    expect(runtimeScope.getGatewayContextResolver(owner)).toBeUndefined();
    runtimeScope.bindGatewayContextResolver(owner, resolver);
    expect(runtimeScope.getGatewayContextResolver(owner)).toBe(resolver);
  });

  it("drops generation ownership for re-admission and restores the caller afterward", async () => {
    const generation = await import("./generation-scope.js");
    const { getCurrentPluginMetadataSnapshot } =
      await import("../current-plugin-metadata-snapshot.js");
    const { bindPluginMetadataSnapshotCache, createPluginCache, getScopedPluginCache } =
      await import("../plugin-cache.js");
    const registry = createEmptyPluginRegistry();
    const metadataSnapshot = createPluginMetadataSnapshotFixture({
      plugins: [{ id: "fixture", providers: ["fixture-provider"] }],
    });
    const cache = createPluginCache();
    bindPluginMetadataSnapshotCache(metadataSnapshot, cache);
    const outsideMetadata = getCurrentPluginMetadataSnapshot();
    await withTestGatewayScope(async () => {
      await generation.withPluginRuntimeGenerationScope(
        { metadataSnapshot, pluginRegistry: registry },
        async () => {
          const original = runtimeScope.getPluginRuntimeGatewayRequestScope();
          expect(original?.declaredProviderOwners).toBe(metadataSnapshot.declaredProviderOwners);
          expect(getCurrentPluginMetadataSnapshot()).toBe(metadataSnapshot);
          expect(getScopedPluginCache()).toBe(cache);
          await generation.runOutsidePluginRuntimeGenerationScope(async () => {
            await Promise.resolve();
            expect(generation.getPluginRuntimeGenerationRegistry()).toBeUndefined();
            expect(getCurrentPluginMetadataSnapshot()).toBe(outsideMetadata);
            expect(getScopedPluginCache()).toBeUndefined();
            expectGatewayScope({
              ...TEST_SCOPE,
              pluginRegistry: undefined,
              declaredProviderOwners: undefined,
            });
          });
          expect(runtimeScope.getPluginRuntimeGatewayRequestScope()).toBe(original);
          expect(generation.getPluginRuntimeGenerationRegistry()).toBe(registry);
          expect(getCurrentPluginMetadataSnapshot()).toBe(metadataSnapshot);
          expect(getScopedPluginCache()).toBe(cache);
        },
      );
    });
  });

  it("keeps caller identity and independent mutable registry fields in copied scopes", async () => {
    const first = createEmptyPluginRegistry();
    const second = createEmptyPluginRegistry();
    const declaredProviderOwners = new Map([["fixture", new Set(["fixture-owner"])]]);
    const marker = Symbol("request fact");
    const hidden = Symbol("hidden fact");
    const caller = {
      ...TEST_SCOPE,
      pluginRegistry: first,
      declaredProviderOwners,
      [marker]: "caller",
    };
    Object.defineProperties(caller, {
      hidden: { get: () => assert.fail("non-enumerable field read") },
      [hidden]: { get: () => assert.fail("non-enumerable symbol read") },
    });
    runtimeScope.withPluginRuntimeGatewayRequestScope(caller, () => {
      expect(runtimeScope.getPluginRuntimeGatewayRequestScope()).toBe(caller);
      runtimeScope.withPluginRuntimePluginScope({ pluginId: "fixture" }, () => {
        const child = runtimeScope.getPluginRuntimeGatewayRequestScope()!;
        expect(child).not.toBe(caller);
        expect(Reflect.get(child, marker)).toBe("caller");
        expect(Object.hasOwn(child, hidden)).toBe(false);
        expect(Object.hasOwn(child, "hidden")).toBe(false);
        const copied = { ...child };
        child.pluginRegistry = second;
        expect(requireActivePluginRegistry()).toBe(second);
        expect(caller.pluginRegistry).toBe(first);
        expect(copied.pluginRegistry).toBe(first);
        runtimeScope.withPluginRuntimeGatewayRequestScope(copied, () => {
          expect(runtimeScope.getPluginRuntimeGatewayRequestScope()).toBe(copied);
          runtimeScope.withPluginRuntimeRegistryScope(first, () => {
            expect(runtimeScope.getPluginRuntimeGatewayRequestScope()?.declaredProviderOwners).toBe(
              declaredProviderOwners,
            );
          });
        });
        delete child.pluginRegistry;
        expect(Object.hasOwn(child, "pluginRegistry")).toBe(false);
      });
      expect(runtimeScope.getPluginRuntimeGatewayRequestScope()).toBe(caller);
    });
  });

  it("keeps an empty prepared selection through collection instead of selecting active plugins", async () => {
    const generation = await import("./generation-scope.js");
    const references: WeakRef<object>[] = [];
    const ActiveService = serviceType("active-service", references);
    const active = serviceRegistry(new ActiveService());
    setActivePluginRegistry(active);
    await generation.withPluginRuntimeGenerationScope(
      { metadataSnapshot: createPluginMetadataSnapshotFixture() },
      async () => {
        await expectLiveObjects(references, 1);
        const selected = generation.getPluginRuntimeGenerationRegistry();
        expect(selected).toBeDefined();
        expect(requireActivePluginRegistry()).toBe(selected);
        expect(selected?.services).toEqual([]);
      },
    );
  });

  it.each(["fulfilled", "rejected", "thenable"] as const)(
    "owns the registry only until a direct async callback settles: %s",
    async (outcome) => {
      const references: WeakRef<object>[] = [];
      const PendingService = serviceType("pending-scope", references);
      const gate = createDeferredCore();
      const failure = new Error("scope callback failed");
      const resources: AsyncResource[] = [];
      let thenReads = 0;
      let thenCalls = 0;
      const run = async () => {
        const resource = new AsyncResource("pending-plugin-scope");
        resources.push(resource);
        await gate.promise;
        expect(requireActivePluginRegistry().services[0]?.id).toBe("pending-scope");
        if (outcome === "rejected") {
          throw failure;
        }
        return resource;
      };
      const pending = (() => {
        const registry = serviceRegistry(new PendingService());
        return runtimeScope.withPluginRuntimeRegistryScope(registry, () => {
          if (outcome !== "thenable") {
            return run();
          }
          return {
            // oxlint-disable-next-line unicorn/no-thenable -- Verify one-shot foreign thenable assimilation.
            get then() {
              thenReads += 1;
              return (
                resolve: (value: AsyncResource) => void,
                reject: (error: unknown) => void,
              ) => {
                thenCalls += 1;
                void run().then(resolve, reject);
              };
            },
          };
        });
      })();
      try {
        await expectLiveObjects(references, 1);
        gate.resolve();
        if (outcome === "rejected") {
          await expect(pending).rejects.toBe(failure);
        } else {
          expect(await pending).toBe(resources[0]);
        }
        const expectedThenAccesses = outcome === "thenable" ? 1 : 0;
        expect([thenReads, thenCalls]).toEqual([expectedThenAccesses, expectedThenAccesses]);
        await expectCollected(...references);
        const resource = resources[0];
        assert.ok(resource);
        resource.runInAsyncScope(expectExpiredRegistry);
        // Keep the settled completion reachable through the post-settlement collection.
        expect(pending).toBeDefined();
      } finally {
        gate.resolve();
        await Promise.allSettled([pending]);
        for (const resource of resources) {
          resource.emitDestroy();
        }
      }
    },
  );

  it.each(["registry", "resolver-copy", "plugin-copy"] as const)(
    "releases retired registries inherited by native async resources through %s",
    async (copy) => {
      const references: WeakRef<object>[] = [];
      const RetainedService = serviceType("runtime-scope-retention", references);
      const resources = Array.from({ length: 4 }, () => {
        const registry = serviceRegistry(new RetainedService());
        const capture = () => new AsyncResource("plugin-runtime-retention");
        const resource = runtimeScope.withPluginRuntimeRegistryScope(registry, () =>
          copy === "resolver-copy"
            ? runtimeScope.withPluginRuntimeGatewayContextResolver(undefined, capture)
            : copy === "plugin-copy"
              ? runtimeScope.withPluginRuntimePluginScope({ pluginId: "fixture" }, capture)
              : capture(),
        );
        markPluginRegistryRetired(registry);
        return resource;
      });
      const active = createEmptyPluginRegistry();
      const replacement = createEmptyPluginRegistry();
      setActivePluginRegistry(active);
      try {
        await expectCollected(...references);
        for (const resource of resources) {
          resource.runInAsyncScope(() => {
            expectExpiredRegistry();
            runtimeScope.withPluginRuntimeGatewayContextResolver(undefined, expectExpiredRegistry);
            runtimeScope.withPluginRuntimeRegistryScope(replacement, () => {
              expect(requireActivePluginRegistry()).toBe(replacement);
              expect(
                runtimeScope.getPluginRuntimeGatewayRequestScope()?.declaredProviderOwners,
              ).toBeUndefined();
            });
            runtimeScope.runOutsidePluginRuntimeRegistryScope(() => {
              expect(requireActivePluginRegistry()).toBe(active);
            });
          });
        }
      } finally {
        for (const resource of resources) {
          resource.emitDestroy();
        }
      }
    },
  );

  it("isolates combined plugin identities across concurrent registry scopes", async () => {
    const parent = {
      ...TEST_SCOPE,
      pluginId: "parent",
      pluginSource: "parent-source",
      pluginOrigin: "bundled" as const,
      pluginTrustedOfficialInstall: true,
    };
    const registries = [createEmptyPluginRegistry(), createEmptyPluginRegistry()];
    await runtimeScope.withPluginRuntimeGatewayRequestScope(parent, async () => {
      await Promise.all(
        registries.map((registry, index) =>
          runtimeScope.withPluginRuntimePluginScope(
            { pluginId: `child-${index}` },
            async () => {
              await Promise.resolve();
              const scoped = runtimeScope.getPluginRuntimeGatewayRequestScope()!;
              expect(scoped).toEqual({
                ...TEST_SCOPE,
                pluginId: `child-${index}`,
                pluginRegistry: registry,
                declaredProviderOwners: undefined,
              });
              expect(Object.hasOwn(scoped, "pluginSource")).toBe(false);
              expect(Object.hasOwn(scoped, "pluginOrigin")).toBe(false);
              expect(Object.hasOwn(scoped, "pluginTrustedOfficialInstall")).toBe(false);
              scoped.pluginSource = "child-only";
              expect(parent.pluginSource).toBe("parent-source");
              expect(requireActivePluginRegistry()).toBe(registry);
            },
            registry,
          ),
        ),
      );
      expectGatewayScope(parent);
    });
  });
});
