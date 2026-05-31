import { execFileSync } from "node:child_process";
import { mkdirSync, symlinkSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupTempDirs, makeTempRepoRoot } from "../helpers/temp-repo.js";

const tempDirs: string[] = [];

function run(cwd: string, cmd: string, args: string[] = []): string {
  return execFileSync(cmd, args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
    },
  }).trim();
}

afterEach(() => {
  cleanupTempDirs(tempDirs);
});

describe("scripts/prepare-git-hooks.mjs", () => {
  it("installs the repo git hooks path when git-hooks/pre-commit exists", () => {
    const dir = makeTempRepoRoot(tempDirs, "openclaw-prepare-hooks-");
    run(dir, "git", ["init", "-q", "--initial-branch=main"]);
    mkdirSync(path.join(dir, "git-hooks"), { recursive: true });
    symlinkSync(
      path.join(process.cwd(), "git-hooks", "pre-commit"),
      path.join(dir, "git-hooks", "pre-commit"),
    );

    const output = run(dir, "node", [path.join(process.cwd(), "scripts/prepare-git-hooks.mjs")]);

    expect(output).toContain("core.hooksPath=git-hooks");
    expect(run(dir, "git", ["config", "--local", "core.hooksPath"])).toBe("git-hooks");
  });

  it("is idempotent when the repo git hooks path is already installed", () => {
    const dir = makeTempRepoRoot(tempDirs, "openclaw-prepare-hooks-idempotent-");
    run(dir, "git", ["init", "-q", "--initial-branch=main"]);
    mkdirSync(path.join(dir, "git-hooks"), { recursive: true });
    symlinkSync(
      path.join(process.cwd(), "git-hooks", "pre-commit"),
      path.join(dir, "git-hooks", "pre-commit"),
    );
    run(dir, "git", ["config", "--local", "core.hooksPath", "git-hooks"]);

    const output = run(dir, "node", [path.join(process.cwd(), "scripts/prepare-git-hooks.mjs")]);

    expect(output).toContain("core.hooksPath=git-hooks");
    expect(run(dir, "git", ["config", "--local", "core.hooksPath"])).toBe("git-hooks");
  });

  it("does not fail outside a git worktree", () => {
    const dir = makeTempRepoRoot(tempDirs, "openclaw-prepare-hooks-no-git-");

    const output = run(dir, "node", [path.join(process.cwd(), "scripts/prepare-git-hooks.mjs")]);

    expect(output).toContain("skipped: not inside a git worktree");
  });
});
