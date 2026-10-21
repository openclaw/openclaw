import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const validator = join(process.cwd(), "scripts/pr-lib/review-transition-state.mjs");

const git = (root: string, ...args: string[]) => runGit(root, args).stdout.trim();

function runGit(root: string, args: string[], status = 0, env = process.env) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", env });
  expect(result.status, result.stdout + result.stderr).toBe(status);
  return result;
}

function resolvedFixture(operation: "merge" | "rebase", renamed = false) {
  const root = tempDirs.make("pr-committed-resolve-undo-");
  git(root, "init", "--initial-branch=main");
  git(root, "config", "user.name", "OpenClaw Test");
  git(root, "config", "user.email", "test@openclaw.invalid");
  git(root, "config", "commit.gpgsign", "false");
  const originalPath = renamed ? "conflict.ts" : "conflict.txt";
  const context = renamed ? "unchanged context\n".repeat(8) : "";
  writeFileSync(join(root, originalPath), `base\n${context}`);
  git(root, "add", ".");
  git(root, "commit", "-m", "base");
  git(root, "branch", "side");
  writeFileSync(join(root, originalPath), `main\n${context}`);
  git(root, "commit", "-am", "main");
  const target = git(root, "rev-parse", "HEAD");
  git(root, "checkout", "side");
  const pathname = renamed ? "conflict.tsx" : originalPath;
  if (renamed) {
    git(root, "mv", originalPath, pathname);
  }
  writeFileSync(join(root, pathname), `side\n${context}`);
  git(root, "commit", "-am", "side");
  const original = git(root, "rev-parse", "HEAD");
  runGit(root, operation === "merge" ? ["merge", "--no-edit", "main"] : ["rebase", "main"], 1);
  expect(git(root, "ls-files", "--unmerged").split("\n")).toHaveLength(3);
  writeFileSync(join(root, pathname), `resolved\n${context}`);
  git(root, "add", pathname);
  runGit(root, operation === "merge" ? ["commit", "--no-edit"] : ["rebase", "--continue"], 0, {
    ...process.env,
    GIT_EDITOR: "true",
  });
  expect(git(root, "ls-files", "--resolve-undo").split("\n")).toHaveLength(3);
  if (operation === "rebase") {
    expect(git(root, "rev-parse", "ORIG_HEAD")).toBe(original);
  }
  return { root, target, pathname };
}

function injectForeignUndo(root: string, pathname = "conflict.txt") {
  const oid = git(root, "rev-parse", `HEAD:${pathname}`);
  const result = spawnSync("git", ["update-index", "--index-info"], {
    cwd: root,
    encoding: "utf8",
    input: `0 ${"0".repeat(40)}\t${pathname}\n100644 ${oid} 1\t${pathname}\n100644 ${oid} 2\t${pathname}\n100644 ${oid} 3\t${pathname}\n`,
  });
  expect(result.status, result.stderr).toBe(0);
  git(root, "add", pathname);
}

function validate(root: string, target: string) {
  const source = git(root, "rev-parse", "HEAD");
  const before = readFileSync(join(root, ".git/index"));
  const result = spawnSync(process.execPath, [validator, source, target], {
    cwd: root,
    encoding: "utf8",
  });
  expect(readFileSync(join(root, ".git/index"))).toEqual(before);
  return result;
}

type Case = {
  operation: "merge" | "rebase";
  renamed?: boolean;
  followup?: boolean;
  fault?: "foreign undo" | "moved ORIG_HEAD" | "working tree" | "staged" | "assume unchanged";
};
it.each<Case>([
  { operation: "merge", renamed: true },
  { operation: "merge", renamed: true, fault: "foreign undo" },
  { operation: "merge" },
  { operation: "merge", followup: true },
  { operation: "rebase" },
  { operation: "rebase", followup: true },
  { operation: "rebase", fault: "foreign undo" },
  { operation: "rebase", fault: "moved ORIG_HEAD" },
  { operation: "merge", fault: "working tree" },
  { operation: "merge", fault: "staged" },
  { operation: "merge", fault: "assume unchanged" },
  { operation: "merge", fault: "foreign undo" },
])("preserves transition index and worktree: %j", ({ operation, renamed, followup, fault }) => {
  const { root, target, pathname } = resolvedFixture(operation, renamed);
  if (followup) {
    writeFileSync(join(root, "repair.txt"), "subsequent compile repair\n");
    git(root, "add", "repair.txt");
    git(root, "commit", "-m", "followup");
  }
  if (fault === "foreign undo") {
    injectForeignUndo(root, pathname);
  } else if (fault === "moved ORIG_HEAD") {
    git(root, "update-ref", "ORIG_HEAD", target);
  } else if (fault) {
    writeFileSync(join(root, pathname), "uncommitted user work\n");
    if (fault === "staged") {
      git(root, "add", pathname);
    }
    if (fault === "assume unchanged") {
      git(root, "update-index", "--assume-unchanged", pathname);
    }
  }
  const result = validate(root, target);
  expect(result.status, result.stdout + result.stderr).toBe(fault ? 1 : 0);
  if (fault && (renamed || operation === "rebase")) {
    expect(result.stderr).toContain(`Unowned transition resolve-undo entry "${pathname}"`);
  }
  if (fault && !renamed) {
    const dirty = ["working tree", "staged", "assume unchanged"].includes(fault);
    expect(readFileSync(join(root, pathname), "utf8")).toBe(
      dirty ? "uncommitted user work\n" : "resolved\n",
    );
  }
});
