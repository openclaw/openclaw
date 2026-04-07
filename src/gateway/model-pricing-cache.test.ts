import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { modelKey } from "../agents/model-selection.js";
import type { OpenClawConfig } from "../config/config.js";
import { withFetchPreconnect } from "../test-utils/fetch-mock.js";
import {
  __resetGatewayModelPricingCacheForTest,
  collectConfiguredModelPricingRefs,
  getCachedGatewayModelPricing,
  refreshGatewayModelPricingCache,
} from "./model-pricing-cache.js";

describe("model-pricing-cache", () => {
  beforeEach(() => {
    __resetGatewayModelPricingCacheForTest();
  });

  afterEach(() => {
    __resetGatewayModelPricingCacheForTest();
  });

  it("collects configured model refs across defaults, aliases, overrides, and media tools", () => {
    const config = {
      agents: {
        defaults: {
          model: { primary: "gpt", fallbacks: ["anthropic/claude-sonnet-4-6"] },
          imageModel: { primary: "google/gemini-3-pro" },
          compaction: { model: "opus" },
          heartbeat: { model: "xai/grok-4" },
          models: {
            "openai/gpt-5.4": { alias: "gpt" },
            "anthropic/claude-opus-4-6": { alias: "opus" },
          },
        },
        list: [
          {
            id: "router",
            model: { primary: "openrouter/anthropic/claude-opus-4-6" },
            subagents: { model: { primary: "openrouter/auto" } },
            heartbeat: { model: "anthropic/claude-opus-4-6" },
          },
        ],
      },
      channels: {
        modelByChannel: {
          slack: {
            C123: "gpt",
          },
        },
      },
      hooks: {
        gmail: { model: "anthropic/claude-opus-4-6" },
        mappings: [{ model: "zai/glm-5" }],
      },
      tools: {
        subagents: { model: { primary: "anthropic/claude-haiku-4-5" } },
        media: {
          models: [{ provider: "google", model: "gemini-2.5-pro" }],
          image: {
            models: [{ provider: "xai", model: "grok-4" }],
          },
        },
      },
      messages: {
        tts: {
          summaryModel: "openai/gpt-5.4",
        },
      },
    } as unknown as OpenClawConfig;

    const refs = collectConfiguredModelPricingRefs(config).map((ref) =>
      modelKey(ref.provider, ref.model),
    );

    expect(refs).toEqual(
      expect.arrayContaining([
        "openai/gpt-5.4",
        "anthropic/claude-sonnet-4-6",
        "google/gemini-3-pro-preview",
        "anthropic/claude-opus-4-6",
        "xai/grok-4",
        "openrouter/anthropic/claude-opus-4-6",
        "openrouter/auto",
        "zai/glm-5",
        "anthropic/claude-haiku-4-5",
        "google/gemini-2.5-pro",
      ]),
    );
    expect(new Set(refs).size).toBe(refs.length);
  });

  it("collects manifest-owned web search plugin model refs without a hardcoded plugin list", () => {
    const refs = collectConfiguredModelPricingRefs({
      plugins: {
        entries: {
          tavily: {
            config: {
              webSearch: {
                model: "tavily/search-preview",
              },
            },
          },
        },
      },
    } as OpenClawConfig).map((ref) => modelKey(ref.provider, ref.model));

    expect(refs).toContain("tavily/search-preview");
  });

  it("loads openrouter pricing and maps provider aliases, wrappers, and anthropic dotted ids", async () => {
    const config = {
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-opus-4-6" },
        },
        list: [
          {
            id: "router",
            model: { primary: "openrouter/anthropic/claude-sonnet-4-6" },
          },
        ],
      },
      hooks: {
        mappings: [{ model: "xai/grok-4.20-experimental-beta-0304-reasoning" }],
      },
      tools: {
        subagents: { model: { primary: "zai/glm-5" } },
      },
    } as unknown as OpenClawConfig;

    const fetchImpl = withFetchPreconnect(
      async () =>
        new Response(
          JSON.stringify({
            data: [
              {
                id: "anthropic/claude-opus-4.6",
                pricing: {
                  prompt: "0.000005",
                  completion: "0.000025",
                  input_cache_read: "0.0000005",
                  input_cache_write: "0.00000625",
                },
              },
              {
                id: "anthropic/claude-sonnet-4.6",
                pricing: {
                  prompt: "0.000003",
                  completion: "0.000015",
                  input_cache_read: "0.0000003",
                },
              },
              {
                id: "x-ai/grok-4.20-experimental-beta-0304-reasoning",
                pricing: {
                  prompt: "0.000002",
                  completion: "0.00001",
                },
              },
              {
                id: "z-ai/glm-5",
                pricing: {
                  prompt: "0.000001",
                  completion: "0.000004",
                },
              },
            ],
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
    );

    await refreshGatewayModelPricingCache({ config, fetchImpl });

    expect(
      getCachedGatewayModelPricing({ provider: "anthropic", model: "claude-opus-4-6" }),
    ).toEqual({
      input: 5,
      output: 25,
      cacheRead: 0.5,
      cacheWrite: 6.25,
    });
    expect(
      getCachedGatewayModelPricing({
        provider: "openrouter",
        model: "anthropic/claude-sonnet-4-6",
      }),
    ).toEqual({
      input: 3,
      output: 15,
      cacheRead: 0.3,
      cacheWrite: 0,
    });
    expect(
      getCachedGatewayModelPricing({
        provider: "xai",
        model: "grok-4.20-experimental-beta-0304-reasoning",
      }),
    ).toEqual({
      input: 2,
      output: 10,
      cacheRead: 0,
      cacheWrite: 0,
    });
    expect(getCachedGatewayModelPricing({ provider: "xai", model: "grok-4.20-reasoning" })).toEqual(
      {
        input: 2,
        output: 10,
        cacheRead: 0,
        cacheWrite: 0,
      },
    );
    expect(getCachedGatewayModelPricing({ provider: "zai", model: "glm-5" })).toEqual({
      input: 1,
      output: 4,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });

  it("does not recurse forever for native openrouter auto refs", async () => {
    const config = {
      agents: {
        defaults: {
          model: { primary: "openrouter/auto" },
        },
      },
    } as unknown as OpenClawConfig;

    const fetchImpl = withFetchPreconnect(
      async () =>
        new Response(
          JSON.stringify({
            data: [
              {
                id: "openrouter/auto",
                pricing: {
                  prompt: "0.000001",
                  completion: "0.000002",
                },
              },
            ],
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
    );

    await expect(refreshGatewayModelPricingCache({ config, fetchImpl })).resolves.toBeUndefined();
    expect(
      getCachedGatewayModelPricing({ provider: "openrouter", model: "openrouter/auto" }),
    ).toEqual({
      input: 1,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });
});
