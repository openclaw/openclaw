import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPluginCache, resetPluginCache, withPluginCache } from "./plugin-cache.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";

const importPolicy = (scope: string) =>
  importFreshModule<typeof import("./provider-policy-surface.js")>(
    import.meta.url,
    `./provider-policy-surface.js?scope=${scope}`,
  );

describe("direct provider policy surface", () => {
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
    const loadBundledPluginPublicArtifactModuleFromCandidatesSync = vi.fn(() => policy);

    vi.doMock("./bundled-dir.js", () => ({
      resolveBundledPluginsDir: () => "/tmp/bundled-plugins",
    }));
    vi.doMock("./manifest-registry.js", manifestRegistryModuleFactory);
    vi.doMock("./public-surface-loader.js", () => ({
      loadBundledPluginPublicArtifactModuleFromCandidatesSync,
    }));

    const { resolveDirectBundledProviderPolicySurface } =
      await importPolicy("direct-provider-policy");

    const surface = resolveDirectBundledProviderPolicySurface("openai");

    expect(surface).toEqual(policy);
    expect(loadBundledPluginPublicArtifactModuleFromCandidatesSync).toHaveBeenCalledWith({
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
      vi.doMock("./public-surface-loader.js", () => ({
        loadBundledPluginPublicArtifactModuleFromCandidatesSync: loadCandidates,
      }));
      const { resolveDirectBundledProviderPolicySurface: resolve } = await importPolicy(
        `generation-${missing}`,
      );
      const checkPolicy = () => {
        const surface = resolve("fixture-provider");
        if (missing) {
          expect(surface).toBeNull();
        }
        expect(
          surface?.normalizeModelCatalogId?.({ provider: "fixture-provider", modelId: "MODEL" }),
        ).toBe(missing ? undefined : "model");
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
    vi.doMock("./public-surface-loader.js", () => ({
      loadBundledPluginPublicArtifactModuleFromCandidatesSync: () => {
        throw error;
      },
    }));
    const { resolveDirectBundledProviderPolicySurface } =
      await importPolicy("invalid-provider-policy");

    expect(() => resolveDirectBundledProviderPolicySurface("custom-provider")).toThrow(error);
  });
});
