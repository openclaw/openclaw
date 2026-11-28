// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  createAmbiguousModelCatalog,
  OPENAI_GPT5_MINI_MODEL,
} from "../../test-helpers/chat-model.ts";
import {
  buildCatalogDisplayLookup,
  buildChatModelOptionFromLookup,
  buildQualifiedChatModelValue,
  formatCatalogChatModelDisplayFromLookup,
  normalizeChatModelOverrideValue,
  resolvePreferredServerChatModelValue as resolve,
} from "./model-ref.ts";

const ambiguous = createAmbiguousModelCatalog("gpt-5-mini", "openai", "openrouter");

describe("chat-model-ref helpers", () => {
  it.each([
    ["claude-cli", "Opus 5.5", "opus", "Opus 5.5"],
    ["claude-cli", "Sonnet 5.5", "sonnet", "Sonnet 5.5"],
    ["anthropic", "Claude Opus 5.5", " OPUS ", "Claude Opus 5.5"],
    ["openai", "GPT-5.5", "gpt", "GPT-5.5"],
    ["example", "Opus 5.5", "op", "Opus 5.5 · op"],
    ["example", "Octopus 5.5", "opus", "Octopus 5.5 · opus"],
    ["example", "Opus 5.5", "opus-prod", "Opus 5.5 · opus-prod"],
    ["example", "Opus 5.5", "writing", "Opus 5.5 · writing"],
    ["example", "Opus 5.5", "5.5", "Opus 5.5 · 5.5"],
    ["example", "Opus 5.5 writing", "writing", "Opus 5.5 writing · writing"],
    ["example", "Opus 5.5", "Opus 5.5 (custom)", "Opus 5.5 (custom)"],
    ["clawrouter", "Opus 5.5 via ClawRouter", "opus", "Opus 5.5"],
    ["clawrouter", "Example Model via ClawRouter", "Example Model", "Example Model"],
    ["clawrouter", "Example Model", "Example Model via ClawRouter", "Example Model"],
    ["clawrouter", "Example Model", "Example Model", "Example Model"],
    [
      "example",
      "Example Model via ClawRouter",
      "Example Model via ClawRouter",
      "Example Model via ClawRouter",
    ],
  ])("formats %s catalog name %s with alias %s", (provider, name, alias, label) => {
    const entry = { id: "vendor/example", provider, name, alias };
    const lookup = buildCatalogDisplayLookup([entry]);
    expect(buildChatModelOptionFromLookup(entry, lookup)).toEqual({
      value: `${provider}/vendor/example`,
      label,
    });
  });

  it("keeps shared names model-only across providers while disambiguating duplicates within one provider", () => {
    const entries = [
      { id: "claude-opus-5-5", name: "Claude Opus 5.5", provider: "anthropic" },
      {
        id: "anthropic/claude-opus-5-5",
        name: "Claude Opus 5.5 via ClawRouter",
        provider: "clawrouter",
      },
      { id: "model-a", name: "Shared name", provider: "custom" },
      { id: "Model-A", name: "Shared name", provider: "custom" },
    ];
    const lookup = buildCatalogDisplayLookup(entries);

    expect(entries.map((entry) => buildChatModelOptionFromLookup(entry, lookup))).toEqual([
      { value: "anthropic/claude-opus-5-5", label: "Claude Opus 5.5" },
      { value: "clawrouter/anthropic/claude-opus-5-5", label: "Claude Opus 5.5" },
      { value: "custom/model-a", label: "Shared name · model-a" },
      { value: "custom/Model-A", label: "Shared name · Model-A" },
    ]);
    expect(formatCatalogChatModelDisplayFromLookup("CUSTOM/Model-A", lookup)).toBe(
      "Shared name · Model-A",
    );
    expect(formatCatalogChatModelDisplayFromLookup("custom/MODEL-A", lookup)).toBe(
      "MODEL-A · custom",
    );
  });

  it("keeps ambiguous raw overrides unchanged", () => {
    expect(normalizeChatModelOverrideValue("gpt-5-mini", ambiguous)).toBe("gpt-5-mini");
  });

  it("does not double-prefix provider-native catalog ids", () => {
    expect(buildQualifiedChatModelValue("openrouter/auto", "openrouter")).toBe("openrouter/auto");
  });

  it.each([
    ["gpt-5-mini", "openai", [], "openai/gpt-5-mini"],
    ["gpt-5-mini", "openai", ambiguous, "openai/gpt-5-mini"],
    [
      "google/gemma-4-26b-a4b-it",
      "openrouter",
      createAmbiguousModelCatalog("google/gemma-4-26b-a4b-it", "google", "openrouter"),
      "openrouter/google/gemma-4-26b-a4b-it",
    ],
    [
      "moonshotai/kimi-k2.5",
      "zai",
      createAmbiguousModelCatalog("moonshotai/kimi-k2.5", "nvidia"),
      "nvidia/moonshotai/kimi-k2.5",
    ],
    ["openai/gpt-5-mini", "openai", [OPENAI_GPT5_MINI_MODEL], "openai/gpt-5-mini"],
    ["openai/gpt-5-mini", "zai", [], "openai/gpt-5-mini"],
    ["gpt-5-mini", null, [OPENAI_GPT5_MINI_MODEL], "openai/gpt-5-mini"],
  ])(
    "resolves server model %s with provider %s and catalog %j",
    (model, provider, catalog, expected) => {
      expect(resolve(model, provider, catalog)).toBe(expected);
    },
  );
});
