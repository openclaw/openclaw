import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

type PackageJson = {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

function readJson<T>(relativePath: string): T {
  return JSON.parse(readFileSync(new URL(relativePath, import.meta.url), "utf8")) as T;
}

describe("bundled extension root dependency mirrors", () => {
  it("mirrors allowlisted bundled extension runtime deps into the root package", () => {
    const rootPackage = readJson<PackageJson>("../package.json");
    const rootDeps = {
      ...rootPackage.dependencies,
      ...rootPackage.optionalDependencies,
    };

    expect(rootDeps).toHaveProperty("google-auth-library");
    expect(rootDeps).toHaveProperty("nostr-tools");
    expect(rootDeps).toHaveProperty("zca-js");
  });
});
