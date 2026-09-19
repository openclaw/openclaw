import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

const scripts = resolve("scripts");
const helper = join(scripts, "pr-lib/review-artifacts.mjs");
const head = "b".repeat(40);
const cli = (...args) => spawnSync(process.execPath, [helper, ...args], { encoding: "utf8" });

function fixture(t, runtime = false) {
  const root = mkdtempSync(join(tmpdir(), "pr-review-artifacts-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const review = JSON.parse(cli("template", "42", head).stdout);
  const reviewPath = join(root, "review.json");
  const metaPath = join(root, "pr-meta.json");
  writeFileSync(
    metaPath,
    JSON.stringify({
      number: 42,
      headRefOid: head,
      files: [{ path: runtime ? "src/example.ts" : "docs/example.md" }],
    }),
  );
  const validate = () => {
    writeFileSync(reviewPath, JSON.stringify(review));
    return cli("validate", reviewPath, metaPath);
  };
  return { root, review, reviewPath, metaPath, validate };
}

for (const runtime of [false, true]) {
  test(`unfinished ${runtime ? "runtime" : "docs"} template is honest and cannot prepare`, (t) => {
    const f = fixture(t, runtime);
    assert.equal(f.validate().status, 0);
    assert.equal(f.review.tests.result, "not_run");
    assert.equal(f.review.issueValidation.performed, false);
    assert.equal(f.review.behavioralSweep.performed, false);
    assert.equal(f.review.nitSweep, undefined);
    f.review.recommendation = "READY FOR /prepare-pr";
    const result = f.validate();
    assert.equal(result.status, 1);
    assert.match(result.stdout, /performed must be true/);
  });
}

for (const [field, allowed, assign] of [
  [
    "recommendation",
    "READY FOR /prepare-pr|NEEDS WORK|NEEDS DISCUSSION|NOT USEFUL (CLOSE)",
    (review, value) => {
      review.recommendation = value;
    },
  ],
  [
    "findings[0].severity",
    "BLOCKER|IMPORTANT|NIT",
    (review, value) => {
      review.findings = [
        { id: "F1", severity: value, title: "Regression", area: "input", fix: "Handle input" },
      ];
    },
  ],
  [
    "nitSweep.status",
    "none|has_nits",
    (review, value) => {
      review.nitSweep = { performed: true, status: value, summary: "No nits." };
    },
  ],
  [
    "issueValidation.source",
    "linked_issue|pr_body|both",
    (review, value) => {
      review.issueValidation.source = value;
    },
  ],
  [
    "issueValidation.status",
    "valid|unclear|invalid|already_fixed_on_main",
    (review, value) => {
      review.issueValidation.status = value;
    },
  ],
  [
    "behavioralSweep.status",
    "pass|needs_work|not_applicable",
    (review, value) => {
      review.behavioralSweep.status = value;
    },
  ],
  [
    "behavioralSweep.silentDropRisk",
    "none|present|unknown",
    (review, value) => {
      review.behavioralSweep.silentDropRisk = value;
    },
  ],
  [
    "tests.result",
    "pass|fail|not_run",
    (review, value) => {
      review.tests.result = value;
    },
  ],
  [
    "docs",
    "up_to_date|missing|not_applicable",
    (review, value) => {
      review.docs = value;
    },
  ],
  [
    "changelog",
    "required|not_required",
    (review, value) => {
      review.changelog = value;
    },
  ],
]) {
  test(`rejects an annotated enum with the exact field and accepted values: ${field}`, (t) => {
    const f = fixture(t);
    const annotated = `${allowed.split("|")[0]} (allowed: ${allowed})`;
    assign(f.review, annotated);
    const result = f.validate();
    assert.equal(result.status, 1);
    assert.ok(
      result.stdout.includes(`${field}=${JSON.stringify(annotated)} (allowed: ${allowed})`),
      result.stdout,
    );
    assert.match(result.stdout, /1 artifact violations/);
  });
}

test("empty required summaries and missing finding severity remain invalid", (t) => {
  const f = fixture(t);
  f.review.issueValidation.summary = "";
  f.review.behavioralSweep.summary = " ";
  f.review.nitSweep = { performed: true, status: "none", summary: "" };
  f.review.findings = [{ id: "F1", title: "Regression", area: "input", fix: "Handle input" }];
  const result = f.validate();
  assert.equal(result.status, 1);
  for (const field of ["issueValidation.summary", "behavioralSweep.summary", "nitSweep.summary"]) {
    assert.ok(result.stdout.includes(`${field} must be a non-empty string`), result.stdout);
  }
  assert.ok(
    result.stdout.includes("findings[0].severity=null (allowed: BLOCKER|IMPORTANT|NIT)"),
    result.stdout,
  );
  assert.match(result.stdout, /4 artifact violations/);
});

test("JSON owns rendering and optional nit evidence remains validated", (t) => {
  const f = fixture(t);
  f.review.recommendation = "READY FOR /prepare-pr";
  Object.assign(f.review.issueValidation, {
    performed: true,
    status: "valid",
    summary: "Confirmed bug.",
  });
  Object.assign(f.review.behavioralSweep, {
    performed: true,
    status: "not_applicable",
    silentDropRisk: "none",
  });
  assert.equal(f.validate().status, 0);
  writeFileSync(join(f.root, "review.md"), "Obsolete foreign verdict");
  const rendered = cli("render", f.reviewPath);
  assert.equal(rendered.status, 0);
  assert.match(rendered.stdout, /Confirmed bug/);
  assert.doesNotMatch(rendered.stdout, /Obsolete|A\) TL;DR|Optional nits/);
  f.review.nitSweep = { performed: true, status: "has_nits", summary: "Missing findings" };
  assert.equal(f.validate().status, 1);
  f.review.nitSweep = { performed: true, status: "none", summary: "No nits" };
  assert.equal(f.validate().status, 0);
  f.review.pr.number = 43;
  assert.equal(f.validate().status, 1);
});

test("substantive findings and runtime proof still gate READY", (t) => {
  const f = fixture(t, true);
  f.review.recommendation = "READY FOR /prepare-pr";
  Object.assign(f.review.issueValidation, { performed: true, status: "valid" });
  Object.assign(f.review.behavioralSweep, {
    performed: true,
    status: "pass",
    silentDropRisk: "none",
    branches: [{ path: "src/example.ts", decision: "empty input", outcome: "explicit error" }],
  });
  f.review.tests = { result: "pass", ran: ["targeted regression"], gaps: [] };
  assert.equal(f.validate().status, 0);
  f.review.findings.push({
    id: "F1",
    severity: "IMPORTANT",
    title: "Regression",
    area: "input",
    fix: "Handle empty input",
  });
  assert.equal(f.validate().status, 1);
  f.review.findings = [];
  f.review.behavioralSweep.branches = [];
  assert.equal(f.validate().status, 1);
  f.review.tests.result = "fail";
  assert.match(f.validate().stdout, /passing tests/);
});

test(
  "native preflight rejects locally and never evaluates metadata shell code",
  { skip: process.platform === "win32" },
  (t) => {
    const f = fixture(t);
    const owner = join(f.root, "repo");
    mkdirSync(owner);
    const git = (...args) => execFileSync("git", ["-C", owner, ...args], { stdio: "pipe" });
    git("init", "-b", "main");
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--allow-empty",
      "-m",
      "fixture",
    );
    const worktree = join(owner, ".worktrees/pr-42");
    git("worktree", "add", "-b", "pr-42", worktree);
    const local = join(worktree, ".local");
    mkdirSync(local);
    const marker = join(f.root, "must-not-execute");
    writeFileSync(join(local, "pr-meta.env"), `touch '${marker}'\n`);
    writeFileSync(join(local, "pr-meta.json"), readFileSync(f.metaPath));
    const run = (invocation) =>
      spawnSync(
        "/bin/bash",
        [
          "-c",
          `
set -euo pipefail
canonical_repo_root="$1"
script_parent_dir="$2"
repo_root() { printf '%s\\n' "$canonical_repo_root"; }
source "$2/pr-lib/common.sh"
source "$2/pr-lib/review.sh"
review_guard() { echo FRESH_GUARD; return 42; }
pr_gh_plain() { echo UNEXPECTED_AUTH; return 43; }
${invocation}
`,
          "fixture",
          owner,
          scripts,
        ],
        { cwd: owner, encoding: "utf8" },
      );
    writeFileSync(join(local, "review.json"), "invalid JSON");
    let result = run("review_validate_artifacts 42");
    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stdout, /FRESH_GUARD|UNEXPECTED_AUTH/);
    writeFileSync(join(local, "review.json"), JSON.stringify(f.review));
    result = run("review_artifact_preflight 42 true");
    assert.equal(result.status, 1);
    assert.match(result.stdout, /requires a validated READY/);
    result = run("review_validate_artifacts 42");
    assert.equal(result.status, 1);
    assert.match(result.stdout, /FRESH_GUARD/);
    assert.equal(existsSync(marker), false);
    assert.equal(existsSync(join(local, "review.md")), false);
    assert.equal(git("branch", "--show-current").toString().trim(), "main");

    git("config", "user.name", "Fixture");
    git("config", "user.email", "fixture@example.test");
    git("config", "commit.gpgsign", "false");
    const operation = join(f.root, "operation.sh");
    for (const [invocation, contents] of [
      ["review_validate_artifacts 42", "invalid JSON"],
      ["prepare_init 42", JSON.stringify(f.review)],
    ]) {
      writeFileSync(join(local, "review.json"), contents);
      writeFileSync(
        operation,
        `#!/bin/bash
set -euo pipefail
canonical_repo_root="$REVIEW_FIXTURE_OWNER"
repo_root() { printf '%s\\n' "$REVIEW_FIXTURE_OWNER"; }
script_parent_dir="$REVIEW_FIXTURE_SCRIPTS"
source "$script_parent_dir/pr-lib/worktree.sh"
source "$script_parent_dir/pr-lib/operation-lock.sh"
source "$script_parent_dir/pr-lib/common.sh"
source "$script_parent_dir/pr-lib/review.sh"
source "$script_parent_dir/pr-lib/prepare-core.sh"
acquire_pr_operation_lock 42
begin_pr_operation_validation_phase
review_guard() { echo UNEXPECTED_GUARD; return 43; }
${invocation} || exit 1
`,
      );
      chmodSync(operation, 0o755);
      const supervised = spawnSync(
        process.execPath,
        [join(scripts, "pr-lib/process-group-runner.mjs"), owner, operation],
        {
          cwd: owner,
          encoding: "utf8",
          timeout: 15000,
          env: { ...process.env, REVIEW_FIXTURE_OWNER: owner, REVIEW_FIXTURE_SCRIPTS: scripts },
        },
      );
      assert.equal(supervised.status, 1, supervised.stdout + supervised.stderr);
      assert.doesNotMatch(supervised.stdout, /UNEXPECTED_GUARD/);
      assert.doesNotMatch(supervised.stderr, /Retaining the operation lock/);
      assert.equal(
        git("for-each-ref", "--format=%(refname)", "refs/openclaw/pr-operation-locks").toString(),
        "",
      );
    }
  },
);
