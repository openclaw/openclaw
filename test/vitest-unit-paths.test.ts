// Vitest unit path tests validate unit test include and exclude paths.
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  filterUnitConfigTestFiles,
  isUnitConfigTestFile,
  unitTestAdditionalExcludePatterns,
  unitTestIncludePatterns,
} from "./vitest/vitest.unit-paths.mjs";

describe("isUnitConfigTestFile", () => {
  it("retains the runtime's hidden-file ownership in bulk and singleton discovery", () => {
    const file = "src/.hidden-fixture.test.ts";
    const included = path.matchesGlob(file, "src/**/*.test.ts");
    expect(filterUnitConfigTestFiles([file])).toEqual(included ? [file] : []);
    expect(isUnitConfigTestFile(file)).toBe(included);
  });

  it("keeps bulk unit discovery ordered with shared exclusions", () => {
    const packageFile = "packages/plugin-package-contract/src/index.test.ts";
    const sourceFile = "src/unowned-fixture.test.ts";
    expect(
      filterUnitConfigTestFiles([
        packageFile,
        "src/state/openclaw-database-verify.process.test.ts",
        sourceFile,
        "src/unowned-fixture.live.test.ts",
        "src/unowned-fixture.e2e.test.ts",
        "src/vendor/unowned-fixture.test.ts",
        packageFile,
      ]),
    ).toEqual([packageFile, sourceFile, packageFile]);
  });

  it("preserves native exclusions for noncanonical paths in bulk and singleton discovery", () => {
    const included = "src/unowned-fixture.test.ts";
    const excluded = "src/state/openclaw-database-verify.process.test.ts";
    const files = [
      included,
      excluded,
      `./${excluded}`,
      excluded.replace("/state/", "//state/"),
      excluded.replace("/state/", "/state/./"),
      excluded.replace("/state/", "/state/../state/"),
      excluded.replaceAll("/", "\\"),
      excluded.toUpperCase(),
      included,
    ];
    const expected = files.filter((file) => {
      const normalized = file.split(path.sep).join("/");
      return (
        unitTestIncludePatterns.some((pattern) => path.matchesGlob(normalized, pattern)) &&
        !unitTestAdditionalExcludePatterns.some((pattern) => path.matchesGlob(normalized, pattern))
      );
    });
    expect(filterUnitConfigTestFiles(files)).toEqual(expected);
    for (const file of files) {
      expect(isUnitConfigTestFile(file)).toBe(expected.includes(file));
    }
  });
});
