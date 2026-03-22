import { describe, expect, it } from "vitest";
import { resolveDiscordPreviewStreamMode } from "./discord-preview-streaming.js";

describe("resolveDiscordPreviewStreamMode", () => {
  it("defaults to off when unset", () => {
    expect(resolveDiscordPreviewStreamMode({})).toBe("off");
  });

  it("preserves explicit off", () => {
    expect(resolveDiscordPreviewStreamMode({ streaming: "off" })).toBe("off");
    expect(resolveDiscordPreviewStreamMode({ streamMode: "off" })).toBe("off");
    expect(resolveDiscordPreviewStreamMode({ streaming: false })).toBe("off");
  });
});
