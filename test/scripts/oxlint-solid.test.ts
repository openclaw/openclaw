import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("enforces Solid 2 rules through the UI oxlint configuration", () => {
  // Materialize intentional violations in the real UI scope without ignoring lintable source.
  const directory = tempDirs.make("solid-lint-test-", path.resolve("ui/src/lib/reactive"));
  const fixtures = ["tsx", "ts"].flatMap((extension) =>
    ["invalid", "valid"].map((name) => {
      const file = path.join(directory, `${name}.${extension}`);
      fs.copyFileSync(`ui/fixtures/solid-lint/${name}.${extension}.txt`, file);
      return path.relative(process.cwd(), file);
    }),
  );
  const outsideDirectory = tempDirs.make("solid-lint-test-", path.resolve("test"));
  const outsideFixtures = ["tsx", "ts"].map((extension) => {
    const file = path.join(outsideDirectory, `invalid.${extension}`);
    fs.copyFileSync(`ui/fixtures/solid-lint/invalid.${extension}.txt`, file);
    return file;
  });
  const result = spawnSync(
    process.execPath,
    [
      "scripts/run-oxlint.mjs",
      "--openclaw-focused-config",
      "--format",
      "json",
      ...fixtures,
      ...outsideFixtures,
    ],
    { encoding: "utf8" },
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(1);
  const report = JSON.parse(result.stdout) as {
    number_of_files: number;
    diagnostics: Array<{ filename: string; code: string; severity: string }>;
  };
  expect(report.number_of_files).toBe(6);
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
  const invalidHelperDiagnostics = report.diagnostics.filter(
    ({ filename }) => filename.replaceAll("\\", "/") === fixtures[2]?.replaceAll("\\", "/"),
  );
  expect(
    invalidHelperDiagnostics
      .map(({ code, severity }) => `${code}:${severity}`)
      .toSorted((a, b) => a.localeCompare(b)),
  ).toEqual([
    "solid(no-single-arg-create-effect):error",
    "solid(removed-api):error",
    "solid(removed-api):error",
    "solid(removed-api):error",
  ]);
  expect(
    report.diagnostics.filter(
      (diagnostic) =>
        !invalidDiagnostics.includes(diagnostic) && !invalidHelperDiagnostics.includes(diagnostic),
    ),
  ).toEqual([]);
});
