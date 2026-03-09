import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function parseSemver(value: string): [number, number, number] {
  const normalized = value.trim().replace(/^[~^]/, "").split("-")[0];
  const parts = normalized
    .split(".")
    .slice(0, 3)
    .map((part) => Number.parseInt(part, 10));
  if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part))) {
    throw new Error(`Invalid semver value: ${value}`);
  }
  return parts as [number, number, number];
}

function compareSemver(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] > b[i]) {
      return 1;
    }
    if (a[i] < b[i]) {
      return -1;
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
});
