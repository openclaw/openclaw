import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

type PackageJson = {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

describe("bundled extension deps", () => {
  it("declares bundled extension runtime deps at the root (npm-installed)", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const repoRoot = path.resolve(here, "../..");

    const readJson = <T>(filePath: string): T => JSON.parse(fs.readFileSync(filePath, "utf8")) as T;

    const rootPkg = readJson<PackageJson>(path.join(repoRoot, "package.json"));
    const memoryLancePkg = readJson<PackageJson>(
      path.join(repoRoot, "extensions", "memory-lancedb", "package.json"),
    );

    const required = Object.keys(memoryLancePkg.dependencies ?? {});
    const missing = required.filter(
      (dep) => !rootPkg.dependencies?.[dep] && !rootPkg.optionalDependencies?.[dep],
    );

    expect(
      missing,
      `package.json must declare bundled extension deps: ${missing.join(", ")}`,
    ).toEqual([]);
  });
});
