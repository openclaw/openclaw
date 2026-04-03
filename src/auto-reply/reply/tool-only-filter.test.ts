import { describe, expect, it } from "vitest";
import { isNonTextVisibleFinal } from "./tool-only-filter.js";

describe("isNonTextVisibleFinal", () => {
  it("returns false for text-only payload", () => {
    expect(isNonTextVisibleFinal({ text: "hello" })).toBe(false);
  });

  it("returns false for empty payload", () => {
    expect(isNonTextVisibleFinal({})).toBe(false);
  });

  it("returns true when mediaUrl is present", () => {
    expect(isNonTextVisibleFinal({ mediaUrl: "https://example.com/img.png" })).toBe(true);
  });

  it("returns true when mediaUrls is present", () => {
    expect(isNonTextVisibleFinal({ mediaUrls: ["a.png", "b.png"] })).toBe(true);
  });

  it("returns true when isError is set", () => {
    expect(isNonTextVisibleFinal({ text: "failed", isError: true })).toBe(true);
  });

  it("returns true when interactive blocks are present", () => {
    expect(
      isNonTextVisibleFinal({
        interactive: {
          blocks: [{ type: "buttons", buttons: [{ label: "OK", value: "ok" }] }],
        },
      }),
    ).toBe(true);
  });

  it("returns false when interactive is empty object", () => {
    expect(isNonTextVisibleFinal({ interactive: {} as never })).toBe(false);
  });

  it("returns true when channelData is non-empty", () => {
    expect(
      isNonTextVisibleFinal({
        channelData: { telegram: { reply_markup: {} } },
      }),
    ).toBe(true);
  });

  it("returns false when channelData is empty object", () => {
    expect(isNonTextVisibleFinal({ channelData: {} })).toBe(false);
  });

  it("returns true when multiple non-text fields are present", () => {
    expect(
      isNonTextVisibleFinal({
        text: "result",
        mediaUrl: "https://example.com/img.png",
        isError: true,
      }),
    ).toBe(true);
  });

  it("returns false for compaction notice (text-only)", () => {
    expect(isNonTextVisibleFinal({ text: "Compacting context...", isCompactionNotice: true })).toBe(
      false,
    );
  });

  it("returns false for reasoning payload (text-only)", () => {
    expect(isNonTextVisibleFinal({ text: "thinking...", isReasoning: true })).toBe(false);
  });
});
