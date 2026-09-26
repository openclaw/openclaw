import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import {
  createPublisherRepoFactory,
  runGatesBash,
  runPublisher,
} from "./pr-prepare.test-support.js";

const cases = useAutoCleanupTempDirTracker(afterEach);
const templates = useAutoCleanupTempDirTracker(afterAll);
const createRepo = createPublisherRepoFactory({ cases, templates });
const describePosix = process.platform === "win32" ? describe.skip : describe;

function publishedPreparation(alias = false) {
  const f = createRepo();
  const head = alias ? f.sameTree : f.candidate;
  f.git("push", "-q", "origin", `${head}:refs/heads/topic`);
  writeFileSync(
    join(f.local, "pr-meta.json"),
    JSON.stringify({ ...f.observation, baseRefOid: f.base }),
  );
  writeFileSync(
    join(f.local, "remote-observation.json"),
    JSON.stringify({ ...f.observation, baseRefOid: f.advance, headRefOid: head }),
  );
  writeFileSync(
    join(f.local, "gates.env"),
    `PR_NUMBER=4242\nGATES_MODE=remote_crabbox_aws_pending\nLAST_VERIFIED_HEAD_SHA=${f.candidate}\nFULL_GATES_HEAD_SHA=''\n`,
  );
  writeFileSync(
    join(f.local, "prepare-push-result.env"),
    [
      `PUSH_PREP_HEAD_SHA=${head}`,
      `PUSH_LOCAL_PREP_HEAD_SHA=${f.candidate}`,
      `PUSHED_FROM_SHA=${f.source}`,
      "PUSH_REPLACED_HOSTED_ANCESTRY=false",
      `PR_HEAD_SHA_AFTER_PUSH=${head}`,
      "",
    ].join("\n"),
  );
  const setup = [
    'enter_worktree() { test "$2:$3" = false:true || return 90; }',
    "refresh_prep_branch_for_reviewed_head() { echo refresh >> .local/events; return 90; }",
    "checkout_prep_branch() { echo checkout >> .local/events; return 90; }",
    "pr_gh() { cat .local/remote-observation.json; }",
    "require_active_org_admin_for_crabbox_gate() { :; }",
    // The actual JS verifier has its own CLI tests. Keep this seam at the child
    // process boundary while exercising prepare admission and both real writers.
    "node() {",
    '  if [ "$2" = --read-crabbox-gates ]; then command node "$@"; return $?; fi',
    '  printf "%s\\n" "$*" >> .local/observer-args',
    '  test "$1" = "$script_parent_dir/pr-lib/ci-dispatch.mjs" || return 91',
    `  test "$2:$3:$4:$5:$6:$7:$8:$9:\${10}:\${11}" = '4242:topic:${head}:${f.base}:false:--backend:crabbox:--pending-gates:--resume-crabbox-run:99' || return 92`,
    `  printf '%s\\n' '${JSON.stringify({ backend: "crabbox", provider: "aws", target: "linux", baseSha: f.base, headSha: head, workflowSha: f.advance, actionsRunAttempt: 1, runId: "run_fixture", leaseId: "cbx_fixture", actionsRunUrl: "https://github.com/openclaw/openclaw/actions/runs/99" })}'`,
    "}",
  ];
  return { ...f, head, setup };
}

