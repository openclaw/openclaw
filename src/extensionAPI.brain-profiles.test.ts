import { describe, expect, it } from "vitest";
import {
  DEFAULT_BRAIN_PROFILES,
  LEGACY_TIER_ROUTING,
  resolveBrainProfileForMode,
} from "./extensionAPI.js";

describe("extensionAPI brain profile exports", () => {
  it("exports provider-neutral brain profile helpers", () => {
    expect(DEFAULT_BRAIN_PROFILES["openai-codex-subscription-best"].modelRef).toBe(
      "openai-codex/gpt-5.5",
    );
    expect(LEGACY_TIER_ROUTING.economy).toBe("legacy-anthropic-haiku");
    expect(
      resolveBrainProfileForMode(
        {
          globalMode: "einstein",
          agentOverrides: {},
          tierRouting: LEGACY_TIER_ROUTING,
          brainProfiles: DEFAULT_BRAIN_PROFILES,
        },
        "einstein",
      ).modelRef,
    ).toBe("anthropic/claude-opus-4-6");
  });
});
