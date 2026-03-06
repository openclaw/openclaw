import { describe, expect, it } from "vitest";
import { buildQiniuProvider, QINIU_DEFAULT_MODEL_ID } from "../agents/models-config.providers.js";

describe("Qiniu Provider", () => {
  it("should use minimax-minimax-m2.5 as default model", () => {
    const provider = buildQiniuProvider();
    expect(provider.models).toHaveLength(1);
    expect(provider.models[0].id).toBe("minimax/minimax-m2.5");
    expect(provider.baseUrl).toBe("https://api.qnaigc.com/v1");
  });

  it("should use custom model when provided", () => {
    const provider = buildQiniuProvider("qiniu/deepseek-r1");
    expect(provider.models).toHaveLength(1);
    expect(provider.models[0].id).toBe("qiniu/deepseek-r1");
  });

  it("should fallback to default model for unknown modelId", () => {
    const provider = buildQiniuProvider("unknown-model");
    expect(provider.models).toHaveLength(1);
    expect(provider.models[0].id).toBe("minimax/minimax-m2.5");
  });

  it("should support multiple popular models", () => {
    const testCases = [
      { modelId: "minimax/minimax-m2.5", expectedName: "MiniMax M2.5" },
      { modelId: "minimax/minimax-m2.1", expectedName: "MiniMax M2.1" },
      { modelId: "qiniu/deepseek-r1", expectedName: "DeepSeek R1" },
      { modelId: "qiniu/gpt-5-pro", expectedName: "GPT-5 Pro" },
      { modelId: "qiniu/gemini-3-pro", expectedName: "Gemini 3.1 Pro" },
    ];

    for (const { modelId, expectedName } of testCases) {
      const provider = buildQiniuProvider(modelId);
      expect(provider.models[0].id).toBe(modelId);
      expect(provider.models[0].name).toBe(expectedName);
    }
  });

  it("should have correct API configuration", () => {
    const provider = buildQiniuProvider();
    expect(provider.api).toBe("openai-completions");
    expect(provider.baseUrl).toBe("https://api.qnaigc.com/v1");
  });
});
