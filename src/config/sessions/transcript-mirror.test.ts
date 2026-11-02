import { describe, expect, it } from "vitest";
import { resolveMirroredTranscriptText } from "./transcript-mirror.js";

describe("resolveMirroredTranscriptText", () => {
  it.each(["   /   ", "data:image/png;base64,aGVsbG8="])(
    "uses the media placeholder when %s has no filename",
    (mediaUrl) => {
      expect(resolveMirroredTranscriptText({ text: "hello", mediaUrls: [mediaUrl] })).toBe(
        "hello\nmedia",
      );
    },
  );

  it("returns media names alone when there is no text", () => {
    expect(
      resolveMirroredTranscriptText({ mediaUrls: ["https://example.com/voice-note.ogg"] }),
    ).toBe("voice-note.ogg");
  });

  it("returns null when both text and media are empty", () => {
    expect(resolveMirroredTranscriptText({ text: "   ", mediaUrls: ["  "] })).toBeNull();
  });
});
