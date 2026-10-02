// Vitest unit path tests validate unit test include and exclude paths.
import path from "node:path";
import { describe, expect, it } from "vitest";
import { bundledPluginFile } from "../scripts/lib/bundled-plugin-paths.mjs";
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

  it("accepts unit-config package tests", () => {
    expect(isUnitConfigTestFile("packages/plugin-package-contract/src/index.test.ts")).toBe(true);
  });

  it("rejects files excluded from the unit config", () => {
    expect(isUnitConfigTestFile("packages/gateway-client/src/index.test.ts")).toBe(false);
    expect(isUnitConfigTestFile("packages/gateway-protocol/src/index.test.ts")).toBe(false);
    expect(
      isUnitConfigTestFile(
        bundledPluginFile("imessage", "src/monitor.shutdown.unhandled-rejection.test.ts"),
      ),
    ).toBe(false);
    expect(isUnitConfigTestFile("src/infra/matrix-plugin-helper.test.ts")).toBe(false);
    expect(isUnitConfigTestFile("src/infra/git-root.test.ts")).toBe(false);
    expect(
      isUnitConfigTestFile(bundledPluginFile("matrix", "src/migration-snapshot.test.ts")),
    ).toBe(false);
    expect(isUnitConfigTestFile("src/plugin-sdk/facade-runtime.test.ts")).toBe(false);
    expect(isUnitConfigTestFile("src/plugins/loader.test.ts")).toBe(false);
    expect(isUnitConfigTestFile("src/state/openclaw-database-verify.process.test.ts")).toBe(false);
    expect(isUnitConfigTestFile("test/format-error.test.ts")).toBe(false);
    expect(isUnitConfigTestFile("src/agents/embedded-agent-runner.test.ts")).toBe(false);
    expect(isUnitConfigTestFile("src/commands/onboard.test.ts")).toBe(false);
    expect(isUnitConfigTestFile("ui/src/ui/views/channels.test.ts")).toBe(false);
  });
});
