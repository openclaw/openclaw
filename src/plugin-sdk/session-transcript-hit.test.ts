import { describe, expect, it } from "vitest";
import { extractTranscriptStemFromSessionsMemoryHit } from "./session-transcript-hit.js";

describe("extractTranscriptStemFromSessionsMemoryHit", () => {
  it("strips sessions/ and .jsonl for builtin paths", () => {
    expect(extractTranscriptStemFromSessionsMemoryHit("sessions/abc-uuid.jsonl")).toBe("abc-uuid");
  });

  it("handles plain basename jsonl", () => {
    expect(extractTranscriptStemFromSessionsMemoryHit("def-topic-thread.jsonl")).toBe(
      "def-topic-thread",
    );
  });

  it("uses .md basename for QMD exports", () => {
    expect(extractTranscriptStemFromSessionsMemoryHit("qmd/sessions/x/y/z.md")).toBe("z");
  });
});
