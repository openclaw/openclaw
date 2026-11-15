import fs from "node:fs";
import path from "node:path";
import { normalizeModelFamily } from "@openclaw/model-catalog-core/model-catalog-types";
import { expect, it } from "vitest";
import { createBundledStaticCatalogModelResolver } from "../../agents/embedded-agent-runner/model.static-catalog.js";
import { prepareConfiguredRuntimeFacts } from "../../agents/prepared-model-runtime.configured-catalog.js";
import { completeConfiguredRuntimeModels } from "../../agents/prepared-model-runtime.configured-completion.js";
import { AuthStorage } from "../../agents/sessions/auth-storage.core.js";
import { ModelRegistry } from "../../agents/sessions/model-registry.core.js";
import { listGitTrackedFiles } from "../../test-utils/repo-files.js";
import { createPluginMetadataSnapshotFixture } from "../plugin-metadata.test-support.js";
import { loadBundledPluginPublicArtifactModuleSync } from "../public-surface-loader.js";
import { createEmptyPluginRegistry } from "../registry-empty.js";
import type { ProviderPlugin } from "../types.js";

const repoRoot = path.resolve(import.meta.dirname, "../../..");

type RawCatalogProvider = { family?: unknown; models?: Array<{ id: string; family?: unknown }> };

function readBundledCatalogProviders(): Array<[string, RawCatalogProvider]> {
  const files = listGitTrackedFiles({ repoRoot, pathspecs: "extensions" });
  if (!files) {
    throw new Error("unable to list bundled plugin files from git");
  }
  return files
    .filter((file) => /^extensions\/[^/]+\/openclaw\.plugin\.json$/.test(file))
    .flatMap((file) => {
      const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, file), "utf8")) as {
        modelCatalog?: { providers?: Record<string, RawCatalogProvider> };
      };
      return Object.entries(manifest.modelCatalog?.providers ?? {});
    });
}

it("authors every bundled family as a canonical token that a developer's own catalog uses", () => {
  const providerFamilies = new Map<string, unknown>();
  const rowFamilies: Array<[string, unknown]> = [];
  for (const [provider, catalog] of readBundledCatalogProviders()) {
    if (catalog.family !== undefined) {
      providerFamilies.set(provider, catalog.family);
    }
    for (const model of catalog.models ?? []) {
      if (model.family !== undefined) {
        rowFamilies.push([`${provider}/${model.id}`, model.family]);
      }
    }
  }
  // Authored values are already canonical; normalization is not relied on to repair them.
  for (const [ref, family] of [...providerFamilies, ...rowFamilies]) {
    expect(normalizeModelFamily(family), ref).toBe(family);
  }
  // A routing catalog's row must use the token its developer's catalog declares.
  const vocabulary = new Set(providerFamilies.values());
  for (const [ref, family] of rowFamilies) {
    expect(vocabulary.has(family), `${ref}: ${String(family)}`).toBe(true);
  }
  expect(Object.fromEntries(providerFamilies)).toMatchObject({
    anthropic: "anthropic",
    openai: "openai",
    google: "google",
    kimi: "moonshot",
    moonshot: "moonshot",
  });
  // Hosts serving several developers' models declare no provider-wide family.
  for (const host of ["qwen", "openrouter", "github-copilot", "clawrouter", "venice"]) {
    expect(providerFamilies.has(host), host).toBe(false);
  }
});

it("gives the same model one family across native and routing catalogs, and none when unknown", () => {
  const resolve = createBundledStaticCatalogModelResolver({ includeRuntimeDiscovery: true });
  const familyOf = (provider: string, modelId: string) => {
    const model = resolve({ provider, modelId });
    expect(model?.id, `${provider}/${modelId}`).toBe(modelId);
    return model?.family;
  };
  expect([
    familyOf("anthropic", "claude-opus-5-5"),
    familyOf("github-copilot", "claude-opus-5.5"),
  ]).toEqual(["anthropic", "anthropic"]);
  expect(familyOf("github-copilot", "gpt-5.5")).toBe(familyOf("openai", "gpt-5.5"));
  expect(familyOf("github-copilot", "gemini-2.5-pro")).toBe(familyOf("google", "gemini-2.5-pro"));
  // Qwen's host also serves GLM and Kimi rows; without a row declaration, no family is guessed.
  expect(familyOf("qwen", "glm-5")).toBeUndefined();
  expect(familyOf("qwen", "qwen3.5-plus")).toBeUndefined();
});

it("publishes the native family when completing a configured model absent from the manifest", async () => {
  const { buildAnthropicProvider } = loadBundledPluginPublicArtifactModuleSync<{
    buildAnthropicProvider: () => ProviderPlugin;
  }>({ dirName: "anthropic", artifactBasename: "api.js" });
  const pluginRegistry = createEmptyPluginRegistry();
  pluginRegistry.providers.push({
    pluginId: "anthropic",
    source: "test",
    provider: buildAnthropicProvider(),
  });
  const pluginMetadataSnapshot = createPluginMetadataSnapshotFixture({
    plugins: [{ id: "anthropic", providers: ["anthropic"] }],
  });
  const modelRegistry = ModelRegistry.create(AuthStorage.inMemory({}), "captured:family", {
    config: {},
    includePluginCatalogs: false,
    pluginMetadataSnapshot,
    modelsJsonContents: null,
  });
  const agentFacts = {
    input: {
      agentDir: "captured:family-agent",
      config: { agents: { defaults: { model: "anthropic/claude-fable-5-2" } } },
    },
    env: {},
    configuredModelRefs: [
      { provider: "anthropic", modelId: "claude-fable-5-2" },
      { provider: "anthropic", modelId: "opaque-deployment" },
      { provider: "openrouter", modelId: "anthropic/claude-fable-5-2" },
    ],
    configuredRuntimeModels: [],
  };
  const completed = await completeConfiguredRuntimeModels(
    agentFacts,
    { pluginMetadataSnapshot, pluginRegistry },
    modelRegistry,
  );
  const { modelCatalog } = prepareConfiguredRuntimeFacts({
    agentFacts,
    workspaceFacts: { pluginMetadataSnapshot },
    templateModelRegistry: modelRegistry,
    configuredRuntimeModels: completed,
  });
  // Completion must use the native plugin, not a name-based fallback for other hosts.
  expect(completed.map(({ provider, modelId }) => provider + "/" + modelId)).toEqual([
    "anthropic/claude-fable-5-2",
  ]);
  for (const rows of [
    modelCatalog.entries,
    modelCatalog.routeVariants,
    modelCatalog.staticEntries,
  ]) {
    expect(rows).toEqual([
      expect.objectContaining({
        provider: "anthropic",
        id: "claude-fable-5-2",
        family: "anthropic",
      }),
    ]);
  }
});
