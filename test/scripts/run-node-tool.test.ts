import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createScriptTestHarness } from "./test-helpers.js";

const scriptSourcePath = path.join(process.cwd(), "scripts", "pre-commit", "run-node-tool.sh");
const { createTempDir } = createScriptTestHarness();

function run(cwd: string, command: string, args: string[], env?: NodeJS.ProcessEnv): string {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    env: env ? { ...process.env, ...env } : process.env,
  }).trim();
}

function git(cwd: string, ...args: string[]): string {
  return run(cwd, "git", args);
}

function writeExecutable(filePath: string, contents: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, contents, { encoding: "utf8", mode: 0o755 });
}

describe("scripts/pre-commit/run-node-tool.sh", () => {
  it("reuses the common-root node_modules tool from a linked worktree", () => {
    const repo = createTempDir("openclaw-run-node-tool-repo-");
    const worktree = createTempDir("openclaw-run-node-tool-worktree-");

    git(repo, "init", "-q", "--initial-branch=main");
    git(repo, "config", "user.email", "test@example.com");
    git(repo, "config", "user.name", "Test User");

    writeExecutable(
      path.join(repo, "scripts", "pre-commit", "run-node-tool.sh"),
      readFileSync(scriptSourcePath, "utf8"),
    );
    writeFileSync(path.join(repo, "tracked.txt"), "seed\n", "utf8");
    git(repo, "add", "scripts/pre-commit/run-node-tool.sh", "tracked.txt");
    git(repo, "commit", "-qm", "seed");

    writeExecutable(
      path.join(repo, "node_modules", ".bin", "oxlint"),
      '#!/usr/bin/env bash\nprintf "shared-root-oxlint %s\\n" "$*"\n',
    );

    git(repo, "worktree", "add", "-b", "wt", worktree, "HEAD");

    const output = run(worktree, "bash", [
      "scripts/pre-commit/run-node-tool.sh",
      "oxlint",
      "--version",
    ]);

    expect(output).toBe("shared-root-oxlint --version");
  });
});
