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

  describe("buildQualifiedChatModelValue — double-prefix prevention", () => {
    it("does not double-prefix when stored model already starts with the provider prefix", () => {
      // Scenario: session stored model is already "openrouter/llamacpp/qwen3-14b.gguf";
      // calling buildQualifiedChatModelValue with provider "openrouter" must not produce
      // "openrouter/openrouter/llamacpp/qwen3-14b.gguf".
      expect(
        buildQualifiedChatModelValue("openrouter/llamacpp/qwen3-14b.gguf", "openrouter"),
      ).toBe("openrouter/llamacpp/qwen3-14b.gguf");
    });

    it("does not double-prefix when stored ollama model already carries provider prefix", () => {
      expect(buildQualifiedChatModelValue("openrouter/ollama/qwen3:14b", "openrouter")).toBe(
        "openrouter/ollama/qwen3:14b",
      );
    });

    it("correctly qualifies a catalog entry whose id contains a vendor sub-prefix", () => {
      // "nvidia/llama-3.1:free" is a catalog id under openrouter — it is NOT already
      // qualified; the provider prefix must be prepended so the backend can route it.
      expect(
        buildQualifiedChatModelValue("nvidia/llama-3.1-nemotron-70b-instruct:free", "openrouter"),
      ).toBe("openrouter/nvidia/llama-3.1-nemotron-70b-instruct:free");
    });

    it("still qualifies a bare model ID with its provider", () => {
      expect(buildQualifiedChatModelValue("gpt-5-mini", "openai")).toBe("openai/gpt-5-mini");
    });
  });

  describe("buildChatModelOption — catalog entries with slash-containing ids", () => {
    it("qualifies catalog entry id with its provider even when id contains a slash", () => {
      // The catalog stores id="llamacpp/qwen3-14b.gguf" with provider="openrouter".
      // buildChatModelOption must produce "openrouter/llamacpp/qwen3-14b.gguf" so the
      // backend can validate the model against the openrouter allowlist.
      const entry: ModelCatalogEntry = {
        id: "llamacpp/qwen3-14b.gguf",
        name: "Qwen3 14B",
        provider: "openrouter",
      };
      expect(buildChatModelOption(entry)).toEqual({
        value: "openrouter/llamacpp/qwen3-14b.gguf",
        label: "llamacpp/qwen3-14b.gguf · openrouter",
      });
    });
  });

  describe("resolveServerChatModelValue — stored model from session row", () => {
    it("prepends provider to a stored bare model id", () => {
      // The gateway stores model="llamacpp/qwen3-14b.gguf" with modelProvider="openrouter".
      // resolveServerChatModelValue must reconstruct the full qualified value.
      expect(resolveServerChatModelValue("llamacpp/qwen3-14b.gguf", "openrouter")).toBe(
        "openrouter/llamacpp/qwen3-14b.gguf",
      );
    });

    it("does not double-prefix a stored model that is already fully qualified", () => {
      expect(
        resolveServerChatModelValue("openrouter/llamacpp/qwen3-14b.gguf", "openrouter"),
      ).toBe("openrouter/llamacpp/qwen3-14b.gguf");
    });
  });
});
