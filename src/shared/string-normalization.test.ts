import { describe, expect, it } from "vitest";
import {
  normalizeAtHashSlug,
  normalizeHyphenSlug,
  normalizeStringEntries,
  normalizeStringEntriesLower,
} from "./string-normalization.js";

describe("shared/string-normalization", () => {
  it("normalizes mixed allow-list entries", () => {
    expect(normalizeStringEntries([" a ", 42, "", "  ", "z"])).toEqual(["a", "42", "z"]);
    expect(normalizeStringEntries([" ok ", null, { toString: () => " obj " }])).toEqual([
      "ok",
      "null",
      "obj",
    ]);
    expect(normalizeStringEntries(undefined)).toEqual([]);
  });

  it("normalizes mixed allow-list entries to lowercase", () => {
    expect(normalizeStringEntriesLower([" A ", "MiXeD", 7])).toEqual(["a", "mixed", "7"]);
  });

  it("normalizes slug-like labels while preserving supported symbols", () => {
    expect(normalizeHyphenSlug("  Team Room  ")).toBe("team-room");
    expect(normalizeHyphenSlug(" #My_Channel + Alerts ")).toBe("#my_channel-+-alerts");
    expect(normalizeHyphenSlug("..foo---bar..")).toBe("foo-bar");
    expect(normalizeHyphenSlug(undefined)).toBe("");
    expect(normalizeHyphenSlug(null)).toBe("");
  });

  it("collapses repeated separators and trims leading/trailing punctuation", () => {
    expect(normalizeHyphenSlug("  ...Hello   /  World---  ")).toBe("hello-world");
    expect(normalizeHyphenSlug(" ###Team@@@Room### ")).toBe("###team@@@room###");
  });

  it("normalizes @/# prefixed slugs used by channel allowlists", () => {
    expect(normalizeAtHashSlug(" #My_Channel + Alerts ")).toBe("my-channel-alerts");
    expect(normalizeAtHashSlug("@@Room___Name")).toBe("room-name");
    expect(normalizeAtHashSlug(undefined)).toBe("");
    expect(normalizeAtHashSlug(null)).toBe("");
  });

  it("strips repeated prefixes and collapses separator-only results", () => {
    expect(normalizeAtHashSlug("###__Room  Name__")).toBe("room-name");
    expect(normalizeAtHashSlug("@@@___")).toBe("");
  });
});
