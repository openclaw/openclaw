import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import {
  createPublisherRepoFactory,
  runGatesBash,
  runPublisher,
} from "./pr-prepare.test-support.js";

const createRepo = createPublisherRepoFactory({
  cases: useAutoCleanupTempDirTracker(afterEach),
  templates: useAutoCleanupTempDirTracker(afterAll),
});
const describePosix = process.platform === "win32" ? describe.skip : describe;

function publishedPreparation(alias = false) {
  const f = createRepo();
  const head = alias ? f.sameTree : f.candidate;
  f.git("push", "-q", "origin", `${head}:refs/heads/topic`);
  f.write("pr-meta.json", JSON.stringify({ ...f.observation, baseRefOid: f.base }));
  f.write(
    "remote-observation.json",
    JSON.stringify({ ...f.observation, baseRefOid: f.advance, headRefOid: head }),
  );
  f.write(
    "gates.env",
    `PR_NUMBER=4242\nGATES_MODE=remote_crabbox_aws_pending\nLAST_VERIFIED_HEAD_SHA=${f.candidate}\nFULL_GATES_HEAD_SHA=''\n`,
  );
  f.write(
    "prepare-push-result.env",
    `PUSH_PREP_HEAD_SHA=${head}\nPUSH_LOCAL_PREP_HEAD_SHA=${f.candidate}\nPUSHED_FROM_SHA=${f.source}\nPUSH_REPLACED_HOSTED_ANCESTRY=false\nPR_HEAD_SHA_AFTER_PUSH=${head}\n`,
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
  return {
    ...f,
    head,
    setup,
    run: (command = 'prepare_push 4242 "" 99', commands = setup) =>
      runPublisher(f, command, commands),
  };
}

describePosix("prepare-push retained Crabbox finalization", () => {
  it.each(["legacy publication", "interrupted writer", "legacy gate"])(
    "finalizes %s without pushing or refreshing",
    (mode) => {
      const f = publishedPreparation(mode === "legacy publication");
      if (mode === "interrupted writer") {
        const first = f.run(undefined, [...f.setup, "complete_prepare_push() { return 77; }"]);
        expect(first.status).toBe(77);
        expect(f.exists("prep.env")).toBe(false);
        const gate = f.read("gates.env");
        expect(gate).toContain("GATES_MODE=remote_crabbox_aws");
        expect(gate).toContain(`REMOTE_GATES_BASE_SHA=${f.base}`);
        expect(gate).toContain("REMOTE_GATES_ACTIONS_RUN_ATTEMPT=1");
      } else if (mode === "legacy gate") {
        // The old writer took eleven arguments, without controller provenance.
        const written = runGatesBash(
          `write_gates_env_stamp 4242 false false remote_crabbox_aws '${f.head}' '${f.head}' '' aws run_fixture cbx_fixture https://github.com/openclaw/openclaw/actions/runs/99`,
          { cwd: f.repoDir },
        );
        expect(written.status, written.stderr).toBe(0);
        expect(f.read("gates.env")).not.toContain("REMOTE_GATES_BASE_SHA");
      }
      const result = f.run();
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toContain("prepare-push complete");
      expect(f.read("events")).toBe("");
      expect(f.git("rev-parse", "HEAD")).toBe(f.candidate);
      expect(f.git("--git-dir", f.remote, "rev-parse", "refs/heads/topic")).toBe(f.head);
      const prep = f.read("prep.env");
      expect(prep).toContain(`PREP_HEAD_SHA=${f.head}`);
      expect(prep).toContain(`LOCAL_PREP_HEAD_SHA=${f.candidate}`);
      expect(prep).toContain(`PREP_MAINLINE_BASE_SHA=${f.base}`);
      const gate = f.read("gates.env");
      expect(gate).toContain("GATES_MODE=remote_crabbox_aws");
      expect(gate).toContain(`FULL_GATES_HEAD_SHA=${f.head}`);
      expect(gate).not.toContain("PENDING_CRABBOX_");
      expect(gate).toContain(`REMOTE_GATES_BASE_SHA=${f.base}`);
    },
  );
  it.each([
    "remote-head",
    "closed",
    "fork",
    "target",
    "branch",
    "dirty",
    "gate",
    "review",
    "publisher",
    "malformed-provenance",
  ] as const)("does not finalize or push on %s mismatch/failure", (mode) => {
    const f = publishedPreparation();
    const setup = [...f.setup];
    const remote = { ...f.observation, baseRefOid: f.advance, headRefOid: f.head };
    const mutate = {
      "remote-head": () => Object.assign(remote, { headRefOid: f.source }),
      closed: () => Object.assign(remote, { state: "CLOSED" }),
      fork: () => Object.assign(remote, { isCrossRepository: true }),
      target: () => Object.assign(remote, { baseRefName: "other" }),
      branch: () => f.git("checkout", "-qb", "other"),
      dirty: () => writeFileSync(join(f.repoDir, "reviewed.txt"), "changed\n"),
      gate: () =>
        f.write("gates.env", `PR_NUMBER=4242\nGATES_MODE=full\nLAST_VERIFIED_HEAD_SHA=${f.head}\n`),
      review: () => setup.push("require_prepared_review() { return 1; }"),
      publisher: () => setup.push("node() { return 1; }"),
      "malformed-provenance": () =>
        f.write(
          "gates.env",
          f.read("gates.env") + "PENDING_CRABBOX_STATE=$(touch .local/evaluated)\n",
        ),
    };
    mutate[mode]();
    f.write("remote-observation.json", JSON.stringify(remote));
    const before = f.read("gates.env");
    const result = f.run(undefined, setup);
    expect(result.status).not.toBe(0);
    if (mode === "malformed-provenance") {
      expect(f.exists("evaluated")).toBe(false);
      expect(f.exists("observer-args")).toBe(false);
    }
    expect(f.exists("prep.env")).toBe(false);
    expect(f.read("gates.env")).toBe(before);
    expect(f.read("events")).toBe("");
  });

  it("refuses ordinary prepare-push before refresh when dispatch acceptance is uncertain", () => {
    const f = publishedPreparation();
    f.write("gates.env", f.read("gates.env") + "PENDING_CRABBOX_STATE=dispatching\n");
    const setup = [...f.setup, "enter_worktree() { :; }"];
    const grep = spawnSync("bash", ["-c", "command -v grep"], { encoding: "utf8" });
    expect(grep.status, grep.stderr).toBe(0);
    const bin = join(f.local, "without-ripgrep");
    mkdirSync(bin);
    symlinkSync(grep.stdout.trim(), join(bin, "grep"));
    setup.push(
      `PATH='${bin.replaceAll("'", "'\\''")}'`,
      "if type -P rg >/dev/null; then echo 'unexpected external rg' >&2; exit 99; fi",
    );
    const result = f.run("prepare_push 4242", setup);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("--resume-crabbox-run");
    expect(f.read("events")).toBe("");
    expect(f.exists("prep.env")).toBe(false);
  });
  it.each([
    ["github_pending", 1],
    ["remote_crabbox_aws", 3],
  ])("preserves the prior receipt when %s write %i fails", (mode, failedWrite) => {
    const f = publishedPreparation();
    const before = f.read("gates.env");
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
    expect(f.read("gates.env")).toBe(before);
    expect(f.exists("renamed")).toBe(false);
    expect(readdirSync(f.local).filter((name) => name.startsWith("gates.env."))).toEqual([]);
  });
});
