import { expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveAgentModelOutputLimit } from "./doctor-model-output-limit.js";

// mock-isolation: the resolver must not scan installed plugin manifests in tests.
vi.mock("../plugins/plugin-registry.js", () => ({
  loadPluginManifestRegistryForPluginRegistry: () => ({ plugins: [] }),
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

it("leaves catalog-only models alone", () => {
  const cfg = withLocal({}, "anthropic/claude-opus-5-5");
  expect(resolveAgentModelOutputLimit({ cfg, agentId: "main" })).toBeUndefined();
});
