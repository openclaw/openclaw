import { describe, expect, it } from "vitest";
import {
  applyProviderNativeStreamingUsageCompat,
  supportsNativeStreamingUsageCompat,
} from "./provider-catalog-shared.js";
import type { ModelDefinitionConfig } from "./provider-model-shared.js";

function buildModel(id: string, supportsUsageInStreaming?: boolean): ModelDefinitionConfig {
  return {
    id,
    name: id,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1024,
    maxTokens: 1024,
    ...(supportsUsageInStreaming === undefined ? {} : { compat: { supportsUsageInStreaming } }),
  };
}

describe("provider-catalog-shared native streaming usage compat", () => {
  it("detects native streaming usage compat from the endpoint capabilities", () => {
    expect(
      supportsNativeStreamingUsageCompat({
        providerId: "custom-qwen",
        baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      }),
    ).toBe(true);
    expect(
      supportsNativeStreamingUsageCompat({
        providerId: "custom-kimi",
        baseUrl: "https://api.moonshot.ai/v1",
      }),
    ).toBe(true);
    expect(
      supportsNativeStreamingUsageCompat({
        providerId: "custom-proxy",
        baseUrl: "https://proxy.example.com/v1",
      }),
    ).toBe(false);
  });

  it("opts models into streaming usage for native endpoints while preserving explicit overrides", () => {
    const provider = applyProviderNativeStreamingUsageCompat({
      providerId: "custom-qwen",
      providerConfig: {
        api: "openai-completions",
        baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        models: [buildModel("qwen-plus"), buildModel("qwen-max", false)],
      },
    });

    expect(provider.models?.[0]?.compat?.supportsUsageInStreaming).toBe(true);
    expect(provider.models?.[1]?.compat?.supportsUsageInStreaming).toBe(false);
  });
});
