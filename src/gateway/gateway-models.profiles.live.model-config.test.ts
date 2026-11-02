import { describe, expect, it } from "vitest";
import { OpenClawSchema } from "../config/zod-schema.js";
import type { Model } from "../llm/types.js";
import { toLiveModelConfig } from "./gateway-models.profiles.live.model-config.test-helpers.js";

describe("toLiveModelConfig", () => {
  it.each([
    "",
    "https://coding-intl.dashscope.aliyuncs.com/v1",
    "https://coding.dashscope.aliyuncs.com/v1",
    "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    "https://dashscope.aliyuncs.com/compatible-mode/v1",
  ])("serializes a runtime model with endpoint %s into valid config", (baseUrl) => {
    const model: Model = {
      id: "qwen3.5-plus",
      name: "Qwen 3.5 Plus",
      provider: "qwen",
      api: "openai-completions",
      baseUrl,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 262_144,
      maxTokens: 4096,
    };
    const modelConfig = toLiveModelConfig(model);
    const providerBaseUrl = baseUrl || "https://coding-intl.dashscope.aliyuncs.com/v1";
    const config = {
      models: {
        providers: {
          qwen: { api: model.api, baseUrl: providerBaseUrl, models: [modelConfig] },
        },
      },
    };
    const serialized = JSON.stringify(config);
    const parsed = OpenClawSchema.parse(JSON.parse(serialized));
    expect(parsed.models?.providers?.qwen?.baseUrl).toBe(providerBaseUrl);
    if (baseUrl) {
      expect(modelConfig.baseUrl).toBe(baseUrl);
    } else {
      expect(modelConfig).not.toHaveProperty("baseUrl");
    }
  });
});
