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
  it("keeps case-distinct catalog display identities with shared names", () => {
    const labels = ["Shared name · model-a · custom", "Shared name · Model-A · custom"];
    const entries = ["model-a", "Model-A"].map((id) => ({
      id,
      name: "Shared name",
      provider: "custom",
    }));
    const lookup = buildCatalogDisplayLookup(entries);

    expect(entries.map((entry) => buildChatModelOptionFromLookup(entry, lookup))).toEqual([
      { value: "custom/model-a", label: labels[0] },
      { value: "custom/Model-A", label: labels[1] },
    ]);
    expect(formatCatalogChatModelDisplayFromLookup("CUSTOM/Model-A", lookup)).toBe(labels[1]);
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
