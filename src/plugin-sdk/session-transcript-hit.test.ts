import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../config/sessions/types.js";
import {
  extractTranscriptIdentityFromSessionsMemoryHit,
  extractTranscriptStemFromSessionsMemoryHit,
  resolveTranscriptStemToSessionKeys,
} from "./session-transcript-hit.js";

describe("extractTranscriptStemFromSessionsMemoryHit", () => {
  it("uses opaque SQLite-backed session memory keys", () => {
    expect(extractTranscriptStemFromSessionsMemoryHit("transcript:main:abc-uuid")).toBe("abc-uuid");
  });
});

describe("extractTranscriptIdentityFromSessionsMemoryHit", () => {
  it("preserves owner metadata for SQLite-backed transcript keys", () => {
    expect(extractTranscriptIdentityFromSessionsMemoryHit("transcript:main:abc-uuid")).toEqual({
      stem: "abc-uuid",
      ownerAgentId: "main",
    });
  });

  it("allows colons inside session ids", () => {
    expect(
      extractTranscriptIdentityFromSessionsMemoryHit("transcript:main:agent:main:abc"),
    ).toEqual({
      stem: "agent:main:abc",
      ownerAgentId: "main",
    });
  });
});

describe("resolveTranscriptStemToSessionKeys", () => {
  const baseEntry = (overrides: Partial<SessionEntry> = {}): SessionEntry => ({
    sessionId: "stem-a",
    updatedAt: 1,
    ...overrides,
  });

  it("returns keys for every agent whose session row matches the stem", () => {
    const entries: Record<string, SessionEntry> = {
      "agent:main:s1": baseEntry({}),
      "agent:peer:s2": baseEntry({}),
    };
    const keys = resolveTranscriptStemToSessionKeys({ entries, stem: "stem-a" }).toSorted();
    expect(keys).toEqual(["agent:main:s1", "agent:peer:s2"]);
  });

  it("does not synthesize keys when live rows have no matching transcript", () => {
    const keys = resolveTranscriptStemToSessionKeys({ entries: {}, stem: "deleted-stem" });

    expect(keys).toEqual([]);
  });
});
