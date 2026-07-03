import { describe, expect, it } from "vitest";
import {
  isLiteLLMAnthropicModel,
  resolveAnthropicCacheRetentionFamily,
} from "./anthropic-family-cache-semantics.js";

describe("LiteLLM Anthropic cache semantics", () => {
  it("recognizes Claude model IDs that LiteLLM commonly routes to Anthropic", () => {
    expect(isLiteLLMAnthropicModel("claude-sonnet-4-6")).toBe(true);
    expect(isLiteLLMAnthropicModel("anthropic/claude-opus-4-6")).toBe(true);
    expect(isLiteLLMAnthropicModel("litellm/claude-haiku-4-6")).toBe(true);
  });

  it("rejects non-Claude LiteLLM model IDs", () => {
    expect(isLiteLLMAnthropicModel("gpt-5.5")).toBe(false);
    expect(isLiteLLMAnthropicModel("gemini-3-pro")).toBe(false);
    expect(isLiteLLMAnthropicModel("mistral-large")).toBe(false);
  });

  it("classifies explicit LiteLLM Claude cache config as custom Anthropic API semantics", () => {
    expect(
      resolveAnthropicCacheRetentionFamily({
        provider: "litellm",
        modelId: "claude-sonnet-4-6",
        modelApi: "openai-completions",
        hasExplicitCacheConfig: true,
      }),
    ).toBe("custom-anthropic-api");
    expect(
      resolveAnthropicCacheRetentionFamily({
        provider: "litellm",
        modelId: "anthropic/claude-opus-4-6",
        modelApi: "openai-completions",
        hasExplicitCacheConfig: true,
      }),
    ).toBe("custom-anthropic-api");
  });

  it("does not opt LiteLLM into Anthropic cache semantics without explicit config", () => {
    expect(
      resolveAnthropicCacheRetentionFamily({
        provider: "litellm",
        modelId: "claude-sonnet-4-6",
        modelApi: "openai-completions",
        hasExplicitCacheConfig: false,
      }),
    ).toBeUndefined();
  });

  it("does not opt non-Claude LiteLLM models into Anthropic cache semantics", () => {
    expect(
      resolveAnthropicCacheRetentionFamily({
        provider: "litellm",
        modelId: "gpt-5.5",
        modelApi: "openai-completions",
        hasExplicitCacheConfig: true,
      }),
    ).toBeUndefined();
  });
});
