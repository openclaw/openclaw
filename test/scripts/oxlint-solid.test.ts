import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const helperDiagnostics = [
  "solid(no-single-arg-create-effect):error",
  "solid(removed-api):error",
  "solid(removed-api):error",
  "solid(removed-api):error",
];
const componentDiagnostics = [
  "solid(reactivity):warning",
  "solid(reactivity):warning",
  "solid(reactivity):warning",
  "solid(reactivity):warning",
  "solid(no-destructure):error",
  "solid(no-unknown-namespaces):error",
  "solid(removed-api):error",
  "solid(no-single-arg-create-effect):error",
];

it("enforces Solid 2 rules across UI helpers and plugin views", () => {
  // Exercise the actual path-scoped config, including non-UI negative controls.
  const scopes = [
    { root: "ui/src/lib/reactive", extension: "ts", diagnostics: helperDiagnostics },
    { root: "ui/src/lib/reactive", extension: "tsx", diagnostics: componentDiagnostics },
    { root: "ui/src/pages", extension: "ts", diagnostics: helperDiagnostics },
    { root: "ui/src/lib", extension: "ts", diagnostics: helperDiagnostics },
    { root: "extensions/memory-core/browser", extension: "ts", diagnostics: helperDiagnostics },
    { root: "extensions/clawrouter/src", extension: "tsx", diagnostics: componentDiagnostics },
    { root: "test", extension: "ts", diagnostics: [] },
    { root: "test", extension: "tsx", diagnostics: [] },
  ];
  const expected = new Map<string, string[]>();
  for (const { root, extension, diagnostics } of scopes) {
    const directory = tempDirs.make("solid-lint-test-", path.resolve(root));
    for (const name of ["invalid", "valid"]) {
      const file = path.join(directory, name + "." + extension);
      fs.copyFileSync("ui/fixtures/solid-lint/" + name + "." + extension + ".txt", file);
      expected.set(
        path.relative(process.cwd(), file).replaceAll("\\", "/"),
        name === "invalid" ? diagnostics : [],
      );
    }
  }
  const dataDirectory = tempDirs.make("solid-lint-test-", path.resolve("ui/src/lib"));
  const dataFile = path.join(dataDirectory, "plain-data.ts");
  fs.writeFileSync(
    dataFile,
    "export function readLabel(props: { label: string }) { return props.label; }",
  );
  expected.set(path.relative(process.cwd(), dataFile).replaceAll("\\", "/"), []);
  const result = spawnSync(
    process.execPath,
    ["scripts/run-oxlint.mjs", "--openclaw-focused-config", "--format", "json", ...expected.keys()],
    { encoding: "utf8" },
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(1);
  const report = JSON.parse(result.stdout) as {
    number_of_files: number;
    diagnostics: Array<{ filename: string; code: string; severity: string }>;
  };
  expect(report.number_of_files).toBe(expected.size);
  for (const [file, diagnostics] of expected) {
    const actual = report.diagnostics
      .filter(({ filename }) => filename.replaceAll("\\", "/") === file)
      .map(({ code, severity }) => code + ":" + severity);
    expect(actual.toSorted(), file).toEqual(diagnostics.toSorted());
  }
});
