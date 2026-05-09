import { describe, expect, it } from "vitest";
import { isPrimaryLegacySessionTranscriptFileName } from "./session-file-artifacts.js";

describe("legacy session file artifacts", () => {
  it("classifies legacy primary transcript files for doctor cleanup", () => {
    expect(isPrimaryLegacySessionTranscriptFileName("abc.jsonl")).toBe(true);
    expect(isPrimaryLegacySessionTranscriptFileName("keep.deleted.keep.jsonl")).toBe(true);
    expect(
      isPrimaryLegacySessionTranscriptFileName(
        "abc.checkpoint.11111111-1111-4111-8111-111111111111.jsonl",
      ),
    ).toBe(false);
    expect(isPrimaryLegacySessionTranscriptFileName("abc.trajectory.jsonl")).toBe(false);
    expect(isPrimaryLegacySessionTranscriptFileName("sessions.json")).toBe(false);
  });
});