describePosix("prepare-push retained Crabbox finalization", () => {
  it.each([false, true])(
    "finalizes legacy published preparation without pushing or refreshing, alias=%s",
    (alias) => {
      const f = publishedPreparation(alias);
      const result = runPublisher(f, 'prepare_push 4242 "" 99', f.setup);
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toContain("prepare-push complete");
      expect(readFileSync(join(f.local, "events"), "utf8")).toBe("");
      expect(f.git("rev-parse", "HEAD")).toBe(f.candidate);
      expect(f.git("--git-dir", f.remote, "rev-parse", "refs/heads/topic")).toBe(f.head);
      const prep = readFileSync(join(f.local, "prep.env"), "utf8");
      expect(prep).toContain(`PREP_HEAD_SHA=${f.head}`);
      expect(prep).toContain(`LOCAL_PREP_HEAD_SHA=${f.candidate}`);
      expect(prep).toContain(`PREP_MAINLINE_BASE_SHA=${f.base}`);
      const gate = readFileSync(join(f.local, "gates.env"), "utf8");
      expect(gate).toContain("GATES_MODE=remote_crabbox_aws");
      expect(gate).toContain(`FULL_GATES_HEAD_SHA=${f.head}`);
      expect(gate).not.toContain("PENDING_CRABBOX_");
    },
  );

  it.each([
    "remote-head",
    "closed",
    "fork",
    "target",
    "branch",
    "dirty",
    "receipt",
    "gate",
    "review",
    "publisher",
  ])("does not finalize or push on %s mismatch/failure", (mode) => {
    const f = publishedPreparation();
    const setup = [...f.setup];
    const remote = { ...f.observation, baseRefOid: f.advance, headRefOid: f.head };
    if (mode === "remote-head") {
      remote.headRefOid = f.source;
    }
    if (mode === "closed") {
      remote.state = "CLOSED";
    }
    if (mode === "fork") {
      remote.isCrossRepository = true;
    }
    if (mode === "target") {
      remote.baseRefName = "other";
    }
    writeFileSync(join(f.local, "remote-observation.json"), JSON.stringify(remote));
    if (mode === "branch") {
      f.git("checkout", "-qb", "other");
    }
    if (mode === "dirty") {
      writeFileSync(join(f.repoDir, "reviewed.txt"), "changed\n");
    }
    if (mode === "receipt") {
      writeFileSync(join(f.local, "prepare-push-result.env"), "PUSH_PREP_HEAD_SHA=bad\n");
    }
    if (mode === "gate") {
      writeFileSync(
        join(f.local, "gates.env"),
        `PR_NUMBER=4242\nGATES_MODE=full\nLAST_VERIFIED_HEAD_SHA=${f.head}\n`,
      );
    }
    if (mode === "review") {
      setup.push("require_prepared_review() { return 1; }");
    }
    if (mode === "publisher") {
      setup.push("node() { return 1; }");
    }
    const before = readFileSync(join(f.local, "gates.env"), "utf8");
    const result = runPublisher(f, 'prepare_push 4242 "" 99', setup);
    expect(result.status).not.toBe(0);
    expect(existsSync(join(f.local, "prep.env"))).toBe(false);
    expect(readFileSync(join(f.local, "gates.env"), "utf8")).toBe(before);
    expect(readFileSync(join(f.local, "events"), "utf8")).toBe("");
  });

  it("refuses ordinary prepare-push before refresh when dispatch acceptance is uncertain", () => {
    const f = publishedPreparation();
    writeFileSync(
      join(f.local, "gates.env"),
      readFileSync(join(f.local, "gates.env"), "utf8") + "PENDING_CRABBOX_STATE=dispatching\n",
    );
    const result = runPublisher(f, "prepare_push 4242", [...f.setup, "enter_worktree() { :; }"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("--resume-crabbox-run");
    expect(readFileSync(join(f.local, "events"), "utf8")).toBe("");
    expect(existsSync(join(f.local, "prep.env"))).toBe(false);
  });
  it("resumes after gate success when the preparation writer was interrupted", () => {
    const f = publishedPreparation();
    const first = runPublisher(f, 'prepare_push 4242 "" 99', [
      ...f.setup,
      "complete_prepare_push() { return 77; }",
    ]);
    expect(first.status).toBe(77);
    expect(existsSync(join(f.local, "prep.env"))).toBe(false);
    const gate = readFileSync(join(f.local, "gates.env"), "utf8");
    expect(gate).toContain("GATES_MODE=remote_crabbox_aws");
    expect(gate).toContain(`REMOTE_GATES_BASE_SHA=${f.base}`);
    expect(gate).toContain("REMOTE_GATES_ACTIONS_RUN_ATTEMPT=1");
    const resumed = runPublisher(f, 'prepare_push 4242 "" 99', f.setup);
    expect(resumed.status, resumed.stdout + resumed.stderr).toBe(0);
    expect(existsSync(join(f.local, "prep.env"))).toBe(true);
    expect(readFileSync(join(f.local, "events"), "utf8")).toBe("");
  });

  it.each([
    "PENDING_CRABBOX_STATE=$(touch .local/evaluated)\n",
    "PENDING_CRABBOX_STATE=selected\n",
    "PENDING_CRABBOX_UNKNOWN=1\n",
    "PENDING_CRABBOX_STATE=dispatching\nPENDING_CRABBOX_STATE=dispatching\n",
  ])("rejects malformed provenance before shell evaluation: %s", (extra) => {
    const f = publishedPreparation();
    const path = join(f.local, "gates.env");
    const before = readFileSync(path, "utf8") + extra;
    writeFileSync(path, before);
    const result = runPublisher(f, 'prepare_push 4242 "" 99', f.setup);
    expect(result.status).not.toBe(0);
    expect(existsSync(join(f.local, "evaluated"))).toBe(false);
    expect(existsSync(join(f.local, "observer-args"))).toBe(false);
    expect(existsSync(join(f.local, "prep.env"))).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(readFileSync(join(f.local, "events"), "utf8")).toBe("");
  });
});

describePosix("atomic gate receipt writes", () => {
  it.each([
    ["github_pending", 1],
    ["remote_crabbox_aws_pending", 1],
    ["remote_crabbox_aws_pending", 2],
    ["full", 1],
    ["full", 2],
    ["remote_crabbox_aws", 1],
    ["remote_crabbox_aws", 2],
    ["remote_crabbox_aws", 3],
  ])("preserves the prior receipt when %s write %i fails", (mode, failedWrite) => {
    const f = publishedPreparation();
    const path = join(f.local, "gates.env");
    const before = readFileSync(path, "utf8");
    const result = runGatesBash(
      [
        "writes=0",
        "printf() {",
        "  if [ \"$1\" = '%s=%q\\n' ]; then",
        "    writes=$((writes + 1))",
        `    if [ "$writes" -eq ${failedWrite} ]; then`,
        "      builtin printf 'injected gate write failure\\n' >&2; return 73",
        "    fi",
        "  fi",
        '  builtin printf "$@"',
        "}",
        'mv() { touch .local/renamed; command mv "$@"; }',
        `if write_gates_env_stamp 4242 false false ${mode} '${f.head}' '' '' aws '' '' '' '${f.base}' '${f.advance}' 1; then exit 99; else exit "$?"; fi`,
      ].join("\n"),
      { cwd: f.repoDir },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("injected gate write failure");
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(existsSync(join(f.local, "renamed"))).toBe(false);
    expect(readdirSync(f.local).filter((name) => name.startsWith("gates.env."))).toEqual([]);
  });
});
