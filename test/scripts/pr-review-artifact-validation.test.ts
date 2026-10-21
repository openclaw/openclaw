import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { createMainRefreshFixture } from "./pr-main-refresh.test-support.js";
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
  checks: "invalid-json" | "invalid-row" | "cancelled" | "failed",
  investigatedLocalFailure = false,
) {
  const f = createMainRefreshFixture(tempDirs.make("openclaw-pr-merge-verification-"));
  f.seedPreparedMerge();
  const review = validReadyReview(f.head);
  Object.assign(review.behavioralSweep, {
    status: "pass",
    branches: [{ path: "src/subject.ts", decision: "synthetic change", outcome: "reviewed" }],
  });
  review.tests.ran = ["synthetic local proof"];
  if (investigatedLocalFailure) {
    Object.assign(review.tests, {
      result: "fail",
      investigatedLocalFailures: {
        head: f.head,
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
  writeFileSync(join(f.local, "review.json"), JSON.stringify(review));
  writeFileSync(join(f.local, "gates.env"), "GATES_MODE=full\n");
  f.configure({
    requiredChecks: checks === "failed" ? "fail" : "pass",
  });
  const responses: Partial<Record<typeof checks, string>> = {
    cancelled: `printf '%s\\n' '[{"name":"CI","bucket":"cancel","state":"CANCELLED"}]'`,
    "invalid-json": "printf '%s\\n' 'not valid JSON'",
    "invalid-row": `printf '%s\\n' '["malformed required row"]'`,
  };
  const response = responses[checks];
  return f.shell(
    [
      ...(response
        ? [
            `pr_gh_plain() { case "$*" in "pr checks 42 --required --json name,bucket,state --repo https://github.com/fixture/repo") ${response};; *) gh_plain "$@";; esac; }`,
          ]
        : []),
      `merge_verify 42 '{"replacementHead":"","autoMergeRequested":false,"observation":null,"qualifiedRefusal":false}' || exit 1`,
    ].join("\n"),
  );
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
    ["invalid-json", "stderr", "unable to verify the required GitHub checks"],
    ["invalid-row", "stderr", "GitHub returned invalid required-check evidence"],
    ["failed", "stdout", "Required checks are failing"],
    ["cancelled", "stdout", "Required checks are failing"],
  ] as const)("keeps %s required checks blocking in an OR-list", (checks, stream, message) => {
    const result = runMergeVerification(checks, checks === "failed");
    expect(result.status).toBe(1);
    expect(result[stream]).toContain(message);
    expect(result.stdout).not.toContain("merge-verify passed");
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
