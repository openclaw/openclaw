import { describe, expect, it } from "vitest";
import { resolveMirroredTranscriptText } from "./transcript.js";

describe("resolveMirroredTranscriptText", () => {
  it("strips Windows-style path segments from encoded media URLs", () => {
    const result = resolveMirroredTranscriptText({
      mediaUrls: ["https://example.com/uploads/..%5Csecret.txt?sig=123"],
    });

    expect(result).toBe("secret.txt");
  });

  it("strips Windows-style path segments from raw media hints", () => {
    const result = resolveMirroredTranscriptText({
      mediaUrls: ["..\\private\\voice-note.m4a#fragment"],
    });

    expect(result).toBe("voice-note.m4a");
  });
});
