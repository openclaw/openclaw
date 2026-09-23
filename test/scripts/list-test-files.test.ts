import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { spawnNodeEvalSync } from "../../src/test-utils/node-process.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("keeps Git test discovery authoritative when unrelated tracked paths exceed the capture limit", () => {
  const root = tempDirs.make("ci-test-discovery-git-");
  const nonGit = tempDirs.make("ci-test-discovery-files-");
  const git = (args: string[], input?: string) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8", input });
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim();
  };
  git(["init", "--quiet"]);
  const blob = git(["hash-object", "-w", "--stdin"], "");
  const tracked = [
    "src/root.test.ts",
    "src/nested/deep.test.ts",
    "src/suffix[1].test.ts",
    "src/suffix1.test.ts",
  ].toSorted((a, b) => a.localeCompare(b));
  mkdirSync(join(root, "src/nested"), { recursive: true });
  mkdirSync(join(root, ".artifacts"), { recursive: true });
  for (const file of [...tracked, "src/custom.case", ".artifacts/untracked.test.ts"]) {
    writeFileSync(join(root, file), "");
  }
  writeFileSync(join(root, ".gitignore"), ".artifacts/\n");
  writeFileSync(join(nonGit, "fallback.test.ts"), "");
  const unrelated = Array.from(
    { length: 2_000 },
    (_, index) => "noise/" + "nested/".repeat(80) + index + ".data",
  );
  expect(Buffer.byteLength(unrelated.join("\n"))).toBeGreaterThan(1024 ** 2);
  const paths = [
    ...tracked,
    "src/custom.case",
    ...unrelated,
    ...unrelated.map((file) => file + ".overflow"),
  ];
  git(
    ["update-index", "--index-info"],
    paths.map((file) => "100644 " + blob + "\t" + file + "\n").join(""),
  );
  const owner = pathToFileURL(resolve("scripts/lib/list-test-files.mts")).href;
  const result = spawnNodeEvalSync(
    [
      "import { listTrackedTestFiles } from " + JSON.stringify(owner) + ";",
      "const nonGit = " + JSON.stringify(nonGit) + ";",
      "const report = {",
      "  root: listTrackedTestFiles('.'),",
      "  relative: listTrackedTestFiles('src'),",
      "  absolute: listTrackedTestFiles(process.cwd() + '/src'),",
      "  literal: listTrackedTestFiles('src', '[1].test.ts'),",
      "  custom: listTrackedTestFiles('.', '.case'),",
      "  nonGit: listTrackedTestFiles(nonGit),",
      "};",
      "try { listTrackedTestFiles('.', '.overflow'); }",
      "catch (error) { report.overflowCode = error.code; }",
      "process.env.PATH = nonGit;",
      "report.missingGit = listTrackedTestFiles(nonGit);",
      "console.log(JSON.stringify(report));",
    ].join("\n"),
    { cwd: root },
  );
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    root: tracked,
    relative: tracked,
    absolute: tracked,
    literal: ["src/suffix[1].test.ts"],
    custom: ["src/custom.case"],
    nonGit: [join(nonGit, "fallback.test.ts").replaceAll("\\", "/")],
    missingGit: [join(nonGit, "fallback.test.ts").replaceAll("\\", "/")],
    overflowCode: "ENOBUFS",
  });
});
