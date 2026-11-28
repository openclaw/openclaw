import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, expect, it, vi } from "vitest";
import { createPluginCache, resetPluginCache, withPluginCache } from "./plugin-cache.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";

async function loadPolicy(scope: string, load: () => unknown) {
  // mock-isolation: Control artifact results without executing bundled provider modules.
  vi.doMock("./public-surface-loader.js", () => ({
    loadBundledPluginPublicArtifactModuleFromCandidatesSync: load,
  }));
  const policy = await importFreshModule<typeof import("./provider-policy-surface.js")>(
    import.meta.url,
    `./provider-policy-surface.js?scope=${scope}`,
  );
  return policy.resolveDirectBundledProviderPolicySurface;
}

afterEach(() => {
  resetPluginCache();
  vi.doUnmock("./bundled-dir.js");
  vi.doUnmock("./manifest-registry.js");
  vi.doUnmock("./public-surface-loader.js");
  vi.resetModules();
});

it("loads the provider-id artifact without evaluating the manifest registry", async () => {
  const manifestRegistryModuleFactory = vi.fn(() => {
    throw new Error("unexpected manifest registry import");
  });
  const policy = {
    deprecatedProfileIds: ["demo:legacy"],
    resolveModelRoutes: vi.fn(),
    resolveServiceTiers: vi.fn(() => ["default"]),
    isResponseModelEquivalent: vi.fn(),
    projectRealtimeVoicePublicProjection: vi.fn(),
  };
  const load = vi.fn(() => policy);

  vi.doMock("./bundled-dir.js", () => ({
    resolveBundledPluginsDir: () => "/tmp/bundled-plugins",
  }));
  vi.doMock("./manifest-registry.js", manifestRegistryModuleFactory);
  const resolve = await loadPolicy("direct-provider-policy", load);
  expect(resolve("openai")).toEqual(policy);
  expect(load).toHaveBeenCalledWith({
    dirName: "openai",
    artifactCandidates: ["provider-policy-api.js"],
  });
  expect(manifestRegistryModuleFactory).not.toHaveBeenCalled();
});

it.each([false, true])(
  "resolves candidate locations once per generation (missing=%s)",
  async (missing) => {
    const normalizeModelCatalogId = ({ modelId }: { modelId: string }) => modelId.toLowerCase();
    const loadCandidates = vi.fn(() => (missing ? null : { normalizeModelCatalogId }));
    const resolve = await loadPolicy(`generation-${missing}`, loadCandidates);
    const checkPolicy = () => {
      expect(resolve("fixture-provider")).toEqual(missing ? null : { normalizeModelCatalogId });
    };

    checkPolicy();
    checkPolicy();
    expect(loadCandidates).toHaveBeenCalledTimes(1);

    const retained = createPluginCache();
    withPluginCache(retained, checkPolicy);
    expect(loadCandidates).toHaveBeenCalledTimes(2);
    clearPluginMetadataLifecycleCaches();
    withPluginCache(retained, checkPolicy);
    expect(loadCandidates).toHaveBeenCalledTimes(2);
    checkPolicy();
    checkPolicy();
    expect(loadCandidates).toHaveBeenCalledTimes(3);
  },
);

it("propagates errors from a present provider artifact", async () => {
  const error = new Error("Provider artifact is outside its boundary root");
  const resolve = await loadPolicy("invalid-provider-policy", () => {
    throw error;
  });
  expect(() => resolve("custom-provider")).toThrow(error);
});
