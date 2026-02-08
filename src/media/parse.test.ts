import { describe, expect, it } from "vitest";
import { splitMediaFromOutput } from "./parse.js";

describe("splitMediaFromOutput", () => {
  it("detects audio_as_voice tag and strips it", () => {
    const result = splitMediaFromOutput("Hello [[audio_as_voice]] world");
    expect(result.audioAsVoice).toBe(true);
    expect(result.text).toBe("Hello world");
  });

  it("rejects absolute media paths to prevent LFI", () => {
    const result = splitMediaFromOutput("MEDIA:/Users/pete/My File.png");
    expect(result.mediaUrls).toBeUndefined();
    expect(result.text).toBe("MEDIA:/Users/pete/My File.png");
  });

  it("rejects quoted absolute media paths to prevent LFI", () => {
    const result = splitMediaFromOutput('MEDIA:"/Users/pete/My File.png"');
    expect(result.mediaUrls).toBeUndefined();
    expect(result.text).toBe('MEDIA:"/Users/pete/My File.png"');
  });

  it("rejects tilde media paths to prevent LFI", () => {
    const result = splitMediaFromOutput("MEDIA:~/Pictures/My File.png");
    expect(result.mediaUrls).toBeUndefined();
    expect(result.text).toBe("MEDIA:~/Pictures/My File.png");
  });

  it("rejects directory traversal media paths to prevent LFI", () => {
    const result = splitMediaFromOutput("MEDIA:../../etc/passwd");
    expect(result.mediaUrls).toBeUndefined();
    expect(result.text).toBe("MEDIA:../../etc/passwd");
  });

  it("captures safe relative media paths", () => {
    const result = splitMediaFromOutput("MEDIA:./screenshots/image.png");
    expect(result.mediaUrls).toEqual(["./screenshots/image.png"]);
    expect(result.text).toBe("");
  });

  it("keeps audio_as_voice detection stable across calls", () => {
    const input = "Hello [[audio_as_voice]]";
    const first = splitMediaFromOutput(input);
    const second = splitMediaFromOutput(input);
    expect(first.audioAsVoice).toBe(true);
    expect(second.audioAsVoice).toBe(true);
  });

  it("keeps MEDIA mentions in prose", () => {
    const input = "The MEDIA: tag fails to deliver";
    const result = splitMediaFromOutput(input);
    expect(result.mediaUrls).toBeUndefined();
    expect(result.text).toBe(input);
  });

  it("parses MEDIA tags with leading whitespace", () => {
    const result = splitMediaFromOutput("  MEDIA:./screenshot.png");
    expect(result.mediaUrls).toEqual(["./screenshot.png"]);
    expect(result.text).toBe("");
  });

  it("allows TTS temp file paths on Linux", () => {
    const result = splitMediaFromOutput("MEDIA:/tmp/tts-fAJy8C/voice-1770246885083.opus");
    expect(result.mediaUrls).toEqual(["/tmp/tts-fAJy8C/voice-1770246885083.opus"]);
    expect(result.text).toBe("");
  });

  it("allows TTS temp file paths on macOS", () => {
    const result = splitMediaFromOutput(
      "MEDIA:/var/folders/6j/1qlznq597hq1c1qbkhh9rg480000gn/T/tts-fAJy8C/voice-1770246885083.opus",
    );
    expect(result.mediaUrls).toEqual([
      "/var/folders/6j/1qlznq597hq1c1qbkhh9rg480000gn/T/tts-fAJy8C/voice-1770246885083.opus",
    ]);
    expect(result.text).toBe("");
  });

  it("still rejects other absolute paths", () => {
    const result = splitMediaFromOutput("MEDIA:/etc/passwd");
    expect(result.mediaUrls).toBeUndefined();
    expect(result.text).toBe("MEDIA:/etc/passwd");
  });

  it("rejects TTS-like paths outside temp directories", () => {
    const result = splitMediaFromOutput("MEDIA:/home/user/tts-fake/voice-123.opus");
    expect(result.mediaUrls).toBeUndefined();
    expect(result.text).toBe("MEDIA:/home/user/tts-fake/voice-123.opus");
  });
});
