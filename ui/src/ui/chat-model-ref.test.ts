import { describe, expect, it } from "vitest";
import {
  buildChatModelOption,
  createChatModelOverride,
  formatChatModelDisplay,
  normalizeChatModelOverrideValue,
  resolveChatModelOverride,
  resolvePreferredServerChatModel,
  resolveServerChatModelValue,
} from "./chat-model-ref.ts";
import {
  createAmbiguousModelCatalog,
  createModelCatalog,
  DEEPSEEK_CHAT_MODEL,
  OPENAI_GPT5_MINI_MODEL,
} from "./chat-model.test-helpers.ts";

const catalog = createModelCatalog(OPENAI_GPT5_MINI_MODEL, {
  id: "claude-sonnet-4-5",
  name: "Claude Sonnet 4.5",
  provider: "anthropic",
});

describe("chat-model-ref helpers", () => {
  it("builds provider-qualified option values and labels", () => {
    expect(buildChatModelOption(catalog[0])).toEqual({
      value: "openai/gpt-5-mini",
      label: "gpt-5-mini · openai",
    });
  });

  it("preserves already-qualified model refs without prepending provider", () => {
    expect(resolveServerChatModelValue("ollama/qwen3:30b", "openai-codex")).toBe(
      "ollama/qwen3:30b",
    );
  });

  it("prefixes provider-native model ids that already contain slashes", () => {
    expect(
      buildChatModelOption({
        id: "google/gemma-4-26b-a4b-it",
        provider: "openrouter",
      } as never),
    ).toEqual({
      value: "openrouter/google/gemma-4-26b-a4b-it",
      label: "google/gemma-4-26b-a4b-it · openrouter",
    });
    expect(
      resolvePreferredServerChatModel("Google/Gemma-4-26b-a4b-it", "openrouter", [
        { id: "google/gemma-4-26b-a4b-it", provider: "openrouter" } as never,
      ]),
    ).toEqual({
      value: "openrouter/google/gemma-4-26b-a4b-it",
      source: "server",
    });
  });

  it("reuses already-qualified catalog ids without double-prefixing them", () => {
    expect(
      resolvePreferredServerChatModel("OpenAI/GPT-4O", "openai", [
        { id: "openai/gpt-4o", provider: "openai" } as never,
      ]),
    ).toEqual({
      value: "openai/gpt-4o",
      source: "server",
    });
  });

  it("normalizes raw overrides when the catalog match is unique", () => {
    expect(normalizeChatModelOverrideValue(createChatModelOverride("gpt-5-mini"), catalog)).toBe(
      "openai/gpt-5-mini",
    );
  });

  it("keeps ambiguous raw overrides unchanged", () => {
    expect(
      normalizeChatModelOverrideValue(
        createChatModelOverride("gpt-5-mini"),
        createAmbiguousModelCatalog("gpt-5-mini", "openai", "openrouter"),
      ),
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

  it("reports the override resolution source for unique catalog matches", () => {
    expect(resolveChatModelOverride(createChatModelOverride("gpt-5-mini"), catalog)).toEqual({
      value: "openai/gpt-5-mini",
      source: "catalog",
    });
  });

  it("reports ambiguous raw overrides without guessing a provider", () => {
    expect(
      resolveChatModelOverride(
        createChatModelOverride("gpt-5-mini"),
        createAmbiguousModelCatalog("gpt-5-mini", "openai", "openrouter"),
      ),
    ).toEqual({
      value: "gpt-5-mini",
      source: "raw",
      reason: "ambiguous",
    });
  });

  it("prefers the catalog provider over a stale server provider when the match is unique", () => {
    expect(resolvePreferredServerChatModel("deepseek-chat", "zai", [DEEPSEEK_CHAT_MODEL])).toEqual({
      value: "deepseek/deepseek-chat",
      source: "catalog",
    });
  });

  it("falls back to the server provider when the catalog misses or is ambiguous", () => {
    expect(resolvePreferredServerChatModel("gpt-5-mini", "openai", [])).toEqual({
      value: "openai/gpt-5-mini",
      source: "server",
      reason: "missing",
    });
    expect(
      resolvePreferredServerChatModel(
        "gpt-5-mini",
        "openai",
        createAmbiguousModelCatalog("gpt-5-mini", "openai", "openrouter"),
      ),
    ).toEqual({
      value: "openai/gpt-5-mini",
      source: "server",
    });
  });
});
