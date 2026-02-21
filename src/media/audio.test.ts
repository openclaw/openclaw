import { describe, expect, it } from "vitest";
import {
  isVoiceCompatibleAudio,
  TELEGRAM_VOICE_AUDIO_EXTENSIONS,
  TELEGRAM_VOICE_MIME_TYPES,
} from "./audio.js";

describe("isVoiceCompatibleAudio", () => {
  it.each([
    ...Array.from(TELEGRAM_VOICE_MIME_TYPES, (contentType) => ({ contentType, fileName: null })),
    { contentType: "audio/ogg; codecs=opus", fileName: null },
    { contentType: "audio/mp4; codecs=mp4a.40.2", fileName: null },
  ])("returns true for MIME type $contentType", (opts) => {
    expect(isVoiceCompatibleAudio(opts)).toBe(true);
  });

  it.each(Array.from(TELEGRAM_VOICE_AUDIO_EXTENSIONS))("returns true for extension %s", (ext) => {
    expect(isVoiceCompatibleAudio({ fileName: `voice${ext}` })).toBe(true);
  });

  it.each([
    { contentType: "audio/wav", fileName: null },
    { contentType: "audio/flac", fileName: null },
    { contentType: "audio/aac", fileName: null },
    { contentType: "video/mp4", fileName: null },
  ])("returns false for unsupported MIME $contentType", (opts) => {
    expect(isVoiceCompatibleAudio(opts)).toBe(false);
  });

  it.each([".wav", ".flac", ".webm"])("returns false for extension %s", (ext) => {
    expect(isVoiceCompatibleAudio({ fileName: `audio${ext}` })).toBe(false);
  });

  it("returns false when no contentType and no fileName", () => {
    expect(isVoiceCompatibleAudio({})).toBe(false);
  });

  it("prefers MIME type over extension", () => {
    expect(isVoiceCompatibleAudio({ contentType: "audio/mpeg", fileName: "file.wav" })).toBe(true);
  });
});
