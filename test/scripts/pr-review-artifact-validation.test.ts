import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import {
  REVIEWED_PR,
  REVIEWED_HEAD,
  validReview,
  writeReviewArtifacts,
  type ReviewArtifactFixtureOptions,
} from "./pr-review-artifact-fixture.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const bash = process.platform === "darwin" ? "/bin/bash" : "bash";
const reviewScript = join(process.cwd(), "scripts/pr-lib/review.sh");
const mergeScript = join(process.cwd(), "scripts/pr-lib/merge.sh");
const describePosix = process.platform === "win32" ? describe.skip : describe;
const testNodeExecPath = resolveTestNodeExecPath();

const REVIEWED_IDENTITY_LINE = `Review artifact for PR #${REVIEWED_PR} at ${REVIEWED_HEAD}`;
const REVIEW_SHELL_COMMAND_SURFACE = [
  "rg() {",
  '  if [ "${1-}" = "-F" ]; then',
  "    shift",
  '    command grep -F "$@"',
  "  else",
  '    command grep -E "$@"',
  "  fi",
  "}",
].join("\n");

it("runs dependency-free CLI and native lock regressions", () => {
  const result = spawnSync(
    testNodeExecPath,
    ["--test", join(process.cwd(), "test/scripts/pr-review-artifacts.node.mjs")],
    { encoding: "utf8", timeout: 30000 },
  );
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
});

function validReadyReview(head = REVIEWED_HEAD) {
  const review = validReview(head);
  review.recommendation = "READY FOR /prepare-pr";
  review.issueValidation.status = "valid";
  return review;
}

function runValidation(
  review: ReturnType<typeof validReview>,
  options: ReviewArtifactFixtureOptions & {
    guardFailure?: boolean;
    orList?: boolean;
  } = {},
) {
  const fixtureRoot = tempDirs.make("openclaw-pr-review-validation-");
  writeReviewArtifacts(fixtureRoot, review, options);

  return runReviewShellFunction(
    fixtureRoot,
    options.orList ? "review_validate_artifacts 42 || exit 1" : "review_validate_artifacts 42",
    [
      'common_repo_root() { printf "%s\\n" "$fixture_root"; }',
      `pr_worktree_state() { printf '{"path":"%s","present":true}\\n' "$fixture_root"; }`,
      options.guardFailure
        ? "review_guard() { REVIEW_MODE=pr; echo 'review head guard failed'; return 1; }"
        : `review_guard() { enter_worktree 42 || return 1; REVIEW_MODE=${options.mode ?? "pr"}; }`,
      "print_review_stdout_summary() { :; }",
    ],
  );
}

function runReviewShellFunction(
  fixtureRoot: string,
  invocation: string,
  setup = ["mark_pr_operation_side_effects_started() { :; }"],
) {
  return runShell(fixtureRoot, reviewScript, [REVIEW_SHELL_COMMAND_SURFACE, ...setup, invocation]);
}

function runShell(fixtureRoot: string, script: string, commands: string[]) {
  const source = [
    "set -euo pipefail",
    'source "$1"',
    'fixture_root="$2"',
    'enter_worktree() { cd "$fixture_root"; }',
    'require_artifact() { [ -s "$1" ]; }',
    ...commands,
  ].join("\n");
  return spawnSync(bash, ["-c", source, "pr-review-shell", script, fixtureRoot], {
    encoding: "utf8",
  });
}

function expectRejected(result: ReturnType<typeof spawnSync>, ...messages: string[]) {
  expect(result.status).toBe(1);
  for (const message of messages) {
    expect(result.stdout).toContain(message);
  }
}

function readArtifact(localDir: string, name: string) {
  return readFileSync(join(localDir, name), "utf8");
}

function runArtifactsInit(review: ReturnType<typeof validReview>, markdown: string) {
  const fixtureRoot = tempDirs.make("openclaw-pr-review-artifacts-init-");
  const localDir = join(fixtureRoot, ".local");
  writeReviewArtifacts(fixtureRoot, review);
  writeFileSync(join(localDir, "review.md"), markdown);
  const result = runReviewShellFunction(fixtureRoot, `review_artifacts_init ${REVIEWED_PR}`);
  return { result, localDir };
}

