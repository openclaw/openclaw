/**
 * suggest-path.test.ts
 *
 * Unit tests for the config path suggestion module.
 * Covers edit-distance computation, path suggestion logic, and hint formatting.
 */

import { describe, expect, it } from "vitest";
import { buildConfigPathSuggestionHint, editDistance, suggestConfigPaths } from "./suggest-path.js";

// ---------------------------------------------------------------------------
// editDistance
// ---------------------------------------------------------------------------

describe("editDistance", () => {
  it("returns 0 for identical strings", () => {
    expect(editDistance("abc", "abc")).toBe(0);
  });

  it("returns length of other string when one is empty", () => {
    expect(editDistance("", "abc")).toBe(3);
    expect(editDistance("abc", "")).toBe(3);
  });

  it("returns 0 for two empty strings", () => {
    expect(editDistance("", "")).toBe(0);
  });

  it("computes single substitution distance", () => {
    expect(editDistance("cat", "bat")).toBe(1);
  });

  it("computes single insertion distance", () => {
    expect(editDistance("cat", "cart")).toBe(1);
  });

  it("computes single deletion distance", () => {
    expect(editDistance("cart", "cat")).toBe(1);
  });

  it("computes multi-edit distance", () => {
    expect(editDistance("kitten", "sitting")).toBe(3);
  });

  it("handles transposition as two edits", () => {
    // Levenshtein counts transposition as 2 operations (delete + insert).
    expect(editDistance("ab", "ba")).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// suggestConfigPaths
// ---------------------------------------------------------------------------

describe("suggestConfigPaths", () => {
  it("returns empty array for empty input", () => {
    expect(suggestConfigPaths("")).toEqual([]);
  });

  it("returns empty array for completely unrelated input", () => {
    // A string that is far from any real config key.
    expect(suggestConfigPaths("xyzzy_totally_unknown_zzz")).toEqual([]);
  });

  it("suggests a close match for a single-char typo in a known path", () => {
    // "gateway.prot" is 1 edit away from "gateway.port"
    const suggestions = suggestConfigPaths("gateway.prot");
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions).toContain("gateway.port");
  });

  it("suggests matches for a typo in the last segment", () => {
    // "logging.levl" should suggest "logging.level"
    const suggestions = suggestConfigPaths("logging.levl");
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions).toContain("logging.level");
  });

  it("returns at most 3 suggestions", () => {
    // Use a short common prefix that could match many paths.
    const suggestions = suggestConfigPaths("gateway");
    expect(suggestions.length).toBeLessThanOrEqual(3);
  });

  it("is case-insensitive", () => {
    const suggestions = suggestConfigPaths("GATEWAY.PORT");
    // Needle is lowercased before matching, so the exact path should always be found.
    expect(suggestions).toContain("gateway.port");
  });

  it("handles segment-level matching for deep paths", () => {
    // "diagnostics.cacheTrace" exists; "diagnostics.cachTrace" has a typo.
    const suggestions = suggestConfigPaths("diagnostics.cachTrace");
    expect(suggestions.length).toBeGreaterThan(0);
    // Should find the real path via segment-level matching.
    expect(suggestions.some((s) => s.startsWith("diagnostics.cacheTrace"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildConfigPathSuggestionHint
// ---------------------------------------------------------------------------

describe("buildConfigPathSuggestionHint", () => {
  it("returns null for empty input", () => {
    expect(buildConfigPathSuggestionHint("")).toBeNull();
  });

  it("returns null for completely unrelated input", () => {
    expect(buildConfigPathSuggestionHint("xyzzy_totally_unknown_zzz")).toBeNull();
  });

  it("returns a 'Did you mean' hint for a close match", () => {
    const hint = buildConfigPathSuggestionHint("gateway.prot");
    expect(hint).not.toBeNull();
    expect(hint).toContain("Did you mean");
    expect(hint).toContain("gateway.port");
  });

  it("uses singular form for single suggestion", () => {
    // Force a path that will likely yield exactly one match.
    const hint = buildConfigPathSuggestionHint("logging.levl");
    if (hint && !hint.includes("one of")) {
      expect(hint).toMatch(/^Did you mean: .+\?$/);
    }
  });

  it("uses plural form for multiple suggestions", () => {
    const hint = buildConfigPathSuggestionHint("gateway");
    if (hint && hint.includes("one of")) {
      expect(hint).toMatch(/^Did you mean one of: .+\?$/);
    }
  });
});
