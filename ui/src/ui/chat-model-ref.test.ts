import { describe, expect, it } from "vitest";
import {
  buildChatModelOption,
  createChatModelOverride,
  formatCatalogChatModelDisplay,
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
  it("builds provider-qualified option values and prefers catalog names for labels", () => {
    expect(buildChatModelOption(catalog[0], catalog)).toEqual({
      value: "openai/gpt-5-mini",
      label: "GPT-5 Mini",
    });
  });

  it("uses friendly catalog names for qualified nested model ids", () => {
    const nestedModel = {
      id: "moonshotai/kimi-k2.5",
      name: "Kimi K2.5 (NVIDIA)",
      provider: "nvidia",
    };
    expect(buildChatModelOption(nestedModel, [nestedModel])).toEqual({
      value: "nvidia/moonshotai/kimi-k2.5",
      label: "Kimi K2.5 (NVIDIA)",
    });
    expect(formatCatalogChatModelDisplay("nvidia/moonshotai/kimi-k2.5", [nestedModel])).toBe(
      "Kimi K2.5 (NVIDIA)",
    );
  });

  it("disambiguates duplicate friendly names with the provider", () => {
    const duplicateNameCatalog = createModelCatalog(
      {
        id: "claude-3-7-sonnet",
        name: "Claude Sonnet",
        provider: "anthropic",
      },
      {
        id: "claude-3-7-sonnet",
        name: "Claude Sonnet",
        provider: "openrouter",
      },
    );

    expect(buildChatModelOption(duplicateNameCatalog[0], duplicateNameCatalog)).toEqual({
      value: "anthropic/claude-3-7-sonnet",
      label: "Claude Sonnet · anthropic",
    });
    expect(
      formatCatalogChatModelDisplay("openrouter/claude-3-7-sonnet", duplicateNameCatalog),
    ).toBe("Claude Sonnet · openrouter");
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
      reason: "ambiguous",
    });
  });

  it("does not treat slash-containing server model ids as already provider-qualified", () => {
    expect(
      resolvePreferredServerChatModel("moonshotai/kimi-k2.5", "nvidia", [
        {
          id: "moonshotai/kimi-k2.5",
          name: "Kimi K2.5 (NVIDIA)",
          provider: "nvidia",
        },
      ]),
    ).toEqual({
      value: "nvidia/moonshotai/kimi-k2.5",
      source: "catalog",
    });
  });
});
