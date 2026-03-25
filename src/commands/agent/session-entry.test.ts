import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import { normalizeSessionId, removeStaleTranscriptPathForSessionId } from "./session-entry.js";

describe("normalizeSessionId", () => {
  it("returns undefined for empty inputs", () => {
    expect(normalizeSessionId(undefined)).toBeUndefined();
    expect(normalizeSessionId("")).toBeUndefined();
    expect(normalizeSessionId("   ")).toBeUndefined();
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeSessionId("  rca-session  ")).toBe("rca-session");
  });
});

describe("removeStaleTranscriptPathForSessionId", () => {
  const entry: SessionEntry = {
    sessionId: "old-session",
    updatedAt: 123,
    sessionFile: "/tmp/old-session.jsonl",
  };

  it("returns undefined when no entry exists", () => {
    expect(removeStaleTranscriptPathForSessionId(undefined, "new-session")).toBeUndefined();
  });

  it("preserves entries without transcript paths", () => {
    const withoutSessionFile: SessionEntry = {
      sessionId: "old-session",
      updatedAt: 123,
    };

    expect(removeStaleTranscriptPathForSessionId(withoutSessionFile, "new-session")).toBe(
      withoutSessionFile,
    );
  });

  it("preserves entries when trimmed session ids match", () => {
    expect(removeStaleTranscriptPathForSessionId(entry, " old-session ")).toBe(entry);
  });

  it("clears stale transcript paths when session ids differ", () => {
    const result = removeStaleTranscriptPathForSessionId(entry, "new-session");

    expect(result).toEqual({
      sessionId: "old-session",
      updatedAt: 123,
    });
    expect(result).not.toHaveProperty("sessionFile");
    expect(result).not.toBe(entry);
    expect(entry.sessionFile).toBe("/tmp/old-session.jsonl");
  });
});
