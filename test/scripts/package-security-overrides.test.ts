import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

type ParsedSemver = {
  core: [number, number, number];
  prerelease: string[];
};

function parseSemver(value: string): ParsedSemver {
  const normalized = value.trim().replace(/^[~^]/, "");
  const [corePart, prereleasePart] = normalized.split("-", 2);
  const coreTokens = corePart.split(".").slice(0, 3);
  if (coreTokens.length !== 3 || coreTokens.some((part) => !/^\d+$/.test(part))) {
    throw new Error(`Invalid semver value: ${value}`);
  }
  const parts = coreTokens.map((part) => Number(part));
  return {
    core: parts as [number, number, number],
    prerelease: prereleasePart ? prereleasePart.split(".").filter(Boolean) : [],
  };
}

function compareIdentifier(a: string, b: string): number {
  const isNumericA = /^\d+$/.test(a);
  const isNumericB = /^\d+$/.test(b);
  const numericA = isNumericA ? Number(a) : Number.NaN;
  const numericB = isNumericB ? Number(b) : Number.NaN;
  if (isNumericA && isNumericB) {
    return numericA === numericB ? 0 : numericA > numericB ? 1 : -1;
  }
  if (isNumericA) {
    return -1;
  }
  if (isNumericB) {
    return 1;
  }
  return a === b ? 0 : a > b ? 1 : -1;
}

function compareSemver(a: ParsedSemver, b: ParsedSemver): number {
  for (let i = 0; i < 3; i += 1) {
    if (a.core[i] > b.core[i]) {
      return 1;
    }
    if (a.core[i] < b.core[i]) {
      return -1;
    }
  }

  const aHasPre = a.prerelease.length > 0;
  const bHasPre = b.prerelease.length > 0;
  if (!aHasPre && !bHasPre) {
    return 0;
  }
  if (!aHasPre) {
    return 1;
  }
  if (!bHasPre) {
    return -1;
  }

  const len = Math.max(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < len; i += 1) {
    const aPart = a.prerelease[i];
    const bPart = b.prerelease[i];
    if (aPart === undefined) {
      return -1;
    }
    if (bPart === undefined) {
      return 1;
    }
    const idCompare = compareIdentifier(aPart, bPart);
    if (idCompare !== 0) {
      return idCompare;
    }
  }
  return 0;
}

function expectAtLeast(actual: string | undefined, minimum: string, label: string): void {
  expect(actual, `${label} must be defined`).toBeTruthy();
  const actualParts = parseSemver(actual!);
  const minimumParts = parseSemver(minimum);
  expect(
    compareSemver(actualParts, minimumParts) >= 0,
    `${label} must be >= ${minimum} (received ${actual})`,
  ).toBe(true);
}

describe("package security override floors", () => {
  it("keeps tar/hono pinned at or above patched versions", () => {
    const packageJsonPath = path.resolve(import.meta.dirname, "../../package.json");
    const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
      dependencies?: Record<string, string>;
      pnpm?: { overrides?: Record<string, string> };
    };

    const honoVersion = pkg.dependencies?.hono ?? pkg.pnpm?.overrides?.hono;
    expectAtLeast(honoVersion, "4.12.5", "hono floor");
    expectAtLeast(pkg.dependencies?.tar, "7.5.10", "tar dependency floor");
    expectAtLeast(pkg.pnpm?.overrides?.tar, "7.5.10", "tar override floor");
  });

  it("treats prereleases as lower than final patched release", () => {
    expect(() => expectAtLeast("7.5.10-beta.1", "7.5.10", "tar prerelease floor")).toThrow(
      /must be >= 7\.5\.10/,
    );
    expectAtLeast("7.5.10", "7.5.10", "tar stable floor");
  });

  it("rejects semver tokens with trailing junk", () => {
    expect(() => expectAtLeast("7.5.10 || 0.0.1", "7.5.10", "tar floor")).toThrow(
      /Invalid semver value/,
    );
  });
});
