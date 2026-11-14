import path from "node:path";
import { beforeEach, expect, it, vi } from "vitest";

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

import { resolveModelAsync } from "../../src/agents/embedded-agent-runner/model.js";
import { resolveRuntimeHooks } from "../../src/agents/embedded-agent-runner/model.provider-hooks.js";
import { loadPluginManifest } from "../../src/plugins/manifest.js";
import { clearPluginMetadataLifecycleCaches } from "../../src/plugins/plugin-metadata-lifecycle.js";
import { createPluginMetadataSnapshotFixture } from "../../src/plugins/plugin-metadata.test-support.js";
import { resolveOwningPluginIdsForProviderRef } from "../../src/plugins/providers.js";
import { resolveBundledPluginPublicModulePath } from "../../src/test-utils/bundled-plugin-public-surface.js";

async function resolveAlias(provider: string, modelId: string) {
  const { model } = await resolveModelAsync(provider, modelId, undefined, undefined, {
    skipAgentDiscovery: true,
    allowBundledStaticCatalogFallback: true,
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
])(
  "%s owns %s alias %s before runtime load and resolves its catalog model",
  async (pluginId, provider, alias, modelId, baseUrl) => {
    loadManifest(pluginId);
    expect(resolveOwningPluginIdsForProviderRef({ provider: alias })).toEqual([pluginId]);
    const canonical = await resolveAlias(provider, modelId);
    expect(canonical).toMatchObject({ provider, id: modelId, api: "openai-completions", baseUrl });
    expect(await resolveAlias(alias, modelId)).toEqual(canonical);
  },
);
