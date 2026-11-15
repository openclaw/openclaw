import { describe, expect, it } from "vitest";
import {
  type ChannelMatchSource,
  buildChannelKeyCandidates,
  normalizeChannelSlug,
  resolveChannelEntryMatch,
  resolveChannelEntryMatchWithFallback,
  resolveNestedAllowlistDecision,
  resolveChannelMatchConfig,
} from "./channel-config.js";

describe("buildChannelKeyCandidates", () => {
  it("dedupes and trims keys", () => {
    expect(buildChannelKeyCandidates(" a ", "a", "", "b", "b")).toEqual(["a", "b"]);
  });
});

describe("resolveChannelEntryMatch", () => {
  it("returns matched entry and wildcard metadata", () => {
    const entries = { a: { allow: true }, "*": { allow: false } };
    const match = resolveChannelEntryMatch({
      entries,
      keys: ["missing", "a"],
      wildcardKey: "*",
    });
    expect(match.entry).toBe(entries.a);
    expect(match.key).toBe("a");
    expect(match.wildcardEntry).toBe(entries["*"]);
    expect(match.wildcardKey).toBe("*");
  });
});

describe("resolveChannelEntryMatchWithFallback", () => {
  it.each([
    ["parent", "parent", "parent"],
    ["wildcard", "still-missing", "*"],
  ] as const)("falls back to %s when direct misses", (source, parentKey, expectedKey) => {
    const entries = { parent: { allow: false }, "*": { allow: true } };
    const match = resolveChannelEntryMatchWithFallback({
      entries,
      keys: ["missing"],
      parentKeys: [parentKey],
      wildcardKey: "*",
    });
    expect(match.entry).toBe(entries[expectedKey]);
    expect(match).toMatchObject({ matchSource: source, matchKey: expectedKey });
  });

  it("matches normalized direct keys before wildcard fallback", () => {
    const entries = { "My Team": { allow: true } };
    const match = resolveChannelEntryMatchWithFallback({
      entries: { ...entries, parent: { allow: false }, "*": { allow: false } },
      keys: ["my-team"],
      parentKeys: ["parent"],
      wildcardKey: "*",
      normalizeKey: normalizeChannelSlug,
    });
    expect(match.entry).toBe(entries["My Team"]);
    expect(match.matchSource).toBe("direct");
    expect(match.matchKey).toBe("My Team");
    expect(match.parentEntry).toBeUndefined();
  });
});

describe("resolveChannelMatchConfig", () => {
  const resolveEntry = (): { matchKey?: string; matchSource?: ChannelMatchSource } => ({});
  it("returns null when no entry is matched", () => {
    const resolved = resolveChannelMatchConfig({ matchKey: "x" }, resolveEntry);
    expect(resolved).toBeNull();
  });

  it("resolves entry and applies match metadata", () => {
    const resolved = resolveChannelMatchConfig(
      { entry: { allow: true }, matchKey: "*", matchSource: "wildcard" },
      resolveEntry,
    );
    expect(resolved).toEqual({ matchKey: "*", matchSource: "wildcard" });
  });
});

describe("resolveNestedAllowlistDecision", () => {
  it.each([
    [false, false, false, false, true],
    [true, false, false, false, false],
    [true, true, true, false, false],
  ])(
    "outer configured=%s matched=%s, inner configured=%s matched=%s → %s",
    (outerConfigured, outerMatched, innerConfigured, innerMatched, expected) => {
      expect(
        resolveNestedAllowlistDecision({
          outerConfigured,
          outerMatched,
          innerConfigured,
          innerMatched,
        }),
      ).toBe(expected);
    },
  );
});
