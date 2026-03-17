import { describe, expect, it } from "vitest";
import {
  buildChatModelOption,
  buildQualifiedChatModelValue,
  createChatModelOverride,
  formatChatModelDisplay,
  normalizeChatModelOverrideValue,
  resolveServerChatModelValue,
} from "./chat-model-ref.ts";
import type { ModelCatalogEntry } from "./types.ts";

const catalog: ModelCatalogEntry[] = [
  { id: "gpt-5-mini", name: "GPT-5 Mini", provider: "openai" },
  { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", provider: "anthropic" },
];

describe("chat-model-ref helpers", () => {
  it("builds provider-qualified option values and labels", () => {
    expect(buildChatModelOption(catalog[0])).toEqual({
      value: "openai/gpt-5-mini",
      label: "gpt-5-mini · openai",
    });
  });

  it("normalizes raw overrides when the catalog match is unique", () => {
    expect(normalizeChatModelOverrideValue(createChatModelOverride("gpt-5-mini"), catalog)).toBe(
      "openai/gpt-5-mini",
    );
  });

  it("keeps ambiguous raw overrides unchanged", () => {
    const ambiguousCatalog: ModelCatalogEntry[] = [
      { id: "gpt-5-mini", name: "GPT-5 Mini", provider: "openai" },
      { id: "gpt-5-mini", name: "GPT-5 Mini", provider: "openrouter" },
    ];

    expect(
      normalizeChatModelOverrideValue(createChatModelOverride("gpt-5-mini"), ambiguousCatalog),
    ).toBe("gpt-5-mini");
  });

  it("formats qualified model refs consistently for default labels", () => {
    expect(formatChatModelDisplay("openai/gpt-5-mini")).toBe("gpt-5-mini · openai");
    expect(formatChatModelDisplay("alias-only")).toBe("alias-only");
  });

  it("resolves server session data to qualified option values", () => {
    expect(resolveServerChatModelValue("gpt-5-mini", "openai")).toBe("openai/gpt-5-mini");
    expect(resolveServerChatModelValue("alias-only", null)).toBe("alias-only");
  });

  describe("buildQualifiedChatModelValue — already-qualified IDs", () => {
    it("does not double-prefix when model already contains a provider separator", () => {
      // Scenario: session modelProvider is "openrouter" but stored model is
      // already the fully-qualified "llamacpp/qwen3-14b.gguf".
      expect(buildQualifiedChatModelValue("llamacpp/qwen3-14b.gguf", "openrouter")).toBe(
        "llamacpp/qwen3-14b.gguf",
      );
    });

    it("does not double-prefix ollama models routed through openrouter", () => {
      expect(buildQualifiedChatModelValue("ollama/qwen3:14b", "openrouter")).toBe(
        "ollama/qwen3:14b",
      );
    });

    it("does not double-prefix free models whose IDs already carry a vendor prefix", () => {
      expect(
        buildQualifiedChatModelValue("nvidia/llama-3.1-nemotron-70b-instruct:free", "openrouter"),
      ).toBe("nvidia/llama-3.1-nemotron-70b-instruct:free");
    });

    it("still qualifies a bare model ID with its provider", () => {
      expect(buildQualifiedChatModelValue("gpt-5-mini", "openai")).toBe("openai/gpt-5-mini");
    });
  });

  describe("buildChatModelOption — already-qualified catalog entries", () => {
    it("uses the id as-is when it is already provider-qualified", () => {
      const entry: ModelCatalogEntry = {
        id: "llamacpp/qwen3-14b.gguf",
        name: "Qwen3 14B",
        provider: "openrouter",
      };
      expect(buildChatModelOption(entry)).toEqual({
        value: "llamacpp/qwen3-14b.gguf",
        label: "llamacpp/qwen3-14b.gguf · openrouter",
      });
    });
  });

  describe("resolveServerChatModelValue — already-qualified model from session row", () => {
    it("does not prepend provider when stored model is already qualified", () => {
      // After a user switches to "llamacpp/qwen3-14b.gguf" the gateway may
      // store the full string as model while keeping modelProvider="openrouter".
      expect(resolveServerChatModelValue("llamacpp/qwen3-14b.gguf", "openrouter")).toBe(
        "llamacpp/qwen3-14b.gguf",
      );
    });
  });
});
