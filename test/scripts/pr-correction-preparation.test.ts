import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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

  it.each(["OPENCLAW_PR_GIT", "GIT_EXEC"])(
    "uses configured Git for correction review initialization and validation via %s",
    (selector) => {
      const f = fixture();
      expect(f.run("prepare_init 42 '' correction").status).toBe(0);
      f.commitFix();
      const resolved = spawnSync("bash", ["-c", "command -v git"], { encoding: "utf8" });
      expect(resolved.status, resolved.stderr).toBe(0);
      const bin = join(f.root, ".local", "git-bin");
      mkdirSync(bin);
      writeFileSync(join(bin, "git"), "#!/bin/sh\necho 'unexpected PATH Git' >&2\nexit 97\n", {
        mode: 0o755,
      });
      const selectedDir = join(f.root, ".local", "selected git");
      mkdirSync(selectedDir);
      const selected = join(selectedDir, "git");
      symlinkSync(resolved.stdout.trim(), selected);
      const env = {
        PATH: `${bin}:${process.env.PATH}`,
        OPENCLAW_PR_GIT: selector === "OPENCLAW_PR_GIT" ? selected : "",
        GIT_EXEC: selector === "GIT_EXEC" ? selected : "",
      };
      const initialized = f.run("prepare_correction_review_init 42", env);
      expect(initialized.status, initialized.stdout + initialized.stderr).toBe(0);
      f.approve();
      const validated = f.run("require_prepared_review 42", env);
      expect(validated.status, validated.stdout + validated.stderr).toBe(0);
      expect(validated.stdout).toContain("READY FOR /prepare-pr");
    },
  );

  it("preserves the observed PR through ordinary prepare-run without treating it as correction mode", () => {
    const f = fixture();
    f.review.recommendation = "READY FOR /prepare-pr";
    f.review.findings = [];
    writeFileSync(join(f.root, ".local/review.json"), JSON.stringify(f.review));
    const result = f.run(
      [
        'pr_observe() { echo "unexpected replacement observation" >&2; return 99; }',
        'prepare_gates() { [ "$1" = 42 ] && [ "$2" = "$(cat .local/pr-meta.json)" ] && touch .local/gates-reached; }',
        'prepare_push() { [ "$1" = 42 ] && [ "$2" = "$(cat .local/pr-meta.json)" ] && touch .local/push-reached; }',
        'prepare_run 42 "$(cat .local/pr-meta.json)"',
      ].join("\n"),
    );
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(readFileSync(join(f.root, ".local/prep-context.env"), "utf8")).toContain(
      "PREP_REVIEW_MODE=ready",
    );
    expect(existsSync(join(f.root, ".local/gates-reached"))).toBe(true);
    expect(existsSync(join(f.root, ".local/push-reached"))).toBe(true);
    expect(f.git("rev-parse", "HEAD")).toBe(f.incoming);
  });

  it("preserves default NEEDS WORK refusal and explicitly admits only correction preparation", () => {
    const f = fixture();
    const original = readFileSync(join(f.root, ".local/review.json"), "utf8");
    const denied = f.run("prepare_init 42");
    expect(denied.status).toBe(1);
    expect(denied.stdout).toContain("requires a validated READY");
    expect(existsSync(join(f.root, ".local/side-effects"))).toBe(false);
    const admitted = f.run("prepare_init 42 '' correction");
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
      const result = f.run("prepare_init 42 '' correction");
      expect(result.status).toBe(1);
      expect(existsSync(join(f.root, ".local/side-effects"))).toBe(false);
    },
  );

  it("requires complete exact-candidate review, then rejects subsequent source drift", () => {
    const f = fixture();
    expect(f.run("prepare_init 42 '' correction").status).toBe(0);
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
      expect(f.run("prepare_init 42 '' correction").status).toBe(0);
      f.commitFix();
      writeFileSync(join(f.root, ".local/gates.env"), "GATES_MODE=full\n");
      const result = f.run(
        [
          'source "$script_parent_dir/pr-lib/gates.sh"',
          "resolve_pr_gates_remote_mode() { echo local; }",
          "mark_pr_operation_side_effects_if_available() { :; }",
          "derive_prepare_gate_change_plan() { touch .local/execution-reached; return 1; }",
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
    expect(f.run("prepare_init 42 '' correction").status).toBe(0);
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
      expect(f.run("prepare_init 42 '' correction").status).toBe(0);
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
      expect(f.run("prepare_init 42 '' correction").status).toBe(0);
      f.commitFix();
      const candidate = f.git("rev-parse", "HEAD");
      expect(f.run("prepare_correction_review_init 42").status).toBe(0);
      f.approve();
      const names = ["correction-review.json", "correction-incoming-review.json"];
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
      expect(f.run("prepare_init 42 '' correction").status).toBe(0);
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
    expect(f.run("prepare_init 42 '' correction").status).toBe(0);
    f.commitFix();
    const qualified = f.git("rev-parse", "HEAD");
    expect(f.run("prepare_correction_review_init 42").status).toBe(0);
    f.approve();
    const publish = () =>
      f.run(
        [
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

  it("does not qualify a correction with deferred GitHub gates", () => {
    const f = fixture();
    expect(f.run("prepare_init 42 '' correction").status).toBe(0);
    f.commitFix();
    expect(f.run("prepare_correction_review_init 42").status).toBe(0);
    f.approve();
    const result = f.run(
      [
        "resolve_pr_gates_remote_mode() { echo github; }",
        "mark_pr_operation_side_effects_if_available() { :; }",
        "derive_prepare_gate_change_plan() { PREPARE_GATE_CHANGED_FILES=docs/fix.md; PREPARE_GATE_DOCS_ONLY=false; PREPARE_GATE_CHANGELOG_ONLY=false; PREPARE_GATE_CHANGELOG_REQUIRED=false; PREPARE_GATE_CHANGELOG_UPDATE=false; }",
        "push_prep_head_to_pr_branch() { touch .local/execution-reached; return 73; }",
        "prepare_gates 42",
        "prepare_push 42",
      ].join("\n"),
    );
    expect(result.status, result.stdout + result.stderr).toBe(1);
    const gates = readFileSync(join(f.root, ".local/gates.env"), "utf8");
    expect(gates).toContain("GATES_MODE=github_pending");
    expect(gates).not.toContain("GATES_PASSED_AT");
    expect(gates).not.toContain("LAST_VERIFIED_HEAD_SHA");
    expect(existsSync(join(f.root, ".local/execution-reached"))).toBe(false);
    expect(f.run("prepare_sync_head 42").status).toBe(1);
  });

  it.each(["completed", "pending", "revoked", "fork", "stale-review", "foreign-gate"])(
    "preserves correction authority when a partial publication has %s gates",
    (state) => {
      const f = fixture();
      expect(f.run("prepare_init 42 '' correction").status).toBe(0);
      f.commitFix();
      const local = f.git("rev-parse", "HEAD");
      expect(f.run("prepare_correction_review_init 42").status).toBe(0);
      f.approve();
      const hosted = f.git("commit-tree", `${local}^{tree}`, "-p", f.incoming, "-m", "hosted");
      writeFileSync(
        join(f.root, ".local/prepare-push-result.env"),
        `PUSH_PREP_HEAD_SHA=${hosted}\nPUSH_LOCAL_PREP_HEAD_SHA=${local}\nPUSHED_FROM_SHA=${f.incoming}\nPUSH_REPLACED_HOSTED_ANCESTRY=false\nPR_HEAD_SHA_AFTER_PUSH=${hosted}\n`,
      );
      const pending = ["pending", "revoked", "fork"].includes(state);
      const qualified =
        state === "foreign-gate"
          ? f.git("commit-tree", `${local}^{tree}`, "-p", f.incoming, "-m", "foreign")
          : pending
            ? local
            : hosted;
      writeFileSync(
        join(f.root, ".local/gates.env"),
        `PR_NUMBER=42\nGATES_MODE=${pending ? "remote_crabbox_aws_pending" : "full"}\nLAST_VERIFIED_HEAD_SHA=${qualified}\nFULL_GATES_HEAD_SHA=${qualified}\nREMOTE_GATES_PROVIDER=aws\n`,
      );
      if (state === "stale-review") {
        const reviewPath = join(f.root, ".local/correction-review.json");
        const review = JSON.parse(readFileSync(reviewPath, "utf8"));
        review.pr.headSha = f.incoming;
        writeFileSync(reviewPath, JSON.stringify(review));
      }
      const target = JSON.stringify({
        state: "OPEN",
        isCrossRepository: state === "fork",
        baseRefName: "main",
        baseRefOid: f.incoming,
        headRefOid: hosted,
      });
      const result = f.run(
        [
          "source .local/prep-context.env",
          `resolve_prep_publication_target 42 ${local}`,
          `test "$PREP_PUBLICATION_LEASE_SHA" = ${hosted}`,
          "require_prepared_review 42",
          `require_active_org_admin_for_crabbox_gate() { [ '${state}' != revoked ]; }`,
          `gh() { printf '%s\\n' '${target}'; }`,
          `require_correction_publication_gates 42 ${local} true`,
        ].join("\n"),
      );
      const allowed = state === "completed" || state === "pending";
      expect(result.status, result.stdout + result.stderr).toBe(allowed ? 0 : 1);
      expect(existsSync(join(f.root, ".local/prep.env"))).toBe(false);
    },
  );

  it.each([
    { fork: true, authorization: "granted" },
    { fork: false, authorization: "granted" },
    { fork: false, authorization: "denied" },
    { fork: false, authorization: "revoked" },
  ])(
    "checks native pending-route eligibility before correction publication, fork=$fork, authorization=$authorization",
    ({ fork, authorization }) => {
      const f = fixture();
      expect(f.run("prepare_init 42 '' correction").status).toBe(0);
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
          `require_active_org_admin_for_crabbox_gate() {
            local phase=qualification
            [ ! -e .local/publication-started ] || phase=publication
            printf '%s\\n' "$phase" >> .local/admin-checks
            [ '${authorization}' != denied ] || return 1
            if [ '${authorization}' = revoked ] && [ "$phase" = publication ]; then return 1; fi
            echo fixture-admin
          }`,
          "derive_prepare_gate_change_plan() { PREPARE_GATE_CHANGED_FILES=docs/fix.md; PREPARE_GATE_DOCS_ONLY=false; PREPARE_GATE_CHANGELOG_ONLY=false; PREPARE_GATE_CHANGELOG_REQUIRED=false; PREPARE_GATE_CHANGELOG_UPDATE=false; }",
          `gh() { printf '%s\\n' '${target}'; }`,
          "push_prep_head_to_pr_branch() { touch .local/execution-reached; return 73; }",
          "prepare_gates 42",
          "touch .local/publication-started",
          "prepare_push 42",
        ].join("\n"),
      );
      const allowed = !fork && authorization === "granted";
      expect(result.status, result.stdout + result.stderr).toBe(allowed ? 73 : 1);
      expect(existsSync(join(f.root, ".local/execution-reached"))).toBe(allowed);
      const checks = readFileSync(join(f.root, ".local/admin-checks"), "utf8").trim().split("\n");
      expect(checks).toContain("qualification");
      if (authorization === "denied") {
        expect(checks).not.toContain("publication");
        expect(existsSync(join(f.root, ".local/gates.env"))).toBe(false);
      } else {
        expect(checks).toContain("publication");
      }
      const sync = f.run("push_prep_head_to_pr_branch() { return 73; }; prepare_sync_head 42");
      expect(sync.status, sync.stderr).toBe(1);
    },
  );

  it.each(["missing", "stale"])(
    "ignores %s Markdown presentation during correction admission",
    (kind) => {
      const f = fixture();
      const markdown = join(f.root, ".local/review.md");
      if (kind === "missing") {
        rmSync(markdown);
      } else {
        writeFileSync(markdown, "Obsolete presentation, not review authority\n");
      }
      expect(f.run("prepare_init 42 '' correction").status).toBe(0);
      f.commitFix();
      expect(f.run("prepare_correction_review_init 42").status).toBe(0);
      f.approve();
      writeFileSync(join(f.root, ".local/correction-review.md"), "NEEDS WORK\n");
      const result = f.run("require_prepared_review 42");
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("READY FOR /prepare-pr");
    },
  );

  it("includes runtime fixup paths in candidate review even when incoming scope is docs", () => {
    const f = fixture();
    expect(f.run("prepare_init 42 '' correction").status).toBe(0);
    f.commitFix();
    mkdirSync(join(f.root, "src"));
    writeFileSync(join(f.root, "src/fix.ts"), "export const fixed = true;\n");
    f.git("add", "src/fix.ts");
    f.git("commit", "-qm", "fix runtime");
    expect(f.run("prepare_correction_review_init 42").status).toBe(0);
    f.approve();
    const result = f.run("require_prepared_review 42");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("runtime file changes require");
  });

  it.each([
    ["git", "unchanged"],
    ["git", "JSON"],
    ["git", "Markdown"],
    ["graphql", "unchanged"],
    ["graphql", "JSON"],
    ["graphql", "Markdown"],
    ["git", "publication receipt"],
    ["graphql", "publication receipt"],
  ])(
    "revalidates JSON authority immediately before %s publication after %s change",
    (route, change) => {
      const f = fixture();
      expect(f.run("prepare_init 42 '' correction").status).toBe(0);
      f.commitFix();
      expect(f.run("prepare_correction_review_init 42").status).toBe(0);
      f.approve();
      const head = f.git("rev-parse", "HEAD");
      writeFileSync(
        join(f.root, ".local/gates.env"),
        `PR_NUMBER=42\nGATES_MODE=full\nLAST_VERIFIED_HEAD_SHA=${head}\nFULL_GATES_HEAD_SHA=${head}\n`,
      );
      const mutation =
        change === "JSON"
          ? "printf '\\n' >> .local/correction-review.json"
          : change === "publication receipt"
            ? "printf 'changed\\n' > .local/prepare-push-result.env"
            : change === "Markdown"
              ? "printf 'obsolete presentation\\n' > .local/correction-review.md"
              : ":";
      const result = f.run(
        [
          'source "$script_parent_dir/pr-lib/push.sh"',
          "PREP_PUBLICATION_PR=42; PREP_PUBLICATION_ALLOW_PENDING=false",
          "PREP_PUBLICATION_REVIEW_SNAPSHOT=$(correction_review_snapshot 42)",
          'pr_git() { if [ "$1" = push ]; then touch .local/publication; return 0; fi; git "$@"; }',
          `pr_gh_plain() { touch .local/publication; printf '%s\\n' '{"data":{"createCommitOnBranch":{"commit":{"oid":"${head}"}}}}'; }`,
          `verify_prep_first_parent_range_signed() { ${mutation}; return 0; }`,
          `verify_prep_head_extends_hosted_head() { git merge-base --is-ancestor "$1" HEAD || return 1; ${mutation}; }`,
          "PRHEAD_REMOTE_URL=https://example.invalid/repo.git; OPENCLAW_PR_PUSH_MODE=git",
          'revalidate_pr_publication() { [ "$1" = 42 ] && [ "$2" = fixture-observation ] && [ "$3" = topic ] && [ "$5" = "$(git rev-parse HEAD)" ]; }',
          route === "git"
            ? `push_prep_head_once topic ${f.incoming} ${head} 42 fixture-observation`
            : `graphql_push_to_fork fixture/repo topic ${f.incoming} 42 fixture-observation ${head}`,
        ].join("\n"),
      );
      const changedAuthority = change === "JSON" || change === "publication receipt";
      expect(result.status, result.stdout + result.stderr).toBe(changedAuthority ? 1 : 0);
      expect(existsSync(join(f.root, ".local/publication"))).toBe(!changedAuthority);
      if (changedAuthority) {
        expect(result.stderr).toContain("Correction review authority changed");
      }
    },
  );

  it("retains prior candidate reviews when initializing another review", () => {
    const f = fixture();
    expect(f.run("prepare_init 42 '' correction").status).toBe(0);
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

  it.each(["review", "publication lease", "replacement flag"])(
    "refuses a resumed no-op when %s changes during hosted acquisition",
    (change) => {
      const f = fixture();
      expect(f.run("prepare_init 42 '' correction").status).toBe(0);
      f.commitFix();
      const local = f.git("rev-parse", "HEAD");
      expect(f.run("prepare_correction_review_init 42").status).toBe(0);
      f.approve();
      const hosted = f.git("commit-tree", `${local}^{tree}`, "-p", f.incoming, "-m", "hosted");
      const receipt = `PUSH_PREP_HEAD_SHA=${hosted}\nPUSH_LOCAL_PREP_HEAD_SHA=${local}\nPUSHED_FROM_SHA=${f.incoming}\nPUSH_REPLACED_HOSTED_ANCESTRY=false\nPR_HEAD_SHA_AFTER_PUSH=${hosted}\n`;
      writeFileSync(join(f.root, ".local/prepare-push-result.env"), receipt);
      writeFileSync(
        join(f.root, ".local/gates.env"),
        `PR_NUMBER=42\nGATES_MODE=full\nLAST_VERIFIED_HEAD_SHA=${hosted}\nFULL_GATES_HEAD_SHA=${hosted}\n`,
      );
      const changedReceipt =
        change === "publication lease"
          ? receipt.replace(`PUSHED_FROM_SHA=${f.incoming}`, `PUSHED_FROM_SHA=${hosted}`)
          : receipt.replace("=false\n", "=true\n");
      const mutation =
        change === "review"
          ? "printf '\\n' >> .local/correction-review.json"
          : `printf '%s' '${changedReceipt}' > .local/prepare-push-result.env`;
      const result = f.run(
        [
          'source "$script_parent_dir/pr-lib/worktree.sh"',
          'source "$script_parent_dir/pr-lib/push.sh"',
          "source .local/prep-context.env",
          "PREP_PUBLICATION_PR=42; PREP_PUBLICATION_ALLOW_PENDING=false",
          "PREP_PUBLICATION_REVIEW_SNAPSHOT=$(correction_review_snapshot 42)",
          "resolve_head_push_url() { echo https://example.invalid/repo.git; }",
          `resolve_prhead_remote_sha() { PRHEAD_REMOTE_SHA=${hosted}; }`,
          "revalidate_pr_publication() { :; }",
          `wait_for_pr_head_sha() { PR_OBSERVATION='{"headRefOid":"${hosted}"}'; }`,
          "verify_pr_publication_identity() { :; }",
          `fetch_pr_head() { git update-ref "$3" "$2"; ${mutation}; }`,
          `push_prep_head_to_pr_branch 42 topic ${hosted} ${hosted} .local/prepare-push-result.env "$(cat .local/pr-meta.json)"`,
          "touch .local/completed",
        ].join("\n"),
      );
      expect(result.status, result.stdout + result.stderr).toBe(1);
      expect(result.stderr).toContain("Correction review authority changed");
      expect(existsSync(join(f.root, ".local/completed"))).toBe(false);
      expect(readFileSync(join(f.root, ".local/prepare-push-result.env"), "utf8")).toBe(
        change === "review" ? receipt : changedReceipt,
      );
    },
  );
});
