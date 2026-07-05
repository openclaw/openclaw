// Covers semver parsing, legacy beta normalization, prerelease ordering, and full version comparison.
import { describe, expect, it } from "vitest";
import {
  compareComparableSemver,
  comparePrereleaseIdentifiers,
  normalizeLegacyDotBetaVersion,
  parseComparableSemver,
} from "./semver-compare.js";

describe("normalizeLegacyDotBetaVersion", () => {
  it("converts dot-beta with suffix to semver prerelease", () => {
    expect(normalizeLegacyDotBetaVersion("1.2.3.beta.4")).toBe("1.2.3-beta.4");
  });

  it("converts dot-beta without suffix to bare prerelease", () => {
    expect(normalizeLegacyDotBetaVersion("1.2.3.beta")).toBe("1.2.3-beta");
  });

  it("preserves v prefix during conversion", () => {
    expect(normalizeLegacyDotBetaVersion("v1.2.3.beta.4")).toBe("v1.2.3-beta.4");
  });

  it("leaves already-semver prerelease unchanged", () => {
    expect(normalizeLegacyDotBetaVersion("1.2.3-beta.4")).toBe("1.2.3-beta.4");
  });

  it("leaves plain semver unchanged", () => {
    expect(normalizeLegacyDotBetaVersion("1.2.3")).toBe("1.2.3");
  });

  it("trims whitespace before matching", () => {
    expect(normalizeLegacyDotBetaVersion(" 1.2.3.beta.4 ")).toBe("1.2.3-beta.4");
  });
});

describe("parseComparableSemver", () => {
  it("parses plain semver", () => {
    expect(parseComparableSemver("1.2.3")).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
      prerelease: null,
    });
  });

  it("strips optional v prefix", () => {
    expect(parseComparableSemver("v1.2.3")).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
      prerelease: null,
    });
  });

  it("parses prerelease identifiers", () => {
    expect(parseComparableSemver("1.2.3-beta.1")).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
      prerelease: ["beta", "1"],
    });
  });

  it("strips build metadata", () => {
    expect(parseComparableSemver("1.2.3+build.123")).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
      prerelease: null,
    });
  });

  it("parses prerelease with build metadata combined", () => {
    expect(parseComparableSemver("1.2.3-beta.1+build.123")).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
      prerelease: ["beta", "1"],
    });
  });

  it("returns null for null or undefined", () => {
    expect(parseComparableSemver(null)).toBeNull();
    expect(parseComparableSemver(undefined)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseComparableSemver("")).toBeNull();
  });

  it("returns null for non-semver strings", () => {
    expect(parseComparableSemver("abc")).toBeNull();
    expect(parseComparableSemver("1.2")).toBeNull();
  });

  it("normalizes legacy dot-beta when option is set", () => {
    expect(parseComparableSemver("1.2.3.beta.4", { normalizeLegacyDotBeta: true })).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
      prerelease: ["beta", "4"],
    });
  });
});

describe("comparePrereleaseIdentifiers", () => {
  it("returns 0 when both are null or empty", () => {
    expect(comparePrereleaseIdentifiers(null, null)).toBe(0);
    expect(comparePrereleaseIdentifiers([], [])).toBe(0);
  });

  it("favors stable release over any prerelease", () => {
    // stable (null) > prerelease
    expect(comparePrereleaseIdentifiers(null, ["beta"])).toBe(1);
    // prerelease < stable
    expect(comparePrereleaseIdentifiers(["beta"], null)).toBe(-1);
  });

  it("compares numeric identifiers numerically", () => {
    expect(comparePrereleaseIdentifiers(["1"], ["2"])).toBe(-1);
    expect(comparePrereleaseIdentifiers(["10"], ["2"])).toBe(1);
  });

  it("ranks numeric identifiers before string identifiers", () => {
    expect(comparePrereleaseIdentifiers(["1"], ["beta"])).toBe(-1);
    expect(comparePrereleaseIdentifiers(["beta"], ["1"])).toBe(1);
  });

  it("compares string identifiers lexicographically", () => {
    expect(comparePrereleaseIdentifiers(["alpha"], ["beta"])).toBe(-1);
    expect(comparePrereleaseIdentifiers(["beta"], ["alpha"])).toBe(1);
  });

  it("favors shorter prerelease when common prefix matches", () => {
    // ["alpha"] < ["alpha","1"]
    expect(comparePrereleaseIdentifiers(["alpha"], ["alpha", "1"])).toBe(-1);
    expect(comparePrereleaseIdentifiers(["alpha", "1"], ["alpha"])).toBe(1);
  });
});

describe("compareComparableSemver", () => {
  it("returns null when either operand is null", () => {
    expect(compareComparableSemver(null, parseComparableSemver("1.0.0"))).toBeNull();
    expect(compareComparableSemver(parseComparableSemver("1.0.0"), null)).toBeNull();
  });

  it("compares major version precedence", () => {
    const a = parseComparableSemver("1.0.0");
    const b = parseComparableSemver("2.0.0");
    expect(compareComparableSemver(a, b)).toBe(-1);
    expect(compareComparableSemver(b, a)).toBe(1);
  });

  it("compares minor version precedence", () => {
    const a = parseComparableSemver("1.1.0");
    const b = parseComparableSemver("1.2.0");
    expect(compareComparableSemver(a, b)).toBe(-1);
  });

  it("compares patch version precedence", () => {
    const a = parseComparableSemver("1.0.1");
    const b = parseComparableSemver("1.0.2");
    expect(compareComparableSemver(a, b)).toBe(-1);
  });

  it("returns 0 for identical versions", () => {
    const a = parseComparableSemver("1.2.3");
    const b = parseComparableSemver("1.2.3");
    expect(compareComparableSemver(a, b)).toBe(0);
  });

  it("delegates to prerelease comparison when major/minor/patch match", () => {
    const stable = parseComparableSemver("1.0.0");
    const prerelease = parseComparableSemver("1.0.0-alpha");
    // stable > prerelease for same base version
    expect(compareComparableSemver(stable, prerelease)).toBe(1);
  });
});
