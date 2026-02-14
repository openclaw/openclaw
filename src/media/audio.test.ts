import { describe, expect, it } from "vitest";
import { isVoiceCompatibleAudio } from "./audio.js";

describe("isVoiceCompatibleAudio", () => {
  it.each([
    { contentType: "audio/ogg", fileName: null },
    { contentType: "audio/opus", fileName: null },
    { contentType: "audio/ogg; codecs=opus", fileName: null },
    { contentType: "audio/mpeg", fileName: null },
    { contentType: "audio/mp3", fileName: null },
    { contentType: "audio/mp4", fileName: null },
    { contentType: "audio/mp4; codecs=mp4a.40.2", fileName: null },
    { contentType: "audio/x-m4a", fileName: null },
    { contentType: "audio/m4a", fileName: null },
  ])("returns true for MIME type $contentType", (opts) => {
    expect(isVoiceCompatibleAudio(opts)).toBe(true);
  });

  it.each([".ogg", ".oga", ".opus", ".mp3", ".m4a"])("returns true for extension %s", (ext) => {
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
