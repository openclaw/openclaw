import { describe, expect, it } from "vitest";

import { parseAudioTag } from "./audio-tags.js";

describe("parseAudioTag", () => {
  it("detects audio_as_voice and strips the tag", () => {
    const result = parseAudioTag("Hello [[audio_as_voice]] world");
    expect(result.audioAsVoice).toBe(true);
    expect(result.hadTag).toBe(true);
    expect(result.text).toBe("Hello world");
  });

  it("returns empty output for missing text", () => {
    const result = parseAudioTag(undefined);
    expect(result.audioAsVoice).toBe(false);
    expect(result.hadTag).toBe(false);
    expect(result.text).toBe("");
  });

  it("removes tag-only messages", () => {
    const result = parseAudioTag("[[audio_as_voice]]");
    expect(result.audioAsVoice).toBe(true);
    expect(result.text).toBe("");
  });
});
