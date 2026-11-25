import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { listRepoFilesSync } from "../../scripts/check-file-utils.js";
import {
  buildVitestRunPlans,
  findUnmatchedExplicitTestTargets,
} from "../../scripts/test-projects.test-support.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it.each([false, true])("discovers an archive nested in Git (ignored: %s)", (ignored) => {
  const parent = tempDirs.make("inventory-parent-");
  execFileSync("git", ["init", "--quiet", parent]);
  if (ignored) {
    fs.writeFileSync(path.join(parent, ".gitignore"), "archive/\n");
  }
  const root = path.join(parent, "archive");
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src/topic.test.ts"), "");

  expect(listRepoFilesSync(root, { includeFile: (file) => file.endsWith(".ts") })).toEqual([
    "src/topic.test.ts",
  ]);
  expect(findUnmatchedExplicitTestTargets(["src/**/*.test.ts"], root)).toEqual([]);
  expect(buildVitestRunPlans(["src/topic"], root)).toEqual([
    expect.objectContaining({ forwardedArgs: ["src/topic.test.ts"] }),
  ]);
});

it("keeps an empty Git index authoritative at its actual root", () => {
  const root = tempDirs.make("inventory-empty-");
  execFileSync("git", ["init", "--quiet", root]);
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src/untracked.ts"), "");
  expect(listRepoFilesSync(root, { includeFile: (file) => file.endsWith(".ts") })).toEqual([]);
  execFileSync("git", ["-C", root, "add", "src/untracked.ts"]);
  expect(listRepoFilesSync(root, { includeFile: (file) => file.endsWith(".ts") })).toEqual([
    "src/untracked.ts",
  ]);
});
