import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createScriptTestHarness } from "./test-helpers.js";

const pushScriptPath = path.join(process.cwd(), "scripts", "pr-lib", "push.sh");
const worktreeScriptPath = path.join(process.cwd(), "scripts", "pr-lib", "worktree.sh");
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

function runPushShell(cwd: string, body: string): string {
  return run(
    cwd,
    "bash",
    [
      "-lc",
      `
source "$OPENCLAW_WORKTREE_SH"
source "$OPENCLAW_PUSH_SH"
${body}
`,
    ],
    {
      OPENCLAW_PUSH_SH: pushScriptPath,
      OPENCLAW_WORKTREE_SH: worktreeScriptPath,
    },
  );
}

describe("scripts/pr-lib/push.sh", () => {
  it("refreshes PR head metadata before configuring prhead", () => {
    const repo = createTempDir("openclaw-pr-lib-push-");
    git(repo, "init", "-q", "--initial-branch=main");
    git(repo, "config", "user.email", "test@example.com");
    git(repo, "config", "user.name", "Test User");
    writeFileSync(path.join(repo, "tracked.txt"), "seed\n", "utf8");
    git(repo, "add", "tracked.txt");
    git(repo, "commit", "-qm", "seed");

    mkdirSync(path.join(repo, ".local"), { recursive: true });
    writeFileSync(
      path.join(repo, ".local", "pr-meta.env"),
      [
        "PR_HEAD_OWNER=stale-owner",
        "PR_HEAD_REPO_NAME=stale-repo",
        "PR_HEAD_REPO_URL=https://github.com/stale-owner/stale-repo",
        "",
      ].join("\n"),
      "utf8",
    );

    runPushShell(
      repo,
      `
pr_meta_json() {
  printf '%s\\n' '{"number":123,"url":"https://github.com/openclaw/openclaw/pull/123","author":{"login":"alice"},"baseRefName":"main","headRefName":"feature","headRefOid":"deadbeef","headRepository":{"nameWithOwner":"fresh-owner/fresh-repo","url":"https://github.com/fresh-owner/fresh-repo","name":"fresh-repo"},"headRepositoryOwner":{"login":"fresh-owner"}}'
}

setup_prhead_remote 123
git remote get-url prhead
`,
    );

    const prMetaEnv = readFileSync(path.join(repo, ".local", "pr-meta.env"), "utf8");
    expect(prMetaEnv).toContain("PR_HEAD_OWNER=fresh-owner");
    expect(prMetaEnv).toContain("PR_HEAD_REPO_NAME=fresh-repo");
    expect(git(repo, "remote", "get-url", "prhead")).toBe(
      "https://github.com/fresh-owner/fresh-repo.git",
    );
  });
});
