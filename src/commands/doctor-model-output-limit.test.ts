import { expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveAgentModelOutputLimit } from "./doctor-model-output-limit.js";

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
  }) as OpenClawConfig;

it.each<[string, Record<string, unknown>, number]>([
  ["the 8192 default", {}, 8192],
  ["provider maxTokens", { maxTokens: 65_536 }, 65_536],
  ["model maxTokens", { models: [{ id: "m", name: "m", maxTokens: 131_072 }] }, 131_072],
])("resolves a configured model's output limit from %s", (_label, provider, maxTokens) => {
  expect(resolveAgentModelOutputLimit({ cfg: withLocal(provider), agentId: "main" })).toEqual({
    providerKey: "local",
    model: "m",
    maxTokens,
  });
});

it("leaves catalog-only models alone", () => {
  const cfg = withLocal({}, "anthropic/claude-opus-5-5");
  expect(resolveAgentModelOutputLimit({ cfg, agentId: "main" })).toBeUndefined();
});
