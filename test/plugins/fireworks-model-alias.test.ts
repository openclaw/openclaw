import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";

const manifestMocks = vi.hoisted(() => ({
  getCurrentPluginMetadataSnapshot: vi.fn(),
  loadPluginManifestRegistryCore: vi.fn(),
}));

vi.mock("../../src/plugins/current-plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../src/plugins/current-plugin-metadata-snapshot.js")
  >()),
  getCurrentPluginMetadataSnapshot: manifestMocks.getCurrentPluginMetadataSnapshot,
}));

vi.mock("../../src/plugins/manifest-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/plugins/manifest-registry.js")>()),
  loadPluginManifestRegistryCore: manifestMocks.loadPluginManifestRegistryCore,
}));

import { resolveRuntimeHooks } from "../../src/agents/embedded-agent-runner/model.provider-hooks.js";
import { resolveModelWithRegistry } from "../../src/agents/embedded-agent-runner/model.registry-resolution.js";
import { resolveBundledStaticCatalogModel } from "../../src/agents/embedded-agent-runner/model.static-catalog.js";
import { loadPluginManifest } from "../../src/plugins/manifest.js";
import { clearPluginMetadataLifecycleCaches } from "../../src/plugins/plugin-metadata-lifecycle.js";
import { createPluginMetadataSnapshotFixture } from "../../src/plugins/plugin-metadata.test-support.js";
import { resolveOwningPluginIdsForProviderRef } from "../../src/plugins/providers.js";
import { resolveBundledPluginPublicModulePath } from "../../src/test-utils/bundled-plugin-public-surface.js";

beforeEach(() => {
  clearPluginMetadataLifecycleCaches();
  manifestMocks.getCurrentPluginMetadataSnapshot.mockReset();
  manifestMocks.loadPluginManifestRegistryCore.mockReset();
});

describe("Fireworks manifest provider alias", () => {
  const modelId = "accounts/fireworks/routers/glm-5p2-fast";
  const providerBaseUrl = "https://fireworks-proxy.example/v1";
  const modelBaseUrl = "https://fireworks-proxy.example/model";

  beforeEach(() => {
    const rootDir = path.dirname(
      resolveBundledPluginPublicModulePath({
        pluginId: "fireworks",
        artifactBasename: "openclaw.plugin.json",
      }),
    );
    const loaded = loadPluginManifest(rootDir);
    if (!loaded.ok) {
      throw new Error(loaded.error);
    }
    const snapshot = createPluginMetadataSnapshotFixture({
      plugins: [{ ...loaded.manifest, origin: "bundled", rootDir }],
    });
    manifestMocks.getCurrentPluginMetadataSnapshot.mockReturnValue(snapshot);
    manifestMocks.loadPluginManifestRegistryCore.mockReturnValue(snapshot.manifestRegistry);
  });

  function resolveFireworksGlm(provider: string, cfg?: OpenClawConfig) {
    const catalogModel = resolveBundledStaticCatalogModel({
      provider: "fireworks",
      modelId,
      includeRuntimeDiscovery: true,
    });
    if (!catalogModel) {
      throw new Error("Missing Fireworks GLM catalog model");
    }
    return resolveModelWithRegistry({
      provider,
      modelId,
      cfg,
      modelRegistry: {
        getAll: () => [catalogModel],
        getAvailable: () => [],
        hasConfiguredAuth: () => false,
        find: (candidateProvider, candidateId) =>
          candidateProvider === catalogModel.provider && candidateId === catalogModel.id
            ? catalogModel
            : undefined,
      },
      runtimeHooks: resolveRuntimeHooks({ skipProviderRuntimeHooks: true }),
      authProfileMode: "api_key",
    });
  }

  it("finds the alias owner before runtime loading and resolves the canonical catalog model", () => {
    expect(resolveOwningPluginIdsForProviderRef({ provider: "fireworks-ai" })).toEqual([
      "fireworks",
    ]);
    const canonical = resolveFireworksGlm("fireworks");
    expect(canonical).toMatchObject({
      provider: "fireworks",
      id: modelId,
      api: "openai-completions",
      baseUrl: "https://api.fireworks.ai/inference/v1",
    });
    expect(resolveFireworksGlm("fireworks-ai")).toEqual(canonical);
  });

  it.each([
    ["omitted API", undefined, undefined, undefined, "openai-completions"],
    ["provider API", "openai-responses", undefined, undefined, "openai-responses"],
    [
      "model API and URL",
      "openai-responses",
      "anthropic-messages",
      modelBaseUrl,
      "anthropic-messages",
    ],
  ] as const)(
    "preserves explicit alias configuration with %s",
    (_name, providerApi, modelApi, configuredModelBaseUrl, expectedApi) => {
      const cfg: OpenClawConfig = {
        models: {
          providers: {
            "fireworks-ai": {
              baseUrl: providerBaseUrl,
              api: providerApi,
              headers: { "X-Fireworks-Route": "custom" },
              models: [
                {
                  id: modelId,
                  name: "Configured GLM",
                  api: modelApi,
                  baseUrl: configuredModelBaseUrl,
                  reasoning: false,
                  input: ["text", "image"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 4096,
                  maxTokens: 512,
                },
              ],
            },
          },
        },
      };

      expect(resolveFireworksGlm("fireworks-ai", cfg)).toMatchObject({
        provider: "fireworks-ai",
        id: modelId,
        api: expectedApi,
        baseUrl: configuredModelBaseUrl ?? providerBaseUrl,
        headers: { "X-Fireworks-Route": "custom" },
        reasoning: false,
        input: ["text", "image"],
        contextWindow: 4096,
        maxTokens: 512,
      });
    },
  );
});
