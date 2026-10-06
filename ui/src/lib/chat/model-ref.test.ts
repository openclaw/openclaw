// @vitest-environment node
// Control UI tests cover chat model ref behavior.
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
  resolvePreferredServerChatModelValue,
} from "./model-ref.ts";

describe("chat-model-ref helpers", () => {
  it.each([
    {
      names: ["Lowercase model", "Uppercase model"],
      labels: ["Lowercase model", "Uppercase model"],
    },
    {
      names: ["Shared name", "Shared name"],
      labels: ["Shared name · model-a · custom", "Shared name · Model-A · custom"],
    },
  ] as const)(
    "keeps case-distinct catalog display identities with names $names",
    ({ names, labels }) => {
      const entries = [
        { id: "model-a", name: names[0], provider: "custom" },
        { id: "Model-A", name: names[1], provider: "custom" },
      ];
      const lookup = buildCatalogDisplayLookup(entries);

      expect(entries.map((entry) => buildChatModelOptionFromLookup(entry, lookup))).toEqual([
        { value: "custom/model-a", label: labels[0] },
        { value: "custom/Model-A", label: labels[1] },
      ]);
      expect(formatCatalogChatModelDisplayFromLookup("CUSTOM/Model-A", lookup)).toBe(labels[1]);
      expect(formatCatalogChatModelDisplayFromLookup("custom/MODEL-A", lookup)).toBe(
        "MODEL-A · custom",
      );
    },
  );

  it("keeps ambiguous raw overrides unchanged", () => {
    expect(
      normalizeChatModelOverrideValue(
        "gpt-5-mini",
        createAmbiguousModelCatalog("gpt-5-mini", "openai", "openrouter"),
      ),
    ).toBe("gpt-5-mini");
  });

  it("does not double-prefix provider-native catalog ids", () => {
    expect(buildQualifiedChatModelValue("openrouter/auto", "openrouter")).toBe("openrouter/auto");
  });

  it("falls back to the server provider when the catalog misses or is ambiguous", () => {
    expect(resolvePreferredServerChatModelValue("gpt-5-mini", "openai", [])).toBe(
      "openai/gpt-5-mini",
    );
    expect(
      resolvePreferredServerChatModelValue(
        "gpt-5-mini",
        "openai",
        createAmbiguousModelCatalog("gpt-5-mini", "openai", "openrouter"),
      ),
    ).toBe("openai/gpt-5-mini");
  });

  it("qualifies slash-containing server model ids with the recorded provider", () => {
    expect(
      resolvePreferredServerChatModelValue("moonshotai/kimi-k2.5", "nvidia", [
        {
          id: "moonshotai/kimi-k2.5",
          name: "Kimi K2.5 (NVIDIA)",
          provider: "nvidia",
        },
      ]),
    ).toBe("nvidia/moonshotai/kimi-k2.5");
  });

  it("uses the recorded provider when a slash-containing id exists under multiple providers", () => {
    expect(
      resolvePreferredServerChatModelValue("google/gemma-4-26b-a4b-it", "openrouter", [
        {
          id: "google/gemma-4-26b-a4b-it",
          name: "Gemma 4",
          provider: "google",
        },
        {
          id: "google/gemma-4-26b-a4b-it",
          name: "Gemma 4",
          provider: "openrouter",
        },
      ]),
    ).toBe("openrouter/google/gemma-4-26b-a4b-it");
  });

  it("uses the catalog-backed provider for slash-containing nested ids before stale provider fallback", () => {
    expect(
      resolvePreferredServerChatModelValue("moonshotai/kimi-k2.5", "zai", [
        {
          id: "moonshotai/kimi-k2.5",
          name: "Kimi K2.5 (NVIDIA)",
          provider: "nvidia",
        },
      ]),
    ).toBe("nvidia/moonshotai/kimi-k2.5");
  });

  it("falls back to the server-qualified value for slash-containing ids when the catalog is empty", () => {
    expect(resolvePreferredServerChatModelValue("moonshotai/kimi-k2.5", "nvidia", [])).toBe(
      "moonshotai/kimi-k2.5",
    );
  });

  it("preserves already-qualified server model values when the provider matches", () => {
    expect(
      resolvePreferredServerChatModelValue("openai/gpt-5-mini", "openai", [OPENAI_GPT5_MINI_MODEL]),
    ).toBe("openai/gpt-5-mini");
  });

  it("preserves already-qualified server model values when the provider is stale", () => {
    expect(
      resolvePreferredServerChatModelValue("openai/gpt-5-mini", "zai", [OPENAI_GPT5_MINI_MODEL]),
    ).toBe("openai/gpt-5-mini");
  });

  it("preserves already-qualified server model values when the provider is stale and the catalog is empty", () => {
    expect(resolvePreferredServerChatModelValue("openai/gpt-5-mini", "zai", [])).toBe(
      "openai/gpt-5-mini",
    );
  });

  it("keeps nested provider-qualified server values stable when the catalog already confirms them", () => {
    const nestedModel = {
      id: "deepseek-ai/deepseek-v3.2",
      name: "DeepSeek V3.2",
      provider: "nvidia",
    };

    expect(
      resolvePreferredServerChatModelValue("nvidia/deepseek-ai/deepseek-v3.2", "nvidia", [
        nestedModel,
      ]),
    ).toBe("nvidia/deepseek-ai/deepseek-v3.2");
  });

  it("uses catalog resolution for provider-less raw server model values", () => {
    expect(resolvePreferredServerChatModelValue("gpt-5-mini", null, [OPENAI_GPT5_MINI_MODEL])).toBe(
      "openai/gpt-5-mini",
    );
  });
});
