import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../config/sessions/types.js";
import {
  extractTranscriptIdentityFromSessionsMemoryHit,
  extractTranscriptStemFromSessionsMemoryHit,
  resolveTranscriptStemToSessionKeys,
} from "./session-transcript-hit.js";

describe("extractTranscriptStemFromSessionsMemoryHit", () => {
  it("uses canonical SQLite-backed session memory paths", () => {
    expect(extractTranscriptStemFromSessionsMemoryHit("sessions/main/abc-uuid")).toBe("abc-uuid");
  });

  it("uses .md basename for QMD exports", () => {
    expect(extractTranscriptStemFromSessionsMemoryHit("qmd/sessions/x/y/z.md")).toBe("z");
  });
});

describe("extractTranscriptIdentityFromSessionsMemoryHit", () => {
  it("preserves owner metadata for canonical SQLite-backed paths", () => {
    expect(extractTranscriptIdentityFromSessionsMemoryHit("sessions/main/abc-uuid")).toEqual({
      stem: "abc-uuid",
      ownerAgentId: "main",
    });
  });

  it("does not invent owner metadata for basename-only QMD exports", () => {
    expect(extractTranscriptIdentityFromSessionsMemoryHit("qmd/sessions/abc-uuid.md")).toEqual({
      stem: "abc-uuid",
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
