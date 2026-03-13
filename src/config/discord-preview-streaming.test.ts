import { describe, expect, it } from "vitest";
import {
  resolveDiscordPreviewSplitOnAssistantBoundary,
  resolveDiscordPreviewStreamMode,
} from "./discord-preview-streaming.js";

describe("resolveDiscordPreviewStreamMode", () => {
  it("maps progress to partial", () => {
    expect(resolveDiscordPreviewStreamMode({ streaming: "progress" })).toBe("partial");
  });
});

describe("resolveDiscordPreviewSplitOnAssistantBoundary", () => {
  it("defaults to false for partial preview mode", () => {
    expect(resolveDiscordPreviewSplitOnAssistantBoundary({ streaming: "partial" })).toBe(false);
  });

  it("defaults to true for block preview mode", () => {
    expect(resolveDiscordPreviewSplitOnAssistantBoundary({ streaming: "block" })).toBe(true);
  });

  it("accepts an explicit override in partial mode", () => {
    expect(
      resolveDiscordPreviewSplitOnAssistantBoundary({
        streaming: "partial",
        previewSplitOnAssistantBoundary: true,
      }),
    ).toBe(true);
  });

  it("accepts an explicit override in block mode", () => {
    expect(
      resolveDiscordPreviewSplitOnAssistantBoundary({
        streaming: "block",
        previewSplitOnAssistantBoundary: false,
      }),
    ).toBe(false);
  });
});
