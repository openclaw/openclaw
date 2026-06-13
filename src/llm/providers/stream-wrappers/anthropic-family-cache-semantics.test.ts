import { describe, expect, it } from "vitest";
import {
  isLiteLLMAnthropicModel,
  resolveAnthropicCacheRetentionFamily,
} from "./anthropic-family-cache-semantics.js";

describe("isLiteLLMAnthropicModel", () => {
  it("matches model IDs containing 'claude'", () => {
    expect(isLiteLLMAnthropicModel("claude-opus-4-6")).toBe(true);
    expect(isLiteLLMAnthropicModel("claude-sonnet-4-6")).toBe(true);
    expect(isLiteLLMAnthropicModel("litellm/claude-opus-4-6")).toBe(true);
  });

  it("matches model IDs starting with 'anthropic/'", () => {
    expect(isLiteLLMAnthropicModel("anthropic/claude-opus-4-6")).toBe(true);
  });

  it("rejects non-Anthropic model IDs", () => {
    expect(isLiteLLMAnthropicModel("gpt-4")).toBe(false);
    expect(isLiteLLMAnthropicModel("gemini-pro")).toBe(false);
    expect(isLiteLLMAnthropicModel("mistral-large")).toBe(false);
  });
});

describe("resolveAnthropicCacheRetentionFamily — LiteLLM", () => {
  it("returns 'custom-anthropic-api' for litellm + claude + explicit cache config", () => {
    const result = resolveAnthropicCacheRetentionFamily({
      provider: "litellm",
      modelId: "claude-opus-4-6",
      hasExplicitCacheConfig: true,
    });
    expect(result).toBe("custom-anthropic-api");
  });

  it("returns 'custom-anthropic-api' for litellm + anthropic/ prefix + explicit cache config", () => {
    const result = resolveAnthropicCacheRetentionFamily({
      provider: "litellm",
      modelId: "anthropic/claude-sonnet-4-6",
      hasExplicitCacheConfig: true,
    });
    expect(result).toBe("custom-anthropic-api");
  });

  it("returns undefined for litellm + non-claude model", () => {
    const result = resolveAnthropicCacheRetentionFamily({
      provider: "litellm",
      modelId: "gpt-4",
      hasExplicitCacheConfig: true,
    });
    expect(result).toBeUndefined();
  });

  it("returns undefined for litellm + claude without explicit cache config", () => {
    const result = resolveAnthropicCacheRetentionFamily({
      provider: "litellm",
      modelId: "claude-opus-4-6",
      hasExplicitCacheConfig: false,
    });
    expect(result).toBeUndefined();
  });

  it("does not affect existing anthropic-direct behavior", () => {
    const result = resolveAnthropicCacheRetentionFamily({
      provider: "anthropic",
      hasExplicitCacheConfig: false,
    });
    expect(result).toBe("anthropic-direct");
  });

  it("does not affect existing custom-anthropic-api via modelApi", () => {
    const result = resolveAnthropicCacheRetentionFamily({
      provider: "openrouter",
      modelApi: "anthropic-messages",
      modelId: "anthropic/claude-sonnet-4-6",
      hasExplicitCacheConfig: true,
    });
    expect(result).toBe("custom-anthropic-api");
  });
});
