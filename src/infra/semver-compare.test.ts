// Tests semantic-version parsing and precedence used by update-check and
// plugin install/update ordering.
import { describe, expect, it } from "vitest";
import {
  compareComparableSemver,
  comparePrereleaseIdentifiers,
  normalizeLegacyDotBetaVersion,
  parseComparableSemver,
} from "./semver-compare.js";

describe("normalizeLegacyDotBetaVersion", () => {
  const cases: Array<[string, string]> = [
    ["1.2.3.beta.4", "1.2.3-beta.4"],
    ["1.2.3.beta", "1.2.3-beta"],
    ["v1.2.3.beta.2", "v1.2.3-beta.2"],
    ["V1.2.3.beta", "V1.2.3-beta"],
    ["1.2.3.beta.10.rc", "1.2.3-beta.10.rc"],
    ["  1.2.3.beta.4  ", "1.2.3-beta.4"],
    // Passthrough: already-semver, plain stable, and non-matching strings.
    ["1.2.3-beta.4", "1.2.3-beta.4"],
    ["1.2.3", "1.2.3"],
    ["1.2.3.alpha.1", "1.2.3.alpha.1"],
    ["not-a-version", "not-a-version"],
  ];
  it.each(cases)("normalizes %s to %s", (input, expected) => {
    expect(normalizeLegacyDotBetaVersion(input)).toBe(expected);
  });
});

describe("parseComparableSemver", () => {
  it("parses a stable version", () => {
    expect(parseComparableSemver("1.2.3")).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
      prerelease: null,
    });
  });

  it("strips a leading v and parses multi-digit components", () => {
    expect(parseComparableSemver("v10.20.30")).toEqual({
      major: 10,
      minor: 20,
      patch: 30,
      prerelease: null,
    });
  });

  it("splits prerelease identifiers on dots and keeps hyphens", () => {
    expect(parseComparableSemver("1.0.0-beta.2")?.prerelease).toEqual(["beta", "2"]);
    expect(parseComparableSemver("1.0.0-x-y.1")?.prerelease).toEqual(["x-y", "1"]);
  });

  it("ignores build metadata", () => {
    expect(parseComparableSemver("1.0.0+build.5")?.prerelease).toBeNull();
    expect(parseComparableSemver("1.0.0-rc.1+build.5")?.prerelease).toEqual(["rc", "1"]);
  });

  it("parses zero components", () => {
    expect(parseComparableSemver("0.0.0")).toEqual({
      major: 0,
      minor: 0,
      patch: 0,
      prerelease: null,
    });
  });

  it("normalizes legacy dot-beta only when the option is set", () => {
    expect(parseComparableSemver("1.2.3.beta.4", { normalizeLegacyDotBeta: true })).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
      prerelease: ["beta", "4"],
    });
    // Without normalization the four-segment legacy tag is not valid semver.
    expect(parseComparableSemver("1.2.3.beta.4")).toBeNull();
  });

  const invalidStrings: Array<[string]> = [
    ["1.2"],
    ["1"],
    ["1.2.3.4"],
    ["1.2.x"],
    ["v"],
    ["beta"],
    [""],
  ];
  it.each(invalidStrings)("returns null for invalid input %s", (input) => {
    expect(parseComparableSemver(input)).toBeNull();
  });

  it("returns null for null and undefined", () => {
    expect(parseComparableSemver(null)).toBeNull();
    expect(parseComparableSemver(undefined)).toBeNull();
  });
});

describe("comparePrereleaseIdentifiers", () => {
  const cases: Array<[string[] | null, string[] | null, number]> = [
    // A stable release outranks any prerelease of the same version.
    [null, null, 0],
    [["alpha"], null, -1],
    [null, ["alpha"], 1],
    [[], [], 0],
    // Equal identifier sets.
    [["beta", "2"], ["beta", "2"], 0],
    // Numeric identifiers compare numerically, not lexically.
    [["2"], ["11"], -1],
    [["11"], ["2"], 1],
    // Numeric identifiers have lower precedence than alphanumeric ones.
    [["1"], ["alpha"], -1],
    [["alpha"], ["1"], 1],
    // Alphanumeric identifiers compare in ASCII order.
    [["alpha"], ["beta"], -1],
    // A larger set outranks a smaller set when the shared prefix is equal.
    [["alpha"], ["alpha", "1"], -1],
    [["alpha", "1"], ["alpha"], 1],
    [["alpha", "1"], ["alpha", "beta"], -1],
  ];
  it.each(cases)("compares %s vs %s to %s", (a, b, expected) => {
    expect(comparePrereleaseIdentifiers(a, b)).toBe(expected);
  });
});

describe("compareComparableSemver", () => {
  const parse = (version: string) => parseComparableSemver(version);

  it("returns null when either side is unparsable", () => {
    expect(compareComparableSemver(parse("nope"), parse("1.0.0"))).toBeNull();
    expect(compareComparableSemver(parse("1.0.0"), null)).toBeNull();
  });

  const cases: Array<[string, string, number]> = [
    ["1.0.0", "2.0.0", -1],
    ["2.1.0", "2.0.9", 1],
    ["1.2.10", "1.2.9", 1],
    ["1.2.3", "1.2.3", 0],
    ["1.0.0-beta.2", "1.0.0-beta.2", 0],
    // Build metadata does not affect precedence.
    ["1.0.0+build.5", "1.0.0", 0],
    // A prerelease has lower precedence than its stable release.
    ["1.0.0-alpha", "1.0.0", -1],
    ["1.0.0", "1.0.0-alpha", 1],
  ];
  it.each(cases)("compares %s vs %s to %s", (a, b, expected) => {
    expect(compareComparableSemver(parse(a), parse(b))).toBe(expected);
  });

  it("orders the canonical semver.org 2.0.0 precedence chain", () => {
    // https://semver.org/#spec-item-11
    const ordered = [
      "1.0.0-alpha",
      "1.0.0-alpha.1",
      "1.0.0-alpha.beta",
      "1.0.0-beta",
      "1.0.0-beta.2",
      "1.0.0-beta.11",
      "1.0.0-rc.1",
      "1.0.0",
    ];
    for (let i = 0; i < ordered.length - 1; i += 1) {
      const lower = parse(ordered[i] ?? "");
      const higher = parse(ordered[i + 1] ?? "");
      expect(compareComparableSemver(lower, higher)).toBe(-1);
      expect(compareComparableSemver(higher, lower)).toBe(1);
    }
  });
});
