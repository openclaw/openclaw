import { describe, expect, it } from "vitest";
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
  it("loads bundled provider policy surfaces for anthropic", () => {
    const surface = resolveBundledProviderPolicySurface("anthropic");

    expect(surface?.normalizeConfig).toBeTypeOf("function");
    expect(surface?.applyConfigDefaults).toBeTypeOf("function");
  });

  it("uses the bundled anthropic policy hooks without loading the runtime plugin", () => {
    const surface = resolveBundledProviderPolicySurface("anthropic");
    expect(surface).toBeTruthy();

    const normalized = surface?.normalizeConfig?.({
      provider: "anthropic",
      providerConfig: {
        baseUrl: "https://api.anthropic.com",
        models: [createModel("claude-sonnet-4-6", "Claude Sonnet 4.6")],
      },
    });
    expect(normalized).toMatchObject({
      api: "anthropic-messages",
      baseUrl: "https://api.anthropic.com",
    });

    const nextConfig = surface?.applyConfigDefaults?.({
      provider: "anthropic",
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
