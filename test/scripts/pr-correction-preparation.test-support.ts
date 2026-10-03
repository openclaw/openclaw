import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";
import { validReview, writeReviewArtifacts } from "./pr-review-artifact-fixture.js";

const scripts = join(process.cwd(), "scripts");

export function createCorrectionFixture(root: string, initialContent = "broken\n") {
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  };
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd: root, env, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim();
  };
  git("init", "-q", "-b", "topic");
  git("config", "commit.gpgSign", "false");
  git("config", "core.hooksPath", "/dev/null");
  writeFileSync(join(root, ".gitignore"), ".local/\n");
  mkdirSync(join(root, "docs"));
  writeFileSync(join(root, "docs/fix.md"), initialContent);
  git("add", ".");
  git("commit", "-qm", "incoming");
  const incoming = git("rev-parse", "HEAD");
  const review = validReview(incoming);
  review.issueValidation.status = "valid";
  review.findings.push({
    id: "I1",
    severity: "IMPORTANT",
    title: "Incorrect behavior",
    area: "docs/fix.md",
    fix: "Correct the behavior",
  });
  writeReviewArtifacts(root, review, { headSha: incoming, files: ["docs/fix.md"] });
  const metadata = {
    number: 42,
    headRefOid: incoming,
    headRefName: "topic",
    url: "https://github.com/fixture/repo/pull/42",
    baseRepository: {
      id: "fixture-repo",
      databaseId: 1,
      nameWithOwner: "fixture/repo",
      url: "https://github.com/fixture/repo",
    },
    files: [{ path: "docs/fix.md" }],
  };
  writeFileSync(join(root, ".local/pr-meta.json"), JSON.stringify(metadata));
  writeFileSync(
    join(root, ".local/pr-meta.env"),
    `PR_NUMBER=42\nPR_HEAD=topic\nPR_HEAD_SHA=${incoming}\n`,
  );
  const run = (invocation: string, envOverrides: NodeJS.ProcessEnv = {}) =>
    spawnSync(
      "bash",
      [
        "-c",
        [
          "set -euo pipefail",
          'script_parent_dir="$1"',
          'source "$1/pr-lib/common.sh"',
          'source "$1/pr-lib/review.sh"',
          'source "$1/pr-lib/prepare-core.sh"',
          'source "$1/pr-lib/gates.sh"',
          'require_artifact() { [ -s "$1" ]; }',
          "enter_worktree() { :; }",
          'pr_git() { "${OPENCLAW_PR_GIT:-${GIT_EXEC:-git}}" "$@"; }',
          'pr_gh() { gh "$@"; }',
          "common_repo_root() { pwd; }",
          "pr_worktree_state() { jq -n --arg path \"$PWD\" '{present:true,path:$path}'; }",
          "read_pr_view_json() { cat .local/pr-meta.json; }",
          'review_guard() { REVIEW_MODE=pr; source .local/pr-meta.env; [ "$(git rev-parse HEAD)" = "$PR_HEAD_SHA" ]; }',
          "print_review_stdout_summary() { :; }",
          "mark_pr_operation_side_effects_started() { touch .local/side-effects; }",
          'checkout_pr_worktree_target() { git checkout -q --detach "$2"; }',
          "pr_meta_json() { cat .local/pr-meta.json; }",
          "resolve_pr_author_access_at_prepare() { echo external; }",
          'fetch_pr_head() { PR_HEAD_OBSERVATION="$4"; git update-ref "$3" "$2"; }',
          invocation,
        ].join("\n"),
        "correction-fixture",
        scripts,
      ],
      { cwd: root, env: { ...env, ...envOverrides }, encoding: "utf8" },
    );
  const commitFix = (content = "corrected\n") => {
    writeFileSync(join(root, "docs/fix.md"), content);
    git("add", "docs/fix.md");
    git("commit", "-qm", "fix behavior");
  };
  const approve = () => {
    const path = join(root, ".local/correction-review.json");
    const correction = JSON.parse(readFileSync(path, "utf8"));
    Object.assign(correction, validReview(git("rev-parse", "HEAD")));
    correction.recommendation = "READY FOR /prepare-pr";
    correction.issueValidation.status = "valid";
    correction.correction.resolvedFindings[0].resolution = "The corrected behavior is verified.";
    writeFileSync(path, JSON.stringify(correction));
  };
  return { root, run, git, incoming, review, commitFix, approve };
}