function runMergeVerification(
  checks: "api-error" | "invalid-json" | "invalid-row" | "pending" | "cancelled" | "failed",
  investigatedLocalFailure = false,
) {
  const fixtureRoot = tempDirs.make("openclaw-pr-merge-verification-");
  const localDir = join(fixtureRoot, ".local");
  const head = "a".repeat(40);
  const review = validReadyReview(head);
  if (investigatedLocalFailure) {
    Object.assign(review.tests, {
      result: "fail",
      investigatedLocalFailures: {
        head,
        failures: [
          {
            failure: "A local live check returned an incomplete reply.",
            reproductionAttempts: ["A same-head diagnostic replay passed."],
            evidence: ["Original failure and diagnostic logs recorded in the PR."],
            remainingUncertainty: "The cause remains unknown; the replay does not prove a fix.",
          },
        ],
      },
    });
  }
  writeReviewArtifacts(fixtureRoot, review, { headSha: head, prNumber: 42 });
  writeFileSync(join(localDir, "prep.env"), `PREP_HEAD_SHA=${head}\n`);
  writeFileSync(join(localDir, "gates.env"), "GATES_MODE=full\n");

  const checksResponse = {
    "api-error": "echo 'GitHub API unavailable' >&2; return 1",
    pending: `printf '%s\\n' '[{"name":"CI","bucket":"pending","state":"IN_PROGRESS"}]'; return 8`,
    cancelled: `printf '%s\\n' '[{"name":"CI","bucket":"cancel","state":"CANCELLED"}]'`,
    failed: `printf '%s\\n' '[{"name":"CI","bucket":"fail","state":"FAILURE"}]'`,
    "invalid-json": "printf '%s\\n' 'not valid JSON'",
    "invalid-row": `printf '%s\\n' '["malformed required row"]'`,
  }[checks];
  const observation = {
    number: 42,
    url: "https://github.com/fixture/repo/pull/42",
    isDraft: false,
    baseRepository: {
      id: "fixture-repo",
      databaseId: 123,
      nameWithOwner: "fixture/repo",
      url: "https://github.com/fixture/repo",
    },
    headRefName: "review-branch",
    headRefOid: head,
  };

  return runShell(fixtureRoot, mergeScript, [
    'script_parent_dir=$(cd "$(dirname "$1")/.." && pwd)',
    'for module in common review worktree merge-outcome; do source "$script_parent_dir/pr-lib/$module.sh"; done',
    'repo_root() { printf "%s\\n" "$fixture_root"; }',
    // common.sh defines these too; reinstall the fixture boundary after sourcing it.
    'enter_worktree() { cd "$fixture_root"; }',
    'require_artifact() { [ -s "$1" ]; }',
    "verify_prep_branch_matches_prepared_head() { :; }",
    `refresh_main_snapshot() { PR_MAIN_SHA=${"b".repeat(40)}; }`,
    "mark_pr_operation_side_effects_started() { :; }",
    "pr_git() {",
    '  if [ "${1-}" = -C ]; then shift 2; fi',
    '  case "${1-}" in --git-dir=*) shift;; esac',
    '  case "$1" in',
    '    remote) printf "%s\\n" "https://github.com/fixture/repo.git";;',
    '    rev-parse) case "$2" in',
    '      --absolute-git-dir) printf "%s/.git\\n" "$fixture_root";;',
    `      --verify) test "$3" = 'refs/heads/pr-42^{commit}' || return 1; printf '%s\\n' '${head}';;`,
    "    esac;;",
    "  esac",
    "}",
    'node() { case "$1" in */watch-pr-ci.mjs) return 0;; *) command node "$@";; esac; }',
    "MERGE_REPO_NAME=fixture/repo",
    "MERGE_REPO_HOST=github.com",
    `pr_gh_plain() { case "$*" in "pr checks 42 --required --json name,bucket,state --repo https://github.com/fixture/repo") ${checksResponse};; *) return 99;; esac; }`,
    'pr_gh_quota_read() { pr_gh_plain "$@"; }',
    `merge_rest() { echo 'REST policy requires GraphQL' >&2; printf '%s\\n' '{"restUnavailable":true}'; }`,
    "pr_gh() {",
    '  test "$*" = "pr view 42 --json number,url,title,state,isDraft,author,baseRefName,baseRefOid,baseRepository,headRefName,headRefOid,headRepository,headRepositoryOwner,isCrossRepository" || return 99',
    `  printf '%s\\n' '${JSON.stringify(observation)}'`,
    "}",
    `merge_verify 42 '{"replacementHead":"","autoMergeRequested":false,"observation":null,"qualifiedRefusal":false}' || exit 1`,
  ]);
}

