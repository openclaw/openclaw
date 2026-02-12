import { describe, expect, it } from "vitest";
import { splitMediaFromOutput } from "./parse.js";

describe("splitMediaFromOutput - Reproduction of #13790", () => {
  it("should extract MEDIA from text even when preceded by text", () => {
    const input = "Here is your audio:\nMEDIA:/tmp/tts-123/voice.opus";
    const result = splitMediaFromOutput(input);
    expect(result.mediaUrls).toEqual(["/tmp/tts-123/voice.opus"]);
    expect(result.text).toBe("Here is your audio:");
  });

  it("should extract inline MEDIA tokens in the same line", () => {
    const input = "Here is your audio: MEDIA:/tmp/tts-123/voice.opus";
    const result = splitMediaFromOutput(input);
    expect(result.mediaUrls).toEqual(["/tmp/tts-123/voice.opus"]);
    expect(result.text).toBe("Here is your audio:");
  });

  it("should handle MEDIA with a space after the colon", () => {
    const input = "MEDIA: /tmp/tts-123/voice.opus";
    const result = splitMediaFromOutput(input);
    expect(result.mediaUrls).toEqual(["/tmp/tts-123/voice.opus"]);
  });

  it("should NOT extract MEDIA from inside code fences (baseline check)", () => {
    const input = "```txt\nMEDIA:/tmp/tts-123/voice.opus\n```";
    const result = splitMediaFromOutput(input);
    expect(result.mediaUrls).toBeUndefined();
    expect(result.text).toContain("MEDIA:/tmp/tts-123/voice.opus");
  });
});
