import { describe, expect, it } from "vitest";

import {
  buildChannelKeyCandidates,
  resolveChannelEntryMatch,
  resolveChannelEntryMatchWithFallback,
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
  it("prefers direct matches over parent and wildcard", () => {
    const entries = { a: { allow: true }, parent: { allow: false }, "*": { allow: false } };
    const match = resolveChannelEntryMatchWithFallback({
      entries,
      keys: ["a"],
      parentKeys: ["parent"],
      wildcardKey: "*",
    });
    expect(match.entry).toBe(entries.a);
    expect(match.matchSource).toBe("direct");
    expect(match.matchKey).toBe("a");
  });

  it("falls back to parent when direct misses", () => {
    const entries = { parent: { allow: false }, "*": { allow: true } };
    const match = resolveChannelEntryMatchWithFallback({
      entries,
      keys: ["missing"],
      parentKeys: ["parent"],
      wildcardKey: "*",
    });
    expect(match.entry).toBe(entries.parent);
    expect(match.matchSource).toBe("parent");
    expect(match.matchKey).toBe("parent");
  });

  it("falls back to wildcard when no direct or parent match", () => {
    const entries = { "*": { allow: true } };
    const match = resolveChannelEntryMatchWithFallback({
      entries,
      keys: ["missing"],
      parentKeys: ["still-missing"],
      wildcardKey: "*",
    });
    expect(match.entry).toBe(entries["*"]);
    expect(match.matchSource).toBe("wildcard");
    expect(match.matchKey).toBe("*");
  });
});
