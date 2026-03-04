import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const baseGitEnv = {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
};
const baseRunEnv: NodeJS.ProcessEnv = { ...process.env, ...baseGitEnv };

const run = (cwd: string, cmd: string, args: string[] = [], env?: NodeJS.ProcessEnv) => {
  return execFileSync(cmd, args, {
    cwd,
    encoding: "utf8",
    env: env ? { ...baseRunEnv, ...env } : baseRunEnv,
  }).trim();
};

describe("git-hooks/pre-commit (integration)", () => {
  it("does not treat staged filenames as git-add flags (e.g. --all)", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "openclaw-pre-commit-"));
    run(dir, "git", ["init", "-q", "--initial-branch=main"]);
    run(dir, "git", ["config", "user.email", "test@example.com"]);
    run(dir, "git", ["config", "user.name", "OpenClaw Test"]);
    run(dir, "git", ["config", "core.hooksPath", "git-hooks"]);

    // Use the real hook script and lightweight helper stubs.
    mkdirSync(path.join(dir, "git-hooks"), { recursive: true });
    mkdirSync(path.join(dir, "scripts", "pre-commit"), { recursive: true });
    const hookTarget = path.join(dir, "git-hooks", "pre-commit");
    writeFileSync(hookTarget, readFileSync(path.join(process.cwd(), "git-hooks", "pre-commit")));
    chmodSync(hookTarget, 0o755);
    writeFileSync(
      path.join(dir, "scripts", "pre-commit", "run-node-tool.sh"),
      "#!/usr/bin/env bash\nexit 0\n",
      {
        encoding: "utf8",
        mode: 0o755,
      },
    );
    writeFileSync(
      path.join(dir, "scripts", "pre-commit", "filter-staged-files.mjs"),
      "process.exit(0);\n",
      "utf8",
    );
    // Create an untracked file that should NOT be staged by the hook.
    writeFileSync(path.join(dir, "secret.txt"), "do-not-stage\n", "utf8");

    // Stage a maliciously-named file. Older hooks using `xargs git add` could run `git add --all`.
    writeFileSync(path.join(dir, "--all"), "flag\n", "utf8");
    run(dir, "git", ["add", "--", "--all"]);

    // Trigger the hook through git so the test does not depend on a standalone bash binary.
    run(dir, "git", ["commit", "-m", "test"]);

    const committed = run(dir, "git", ["show", "--pretty=format:", "--name-only", "HEAD"])
      .split("\n")
      .filter(Boolean);
    expect(committed).toEqual(["--all"]);
    const status = run(dir, "git", ["status", "--short"]).split("\n").filter(Boolean);
    expect(status).toContain("?? secret.txt");
    expect(status.filter((line) => !line.startsWith("?? "))).toEqual([]);
  });
});
