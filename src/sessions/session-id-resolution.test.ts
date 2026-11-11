// Session id resolution tests cover resolving aliases and explicit ids.
import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../config/sessions/types.js";
import {
  resolvePreferredSessionKeyForSessionIdMatches,
  resolveSessionIdMatchSelection,
} from "./session-id-resolution.js";

function entry(updatedAt: number, sessionId = "s1"): SessionEntry {
  return { sessionId, updatedAt };
}

describe("resolvePreferredSessionKeyForSessionIdMatches", () => {
  it("returns undefined for empty matches", () => {
    expect(resolvePreferredSessionKeyForSessionIdMatches([], "s1")).toBeUndefined();
  });

  it("collapses alias duplicates before resolving structural ties", () => {
    const matches: Array<[string, SessionEntry]> = [
      ["agent:main:MAIN", entry(10, "main")],
      ["agent:main:main", entry(10, "main")],
    ];

    expect(resolvePreferredSessionKeyForSessionIdMatches(matches, "main")).toBe("agent:main:main");
  });

  it("reports ambiguity for fuzzy-only matches with tied timestamps", () => {
    const matches: Array<[string, SessionEntry]> = [
      ["agent:main:beta", entry(10)],
      ["agent:main:alpha", entry(10)],
    ];

    expect(resolveSessionIdMatchSelection(matches, "s1")).toEqual({
      kind: "ambiguous",
      sessionKeys: ["agent:main:beta", "agent:main:alpha"],
    });
  });
});
