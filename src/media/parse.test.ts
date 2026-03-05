import { describe, expect, it } from "vitest";
import { splitMediaFromOutput } from "./parse.js";

describe("splitMediaFromOutput", () => {
  it("detects audio_as_voice tag and strips it", () => {
    const result = splitMediaFromOutput("Hello [[audio_as_voice]] world");
    expect(result.audioAsVoice).toBe(true);
    expect(result.text).toBe("Hello world");
  });

  it("accepts supported media path variants", () => {
    const pathCases = [
      ["/Users/pete/My File.png", "MEDIA:/Users/pete/My File.png"],
      ["/Users/pete/My File.png", 'MEDIA:"/Users/pete/My File.png"'],
      ["~/Pictures/My File.png", "MEDIA:~/Pictures/My File.png"],
      ["../../etc/passwd", "MEDIA:../../etc/passwd"],
      ["./screenshots/image.png", "MEDIA:./screenshots/image.png"],
      ["media/inbound/image.png", "MEDIA:media/inbound/image.png"],
      ["./screenshot.png", "  MEDIA:./screenshot.png"],
      ["C:\\Users\\pete\\Pictures\\snap.png", "MEDIA:C:\\Users\\pete\\Pictures\\snap.png"],
      [
        "/tmp/tts-fAJy8C/voice-1770246885083.opus",
        "MEDIA:/tmp/tts-fAJy8C/voice-1770246885083.opus",
      ],
      ["image.png", "MEDIA:image.png"],
    ] as const;
    for (const [expectedPath, input] of pathCases) {
      const result = splitMediaFromOutput(input);
      expect(result.mediaUrls).toEqual([expectedPath]);
      expect(result.text).toBe("");
    }
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

  it("rejects bare words without file extensions", () => {
    const result = splitMediaFromOutput("MEDIA:screenshot");
    expect(result.mediaUrls).toBeUndefined();
  });
});
