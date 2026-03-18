import { describe, expect, it } from "vitest";
import {
  AZURE_OPENAI_DEFAULT_API_VERSION,
  applyAzureOpenAIConfig,
  isAzureOpenAIModernModelRef,
  normalizeAzureOpenAIBaseUrl,
  normalizeAzureOpenAIApiVersion,
  normalizeAzureOpenAIModelId,
  supportsAzureOpenAIXHighThinking,
} from "./azure-openai-config.js";

describe("azure-openai-config", () => {
  it("normalizes Azure base URL to /openai/v1", () => {
    const cases = [
      ["https://example.openai.azure.com", "https://example.openai.azure.com/openai/v1"],
      ["https://example.openai.azure.com/openai/v1", "https://example.openai.azure.com/openai/v1"],
      ["https://example.services.ai.azure.com", "https://example.services.ai.azure.com/openai/v1"],
      [
        "https://example.cognitiveservices.azure.com",
        "https://example.cognitiveservices.azure.com/openai/v1",
      ],
    ] as const;

    for (const [input, expected] of cases) {
      expect(normalizeAzureOpenAIBaseUrl(input)).toBe(expected);
    }
  });

  it("rejects non-Azure hosts", () => {
    expect(() => normalizeAzureOpenAIBaseUrl("https://api.openai.com/v1")).toThrow(
      /Azure OpenAI base URL must use an Azure host/i,
    );
  });

  it("rejects non-HTTPS base URLs", () => {
    expect(() => normalizeAzureOpenAIBaseUrl("http://example.openai.azure.com/openai/v1")).toThrow(
      /Azure OpenAI base URL must use HTTPS/i,
    );
  });
  it("rejects empty model IDs", () => {
    expect(() => normalizeAzureOpenAIModelId("   ")).toThrow(/deployment\/model ID is required/i);
  });

  it("validates apiVersion input", () => {
    expect(normalizeAzureOpenAIApiVersion(" 2025-04-01-preview ")).toBe("2025-04-01-preview");
    expect(() => normalizeAzureOpenAIApiVersion("  ")).toThrow(/API version/i);
  });

  it("applies provider + default model config", () => {
    const cfg = applyAzureOpenAIConfig(
      {},
      {
        baseUrl: "https://example.openai.azure.com/openai/v1",
        modelId: "gpt-4.1",
        apiVersion: "2025-04-01-preview",
      },
    );

    expect(cfg.models?.providers?.["azure-openai-responses"]?.api).toBe("openai-responses");
    expect(cfg.models?.providers?.["azure-openai-responses"]?.baseUrl).toBe(
      "https://example.openai.azure.com/openai/v1",
    );
    expect(cfg.agents?.defaults?.models?.["azure-openai-responses/gpt-4.1"]?.params).toMatchObject({
      azureApiVersion: "2025-04-01-preview",
    });
    expect(cfg.agents?.defaults?.model).toEqual({ primary: "azure-openai-responses/gpt-4.1" });
  });

  it("uses default v1 apiVersion without adding explicit params", () => {
    const cfg = applyAzureOpenAIConfig(
      {},
      {
        baseUrl: "https://example.openai.azure.com/openai/v1",
        modelId: "gpt-4.1",
        apiVersion: AZURE_OPENAI_DEFAULT_API_VERSION,
      },
    );
    expect(cfg.agents?.defaults?.models?.["azure-openai-responses/gpt-4.1"]?.params).toEqual({});
  });

  it("assigns GPT-5.4 class token limits to Azure model definitions", () => {
    const cfg = applyAzureOpenAIConfig(
      {},
      {
        baseUrl: "https://example.openai.azure.com/openai/v1",
        modelId: "gpt-5.4",
      },
    );
    const model = cfg.models?.providers?.["azure-openai-responses"]?.models?.find(
      (entry) => entry.id === "gpt-5.4",
    );
    expect(model?.contextWindow).toBe(1_050_000);
    expect(model?.maxTokens).toBe(128_000);
  });

  it("keeps baseline token limits for non GPT-5.4 Azure models", () => {
    const cfg = applyAzureOpenAIConfig(
      {},
      {
        baseUrl: "https://example.openai.azure.com/openai/v1",
        modelId: "gpt-4.1",
      },
    );
    const model = cfg.models?.providers?.["azure-openai-responses"]?.models?.find(
      (entry) => entry.id === "gpt-4.1",
    );
    expect(model?.contextWindow).toBe(200000);
    expect(model?.maxTokens).toBe(8192);
  });

  it("marks Azure GPT-5.4 class models as xhigh + modern", () => {
    expect(supportsAzureOpenAIXHighThinking("gpt-5.4")).toBe(true);
    expect(supportsAzureOpenAIXHighThinking("gpt-5.4-pro")).toBe(true);
    expect(supportsAzureOpenAIXHighThinking("gpt-4.1")).toBe(false);
    expect(isAzureOpenAIModernModelRef("gpt-5.4")).toBe(true);
    expect(isAzureOpenAIModernModelRef("gpt-5.4-pro")).toBe(true);
    expect(isAzureOpenAIModernModelRef("gpt-4.1")).toBe(false);
  });
});
