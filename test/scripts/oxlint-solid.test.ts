import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("enforces Solid 2 rules through the UI oxlint configuration", () => {
  // Materialize intentional violations in the real UI scope without ignoring lintable source.
  const directory = tempDirs.make("solid-lint-test-", path.resolve("ui"));
  const fixtures = ["invalid", "valid"].map((name) => {
    const file = path.join(directory, `${name}.tsx`);
    fs.copyFileSync(`ui/fixtures/solid-lint/${name}.tsx.txt`, file);
    return path.relative(process.cwd(), file);
  });
  const outsideDirectory = tempDirs.make("solid-lint-test-", path.resolve("test"));
  const outsideFixture = path.join(outsideDirectory, "invalid.tsx");
  fs.copyFileSync("ui/fixtures/solid-lint/invalid.tsx.txt", outsideFixture);
  const result = spawnSync(
    process.execPath,
    [
      "scripts/run-oxlint.mjs",
      "--openclaw-focused-config",
      "--format",
      "json",
      ...fixtures,
      outsideFixture,
    ],
    { encoding: "utf8" },
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(1);
  const report = JSON.parse(result.stdout) as {
    number_of_files: number;
    diagnostics: Array<{ filename: string; code: string; severity: string }>;
  };
  expect(report.number_of_files).toBe(3);
  const invalidDiagnostics = report.diagnostics.filter(
    ({ filename }) => filename.replaceAll("\\", "/") === fixtures[0]?.replaceAll("\\", "/"),
  );
  expect(
    invalidDiagnostics
      .map(({ code, severity }) => `${code}:${severity}`)
      .toSorted((a, b) => a.localeCompare(b)),
  ).toEqual(
    [
      "solid(reactivity):warning",
      "solid(reactivity):warning",
      "solid(reactivity):warning",
      "solid(reactivity):warning",
      "solid(no-destructure):error",
      "solid(no-unknown-namespaces):error",
      "solid(removed-api):error",
      "solid(no-single-arg-create-effect):error",
    ].toSorted((a, b) => a.localeCompare(b)),
  );
  expect(
    report.diagnostics.filter((diagnostic) => !invalidDiagnostics.includes(diagnostic)),
  ).toEqual([]);
});
