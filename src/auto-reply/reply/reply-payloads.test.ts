import { describe, expect, it } from "vitest";
import { isRenderablePayload } from "./reply-payloads.js";

describe("isRenderablePayload", () => {
  it("returns true for text payload", () => {
    expect(isRenderablePayload({ text: "hello" })).toBe(true);
  });

  it("returns false for empty text with no media", () => {
    expect(isRenderablePayload({ text: "" })).toBe(false);
  });

  it("returns false for undefined text", () => {
    expect(isRenderablePayload({})).toBe(false);
  });

  it("returns true for mediaUrl only", () => {
    expect(isRenderablePayload({ mediaUrl: "https://x.test/a.png" })).toBe(true);
  });

  it("returns true for mediaUrls array", () => {
    expect(isRenderablePayload({ mediaUrls: ["https://x.test/a.png"] })).toBe(true);
  });

  it("returns false for empty mediaUrls", () => {
    expect(isRenderablePayload({ mediaUrls: [] })).toBe(false);
  });

  it("returns true for audioAsVoice", () => {
    expect(isRenderablePayload({ audioAsVoice: "https://x.test/a.ogg" })).toBe(true);
  });

  it("returns true for channelData", () => {
    expect(isRenderablePayload({ channelData: { line: { msg: "flex" } } })).toBe(true);
  });

  it("returns false for empty object", () => {
    expect(isRenderablePayload({})).toBe(false);
  });
});
