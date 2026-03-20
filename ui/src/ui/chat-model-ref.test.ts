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

  describe("buildQualifiedChatModelValue — double-prefix guard", () => {
    it("prepends provider when model has no prefix", () => {
      expect(buildQualifiedChatModelValue("gpt-5-mini", "openai")).toBe("openai/gpt-5-mini");
    });

    it("does not double-prefix when model already starts with provider/", () => {
      expect(buildQualifiedChatModelValue("moonshotai/kimi-k2.5", "openrouter")).toBe(
        "openrouter/moonshotai/kimi-k2.5",
      );
    });

    it("returns model as-is when it already starts with provider/ (case-insensitive)", () => {
      expect(buildQualifiedChatModelValue("OpenAI/gpt-5-mini", "openai")).toBe("OpenAI/gpt-5-mini");
    });

    it("returns model unchanged when no provider given", () => {
      expect(buildQualifiedChatModelValue("gpt-5-mini", null)).toBe("gpt-5-mini");
      expect(buildQualifiedChatModelValue("gpt-5-mini", "")).toBe("gpt-5-mini");
    });
  });

  describe("buildChatModelOption — openrouter multi-segment model IDs", () => {
    it("builds correct value and label for openrouter model with multi-segment id", () => {
      const entry: ModelCatalogEntry = {
        id: "moonshotai/kimi-k2.5",
        name: "Kimi K2.5",
        provider: "openrouter",
      };
      expect(buildChatModelOption(entry)).toEqual({
        value: "openrouter/moonshotai/kimi-k2.5",
        label: "moonshotai/kimi-k2.5 · openrouter",
      });
    });

    it("does not double-prefix when catalog entry id already contains provider prefix", () => {
      const entry: ModelCatalogEntry = {
        id: "openrouter/moonshotai/kimi-k2.5",
        name: "Kimi K2.5",
        provider: "openrouter",
      };
      expect(buildChatModelOption(entry).value).toBe("openrouter/moonshotai/kimi-k2.5");
    });
  });

  describe("resolveServerChatModelValue — stale session modelProvider (server-side issue)", () => {
    it("reflects whatever provider the server sends", () => {
      expect(resolveServerChatModelValue("gpt-5.2-codex", "openai-codex")).toBe(
        "openai-codex/gpt-5.2-codex",
      );
      // Stale modelProvider (#50585) is a server-side data problem; UI reflects it as-is.
      expect(resolveServerChatModelValue("gpt-5.2-codex", "ollama")).toBe("ollama/gpt-5.2-codex");
    });
  });
});
