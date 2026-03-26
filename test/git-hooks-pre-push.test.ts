import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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

describe("git-hooks/pre-push (integration)", () => {
  it("blocks protected identities from pushing to existing remote branches", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "openclaw-pre-push-"));
    const remoteDir = path.join(root, "remote.git");
    const workDir = path.join(root, "work");

    run(root, "git", ["init", "-q", "--bare", remoteDir]);
    mkdirSync(workDir, { recursive: true });
    run(workDir, "git", ["init", "-q", "--initial-branch=main"]);
    run(workDir, "git", ["remote", "add", "origin", remoteDir]);
    run(workDir, "git", ["config", "user.name", "OpenClaw SRE Bot"]);
    run(workDir, "git", [
      "config",
      "user.email",
      "264278285+prd-carapulse[bot]@users.noreply.github.com",
    ]);
    run(workDir, "git", ["config", "core.hooksPath", "git-hooks"]);

    mkdirSync(path.join(workDir, "git-hooks"), { recursive: true });
    copyFileSync(
      path.join(process.cwd(), "git-hooks", "pre-push"),
      path.join(workDir, "git-hooks", "pre-push"),
    );
    chmodSync(path.join(workDir, "git-hooks", "pre-push"), 0o755);

    writeFileSync(path.join(workDir, "tracked.txt"), "one\n", "utf8");
    run(workDir, "git", ["add", "tracked.txt"]);
    run(workDir, "git", ["commit", "-qm", "init"]);
    run(workDir, "git", ["push", "-u", "origin", "main"]);

    writeFileSync(path.join(workDir, "tracked.txt"), "two\n", "utf8");
    run(workDir, "git", ["add", "tracked.txt"]);
    run(workDir, "git", ["commit", "-qm", "second"]);

    expect(() => run(workDir, "git", ["push", "origin", "main"])).toThrowError(
      /pre-push guard: protected identity .* cannot push to existing remote branch main/,
    );
  });

  it("allows protected identities to push fresh remote branches", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "openclaw-pre-push-new-"));
    const remoteDir = path.join(root, "remote.git");
    const workDir = path.join(root, "work");

    run(root, "git", ["init", "-q", "--bare", remoteDir]);
    mkdirSync(workDir, { recursive: true });
    run(workDir, "git", ["init", "-q", "--initial-branch=main"]);
    run(workDir, "git", ["remote", "add", "origin", remoteDir]);
    run(workDir, "git", ["config", "user.name", "OpenClaw SRE Bot"]);
    run(workDir, "git", [
      "config",
      "user.email",
      "264278285+prd-carapulse[bot]@users.noreply.github.com",
    ]);
    run(workDir, "git", ["config", "core.hooksPath", "git-hooks"]);

    mkdirSync(path.join(workDir, "git-hooks"), { recursive: true });
    copyFileSync(
      path.join(process.cwd(), "git-hooks", "pre-push"),
      path.join(workDir, "git-hooks", "pre-push"),
    );
    chmodSync(path.join(workDir, "git-hooks", "pre-push"), 0o755);

    writeFileSync(path.join(workDir, "tracked.txt"), "one\n", "utf8");
    run(workDir, "git", ["add", "tracked.txt"]);
    run(workDir, "git", ["commit", "-qm", "init"]);
    run(workDir, "git", ["checkout", "-q", "-b", "openclaw/sre-auto/test-branch"]);

    run(workDir, "git", ["push", "-u", "origin", "openclaw/sre-auto/test-branch"]);

    const remoteHeads = run(root, "git", ["--git-dir", remoteDir, "for-each-ref", "refs/heads"]);
    expect(remoteHeads).toContain("refs/heads/openclaw/sre-auto/test-branch");
  });
});
