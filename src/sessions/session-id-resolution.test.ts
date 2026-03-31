import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../config/sessions/types.js";
import { resolvePreferredSessionKeyForSessionIdMatches } from "./session-id-resolution.js";

function entry(updatedAt: number, sessionId = "s1"): SessionEntry {
  return { sessionId, updatedAt };
}

describe("resolvePreferredSessionKeyForSessionIdMatches", () => {
  it("returns undefined for empty matches", () => {
    expect(resolvePreferredSessionKeyForSessionIdMatches([], "s1")).toBeUndefined();
  });

  it("returns the only match for a single-element array", () => {
    const matches: Array<[string, SessionEntry]> = [["agent:main:main", entry(10)]];
    expect(resolvePreferredSessionKeyForSessionIdMatches(matches, "s1")).toBe("agent:main:main");
  });

  it("returns the single structural match when exactly one exists", () => {
    const matches: Array<[string, SessionEntry]> = [
      ["agent:main:s1", entry(5)],
      ["agent:main:other", entry(20)],
    ];
    // "agent:main:s1" ends with `:s1` which matches the sessionId structurally.
    expect(resolvePreferredSessionKeyForSessionIdMatches(matches, "s1")).toBe("agent:main:s1");
  });

  it("returns the freshest match when timestamps differ", () => {
    const matches: Array<[string, SessionEntry]> = [
      ["agent:main:alpha", entry(10)],
      ["agent:main:beta", entry(20)],
    ];
    expect(resolvePreferredSessionKeyForSessionIdMatches(matches, "s1")).toBe("agent:main:beta");
  });

  it("returns undefined for fuzzy-only matches with tied timestamps (ambiguity signal)", () => {
    // No structural match exists (neither key ends with :s1).
    // Callers like resolveSessionKeyForRun rely on undefined to avoid misrouting.
    const matches: Array<[string, SessionEntry]> = [
      ["agent:main:beta", entry(10)],
      ["agent:main:alpha", entry(10)],
    ];
    expect(resolvePreferredSessionKeyForSessionIdMatches(matches, "s1")).toBeUndefined();
  });

  it("returns undefined when updatedAt is missing on all fuzzy-only entries", () => {
    const matches: Array<[string, SessionEntry]> = [
      ["agent:main:beta", { sessionId: "s1" } as SessionEntry],
      ["agent:main:alpha", { sessionId: "s1" } as SessionEntry],
    ];
    expect(resolvePreferredSessionKeyForSessionIdMatches(matches, "s1")).toBeUndefined();
  });

  it("prefers structural matches over fresher fuzzy matches", () => {
    // "agent:main:acp:run-dup" structurally matches "run-dup" (ends with :run-dup).
    // "agent:main:other" is a fuzzy match (only sessionId matches) with a newer timestamp.
    // The function should prefer the structural match pool.
    const matches: Array<[string, SessionEntry]> = [
      ["agent:main:other", entry(999, "run-dup")],
      ["agent:main:acp:run-dup", entry(100, "run-dup")],
      ["agent:main:acp2:run-dup", entry(50, "run-dup")],
    ];
    // Two structural matches exist (both end with :run-dup).
    // Among them, agent:main:acp:run-dup (updatedAt=100) is fresher.
    const result = resolvePreferredSessionKeyForSessionIdMatches(matches, "run-dup");
    expect(result).toBe("agent:main:acp:run-dup");
  });

  it("returns undefined for three-way fuzzy-only tie (ambiguity signal)", () => {
    const matches: Array<[string, SessionEntry]> = [
      ["agent:main:charlie", entry(10)],
      ["agent:main:alpha", entry(10)],
      ["agent:main:bravo", entry(10)],
    ];
    expect(resolvePreferredSessionKeyForSessionIdMatches(matches, "s1")).toBeUndefined();
  });

  it("uses structural matches for tie-breaking when multiple structural matches tie", () => {
    const matches: Array<[string, SessionEntry]> = [
      ["agent:main:extra", entry(500, "sid")],
      ["agent:main:b:sid", entry(10, "sid")],
      ["agent:main:a:sid", entry(10, "sid")],
    ];
    // Two structural matches (ending with :sid) with the same timestamp.
    // Should pick agent:main:a:sid lexicographically and NOT fall through to the
    // fresher fuzzy match "agent:main:extra".
    const result = resolvePreferredSessionKeyForSessionIdMatches(matches, "sid");
    expect(result).toBe("agent:main:a:sid");
  });
});
