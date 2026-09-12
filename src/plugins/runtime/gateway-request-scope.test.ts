// Gateway request scope tests cover request-local plugin runtime context propagation.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPluginMetadataSnapshotFixture } from "../plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../registry-empty.js";
import {
  requireActivePluginRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../runtime.js";
import type { PluginRuntimeGatewayRequestScope } from "./gateway-request-scope.test-fixtures.js";

const TEST_SCOPE: PluginRuntimeGatewayRequestScope = {
  context: {} as PluginRuntimeGatewayRequestScope["context"],
  isWebchatConnect: (() => false) as PluginRuntimeGatewayRequestScope["isWebchatConnect"],
};

describe("gateway request scope", () => {
  afterEach(() => {
    vi.doUnmock("../current-plugin-metadata-snapshot.js");
    vi.resetModules();
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

  it("does not import the plugin metadata control plane", async () => {
    vi.resetModules();
    vi.doMock("../current-plugin-metadata-snapshot.js", () => {
      throw new Error("gateway request scope must remain lightweight");
    });

    const runtimeScope = await importGatewayRequestScopeModule();

    expect(runtimeScope.withPluginRuntimeGatewayRequestScope).toBeTypeOf("function");
  });

  it("reuses AsyncLocalStorage across reloaded module instances", async () => {
    const first = await importGatewayRequestScopeModule();

    await first.withPluginRuntimeGatewayRequestScope(TEST_SCOPE, async () => {
      vi.resetModules();
      const second = await importGatewayRequestScopeModule();
      expectGatewayScope(second, TEST_SCOPE);
    });
  });

  it("preserves host-issued Gateway resolver bindings across reloaded modules", async () => {
    const first = await importGatewayRequestScopeModule();
    const owner = {};
    const resolver = vi.fn(() => TEST_SCOPE.context!);
    first.bindGatewayContextResolver(owner, resolver);

    vi.resetModules();
    const second = await importGatewayRequestScopeModule();

    expect(second.getGatewayContextResolver(owner)).toBe(resolver);
    expect(second.getSharedGatewayContextResolver([owner])?.()).toBe(TEST_SCOPE.context);
    expect(second.getGatewayContextResolver({})).toBeUndefined();

    second.clearGatewayContextResolver(owner);
    expect(first.getGatewayContextResolver(owner)).toBeUndefined();
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
    const registry = createEmptyPluginRegistry();
    const metadataSnapshot = createPluginMetadataSnapshotFixture({
      plugins: [{ id: "fixture", providers: ["fixture-provider"] }],
    });
    await withTestGatewayScope(async (runtimeScope) => {
      await generation.withPluginRuntimeGenerationScope(
        { metadataSnapshot, pluginRegistry: registry },
        async () => {
          const original = runtimeScope.getPluginRuntimeGatewayRequestScope();
          expect(original?.declaredProviderOwners).toBe(metadataSnapshot.declaredProviderOwners);
          await generation.runOutsidePluginRuntimeGenerationScope(async () => {
            await Promise.resolve();
            expect(generation.getPluginRuntimeGenerationRegistry()).toBeUndefined();
            expectGatewayScope(runtimeScope, {
              ...TEST_SCOPE,
              pluginRegistry: undefined,
              declaredProviderOwners: undefined,
            });
          });
          expect(runtimeScope.getPluginRuntimeGatewayRequestScope()).toBe(original);
          expect(generation.getPluginRuntimeGenerationRegistry()).toBe(registry);
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
