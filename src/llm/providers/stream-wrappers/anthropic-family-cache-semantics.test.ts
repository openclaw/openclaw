import { describe, expect, it } from "vitest";
import { resolveAnthropicCacheRetentionFamily } from "./anthropic-family-cache-semantics.js";

describe("Anthropic cache semantics", () => {
  it.each(["claude-sonnet-4-6", "anthropic/claude-opus-4-6", "litellm/claude-haiku-4-6"])(
    "does not infer LiteLLM cache capability from model name %s",
    (modelId) => {
      expect(
        resolveAnthropicCacheRetentionFamily({
          provider: "litellm",
          modelId,
          modelApi: "openai-completions",
          hasExplicitCacheConfig: true,
        }),
      ).toBeUndefined();
    },
  );

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