describePosix("scripts/pr review artifact validation", () => {
  it.each([
    [
      "superseded head",
      () => runValidation(validReadyReview("c".repeat(40))),
      "Review artifact identity mismatch in .local/review.json",
    ],
    [
      "another PR",
      () => runValidation(validReadyReview(), { metaEnvPrNumber: 113928 }),
      `Review artifact identity mismatch: .local/pr-meta.json describes PR #${REVIEWED_PR} at ${REVIEWED_HEAD}, which does not match .local/pr-meta.env.`,
    ],
    [
      "main-baseline mode",
      () => runValidation(validReview(), { mode: "main" }),
      "Review artifact validation requires the reviewed PR head, not main-baseline mode.",
    ],
  ] as const)("rejects %s", (_name, run, message) => expectRejected(run(), message));

  it("rejects a review with no PR identity stamp", () => {
    const review = validReadyReview() as Partial<ReturnType<typeof validReadyReview>>;
    review.pr = undefined;

    expectRejected(
      runValidation(review as ReturnType<typeof validReadyReview>),
      "Invalid PR identity in .local/review.json",
    );
  });

  it("moves foreign review artifacts aside and stamps a fresh template", () => {
    const foreign = validReadyReview();
    foreign.pr.number = 113928;
    const { result, localDir } = runArtifactsInit(foreign, "A) Ship another PR\n");

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("moved aside .local/review.json");
    const archives = readdirSync(join(localDir, "superseded"));
    expect(archives).toHaveLength(1);
    const archive = join(localDir, "superseded", archives[0]!);
    expect(readdirSync(archive).toSorted()).toEqual(["review.json", "review.md"]);
    expect(JSON.parse(readArtifact(archive, "review.json")).pr.number).toBe(113928);
    expect(readArtifact(archive, "review.md")).toBe("A) Ship another PR\n");

    const { pr, recommendation } = JSON.parse(readArtifact(localDir, "review.json"));
    expect({ pr, recommendation }).toEqual({
      pr: { number: REVIEWED_PR, headSha: REVIEWED_HEAD },
      recommendation: expect.stringContaining("NEEDS WORK"),
    });
    expect(existsSync(join(localDir, "review.md"))).toBe(false);
  });

  it("preserves in-progress artifacts already stamped for this head", () => {
    const inProgress = validReadyReview();
    inProgress.issueValidation.summary = "Half-written review worth keeping.";
    const markdown = `${REVIEWED_IDENTITY_LINE}\n\nA) Half-written review worth keeping.\n`;
    const { result, localDir } = runArtifactsInit(inProgress, markdown);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain(
      `review artifacts already stamped for PR #${REVIEWED_PR} at ${REVIEWED_HEAD}`,
    );
    expect(readArtifact(localDir, "review.md")).toBe(markdown);
    expect(JSON.parse(readArtifact(localDir, "review.json")).issueValidation.summary).toBe(
      inProgress.issueValidation.summary,
    );
  });

  it("rejects a review guard whose PR metadata describes another PR", () => {
    const fixtureRoot = tempDirs.make("openclaw-pr-review-guard-");
    writeReviewArtifacts(fixtureRoot, validReview(), { prNumber: 113928 });

    const result = runReviewShellFunction(fixtureRoot, `review_guard ${REVIEWED_PR}`);

    expectRejected(
      result,
      `Review guard failed: .local/pr-meta.env describes PR #113928, not #${REVIEWED_PR}`,
    );
  });

  it("preserves head-guard failures when preparation calls validation in an OR-list", () => {
    const result = runValidation(validReview(), { guardFailure: true, orList: true });

    expectRejected(result, "review head guard failed");
    expect(result.stdout).not.toContain("review artifacts validated");
  });

  it.each(["packages/normalization-core/src/string-normalization.ts", "ui/src/app.ts"])(
    "requires behavioral review for core runtime path %s",
    (path) => {
      expectRejected(
        runValidation(validReview(), { files: [path] }),
        "runtime file changes require behavioralSweep.status=pass|needs_work",
        "runtime file changes require at least one branch entry",
      );
    },
  );

  it.each([
    ["api-error", "stderr", "unable to verify the required GitHub checks"],
    ["invalid-json", "stderr", "unable to verify the required GitHub checks"],
    ["invalid-row", "stderr", "GitHub returned invalid required-check evidence"],
    ["failed", "stdout", "Required checks are failing"],
    ["cancelled", "stdout", "Required checks are failing"],
    ["pending", "stdout", "Required checks are still pending."],
  ] as const)("keeps %s required checks blocking in an OR-list", (checks, stream, message) => {
    const result = runMergeVerification(checks, checks === "failed");
    expect(result.status).toBe(1);
    expect(result[stream]).toContain(message);
    expect(result.stdout).not.toContain("merge-verify passed");
    if (checks === "api-error") {
      expect(result.stderr).toContain("GitHub API unavailable");
      expect(result.stdout).not.toContain("No required checks configured");
    }
    if (checks === "pending") {
      expect(result.stderr).not.toContain("unable to verify the required GitHub checks");
    }
  });

  it("reports the required branch entry shape without a raw jq error", () => {
    const review = validReview();
    review.behavioralSweep.branches = ["src/example.ts"];
    const result = runValidation(review);

    expectRejected(
      result,
      "Invalid behavioral sweep branch entry in .local/review.json: each entry must be an object with string path/decision/outcome",
    );
    expect(`${result.stdout}\n${result.stderr}`).not.toContain(
      'Cannot index string with string ("path")',
    );
  });
});
