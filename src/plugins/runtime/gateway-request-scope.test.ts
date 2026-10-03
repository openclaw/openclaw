// Gateway request scope tests cover request-local plugin runtime context propagation.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPluginMetadataSnapshotFixture } from "../plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../registry-empty.js";
import {
  requireActivePluginRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../runtime.js";
import { prepareGatewayContextBindingOwner } from "./gateway-context-binding-owner.js";
import type { PluginRuntimeGatewayRequestScope } from "./gateway-request-scope.test-fixtures.js";

const TEST_SCOPE: PluginRuntimeGatewayRequestScope = {
  context: {} as PluginRuntimeGatewayRequestScope["context"],
  isWebchatConnect: (() => false) as PluginRuntimeGatewayRequestScope["isWebchatConnect"],
};

describe("gateway request scope", () => {
  afterEach(() => {
    resetPluginRuntimeStateForTest();
  });
  async function importGatewayRequestScopeModule() {
    return await import("./gateway-request-scope.js");
  }

  async function withTestGatewayScope<T>(
    run: (runtimeScope: Awaited<ReturnType<typeof importGatewayRequestScopeModule>>) => Promise<T>,
  ) {
    const runtimeScope = await importGatewayRequestScopeModule();
    return await runtimeScope.withPluginRuntimeGatewayRequestScope(TEST_SCOPE, async () => {
      return await run(runtimeScope);
    });
  }

  function expectGatewayScope(
    runtimeScope: Awaited<ReturnType<typeof importGatewayRequestScopeModule>>,
    expected: PluginRuntimeGatewayRequestScope,
  ) {
    expect(runtimeScope.getPluginRuntimeGatewayRequestScope()).toEqual(expected);
  }

  async function expectPluginIdScopedGatewayScope(pluginId: string) {
    await withPluginIdScope(pluginId, async (runtimeScope) => {
      expectGatewayScope(runtimeScope, {
        ...TEST_SCOPE,
        pluginId,
      });
    });
  }

  async function withPluginIdScope(
    pluginId: string,
    run: (
      runtimeScope: Awaited<ReturnType<typeof importGatewayRequestScopeModule>>,
    ) => Promise<void>,
  ) {
    await withTestGatewayScope(async (runtimeScope) => {
      await runtimeScope.withPluginRuntimePluginScope({ pluginId }, async () => {
        await run(runtimeScope);
      });
    });
  }

  it("preserves Gateway scope across async work and restores the caller", async () => {
    const runtimeScope = await importGatewayRequestScopeModule();

    expect(runtimeScope.getPluginRuntimeGatewayRequestScope()).toBeUndefined();
    await runtimeScope.withPluginRuntimeGatewayRequestScope(TEST_SCOPE, async () => {
      await Promise.resolve();
      expectGatewayScope(runtimeScope, TEST_SCOPE);
    });
    expect(runtimeScope.getPluginRuntimeGatewayRequestScope()).toBeUndefined();
  });

  it("keeps Gateway routing bound to the exact owner across wrappers and cleanup", async () => {
    const runtimeScope = await importGatewayRequestScopeModule();
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

  it("retains terminal Gateway lifetime independently of another resolver", async () => {
    const runtimeScope = await importGatewayRequestScopeModule();
    const first = () => TEST_SCOPE.context;
    const second = () => TEST_SCOPE.context;
    const lifetime = runtimeScope.getGatewayContextLifetime(first);
    lifetime.abort();

    expect(runtimeScope.getGatewayContextLifetime(first)).toBe(lifetime);
    expect(runtimeScope.getGatewayContextLifetime(first).signal.aborted).toBe(true);
    expect(runtimeScope.getGatewayContextLifetime(second).signal.aborted).toBe(false);
  });

  it("rejects cyclic Gateway ownership without invoking execution resolvers", async () => {
    const scope = await importGatewayRequestScopeModule();
    const first = vi.fn(() => TEST_SCOPE.context!);
    const second = vi.fn(() => TEST_SCOPE.context!);
    const root = vi.fn(() => TEST_SCOPE.context!);
    const owner = {};
    scope.bindGatewayContextResolver(owner, first);
    scope.bindGatewayContextResolver(first, second);
    scope.bindGatewayContextResolver(second, first);

    expect(scope.hasGatewayContextOwner(owner, root)).toBe(false);
    expect(scope.hasGatewayContextOwner(owner, second)).toBe(false);
    expect(scope.hasGatewayContextOwner({}, root)).toBe(false);
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
    expect(root).not.toHaveBeenCalled();
  });

  it("attaches plugin id to the active scope", async () => {
    await expectPluginIdScopedGatewayScope("voice-call");
  });

  it("resolves the owned registry while preserving gateway request facts", async () => {
    const activeRegistry = createEmptyPluginRegistry();
    const requestRegistry = createEmptyPluginRegistry();
    setActivePluginRegistry(activeRegistry);

    await withTestGatewayScope(async (runtimeScope) => {
      await runtimeScope.withPluginRuntimeRegistryScope(requestRegistry, async () => {
        expect(requireActivePluginRegistry()).toBe(requestRegistry);
        expectGatewayScope(runtimeScope, { ...TEST_SCOPE, pluginRegistry: requestRegistry });
      });
      expect(requireActivePluginRegistry()).toBe(activeRegistry);
    });
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
    await withTestGatewayScope(async (runtimeScope) => {
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
            expectGatewayScope(runtimeScope, {
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

  it("isolates combined plugin identities across concurrent registry scopes", async () => {
    const runtimeScope = await importGatewayRequestScopeModule();
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
      expectGatewayScope(runtimeScope, parent);
    });
  });
});
