import { describe, expect, it } from "vitest";
import {
  buildQualifiedChatModelValue,
  createChatModelOverride,
  normalizeChatModelOverrideValue,
} from "../ui/src/ui/chat-model-ref.ts";
import type { ModelCatalogEntry } from "../ui/src/ui/types.ts";

describe("chat-model-ref canonical OpenRouter ids", () => {
  const openRouterCatalog: ModelCatalogEntry[] = [
    {
      id: "openrouter/hunter-alpha",
      name: "Hunter Alpha",
      provider: "openrouter",
    },
  ];

  it("does not duplicate the provider prefix when already provider-native", () => {
    expect(buildQualifiedChatModelValue("openrouter/hunter-alpha", "openrouter")).toBe(
      "openrouter/hunter-alpha",
    );
  });

  it("preserves canonical OpenRouter-native ids during override normalization", () => {
    expect(
      normalizeChatModelOverrideValue(
        createChatModelOverride("openrouter/hunter-alpha"),
        openRouterCatalog,
      ),
    ).toBe("openrouter/hunter-alpha");
  });
});
