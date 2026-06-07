import { describe, test, expect } from "vitest";

/**
 * Parse version string into parts
 */
function getVersionParts(version: string): {
  major: number;
  minor: number;
  patch: number;
  raw: string;
} {
  // Strip 'v' prefix if present
  const cleanVersion = version.replace(/^v/, "");
  const parts = cleanVersion.split(".");
  return {
    major: parseInt(parts[0] ?? "0", 10),
    minor: parseInt(parts[1] ?? "0", 10),
    patch: parseInt(parts[2] ?? "0", 10),
    raw: version,
  };
}

/**
 * Compare two versions and return lag
 * @returns 0=same, positive=behind, 100+=minor lag, 1000+=major lag
 */
function compareVersions(current: string, latest: string): number {
  const currentParts = getVersionParts(current);
  const latestParts = getVersionParts(latest);

  if (latestParts.major !== currentParts.major) {
    return 1000; // Major version difference is significant
  }

  if (latestParts.minor !== currentParts.minor) {
    return 100; // Minor version difference is significant
  }

  return latestParts.patch - currentParts.patch;
}

describe("Windows Node Version Check", () => {
  describe("getVersionParts", () => {
    test("parses standard version", () => {
      const parts = getVersionParts("0.6.3");
      expect(parts).toEqual({ major: 0, minor: 6, patch: 3, raw: "0.6.3" });
    });

    test("handles v prefix", () => {
      const parts = getVersionParts("v0.6.3");
      expect(parts).toEqual({ major: 0, minor: 6, patch: 3, raw: "v0.6.3" });
    });

    test("handles partial versions", () => {
      const parts = getVersionParts("0.6");
      expect(parts).toEqual({ major: 0, minor: 6, patch: 0, raw: "0.6" });
    });
  });

  describe("compareVersions", () => {
    test("same version - no lag", () => {
      expect(compareVersions("0.6.3", "0.6.3")).toBe(0);
    });

    test("same version with v prefix - no lag", () => {
      expect(compareVersions("v0.6.3", "0.6.3")).toBe(0);
    });

    test("one patch behind - acceptable", () => {
      expect(compareVersions("0.6.2", "0.6.3")).toBe(1);
    });

    test("two patches behind - acceptable (default threshold)", () => {
      expect(compareVersions("0.6.1", "0.6.3")).toBe(2);
    });

    test("three patches behind - exceeds default threshold", () => {
      expect(compareVersions("0.6.0", "0.6.3")).toBe(3);
    });

    test("minor version behind - significant lag", () => {
      expect(compareVersions("0.5.5", "0.6.3")).toBe(100);
    });

    test("major version behind - critical lag", () => {
      expect(compareVersions("0.6.3", "1.0.0")).toBe(1000);
    });

    test("ahead of latest - negative lag", () => {
      expect(compareVersions("0.6.4", "0.6.3")).toBe(-1);
    });

    test("real issue 90953 scenario - v0.6.0 vs v0.6.3", () => {
      // Issue 90953: OpenClaw release uses v0.6.0, but fixed version is v0.6.3
      const lag = compareVersions("0.6.0", "0.6.3");
      expect(lag).toBe(3);
      expect(lag).toBeGreaterThan(2); // Should exceed default MaxPatchLag threshold of 2
    });

    test("critical lag detection - minor version mismatch", () => {
      const lag = compareVersions("0.5.9", "0.6.0");
      expect(lag).toBe(100);
      expect(lag).toBeGreaterThanOrEqual(100);
    });

    test("critical lag detection - major version mismatch", () => {
      const lag = compareVersions("0.9.9", "1.0.0");
      expect(lag).toBe(1000);
      expect(lag).toBeGreaterThanOrEqual(1000);
    });
  });

  describe("threshold validation", () => {
    test("default threshold of 2 allows patch lag 1", () => {
      const lag = compareVersions("0.6.2", "0.6.3");
      const maxPatchLag = 2;
      expect(lag).toBeLessThanOrEqual(maxPatchLag);
    });

    test("default threshold of 2 allows patch lag 2", () => {
      const lag = compareVersions("0.6.1", "0.6.3");
      const maxPatchLag = 2;
      expect(lag).toBeLessThanOrEqual(maxPatchLag);
    });

    test("default threshold of 2 blocks patch lag 3", () => {
      const lag = compareVersions("0.6.0", "0.6.3");
      const maxPatchLag = 2;
      expect(lag).toBeGreaterThan(maxPatchLag);
    });
  });
});
