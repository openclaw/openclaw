import { describe, expect, it } from "vitest";
import {
  compareComparableSemver,
  comparePrereleaseIdentifiers,
  normalizeLegacyDotBetaVersion,
  parseComparableSemver,
} from "./semver-compare.js";

describe("normalizeLegacyDotBetaVersion", () => {
  it("converts legacy dot-beta tags to semver prerelease format", () => {
    expect(normalizeLegacyDotBetaVersion("1.2.3.beta.4")).toBe("1.2.3-beta.4");
    expect(normalizeLegacyDotBetaVersion("1.0.0.beta.1")).toBe("1.0.0-beta.1");
  });

  it("handles beta without a numeric suffix", () => {
    expect(normalizeLegacyDotBetaVersion("2.0.0.beta")).toBe("2.0.0-beta");
  });

  it("preserves v-prefixed versions", () => {
    expect(normalizeLegacyDotBetaVersion("v1.2.3.beta.1")).toBe("v1.2.3-beta.1");
  });

  it("passes through already-standard semver unchanged", () => {
    expect(normalizeLegacyDotBetaVersion("1.2.3-beta.1")).toBe("1.2.3-beta.1");
    expect(normalizeLegacyDotBetaVersion("1.2.3")).toBe("1.2.3");
  });
});

describe("parseComparableSemver", () => {
  it("parses standard semver with prerelease", () => {
    expect(parseComparableSemver("1.2.3-beta.1")).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
      prerelease: ["beta", "1"],
    });
  });

  it("parses semver without prerelease", () => {
    expect(parseComparableSemver("2.0.0")).toEqual({
      major: 2,
      minor: 0,
      patch: 0,
      prerelease: null,
    });
  });

  it("handles v-prefix", () => {
    const result = parseComparableSemver("v3.1.4");
    expect(result?.major).toBe(3);
    expect(result?.minor).toBe(1);
    expect(result?.patch).toBe(4);
  });

  it("returns null for null or undefined", () => {
    expect(parseComparableSemver(null)).toBeNull();
    expect(parseComparableSemver(undefined)).toBeNull();
  });

  it("returns null for invalid version strings", () => {
    expect(parseComparableSemver("not-a-version")).toBeNull();
    expect(parseComparableSemver("1.2")).toBeNull();
  });

  it("normalizes legacy dot-beta when option is enabled", () => {
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

  it("stable release outranks any prerelease", () => {
    expect(comparePrereleaseIdentifiers(null, ["beta"])).toBe(1);
    expect(comparePrereleaseIdentifiers(["beta"], null)).toBe(-1);
  });

  it("shorter identifier list loses to longer when prefixes match", () => {
    expect(comparePrereleaseIdentifiers(["beta"], ["beta", "1"])).toBe(-1);
    expect(comparePrereleaseIdentifiers(["beta", "1"], ["beta"])).toBe(1);
  });
});

describe("compareComparableSemver", () => {
  it("returns null for null inputs", () => {
    expect(compareComparableSemver(null, null)).toBeNull();
  });

  it("compares major version first", () => {
    const a = parseComparableSemver("2.0.0")!;
    const b = parseComparableSemver("1.0.0")!;
    expect(compareComparableSemver(a, b)).toBe(1);
    expect(compareComparableSemver(b, a)).toBe(-1);
  });

  it("returns 0 for equal versions", () => {
    const a = parseComparableSemver("1.2.3")!;
    expect(compareComparableSemver(a, a)).toBe(0);
  });
});
