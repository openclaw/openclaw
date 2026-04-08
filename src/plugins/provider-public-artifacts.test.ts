import { describe, expect, it } from "vitest";
import {
  applyAnthropicConfigDefaults,
  normalizeAnthropicProviderConfig,
} from "../../extensions/anthropic/config-defaults.js";
import type { ModelDefinitionConfig, ModelProviderConfig } from "../config/types.models.js";
import { resolveBundledProviderPolicySurface } from "./provider-public-artifacts.js";

function createModel(id: string, name: string): ModelDefinitionConfig {
  return {
    id,
    name,
    reasoning: false,
    input: ["text"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 128_000,
    maxTokens: 8_192,
  };
}
describe("provider public artifacts", () => {
  it("uses the bundled anthropic policy hooks without loading the public artifact", () => {
    const normalized = normalizeAnthropicProviderConfig({
      baseUrl: "https://api.anthropic.com",
      models: [createModel("claude-sonnet-4-6", "Claude Sonnet 4.6")],
    });

    expect(normalized).toMatchObject({
      api: "anthropic-messages",
      baseUrl: "https://api.anthropic.com",
    });

    const nextConfig = applyAnthropicConfigDefaults({
      config: {
        auth: {
          profiles: {
            "anthropic:default": {
              provider: "anthropic",
              mode: "api_key",
            },
          },
          order: { anthropic: ["anthropic:default"] },
        },
        agents: {
          defaults: {},
        },
      },
      env: {},
    });
    expect(nextConfig?.agents?.defaults?.contextPruning).toMatchObject({
      mode: "cache-ttl",
      ttl: "1h",
    });
  });

  it("allows bundled providers to publish explicit no-op policy hooks", () => {
    const surface = resolveBundledProviderPolicySurface("openai");
    expect(surface?.normalizeConfig).toBeTypeOf("function");

    const providerConfig: ModelProviderConfig = {
      baseUrl: "https://api.openai.com/v1",
      api: "openai-completions",
      models: [createModel("gpt-5", "gpt-5")],
    };
    expect(
      surface?.normalizeConfig?.({
        provider: "openai",
        providerConfig,
      }),
    ).toBe(providerConfig);
  });
});
