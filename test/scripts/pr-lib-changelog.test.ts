import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createScriptTestHarness } from "./test-helpers.js";

const changelogScriptPath = path.join(process.cwd(), "scripts", "pr-lib", "changelog.sh");
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

function evaluateShell(cwd: string, body: string): string {
  return run(
    cwd,
    "bash",
    [
      "-lc",
      `
source "$OPENCLAW_PR_CHANGELOG_SH"
${body}
`,
    ],
    {
      OPENCLAW_PR_CHANGELOG_SH: changelogScriptPath,
    },
  );
}

function initRepo(prefix: string): string {
  const repo = createTempDir(prefix);
  git(repo, "init", "-q", "--initial-branch=main");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test User");
  writeFileSync(
    path.join(repo, "CHANGELOG.md"),
    "# Changelog\n\n## Unreleased\n\n### Changes\n\n",
    "utf8",
  );
  git(repo, "add", "CHANGELOG.md");
  git(repo, "commit", "-qm", "seed");
  return repo;
}

describe("scripts/pr-lib/changelog.sh", () => {
  it("prefers the previous prep head when it is an ancestor of HEAD", () => {
    const repo = initRepo("openclaw-pr-lib-changelog-range-");
    const baseSha = git(repo, "rev-parse", "HEAD");

    git(repo, "update-ref", "refs/remotes/origin/main", baseSha);
    git(repo, "checkout", "-qb", "feature");
    writeFileSync(path.join(repo, "feature.txt"), "feature\n", "utf8");
    git(repo, "add", "feature.txt");
    git(repo, "commit", "-qm", "feature");

    mkdirSync(path.join(repo, ".local"), { recursive: true });
    writeFileSync(path.join(repo, ".local", "prep.env"), `PR_HEAD_SHA_BEFORE=${baseSha}\n`, "utf8");

    const diffRange = evaluateShell(repo, "resolve_changelog_diff_range");

    expect(diffRange).toBe(`${baseSha}..HEAD`);
  });

  it("falls back to origin/main three-dot diff when prep metadata does not point to an ancestor", () => {
    const repo = initRepo("openclaw-pr-lib-changelog-fallback-");
    const seedSha = git(repo, "rev-parse", "HEAD");

    git(repo, "checkout", "-qb", "feature");
    writeFileSync(path.join(repo, "feature.txt"), "feature\n", "utf8");
    git(repo, "add", "feature.txt");
    git(repo, "commit", "-qm", "feature");

    git(repo, "checkout", "main");
    writeFileSync(path.join(repo, "main.txt"), "main\n", "utf8");
    git(repo, "add", "main.txt");
    git(repo, "commit", "-qm", "main advance");
    const mainAdvanceSha = git(repo, "rev-parse", "HEAD");
    git(repo, "update-ref", "refs/remotes/origin/main", mainAdvanceSha);

    git(repo, "checkout", "feature");
    mkdirSync(path.join(repo, ".local"), { recursive: true });
    writeFileSync(
      path.join(repo, ".local", "prep.env"),
      `PR_HEAD_SHA_BEFORE=${mainAdvanceSha}\nORIGINAL_SEED=${seedSha}\n`,
      "utf8",
    );

    const diffRange = evaluateShell(repo, "resolve_changelog_diff_range");

    expect(diffRange).toBe("origin/main...HEAD");
  });

  it("validates PR-linked changelog entries from the current file contents", () => {
    const repo = createTempDir("openclaw-pr-lib-changelog-entry-");
    writeFileSync(
      path.join(repo, "CHANGELOG.md"),
      [
        "# Changelog",
        "",
        "## Unreleased",
        "",
        "### Fixes",
        "",
        "Fix bug in merge flow (#67082). Thanks @alice",
        "",
      ].join("\n"),
      "utf8",
    );

    const output = evaluateShell(repo, "validate_changelog_entry_for_pr 67082 alice");

    expect(output).toContain("changelog placement validated");
    expect(output).toContain("changelog validated: found PR #67082 + thanks @alice");
  });
});
