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

  it("should not capture trailing text after an inline MEDIA path", () => {
    const input = "Here is your audio: MEDIA:/tmp/voice.opus and enjoy";
    const result = splitMediaFromOutput(input);
    // The parser splits payload by whitespace and validates each part.
    // "/tmp/voice.opus" is valid media, "and" and "enjoy" are not.
    expect(result.mediaUrls).toEqual(["/tmp/voice.opus"]);
    // Trailing non-media words should be preserved in text output
    expect(result.text).toMatch(/and enjoy/);
  });

  it("should support backtick-quoted paths with spaces", () => {
    const input = "MEDIA:`/tmp/file with spaces.opus`";
    const result = splitMediaFromOutput(input);
    expect(result.mediaUrls).toEqual(["/tmp/file with spaces.opus"]);
  });

  it("should handle prose containing MEDIA: mid-sentence", () => {
    const input = "Docs: MEDIA:/tmp/foo.png is used for thumbnails";
    const result = splitMediaFromOutput(input);
    // The inline MEDIA: token should extract the valid path but preserve surrounding prose
    expect(result.mediaUrls).toEqual(["/tmp/foo.png"]);
    expect(result.text).toMatch(/Docs:/);
    expect(result.text).toMatch(/is used for thumbnails/);
  });

  it("should NOT extract MEDIA from inside code fences (baseline check)", () => {
    const input = "```txt\nMEDIA:/tmp/tts-123/voice.opus\n```";
    const result = splitMediaFromOutput(input);
    expect(result.mediaUrls).toBeUndefined();
    expect(result.text).toContain("MEDIA:/tmp/tts-123/voice.opus");
  });
});
