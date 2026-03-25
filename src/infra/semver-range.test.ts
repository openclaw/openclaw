import { describe, expect, it } from "vitest";
import {
  compareSemver,
  findLatestCompatible,
  isPrerelease,
  parseSemverTuple,
  satisfiesRange,
  sortVersionsDescending,
} from "./semver-range.js";

describe("parseSemverTuple", () => {
  it("parses basic version", () => {
    expect(parseSemverTuple("2026.3.14")).toEqual({
      major: 2026,
      minor: 3,
      patch: 14,
      prerelease: null,
    });
  });

  it("parses version with v prefix", () => {
    expect(parseSemverTuple("v1.2.3")).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
      prerelease: null,
    });
  });

  it("parses prerelease version", () => {
    expect(parseSemverTuple("2026.3.14-beta.1")).toEqual({
      major: 2026,
      minor: 3,
      patch: 14,
      prerelease: ["beta", "1"],
    });
  });

  it("returns null for invalid version", () => {
    expect(parseSemverTuple("not-a-version")).toBeNull();
    expect(parseSemverTuple("")).toBeNull();
  });
});

describe("compareSemver", () => {
  it("compares major versions", () => {
    const a = parseSemverTuple("2026.3.14")!;
    const b = parseSemverTuple("2025.3.14")!;
    expect(compareSemver(a, b)).toBeGreaterThan(0);
    expect(compareSemver(b, a)).toBeLessThan(0);
  });

  it("compares minor versions", () => {
    const a = parseSemverTuple("2026.4.0")!;
    const b = parseSemverTuple("2026.3.14")!;
    expect(compareSemver(a, b)).toBeGreaterThan(0);
  });

  it("compares patch versions", () => {
    const a = parseSemverTuple("2026.3.15")!;
    const b = parseSemverTuple("2026.3.14")!;
    expect(compareSemver(a, b)).toBeGreaterThan(0);
  });

  it("equal versions return 0", () => {
    const a = parseSemverTuple("2026.3.14")!;
    const b = parseSemverTuple("2026.3.14")!;
    expect(compareSemver(a, b)).toBe(0);
  });

  it("release > prerelease", () => {
    const release = parseSemverTuple("2026.3.14")!;
    const pre = parseSemverTuple("2026.3.14-beta.1")!;
    expect(compareSemver(release, pre)).toBeGreaterThan(0);
    expect(compareSemver(pre, release)).toBeLessThan(0);
  });
});

