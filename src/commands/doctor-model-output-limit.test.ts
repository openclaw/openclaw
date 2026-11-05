import path from "node:path";
import { expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadPluginManifest } from "../plugins/manifest.js";
import { createPluginManifestRecordFixture } from "../plugins/plugin-metadata.test-support.js";
import { resolveAgentModelOutputLimit } from "./doctor-model-output-limit.js";

const registry = vi.hoisted(() => ({ plugins: [] as unknown[] }));
// mock-isolation: the resolver must not scan installed plugin manifests in tests.
vi.mock("../plugins/plugin-registry.js", () => ({
  loadPluginManifestRegistryForPluginRegistry: () => registry,
}));

const withLocal = (provider: Record<string, unknown>, primary = "Local/m"): OpenClawConfig =>
  ({
    agents: { defaults: { model: { primary } } },
    models: {
      providers: {
        local: { baseUrl: "http://local.test/v1", models: [{ id: "m", name: "m" }], ...provider },
      },
    },
  }) as unknown as OpenClawConfig;

const providerPath = "models.providers.local.maxTokens";
const rowPath = "models.providers.local.models[0].maxTokens";
it.each<[string, Record<string, unknown>, number, string]>([
  ["the 8192 default", {}, 8192, providerPath],
  ["provider maxTokens", { maxTokens: 65_536 }, 65_536, providerPath],
  ["model maxTokens", { models: [{ id: "m", name: "m", maxTokens: 131_072 }] }, 131_072, rowPath],
])("resolves a configured model's output limit from %s", (_label, provider, maxTokens, path) => {
  const cfg = withLocal(provider);
  expect(resolveAgentModelOutputLimit({ cfg, agentId: "main" })).toEqual({
    providerKey: "local",
    model: "m",
    maxTokens,
    path,
  });
});

it.each([
  [8192, 131_072, 8192, "agents.entries.main.params.maxTokens"],
  [131_072, 8192, 8192, rowPath],
])("binds the lower of request budget %i and model ceiling %i", (budget, ceiling, max, path) => {
  const cfg = withLocal({ models: [{ id: "m", name: "m", maxTokens: ceiling }] });
  cfg.agents!.entries = { main: { params: { max_tokens: budget } } };
  expect(resolveAgentModelOutputLimit({ cfg, agentId: "main" })).toMatchObject({
    maxTokens: max,
    path,
  });
});

it("points a catalog-derived limit at the model row, where a raise takes effect", () => {
  const rootDir = path.resolve("extensions/openai");
  const loaded = loadPluginManifest(rootDir);
  if (!loaded.ok) {
    throw new Error(loaded.error);
  }
  registry.plugins = [createPluginManifestRecordFixture({ ...loaded.manifest, rootDir })];
  const cfg = {
    agents: { defaults: { model: { primary: "openai/gpt-4.1" } } },
    models: {
      providers: {
        openai: { maxTokens: 65_536, models: [{ id: "gpt-4.1", name: "gpt-4.1" }] },
      },
    },
  } as unknown as OpenClawConfig;
  expect(resolveAgentModelOutputLimit({ cfg, agentId: "main" })).toMatchObject({
    maxTokens: 32_768,
    path: "models.providers.openai.models[0].maxTokens",
  });
  registry.plugins = [];
});

it("leaves catalog-only models alone", () => {
  const cfg = withLocal({}, "anthropic/claude-opus-5-5");
  expect(resolveAgentModelOutputLimit({ cfg, agentId: "main" })).toBeUndefined();
});
