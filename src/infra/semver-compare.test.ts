// Tests for semantic version comparison helpers.
import { describe, expect, it } from "vitest";
import {
  normalizeLegacyDotBetaVersion,
  parseComparableSemver,
  comparePrereleaseIdentifiers,
  compareComparableSemver,
} from "./semver-compare.js";

describe("normalizeLegacyDotBetaVersion", () => {
  it("converts legacy dot-beta format", () => {
    expect(normalizeLegacyDotBetaVersion("1.2.3.beta.4")).toBe("1.2.3-beta.4");
  });

  it("converts legacy dot-beta without suffix", () => {
    expect(normalizeLegacyDotBetaVersion("1.2.3.beta")).toBe("1.2.3-beta");
  });

  it("preserves standard semver", () => {
    expect(normalizeLegacyDotBetaVersion("1.2.3-beta.4")).toBe("1.2.3-beta.4");
  });

  it("preserves version without prerelease", () => {
    expect(normalizeLegacyDotBetaVersion("1.2.3")).toBe("1.2.3");
  });

  it("handles v prefix", () => {
    expect(normalizeLegacyDotBetaVersion("v1.2.3.beta.4")).toBe("v1.2.3-beta.4");
  });

  it("handles whitespace", () => {
    expect(normalizeLegacyDotBetaVersion("  1.2.3.beta.4  ")).toBe("1.2.3-beta.4");
  });
});

describe("parseComparableSemver", () => {
  it("parses standard semver", () => {
    expect(parseComparableSemver("1.2.3")).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
      prerelease: null,
    });
  });

  it("parses semver with prerelease", () => {
    expect(parseComparableSemver("1.2.3-beta.4")).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
      prerelease: ["beta", "4"],
    });
  });

  it("parses semver with v prefix", () => {
    expect(parseComparableSemver("v1.2.3")).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
      prerelease: null,
    });
  });

  it("returns null for invalid version", () => {
    expect(parseComparableSemver("invalid")).toBeNull();
  });

  it("returns null for null input", () => {
    expect(parseComparableSemver(null)).toBeNull();
  });

  it("returns null for undefined input", () => {
    expect(parseComparableSemver(undefined)).toBeNull();
  });

  it("normalizes legacy dot-beta when option enabled", () => {
    expect(parseComparableSemver("1.2.3.beta.4", { normalizeLegacyDotBeta: true })).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
      prerelease: ["beta", "4"],
    });
  });
});

describe("comparePrereleaseIdentifiers", () => {
  it("returns 0 for both null", () => {
    expect(comparePrereleaseIdentifiers(null, null)).toBe(0);
  });

  it("returns 0 for both empty", () => {
    expect(comparePrereleaseIdentifiers([], [])).toBe(0);
  });

  it("stable release has higher precedence than prerelease", () => {
    expect(comparePrereleaseIdentifiers(null, ["beta"])).toBe(1);
    expect(comparePrereleaseIdentifiers(["beta"], null)).toBe(-1);
  });

  it("compares numeric identifiers numerically", () => {
    expect(comparePrereleaseIdentifiers(["1"], ["2"])).toBe(-1);
    expect(comparePrereleaseIdentifiers(["2"], ["1"])).toBe(1);
    expect(comparePrereleaseIdentifiers(["1"], ["1"])).toBe(0);
  });

  it("numeric identifiers have lower precedence than string", () => {
    expect(comparePrereleaseIdentifiers(["1"], ["beta"])).toBe(-1);
    expect(comparePrereleaseIdentifiers(["beta"], ["1"])).toBe(1);
  });

  it("compares string identifiers lexically", () => {
    expect(comparePrereleaseIdentifiers(["alpha"], ["beta"])).toBe(-1);
    expect(comparePrereleaseIdentifiers(["beta"], ["alpha"])).toBe(1);
  });
});

describe("compareComparableSemver", () => {
  it("returns null for null a", () => {
    expect(
      compareComparableSemver(null, { major: 1, minor: 0, patch: 0, prerelease: null }),
    ).toBeNull();
  });

  it("returns null for null b", () => {
    expect(
      compareComparableSemver({ major: 1, minor: 0, patch: 0, prerelease: null }, null),
    ).toBeNull();
  });

  it("compares major versions", () => {
    expect(
      compareComparableSemver(
        { major: 1, minor: 0, patch: 0, prerelease: null },
        { major: 2, minor: 0, patch: 0, prerelease: null },
      ),
    ).toBe(-1);
  });

  it("compares minor versions", () => {
    expect(
      compareComparableSemver(
        { major: 1, minor: 0, patch: 0, prerelease: null },
        { major: 1, minor: 1, patch: 0, prerelease: null },
      ),
    ).toBe(-1);
  });

  it("compares patch versions", () => {
    expect(
      compareComparableSemver(
        { major: 1, minor: 0, patch: 0, prerelease: null },
        { major: 1, minor: 0, patch: 1, prerelease: null },
      ),
    ).toBe(-1);
  });

  it("compares prerelease versions", () => {
    expect(
      compareComparableSemver(
        { major: 1, minor: 0, patch: 0, prerelease: ["alpha"] },
        { major: 1, minor: 0, patch: 0, prerelease: ["beta"] },
      ),
    ).toBe(-1);
  });
});
