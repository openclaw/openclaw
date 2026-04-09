import fs from "node:fs";
import { describe, expect, it } from "vitest";

type OxlintConfig = {
  ignorePatterns?: string[];
};

type OxlintTsconfig = {
  include?: string[];
  exclude?: string[];
};

function readJson<T>(path: string): T {
  return JSON.parse(fs.readFileSync(path, "utf8")) as T;
}

describe("oxlint config", () => {
  it("includes bundled extensions in type-aware lint coverage", () => {
    const tsconfig = readJson<OxlintTsconfig>("tsconfig.oxlint.json");

    expect(tsconfig.include).toContain("extensions/**/*");
    expect(tsconfig.exclude ?? []).not.toContain("extensions");
  });

  it("does not ignore the bundled extensions tree", () => {
    const config = readJson<OxlintConfig>(".oxlintrc.json");

    expect(config.ignorePatterns ?? []).not.toContain("extensions/");
  });

  it("keeps generated and vendored extension outputs ignored", () => {
    const config = readJson<OxlintConfig>(".oxlintrc.json");
    const ignorePatterns = config.ignorePatterns ?? [];

    expect(ignorePatterns).toContain("**/node_modules/**");
    expect(ignorePatterns).toContain("**/dist/**");
    expect(ignorePatterns).toContain("**/build/**");
    expect(ignorePatterns).toContain("**/coverage/**");
    expect(ignorePatterns).toContain("**/.cache/**");
  });
});
