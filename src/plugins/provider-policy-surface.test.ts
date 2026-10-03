import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPluginCache, resetPluginCache, withPluginCache } from "./plugin-cache.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";

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
    const resolveModelRoutes = vi.fn();
    const isResponseModelEquivalent = vi.fn();
    const projectRealtimeVoicePublicProjection = vi.fn();
    const loadBundledPluginPublicArtifactModuleFromCandidatesSync = vi.fn(() => ({
      deprecatedProfileIds: ["demo:legacy"],
      resolveModelRoutes,
      isResponseModelEquivalent,
      projectRealtimeVoicePublicProjection,
    }));

    vi.doMock("./bundled-dir.js", () => ({
      resolveBundledPluginsDir: () => "/tmp/bundled-plugins",
    }));
    vi.doMock("./manifest-registry.js", manifestRegistryModuleFactory);
    vi.doMock("./public-surface-loader.js", () => ({
      loadBundledPluginPublicArtifactModuleFromCandidatesSync,
    }));

    const { resolveDirectBundledProviderPolicySurface } = await importFreshModule<
      typeof import("./provider-policy-surface.js")
    >(import.meta.url, "./provider-policy-surface.js?scope=direct-provider-policy");

    const surface = resolveDirectBundledProviderPolicySurface("openai");

    expect(surface?.resolveModelRoutes).toBe(resolveModelRoutes);
    expect(surface?.isResponseModelEquivalent).toBe(isResponseModelEquivalent);
    expect(surface?.projectRealtimeVoicePublicProjection).toBe(
      projectRealtimeVoicePublicProjection,
    );
    expect(surface?.deprecatedProfileIds).toEqual(["demo:legacy"]);
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
      const { resolveDirectBundledProviderPolicySurface: resolve } = await importFreshModule<
        typeof import("./provider-policy-surface.js")
      >(import.meta.url, `./provider-policy-surface.js?scope=generation-${missing}`);
      const checkPolicy = () => {
        const surface = resolve("fixture-provider");
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

  it("returns no policy for a provider without a bundled artifact", async () => {
    vi.doMock("./public-surface-loader.js", () => ({
      loadBundledPluginPublicArtifactModuleFromCandidatesSync: () => null,
    }));
    const { resolveDirectBundledProviderPolicySurface } = await importFreshModule<
      typeof import("./provider-policy-surface.js")
    >(import.meta.url, "./provider-policy-surface.js?scope=missing-provider-policy");

    expect(resolveDirectBundledProviderPolicySurface("custom-provider")).toBeNull();
  });

  it("propagates errors from a present provider artifact", async () => {
    const error = new Error("Provider artifact is outside its boundary root");
    vi.doMock("./public-surface-loader.js", () => ({
      loadBundledPluginPublicArtifactModuleFromCandidatesSync: () => {
        throw error;
      },
    }));
    const { resolveDirectBundledProviderPolicySurface } = await importFreshModule<
      typeof import("./provider-policy-surface.js")
    >(import.meta.url, "./provider-policy-surface.js?scope=invalid-provider-policy");

    expect(() => resolveDirectBundledProviderPolicySurface("custom-provider")).toThrow(error);
  });
});
