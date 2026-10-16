import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const validator = join(process.cwd(), "scripts/pr-lib/review-transition-state.mjs");

function git(root: string, ...args: string[]) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  expect(result.status, result.stdout + result.stderr).toBe(0);
  return result.stdout.trim();
}

function conflictFixture(renamed = false) {
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
  return { root, target, pathname, context };
}

function mergedFixture(renamed = false) {
  const { root, target, pathname, context } = conflictFixture(renamed);
  const merge = spawnSync("git", ["merge", "--no-edit", "main"], {
    cwd: root,
    encoding: "utf8",
  });
  expect(merge.status, merge.stdout + merge.stderr).toBe(1);
  expect(git(root, "ls-files", "--unmerged").split("\n")).toHaveLength(3);
  writeFileSync(join(root, pathname), `resolved\n${context}`);
  git(root, "add", pathname);
  git(root, "commit", "--no-edit");
  expect(git(root, "ls-files", "--resolve-undo").split("\n")).toHaveLength(3);
  return { root, target, pathname };
}

function rebasedFixture() {
  const { root, target } = conflictFixture();
  const original = git(root, "rev-parse", "HEAD");
  const rebase = spawnSync("git", ["rebase", "main"], { cwd: root, encoding: "utf8" });
  expect(rebase.status, rebase.stdout + rebase.stderr).toBe(1);
  expect(git(root, "ls-files", "--unmerged").split("\n")).toHaveLength(3);
  writeFileSync(join(root, "conflict.txt"), "resolved\n");
  git(root, "add", "conflict.txt");
  const continued = spawnSync("git", ["rebase", "--continue"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, GIT_EDITOR: "true" },
  });
  expect(continued.status, continued.stdout + continued.stderr).toBe(0);
  expect(git(root, "ls-files", "--resolve-undo").split("\n")).toHaveLength(3);
  expect(git(root, "rev-parse", "ORIG_HEAD")).toBe(original);
  return { root, target };
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

describe("native transition of committed conflict resolutions", () => {
  it.each(["committed", "foreign"])(
    "validates renamed conflict stages without changing the index (%s)",
    (kind) => {
      const { root, target, pathname } = mergedFixture(true);
      if (kind === "foreign") {
        injectForeignUndo(root, pathname);
      }
      const result = validate(root, target);
      expect(result.status, result.stdout + result.stderr).toBe(kind === "committed" ? 0 : 1);
      if (kind === "foreign") {
        expect(result.stderr).toContain(`Unowned transition resolve-undo entry "${pathname}"`);
      }
    },
  );

  it.each([false, true])(
    "accepts committed merge undo without changing the index (followup=%s)",
    (followup) => {
      const { root, target } = mergedFixture();
      if (followup) {
        writeFileSync(join(root, "repair.txt"), "subsequent compile repair\n");
        git(root, "add", "repair.txt");
        git(root, "commit", "-m", "followup");
      }
      const result = validate(root, target);
      expect(result.status, result.stdout + result.stderr).toBe(0);
    },
  );

  it.each([false, true])(
    "accepts committed rebase undo without changing the index (followup=%s)",
    (followup) => {
      const { root, target } = rebasedFixture();
      if (followup) {
        writeFileSync(join(root, "repair.txt"), "subsequent compile repair\n");
        git(root, "add", "repair.txt");
        git(root, "commit", "-m", "followup");
      }
      const result = validate(root, target);
      expect(result.status, result.stdout + result.stderr).toBe(0);
    },
  );

  it.each(["foreign undo", "moved ORIG_HEAD"])(
    "refuses unbound committed rebase undo (%s)",
    (kind) => {
      const { root, target } = rebasedFixture();
      if (kind === "foreign undo") {
        injectForeignUndo(root);
      } else {
        git(root, "update-ref", "ORIG_HEAD", target);
      }
      const result = validate(root, target);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('Unowned transition resolve-undo entry "conflict.txt"');
      expect(readFileSync(join(root, "conflict.txt"), "utf8")).toBe("resolved\n");
    },
  );

  it.each(["working tree", "staged", "assume unchanged", "foreign undo"])(
    "refuses and preserves uncommitted %s state beside a committed merge",
    (kind) => {
      const { root, target } = mergedFixture();
      if (kind === "foreign undo") {
        injectForeignUndo(root);
      } else {
        writeFileSync(join(root, "conflict.txt"), "uncommitted user work\n");
        if (kind === "staged") {
          git(root, "add", "conflict.txt");
        }
        if (kind === "assume unchanged") {
          git(root, "update-index", "--assume-unchanged", "conflict.txt");
        }
      }
      const result = validate(root, target);
      expect(result.status).not.toBe(0);
      expect(readFileSync(join(root, "conflict.txt"), "utf8")).toBe(
        kind === "foreign undo" ? "resolved\n" : "uncommitted user work\n",
      );
    },
  );
});
