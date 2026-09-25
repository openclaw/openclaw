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

function mergedFixture() {
  const root = tempDirs.make("pr-committed-resolve-undo-");
  git(root, "init", "--initial-branch=main");
  git(root, "config", "user.name", "OpenClaw Test");
  git(root, "config", "user.email", "test@openclaw.invalid");
  git(root, "config", "commit.gpgsign", "false");
  writeFileSync(join(root, "conflict.txt"), "base\n");
  git(root, "add", ".");
  git(root, "commit", "-m", "base");
  git(root, "branch", "side");
  writeFileSync(join(root, "conflict.txt"), "main\n");
  git(root, "commit", "-am", "main");
  const target = git(root, "rev-parse", "HEAD");
  git(root, "checkout", "side");
  writeFileSync(join(root, "conflict.txt"), "side\n");
  git(root, "commit", "-am", "side");
  const merge = spawnSync("git", ["merge", "--no-edit", "main"], {
    cwd: root,
    encoding: "utf8",
  });
  expect(merge.status, merge.stdout + merge.stderr).toBe(1);
  expect(git(root, "ls-files", "--unmerged").split("\n")).toHaveLength(3);
  writeFileSync(join(root, "conflict.txt"), "resolved\n");
  git(root, "add", "conflict.txt");
  git(root, "commit", "--no-edit");
  expect(git(root, "ls-files", "--resolve-undo").split("\n")).toHaveLength(3);
  return { root, target };
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

  it.each(["working tree", "staged", "assume unchanged", "foreign undo"])(
    "refuses and preserves uncommitted %s state beside a committed merge",
    (kind) => {
      const { root, target } = mergedFixture();
      if (kind === "foreign undo") {
        const oid = git(root, "rev-parse", "HEAD:conflict.txt");
        const result = spawnSync("git", ["update-index", "--index-info"], {
          cwd: root,
          encoding: "utf8",
          input: `0 ${"0".repeat(40)}\tconflict.txt\n100644 ${oid} 1\tconflict.txt\n100644 ${oid} 2\tconflict.txt\n100644 ${oid} 3\tconflict.txt\n`,
        });
        expect(result.status, result.stderr).toBe(0);
        git(root, "add", "conflict.txt");
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
