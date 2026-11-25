import { describe, expect, it } from "vitest";
import { resolveMirroredTranscriptText } from "./transcript-mirror.js";

describe("resolveMirroredTranscriptText", () => {
  it.each([
    [{ text: "hello", mediaUrls: ["   /   "] }, "hello\nmedia"],
    [{ text: "hello", mediaUrls: ["data:image/png;base64,aGVsbG8="] }, "hello\nmedia"],
    [{ mediaUrls: ["https://example.com/voice-note.ogg"] }, "voice-note.ogg"],
    [{ text: "   ", mediaUrls: ["  "] }, null],
  ])("resolves %j to %j", (params, expected) => {
    expect(resolveMirroredTranscriptText(params)).toBe(expected);
  });
});
