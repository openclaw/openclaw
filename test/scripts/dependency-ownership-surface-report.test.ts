import { execFileSync } from "node:child_process";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  collectDependencyOwnershipSurfaceCheckErrors,
  type collectDependencyOwnershipSurfaceReport,
  packageNameFromLockKey,
  parseArgs,
  renderDependencyOwnershipSurfaceMarkdownReport,
} from "../../scripts/dependency-ownership-surface-report.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { writeFixtureFiles } from "./z0632-fixtures.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("extracts scoped and unscoped names from pnpm snapshot keys", () => {
  expect(packageNameFromLockKey("@scope/pkg@1.2.3(peer@1.0.0)")).toBe("@scope/pkg");
  expect(packageNameFromLockKey("left-pad@1.3.0")).toBe("left-pad");
});
it("keeps json as a boolean or optional artifact path", () => {
  expect(parseArgs(["--json"])).toMatchObject({ asJson: true, jsonPath: null });
  expect(parseArgs(["--json", "report.json"])).toMatchObject({
    asJson: true,
    jsonPath: "report.json",
  });
  expect(() => parseArgs(["--json", "-h"])).toThrow("Unsupported argument: -h");
});

it("rejects duplicate report artifact options", () => {
  expect(() => parseArgs(["--json", "first.json", "--json", "second.json"])).toThrow(
    "--json was provided more than once.",
  );
  expect(() => parseArgs(["--markdown", "first.md", "--markdown", "second.md"])).toThrow(
    "--markdown was provided more than once.",
  );
});
it("reports ownership and install surface with toolchain metadata", () => {
  const repoRoot = tempDirs.make("openclaw-ownership-surface-");
  const ownership = (owner: string, risk: string) => ({
    owner,
    class: "core-runtime",
    risk: [risk],
  });
  writeFixtureFiles(repoRoot, {
    "package.json": { dependencies: { "core-lib": "1.0.0", "missing-owner": "2.0.0" } },
    "scripts/lib/dependency-ownership.json": {
      schemaVersion: 1,
      dependencies: {
        "alias-domexception": ownership("core:test", "compat"),
        "core-lib": ownership("core:test", "network"),
        "plugin-readable": {
          owner: "plugin:web-readability",
          class: "plugin-runtime",
          risk: ["html"],
        },
        "removed-lib": ownership("core:test", "unused"),
      },
    },
    "src/index.ts": 'import "core-lib";\n',
    "pnpm-lock.yaml": `---
lockfileVersion: '9.0'
packages: {toolchain@12.0.0: {hasBin: true}}
snapshots: {toolchain@12.0.0: {}}
---
lockfileVersion: '9.0'
importers:
  .:
    dependencies:
      core-lib: {specifier: 1.0.0, version: 1.0.0}
      missing-owner: {specifier: 2.0.0, version: 2.0.0}
      alias-domexception: {specifier: 'npm:@nolyfill/domexception@1.0.0', version: 'npm:@nolyfill/domexception@1.0.0'}
  extensions/web-readability:
    dependencies: {plugin-readable: {specifier: 2.0.0, version: 2.0.0}}
packages:
  core-lib@1.0.0: {}
  transitive-native@1.0.0: {requiresBuild: true}
  missing-owner@2.0.0: {}
  '@nolyfill/domexception@1.0.0': {}
  plugin-readable@2.0.0: {}
snapshots:
  core-lib@1.0.0:
    dependencies: {transitive-native: 1.0.0, alias-domexception: '@nolyfill/domexception@1.0.0'}
  transitive-native@1.0.0: {}
  missing-owner@2.0.0: {}
  '@nolyfill/domexception@1.0.0': {}
  plugin-readable@2.0.0: {}
`,
  });
  const report: ReturnType<typeof collectDependencyOwnershipSurfaceReport> = JSON.parse(
    execFileSync(
      process.execPath,
      [
        "--import",
        path.resolve("scripts/tsx.mjs"),
        path.resolve("scripts/dependency-ownership-surface-report.mts"),
        "--root",
        repoRoot,
        "--json",
      ],
      { encoding: "utf8" },
    ),
  );
  expect(report.summary).toEqual({
    buildRiskPackageCount: 2,
    importerCount: 2,
    lockfilePackageCount: 6,
    rootClosurePackageCount: 4,
    rootDirectDependencyCount: 3,
    rootOwnershipRecordCount: 4,
  });
  expect(report.ownershipGaps).toEqual(["missing-owner"]);
  expect(report.staleOwnershipRecords).toEqual(["removed-lib"]);
  expect(report.topRootDependencyCones[0]).toEqual({
    class: "core-runtime",
    closureSize: 3,
    missingSnapshotKeys: [],
    name: "core-lib",
    owner: "core:test",
    resolved: "1.0.0",
    risk: ["network"],
    section: "dependencies",
    sourceCategory: "unreferenced",
    sourceFileCount: 0,
    sourceSections: [],
    specifier: "1.0.0",
  });
  expect(collectDependencyOwnershipSurfaceCheckErrors(report)).toEqual([
    "root dependency 'missing-owner' is missing from scripts/lib/dependency-ownership.json",
  ]);

  const markdown = renderDependencyOwnershipSurfaceMarkdownReport(report);
  expect(markdown).toContain("`missing-owner`");
  expect(markdown).toContain("`core-lib`: 3 resolved transitive packages");
  expect(markdown).toContain("3 direct dependencies");
  expect(markdown).toContain("`transitive-native@1.0.0`: requires build");
});
