// Audio media tests cover audio type normalization and extension mapping.
import { describe, expect, it } from "vitest";
import { hasNonAudioMediaReference, isVoiceCompatibleAudio } from "./audio.js";

describe("isVoiceCompatibleAudio", () => {
  it.each([
    {
      name: "returns true for supported MIME types",
      cases: [
        ...[
          "audio/ogg",
          "audio/opus",
          "audio/mpeg",
          "audio/mp3",
          "audio/mp4",
          "audio/x-m4a",
          "audio/m4a",
        ].map((contentType) => ({
          opts: { contentType, fileName: null },
          expected: true,
        })),
        { opts: { contentType: "audio/ogg; codecs=opus", fileName: null }, expected: true },
        { opts: { contentType: "audio/mp4; codecs=mp4a.40.2", fileName: null }, expected: true },
      ],
    },
    {
      name: "returns true for supported extensions",
      cases: [".oga", ".ogg", ".opus", ".mp3", ".m4a"].map((ext) => ({
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
    for (const { opts, expected } of cases) {
      expect(isVoiceCompatibleAudio(opts)).toBe(expected);
    }
  });
});

describe("hasNonAudioMediaReference", () => {
  it("reports nothing for an empty media list", () => {
    expect(hasNonAudioMediaReference([])).toBe(false);
  });

  it("reports audio-only payloads as audio", () => {
    expect(hasNonAudioMediaReference(["/tmp/a.opus", "/tmp/b.mp3"])).toBe(false);
  });

  it("reports a mixed payload as carrying non-audio media", () => {
    expect(hasNonAudioMediaReference(["/tmp/a.opus", "/tmp/photo.jpg"])).toBe(true);
  });

  it("reports pictures, documents, and video as non-audio", () => {
    for (const fileName of ["photo.jpg", "chart.png", "report.pdf", "clip.mp4"]) {
      expect(hasNonAudioMediaReference([fileName])).toBe(true);
    }
  });

  it("accepts audio the voice-message check rejects", () => {
    for (const fileName of ["note.wav", "song.flac", "clip.aac", "tape.amr"]) {
      expect(hasNonAudioMediaReference([fileName])).toBe(false);
    }
  });

  it("ignores MEDIA: prefixes and URL query strings", () => {
    expect(hasNonAudioMediaReference(["MEDIA: /tmp/reply.opus"])).toBe(false);
    expect(hasNonAudioMediaReference(["https://example.com/reply.opus?token=1"])).toBe(false);
    expect(hasNonAudioMediaReference(["https://example.com/photo.jpg?token=1"])).toBe(true);
  });

  it("follows the shared media table rather than a private extension list", () => {
    // Audio the voice-message check rejects but the media layer knows.
    for (const audio of ["/tmp/memo.caf", "/tmp/book.m4b", "/tmp/take.aifc", "/tmp/take.m2a"]) {
      expect(hasNonAudioMediaReference([audio])).toBe(false);
    }
    // The same table calls .webm video, and so does this check.
    expect(hasNonAudioMediaReference(["/tmp/clip.webm"])).toBe(true);
  });

  it("keeps local paths that contain URL punctuation", () => {
    expect(hasNonAudioMediaReference(["/tmp/track #1.mp3"])).toBe(false);
    expect(hasNonAudioMediaReference(["/tmp/why? .m4a"])).toBe(false);
  });
});
