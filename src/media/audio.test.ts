import { describe, expect, it } from "vitest";
import {
  isVoiceCompatibleAudio,
  isWhatsAppVoiceCompatibleAudio,
  TELEGRAM_VOICE_AUDIO_EXTENSIONS,
  TELEGRAM_VOICE_MIME_TYPES,
  WHATSAPP_VOICE_AUDIO_EXTENSIONS,
  WHATSAPP_VOICE_MIME_TYPES,
} from "./audio.js";

describe("isVoiceCompatibleAudio", () => {
  function expectVoiceCompatibilityCase(
    opts: Parameters<typeof isVoiceCompatibleAudio>[0],
    expected: boolean,
  ) {
    expect(isVoiceCompatibleAudio(opts)).toBe(expected);
  }

  function expectVoiceCompatibilityCases(
    cases: ReadonlyArray<{
      opts: Parameters<typeof isVoiceCompatibleAudio>[0];
      expected: boolean;
    }>,
  ) {
    cases.forEach(({ opts, expected }) => {
      expectVoiceCompatibilityCase(opts, expected);
    });
  }

  it.each([
    {
      name: "returns true for supported MIME types",
      cases: [
        ...Array.from(TELEGRAM_VOICE_MIME_TYPES, (contentType) => ({
          opts: { contentType, fileName: null },
          expected: true,
        })),
        { opts: { contentType: "audio/ogg; codecs=opus", fileName: null }, expected: true },
        { opts: { contentType: "audio/mp4; codecs=mp4a.40.2", fileName: null }, expected: true },
      ],
    },
    {
      name: "returns true for supported extensions",
      cases: Array.from(TELEGRAM_VOICE_AUDIO_EXTENSIONS, (ext) => ({
        opts: { fileName: `voice${ext}` },
        expected: true,
      })),
    },
    {
      name: "returns false for unsupported MIME types",
      cases: [
        { opts: { contentType: "audio/wav", fileName: null }, expected: false },
        { opts: { contentType: "audio/flac", fileName: null }, expected: false },
        { opts: { contentType: "audio/aac", fileName: null }, expected: false },
        { opts: { contentType: "video/mp4", fileName: null }, expected: false },
      ],
    },
    {
      name: "returns false for unsupported extensions",
      cases: [".wav", ".flac", ".webm"].map((ext) => ({
        opts: { fileName: `audio${ext}` },
        expected: false,
      })),
    },
    {
      name: "keeps fallback edge cases explicit",
      cases: [
        {
          opts: {},
          expected: false,
        },
        {
          opts: { contentType: "audio/mpeg", fileName: "file.wav" },
          expected: true,
        },
      ],
    },
  ])("$name", ({ cases }) => {
    expectVoiceCompatibilityCases(cases);
  });
});

describe("isWhatsAppVoiceCompatibleAudio", () => {
  it.each([
    ...Array.from(WHATSAPP_VOICE_MIME_TYPES, (contentType) => ({ contentType, fileName: null })),
    { contentType: "audio/ogg; codecs=opus", fileName: null },
  ])("returns true for MIME type $contentType", (opts) => {
    expect(isWhatsAppVoiceCompatibleAudio(opts)).toBe(true);
  });

  it.each(Array.from(WHATSAPP_VOICE_AUDIO_EXTENSIONS))("returns true for extension %s", (ext) => {
    expect(isWhatsAppVoiceCompatibleAudio({ fileName: `voice${ext}` })).toBe(true);
  });

  it.each([
    { contentType: "audio/mpeg", fileName: null },
    { contentType: "audio/mp4", fileName: null },
    { contentType: "audio/x-m4a", fileName: null },
    { contentType: "audio/webm", fileName: null },
  ])("returns false for unsupported MIME $contentType", (opts) => {
    expect(isWhatsAppVoiceCompatibleAudio(opts)).toBe(false);
  });

  it.each([".mp3", ".m4a", ".wav", ".webm"])("returns false for extension %s", (ext) => {
    expect(isWhatsAppVoiceCompatibleAudio({ fileName: `audio${ext}` })).toBe(false);
  });
});
