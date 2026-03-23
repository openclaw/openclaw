import { describe, expect, it } from "vitest";
import {
  buildStructuredInlineButtonsChannelData,
  supportsStructuredInlineButtonsSurface,
} from "./inline-buttons.js";

describe("inline button surfaces", () => {
  it("supports telegram and poros as structured button surfaces", () => {
    expect(supportsStructuredInlineButtonsSurface("telegram")).toBe(true);
    expect(supportsStructuredInlineButtonsSurface("poros")).toBe(true);
    expect(supportsStructuredInlineButtonsSurface("discord")).toBe(false);
  });

  it("builds channelData for the active structured surface", () => {
    const buttons = [[{ text: "OpenAI", callback_data: "mdl_list_openai_1" }]];

    expect(buildStructuredInlineButtonsChannelData(buttons, "poros")).toEqual({
      poros: { buttons },
    });
    expect(buildStructuredInlineButtonsChannelData(buttons, "telegram")).toEqual({
      telegram: { buttons },
    });
    expect(buildStructuredInlineButtonsChannelData(buttons, "discord")).toBeUndefined();
  });
});
