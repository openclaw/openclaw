import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const run = (cwd: string, cmd: string, args: string[] = []) => {
  return execFileSync(cmd, args, { cwd, encoding: "utf8" }).trim();
};

describe("git-hooks/pre-commit (integration)", () => {
  it("does not treat staged filenames as git-add flags (e.g. --all)", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "openclaw-pre-commit-"));
    run(dir, "git", ["init", "-q"]);

    // Copy the hook + helpers so the test exercises real on-disk wiring.
    mkdirSync(path.join(dir, "git-hooks"), { recursive: true });
    mkdirSync(path.join(dir, "scripts", "pre-commit"), { recursive: true });
    symlinkSync(
      path.join(process.cwd(), "git-hooks", "pre-commit"),
      path.join(dir, "git-hooks", "pre-commit"),
    );
    symlinkSync(
      path.join(process.cwd(), "scripts", "pre-commit", "run-node-tool.sh"),
      path.join(dir, "scripts", "pre-commit", "run-node-tool.sh"),
    );
    symlinkSync(
      path.join(process.cwd(), "scripts", "pre-commit", "filter-staged-files.mjs"),
      path.join(dir, "scripts", "pre-commit", "filter-staged-files.mjs"),
    );

    // Create an untracked file that should NOT be staged by the hook.
    writeFileSync(path.join(dir, "secret.txt"), "do-not-stage\n", "utf8");

    // Stage a maliciously-named file. Older hooks using `xargs git add` could run `git add --all`.
    writeFileSync(path.join(dir, "--all"), "flag\n", "utf8");
    run(dir, "git", ["add", "--", "--all"]);

    // Run the hook directly (same logic as when installed via core.hooksPath).
    run(dir, "bash", ["git-hooks/pre-commit"]);

    const staged = run(dir, "git", ["diff", "--cached", "--name-only"]).split("\n").filter(Boolean);
    expect(staged).toEqual(["--all"]);
  });
});
