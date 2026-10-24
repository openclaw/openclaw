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

import {
  createEmptyAgentDiscoveryStores,
  resolveModelAsync,
} from "../../src/agents/embedded-agent-runner/model.js";
import { resolveRuntimeHooks } from "../../src/agents/embedded-agent-runner/model.provider-hooks.js";
import { resolveBundledStaticCatalogModel } from "../../src/agents/embedded-agent-runner/model.static-catalog.js";
import { loadPluginManifest } from "../../src/plugins/manifest.js";
import { clearPluginMetadataLifecycleCaches } from "../../src/plugins/plugin-metadata-lifecycle.js";
import { createPluginMetadataSnapshotFixture } from "../../src/plugins/plugin-metadata.test-support.js";
import { resolveOwningPluginIdsForProviderRef } from "../../src/plugins/providers.js";
import { resolveBundledPluginPublicModulePath } from "../../src/test-utils/bundled-plugin-public-surface.js";

async function resolveAlias(
  provider: string,
  modelId: string,
  catalogProvider = provider,
  cfg?: OpenClawConfig,
) {
  const catalogModel = resolveBundledStaticCatalogModel({
    provider: catalogProvider,
    modelId,
    includeRuntimeDiscovery: true,
  });
  if (!catalogModel) {
    throw new Error(`Missing ${catalogProvider} catalog model`);
  }
  const stores = createEmptyAgentDiscoveryStores();
  vi.spyOn(stores.modelRegistry, "find").mockImplementation((candidateProvider, candidateId) =>
    candidateProvider === catalogModel.provider && candidateId === catalogModel.id
      ? catalogModel
      : undefined,
  );
  const { model } = await resolveModelAsync(provider, catalogModel.id, undefined, cfg, {
    ...stores,
    runtimeHooks: resolveRuntimeHooks({ skipProviderRuntimeHooks: true }),
    authProfileMode: "api_key",
  });
  return model;
}

beforeEach(() => {
  clearPluginMetadataLifecycleCaches();
  manifestMocks.getCurrentPluginMetadataSnapshot.mockReset();
  manifestMocks.loadPluginManifestRegistryCore.mockReset();
});

function loadManifest(pluginId: string) {
  const rootDir = path.dirname(
    resolveBundledPluginPublicModulePath({
      pluginId,
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
}

async function expectAlias(
  pluginId: string,
  provider: string,
  alias: string,
  modelId: string,
  baseUrl: string,
) {
  loadManifest(pluginId);
  expect(resolveOwningPluginIdsForProviderRef({ provider: alias })).toEqual([pluginId]);
  const expected = { provider, id: modelId, api: "openai-completions", baseUrl };
  expect(
    resolveBundledStaticCatalogModel({ provider, modelId, includeRuntimeDiscovery: true }),
  ).toMatchObject(expected);
  const canonical = await resolveAlias(provider, modelId);
  expect(canonical).toMatchObject(expected);
  expect(await resolveAlias(alias, modelId, provider)).toEqual(canonical);
}

it.each([
  [
    "fireworks",
    "fireworks",
    "fireworks-ai",
    "accounts/fireworks/routers/glm-5p3-fast",
    "https://api.fireworks.ai/inference/v1",
  ],
  ["stepfun", "stepfun", "stepfun-ai", "step-3.7-flash", "https://api.stepfun.ai/v1"],
  [
    "stepfun",
    "stepfun-plan",
    "stepfun-ai-step-plan",
    "step-3.7-flash",
    "https://api.stepfun.ai/step_plan/v1",
  ],
  ["together", "together", "togetherai", "zai-org/GLM-5.2", "https://api.together.xyz/v1"],
  ["kilocode", "kilocode", "kilo", "kilo-auto/balanced", "https://api.kilo.ai/api/gateway/"],
])("%s owns %s alias %s before runtime load and resolves its catalog model", expectAlias);

describe.each([
  ["fireworks", "fireworks-ai", "accounts/fireworks/routers/glm-5p3-fast", "X-Fireworks-Route"],
  ["stepfun", "stepfun-ai", "step-3.7-flash", "X-StepFun-Route"],
])("%s explicit alias configuration", (catalogProvider, provider, modelId, header) => {
  it.each([
    ["omitted API", undefined, undefined, undefined, "openai-completions"],
    ["provider API", "openai-responses", undefined, undefined, "openai-responses"],
    [
      "model API and URL",
      "openai-responses",
      "anthropic-messages",
      `https://${catalogProvider}-proxy.example/model`,
      "anthropic-messages",
    ],
  ] as const)("preserves %s", async (_name, providerApi, modelApi, modelBaseUrl, expectedApi) => {
    loadManifest(catalogProvider);
    const baseUrl = `https://${catalogProvider}-proxy.example/v1`;
    const headers = { [header]: "custom" };
    const cfg: OpenClawConfig = {
      models: {
        providers: {
          [provider]: {
            baseUrl,
            api: providerApi,
            headers,
            models: [
              {
                id: modelId,
                name: "Configured model",
                api: modelApi,
                baseUrl: modelBaseUrl,
                reasoning: false,
                input: ["text", "image"],
                contextWindow: 4096,
                maxTokens: 512,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              },
            ],
          },
        },
      },
    };
    expect(await resolveAlias(provider, modelId, catalogProvider, cfg)).toMatchObject({
      provider,
      id: modelId,
      api: expectedApi,
      baseUrl: modelBaseUrl ?? baseUrl,
      headers,
      reasoning: false,
      input: ["text", "image"],
      contextWindow: 4096,
      maxTokens: 512,
    });
  });
});
