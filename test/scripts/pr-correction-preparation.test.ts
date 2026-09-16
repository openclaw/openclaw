import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { validReview, writeReviewArtifacts } from "./pr-review-artifact-fixture.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const scripts = join(process.cwd(), "scripts");
const describePosix = process.platform === "win32" ? describe.skip : describe;

function fixture() {
  const root = tempDirs.make("openclaw-pr-correction-");
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
  writeFileSync(join(root, "docs/fix.md"), "broken\n");
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
    files: [{ path: "docs/fix.md" }],
  };
  writeFileSync(join(root, ".local/pr-meta.json"), JSON.stringify(metadata));
  writeFileSync(
    join(root, ".local/pr-meta.env"),
    `PR_NUMBER=42\nPR_HEAD=topic\nPR_HEAD_SHA=${incoming}\n`,
  );
  const run = (invocation: string) =>
    spawnSync(
      "bash",
      [
        "-c",
        [
          "set -euo pipefail",
          'script_parent_dir="$1"',
          'source "$1/pr-lib/review.sh"',
          'source "$1/pr-lib/prepare-core.sh"',
          'source "$1/pr-lib/gates.sh"',
          'require_artifact() { [ -s "$1" ]; }',
          "enter_worktree() { :; }",
          'review_guard() { REVIEW_MODE=pr; source .local/pr-meta.env; [ "$(git rev-parse HEAD)" = "$PR_HEAD_SHA" ]; }',
          "print_review_stdout_summary() { :; }",
          "mark_pr_operation_side_effects_started() { touch .local/side-effects; }",
          'checkout_pr_worktree_target() { git checkout -q --detach "$2"; }',
          "pr_meta_json() { cat .local/pr-meta.json; }",
          "resolve_pr_author_access_at_prepare() { echo external; }",
          'fetch_pr_head() { git update-ref "$3" "$2"; }',
          invocation,
        ].join("\n"),
        "correction-fixture",
        scripts,
      ],
      { cwd: root, env, encoding: "utf8" },
    );
  const commitFix = () => {
    writeFileSync(join(root, "docs/fix.md"), "corrected\n");
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

describePosix("native correction preparation", () => {
  it("keeps normal READY preparation available", () => {
    const f = fixture();
    f.review.recommendation = "READY FOR /prepare-pr";
    f.review.findings = [];
    writeFileSync(join(f.root, ".local/review.json"), JSON.stringify(f.review));
    expect(f.run("prepare_init 42").status).toBe(0);
    expect(f.run("require_prepared_review 42").status).toBe(0);
  });

  it("preserves default NEEDS WORK refusal and explicitly admits only correction preparation", () => {
    const f = fixture();
    const original = readFileSync(join(f.root, ".local/review.json"), "utf8");
    const denied = f.run("prepare_init 42");
    expect(denied.status).toBe(1);
    expect(denied.stdout).toContain("requires a validated READY");
    expect(existsSync(join(f.root, ".local/side-effects"))).toBe(false);
    const admitted = f.run("prepare_init 42 correction");
    expect(admitted.status, admitted.stderr).toBe(0);
    expect(f.git("rev-parse", "HEAD")).toBe(f.incoming);
    expect(readFileSync(join(f.root, ".local/review.json"), "utf8")).toBe(original);
    expect(f.run("require_prepared_review 42").status).toBe(1);
    expect(existsSync(join(f.root, ".local/gates.env"))).toBe(false);
  });

  it.each(["NEEDS DISCUSSION", "NOT USEFUL (CLOSE)"])(
    "does not admit %s for correction",
    (recommendation) => {
      const f = fixture();
      f.review.recommendation = recommendation;
      writeFileSync(join(f.root, ".local/review.json"), JSON.stringify(f.review));
      const result = f.run("prepare_init 42 correction");
      expect(result.status).toBe(1);
      expect(existsSync(join(f.root, ".local/side-effects"))).toBe(false);
    },
  );

  it("requires complete exact-candidate review, then rejects subsequent source drift", () => {
    const f = fixture();
    expect(f.run("prepare_init 42 correction").status).toBe(0);
    f.commitFix();
    expect(f.run("prepare_correction_review_init 42").status).toBe(0);
    expect(f.run("require_prepared_review 42").status).toBe(1);
    f.approve();
    const accepted = f.run("require_prepared_review 42");
    expect(accepted.status, accepted.stderr).toBe(0);
    f.git("commit", "-q", "--allow-empty", "-m", "candidate moved");
    expect(f.run("require_prepared_review 42").status).toBe(1);
  });

  it.each(["gates", "push", "sync"])(
    "refuses %s before its execution/publication owner without candidate approval",
    (operation) => {
      const f = fixture();
      expect(f.run("prepare_init 42 correction").status).toBe(0);
      f.commitFix();
      writeFileSync(join(f.root, ".local/gates.env"), "GATES_MODE=full\n");
      const result = f.run(
        [
          'source "$script_parent_dir/pr-lib/gates.sh"',
          "resolve_pr_gates_remote_mode() { echo local; }",
          "mark_pr_operation_side_effects_if_available() { :; }",
          "derive_prepare_gate_change_plan() { touch .local/execution-reached; return 1; }",
          "verify_pr_head_branch_matches_expected() { :; }",
          "push_prep_head_to_pr_branch() { touch .local/execution-reached; return 1; }",
          operation === "gates"
            ? "prepare_gates 42"
            : operation === "push"
              ? "prepare_push 42"
              : "prepare_sync_head 42",
        ].join("\n"),
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("correction-review.json");
      expect(existsSync(join(f.root, ".local/execution-reached"))).toBe(false);
    },
  );

  it("rejects candidate review when the corrected history drops the incoming commit", () => {
    const f = fixture();
    expect(f.run("prepare_init 42 correction").status).toBe(0);
    f.commitFix();
    f.git("checkout", "--orphan", "replacement");
    f.git("add", ".");
    f.git("commit", "-qm", "rewritten source");
    f.git("branch", "-f", "pr-42-prep", "HEAD");
    expect(f.run("prepare_correction_review_init 42").status).toBe(1);
  });

  it.each(["incoming review", "finding resolution", "foreign candidate", "lost correction mode"])(
    "refuses changed %s",
    (kind) => {
      const f = fixture();
      expect(f.run("prepare_init 42 correction").status).toBe(0);
      f.commitFix();
      expect(f.run("prepare_correction_review_init 42").status).toBe(0);
      f.approve();
      if (kind === "incoming review") {
        writeFileSync(join(f.root, ".local/review.json"), `${JSON.stringify(f.review)}\n\n`);
      } else if (kind === "lost correction mode") {
        const path = join(f.root, ".local/prep-context.env");
        writeFileSync(
          path,
          readFileSync(path, "utf8").replace(
            "PREP_REVIEW_MODE=correction",
            "PREP_REVIEW_MODE=ready",
          ),
        );
      } else {
        const path = join(f.root, ".local/correction-review.json");
        const review = JSON.parse(readFileSync(path, "utf8"));
        if (kind === "finding resolution") {
          review.correction.resolvedFindings = [];
        } else {
          review.pr.headSha = "a".repeat(40);
        }
        writeFileSync(path, JSON.stringify(review));
      }
      expect(f.run("require_prepared_review 42").status).toBe(1);
    },
  );

  it.each([false, true])(
    "binds recovered approval to incoming review bytes, changed=%s",
    (changed) => {
      const f = fixture();
      expect(f.run("prepare_init 42 correction").status).toBe(0);
      f.commitFix();
      const candidate = f.git("rev-parse", "HEAD");
      expect(f.run("prepare_correction_review_init 42").status).toBe(0);
      f.approve();
      const names = [
        "correction-review.json",
        "correction-review.md",
        "correction-incoming-review.json",
        "correction-incoming-review.md",
      ];
      const retained = names.map((name) => ({
        name,
        bytes: readFileSync(join(f.root, ".local", name)),
      }));
      f.git("checkout", "--detach", f.incoming);
      if (changed) {
        const finding = f.review.findings[0];
        if (!finding) {
          throw new Error("Missing incoming fixture finding");
        }
        finding.fix = "A different obligation with the same I1 identifier";
        writeFileSync(join(f.root, ".local/review.json"), JSON.stringify(f.review));
      }
      expect(f.run("prepare_init 42 correction").status).toBe(0);
      f.git("reset", "--hard", candidate);
      retained.forEach(({ name, bytes }) => writeFileSync(join(f.root, ".local", name), bytes));
      const result = f.run("require_prepared_review 42");
      expect(result.status, result.stderr).toBe(changed ? 1 : 0);
      if (changed) {
        expect(result.stderr).toContain("exact incoming review bytes");
      }
    },
  );

  it.each(["push", "sync"])("requires exact gates before correction %s", (operation) => {
    const f = fixture();
    expect(f.run("prepare_init 42 correction").status).toBe(0);
    f.commitFix();
    const qualified = f.git("rev-parse", "HEAD");
    expect(f.run("prepare_correction_review_init 42").status).toBe(0);
    f.approve();
    const publish = () =>
      f.run(
        [
          "verify_pr_head_branch_matches_expected() { :; }",
          "push_prep_head_to_pr_branch() { touch .local/execution-reached; return 73; }",
          operation === "push" ? "prepare_push 42" : "prepare_sync_head 42",
        ].join("\n"),
      );
    expect(publish().status).toBe(1);
    expect(existsSync(join(f.root, ".local/execution-reached"))).toBe(false);
    writeFileSync(
      join(f.root, ".local/gates.env"),
      `PR_NUMBER=42\nGATES_MODE=full\nLAST_VERIFIED_HEAD_SHA=${qualified}\nFULL_GATES_HEAD_SHA=${qualified}\n`,
    );
    f.git("commit", "-q", "--allow-empty", "-m", "new candidate same tree");
    expect(f.run("prepare_correction_review_init 42").status).toBe(0);
    f.approve();
    expect(publish().status).toBe(1);
    expect(existsSync(join(f.root, ".local/execution-reached"))).toBe(false);
    const current = f.git("rev-parse", "HEAD");
    writeFileSync(
      join(f.root, ".local/gates.env"),
      `PR_NUMBER=42\nGATES_MODE=full\nLAST_VERIFIED_HEAD_SHA=${current}\nFULL_GATES_HEAD_SHA=${current}\n`,
    );
    expect(publish().status).toBe(73);
    expect(existsSync(join(f.root, ".local/execution-reached"))).toBe(true);
  });

  it.each([true, false])(
    "checks native pending-route eligibility before correction publication, fork=%s",
    (fork) => {
      const f = fixture();
      expect(f.run("prepare_init 42 correction").status).toBe(0);
      f.commitFix();
      expect(f.run("prepare_correction_review_init 42").status).toBe(0);
      f.approve();
      const target = JSON.stringify({
        state: "OPEN",
        isCrossRepository: fork,
        baseRefName: "main",
        baseRefOid: f.incoming,
        headRefOid: f.incoming,
      });
      const result = f.run(
        [
          "resolve_pr_gates_remote_mode() { echo crabbox-aws; }",
          "mark_pr_operation_side_effects_if_available() { :; }",
          "require_active_org_admin_for_crabbox_gate() { echo fixture-admin; }",
          "derive_prepare_gate_change_plan() { PREPARE_GATE_CHANGED_FILES=docs/fix.md; PREPARE_GATE_DOCS_ONLY=false; PREPARE_GATE_CHANGELOG_ONLY=false; PREPARE_GATE_CHANGELOG_REQUIRED=false; PREPARE_GATE_CHANGELOG_UPDATE=false; }",
          "verify_pr_head_branch_matches_expected() { :; }",
          `gh() { printf '%s\\n' '${target}'; }`,
          "push_prep_head_to_pr_branch() { touch .local/execution-reached; return 73; }",
          "prepare_gates 42",
          "prepare_push 42",
        ].join("\n"),
      );
      expect(result.status, result.stdout + result.stderr).toBe(fork ? 1 : 73);
      expect(existsSync(join(f.root, ".local/execution-reached"))).toBe(!fork);
      const sync = f.run(
        "verify_pr_head_branch_matches_expected() { :; }; push_prep_head_to_pr_branch() { return 73; }; prepare_sync_head 42",
      );
      expect(sync.status, sync.stderr).toBe(1);
    },
  );

  it("retains prior candidate reviews when initializing another review", () => {
    const f = fixture();
    expect(f.run("prepare_init 42 correction").status).toBe(0);
    f.commitFix();
    expect(f.run("prepare_correction_review_init 42").status).toBe(0);
    f.approve();
    const original = readFileSync(join(f.root, ".local/correction-review.json"), "utf8");
    expect(f.run("prepare_correction_review_init 42").status).toBe(0);
    const retained = readdirSync(join(f.root, ".local")).find((name) =>
      name.startsWith("correction-review-retained."),
    );
    expect(retained).toBeTruthy();
    if (!retained) {
      throw new Error("Missing retained review");
    }
    expect(readFileSync(join(f.root, ".local", retained, "correction-review.json"), "utf8")).toBe(
      original,
    );
    expect(f.run("require_prepared_review 42").status).toBe(1);
  });
});