describe("satisfiesRange", () => {
  describe("operators", () => {
    it(">=", () => {
      expect(satisfiesRange("2026.3.14", ">=2026.3.10")).toBe(true);
      expect(satisfiesRange("2026.3.10", ">=2026.3.10")).toBe(true);
      expect(satisfiesRange("2026.3.9", ">=2026.3.10")).toBe(false);
    });

    it(">", () => {
      expect(satisfiesRange("2026.3.14", ">2026.3.10")).toBe(true);
      expect(satisfiesRange("2026.3.10", ">2026.3.10")).toBe(false);
    });

    it("<=", () => {
      expect(satisfiesRange("2026.3.10", "<=2026.3.14")).toBe(true);
      expect(satisfiesRange("2026.3.14", "<=2026.3.14")).toBe(true);
      expect(satisfiesRange("2026.3.15", "<=2026.3.14")).toBe(false);
    });

    it("<", () => {
      expect(satisfiesRange("2026.3.10", "<2026.3.14")).toBe(true);
      expect(satisfiesRange("2026.3.14", "<2026.3.14")).toBe(false);
    });

    it("=", () => {
      expect(satisfiesRange("2026.3.14", "=2026.3.14")).toBe(true);
      expect(satisfiesRange("2026.3.13", "=2026.3.14")).toBe(false);
    });
  });

  describe("caret range", () => {
    it("^M.m.p with M > 0", () => {
      // ^2026.3.10 → >=2026.3.10 <2027.0.0
      expect(satisfiesRange("2026.3.14", "^2026.3.10")).toBe(true);
      expect(satisfiesRange("2026.3.10", "^2026.3.10")).toBe(true);
      expect(satisfiesRange("2026.12.0", "^2026.3.10")).toBe(true);
      expect(satisfiesRange("2026.3.9", "^2026.3.10")).toBe(false);
      expect(satisfiesRange("2027.0.0", "^2026.3.10")).toBe(false);
    });

    it("^0.m.p with m > 0", () => {
      // ^0.2.3 → >=0.2.3 <0.3.0
      expect(satisfiesRange("0.2.5", "^0.2.3")).toBe(true);
      expect(satisfiesRange("0.3.0", "^0.2.3")).toBe(false);
    });

    it("^0.0.p", () => {
      // ^0.0.3 → >=0.0.3 <0.0.4
      expect(satisfiesRange("0.0.3", "^0.0.3")).toBe(true);
      expect(satisfiesRange("0.0.4", "^0.0.3")).toBe(false);
    });
  });

  describe("tilde range", () => {
    it("~M.m.p", () => {
      // ~2026.3.10 → >=2026.3.10 <2026.4.0
      expect(satisfiesRange("2026.3.14", "~2026.3.10")).toBe(true);
      expect(satisfiesRange("2026.3.10", "~2026.3.10")).toBe(true);
      expect(satisfiesRange("2026.4.0", "~2026.3.10")).toBe(false);
      expect(satisfiesRange("2026.3.9", "~2026.3.10")).toBe(false);
    });
  });

  describe("wildcard", () => {
    it("* matches everything", () => {
      expect(satisfiesRange("2026.3.14", "*")).toBe(true);
      expect(satisfiesRange("0.0.1", "*")).toBe(true);
    });

    it("empty range matches everything", () => {
      expect(satisfiesRange("2026.3.14", "")).toBe(true);
    });
  });

  describe("unions (||)", () => {
    it("matches if any branch matches", () => {
      expect(satisfiesRange("2026.3.14", ">=2026.3.10 || >=2025.0.0 <2026.0.0")).toBe(true);
      expect(satisfiesRange("2025.6.0", ">=2026.3.10 || >=2025.0.0 <2026.0.0")).toBe(true);
      expect(satisfiesRange("2024.1.0", ">=2026.3.10 || >=2025.0.0 <2026.0.0")).toBe(false);
    });
  });

  describe("compound ranges", () => {
    it(">=A <B", () => {
      expect(satisfiesRange("2026.3.14", ">=2026.3.10 <2027.0.0")).toBe(true);
      expect(satisfiesRange("2027.0.0", ">=2026.3.10 <2027.0.0")).toBe(false);
      expect(satisfiesRange("2026.3.9", ">=2026.3.10 <2027.0.0")).toBe(false);
    });
  });

  describe("bare version (exact match)", () => {
    it("matches only the exact version", () => {
      expect(satisfiesRange("2026.3.14", "2026.3.14")).toBe(true);
      expect(satisfiesRange("2026.3.15", "2026.3.14")).toBe(false);
    });
  });

  describe("prerelease handling", () => {
    it("prerelease version satisfies >= range", () => {
      expect(satisfiesRange("2026.3.14-beta.1", ">=2026.3.10")).toBe(true);
    });

    it("prerelease version does not satisfy >= its own release", () => {
      expect(satisfiesRange("2026.3.14-beta.1", ">=2026.3.14")).toBe(false);
    });
  });

  describe("invalid inputs", () => {
    it("returns false for invalid version", () => {
      expect(satisfiesRange("not-a-version", ">=1.0.0")).toBe(false);
    });
  });
});

describe("sortVersionsDescending", () => {
  it("sorts versions in descending order", () => {
    const versions = ["2026.3.10", "2026.3.14", "2026.3.12", "2025.1.0"];
    expect(sortVersionsDescending(versions)).toEqual([
      "2026.3.14",
      "2026.3.12",
      "2026.3.10",
      "2025.1.0",
    ]);
  });

  it("sorts prereleases before their release", () => {
    const versions = ["2026.3.14", "2026.3.14-beta.1", "2026.3.14-beta.2"];
    expect(sortVersionsDescending(versions)).toEqual([
      "2026.3.14",
      "2026.3.14-beta.2",
      "2026.3.14-beta.1",
    ]);
  });
});

describe("findLatestCompatible", () => {
  const versions = ["2026.3.14", "2026.3.12", "2026.3.10", "2025.12.1", "2025.6.0"];

  it("finds latest version satisfying range", () => {
    expect(findLatestCompatible(versions, ">=2026.3.10")).toBe("2026.3.14");
  });

  it("finds latest when latest does not match", () => {
    expect(findLatestCompatible(versions, ">=2025.0.0 <2026.0.0")).toBe("2025.12.1");
  });

  it("returns null when no version matches", () => {
    expect(findLatestCompatible(versions, ">=2027.0.0")).toBeNull();
  });

  it("handles wildcard range", () => {
    expect(findLatestCompatible(versions, "*")).toBe("2026.3.14");
  });
});

describe("isPrerelease", () => {
  it("detects prerelease versions", () => {
    expect(isPrerelease("2026.3.14-beta.1")).toBe(true);
    expect(isPrerelease("2026.3.14")).toBe(false);
  });
});
