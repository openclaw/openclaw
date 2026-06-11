import { describe, expect, it } from "vitest";
import {
  PATTERN_LAB_DISCORD_NAMESPACE,
  buildPatternLabDiscordCallbackData,
} from "./pattern-lab-discord-interactions.js";

describe("Pattern Lab Discord interactions", () => {
  it("builds namespaced callback payloads for review buttons", () => {
    const callbackData = buildPatternLabDiscordCallbackData({
      action: "regenerate",
      assetType: "thumbnail",
      videoId: "01",
      filename: "images/thumbnail_candidate_a.png",
      reason: "owner requested another candidate",
    });

    expect(callbackData.startsWith(`${PATTERN_LAB_DISCORD_NAMESPACE}:`)).toBe(true);
    const payload = JSON.parse(callbackData.slice(`${PATTERN_LAB_DISCORD_NAMESPACE}:`.length));
    expect(payload).toEqual({
      action: "regenerate",
      assetType: "thumbnail",
      videoId: "01",
      filename: "images/thumbnail_candidate_a.png",
      reason: "owner requested another candidate",
    });
  });

  it("rejects unsupported asset types before button creation", () => {
    expect(() =>
      buildPatternLabDiscordCallbackData({
        action: "approve",
        assetType: "script",
        videoId: "01",
      }),
    ).toThrow(/Unsupported Pattern Lab asset type/);
  });
});
