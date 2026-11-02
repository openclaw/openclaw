import { spawnSync } from "node:child_process";
import {
  constants,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import {
  createPublisherRepoFactory,
  runGatesBash,
  runPublisher,
} from "./pr-prepare.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const retryTemplates = useAutoCleanupTempDirTracker(afterAll);
let retryTemplate: { repoDir: string; headSha: string } | undefined;
const createPublisher = createPublisherRepoFactory({
  cases: tempDirs,
  templates: useAutoCleanupTempDirTracker(afterAll),
});

function fixtureGit(cwd: string, args: string[]) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

function initRepo(dirs = tempDirs) {
  const repoDir = join(dirs.make("openclaw-pr-gates-"), "repo");
  mkdirSync(repoDir);
  const git = (...args: string[]) => fixtureGit(repoDir, args);
  git("init", "-q", "-b", "main");
  git("config", "user.name", "t");
  git("config", "user.email", "t@example.com");
  mkdirSync(join(repoDir, ".local"));
  return { repoDir, git };
}

function writeLocal(repoDir: string, name: string, text: string) {
  writeFileSync(join(repoDir, ".local", name), text);
}

function commitFile(repoDir: string, path: string, text: string, message = "change") {
  writeFileSync(join(repoDir, path), text);
  fixtureGit(repoDir, ["add", path]);
  fixtureGit(repoDir, ["commit", "-qm", message]);
}

function makeRetryRepo() {
  if (!retryTemplate) {
    const { repoDir, git } = initRepo(retryTemplates);
    // Keep the pristine seed unchanged while each case copies its private Git state.
    git(
      "-c",
      "maintenance.auto=false",
      "-c",
      "gc.auto=0",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "retry head",
    );
    retryTemplate = { repoDir, headSha: git("rev-parse", "HEAD") };
  }
  const repoDir = join(tempDirs.make("openclaw-pr-gates-"), "repo");
  // Cases mutate private refs, indexes, objects and gate receipts.
  cpSync(retryTemplate.repoDir, repoDir, {
    recursive: true,
    mode: constants.COPYFILE_FICLONE,
  });
  return { repoDir, headSha: retryTemplate.headSha };
}

function changePlan(base: string, files = "''", docsOnly = false, changelogUpdate = false) {
  return `derive_prepare_gate_change_plan() {
  PREPARE_GATE_BASE_SHA=${base}
  PREPARE_GATE_CHANGED_FILES=${files}
  PREPARE_GATE_DOCS_ONLY=${docsOnly}
  PREPARE_GATE_CHANGELOG_ONLY=false
  PREPARE_GATE_CHANGELOG_UPDATE=${changelogUpdate}
  PREPARE_GATE_CHANGELOG_REQUIRED=false
}`;
}

function makeStaleGateRepo(docsOnly: boolean) {
  const { repoDir } = makeRetryRepo();
  fixtureGit(repoDir, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  if (docsOnly) {
    mkdirSync(join(repoDir, "docs"));
  }
  commitFile(repoDir, docsOnly ? "docs/proof.md" : "changed.ts", "change\n");
  writeLocal(repoDir, "pr-meta.env", "PR_NUMBER=4242\nPR_AUTHOR=steipete\n");
  writeLocal(
    repoDir,
    "prep-context.env",
    `PR_NUMBER=4242\nPR_HEAD=topic\nPR_HEAD_SHA_BEFORE=${fixtureGit(repoDir, ["rev-parse", "HEAD"])}\n`,
  );
  writeLocal(
    repoDir,
    "gates.env",
    `LAST_VERIFIED_HEAD_SHA=deadbeef
FULL_GATES_HEAD_SHA=deadbeef
${docsOnly ? "" : "HOSTED_GATES_TARGET_HEAD_SHA=deadbeef\nGATES_PASSED_AT=2026-09-01T00:00:00Z\n"}REMOTE_GATES_PROVIDER=blacksmith-testbox
REMOTE_GATES_LEASE_ID=tbx_stale
REMOTE_GATES_RUN_URL=https://example.test/runs/1
`,
  );
  return repoDir;
}

it("keeps pending evidence when the protected publisher fails in a conditional caller", () => {
  const workDir = join(tempDirs.make("openclaw-pr-gates-aws-failure-"), "work");
  mkdirSync(workDir, { recursive: true });
  mkdirSync(join(workDir, ".local"));
  writeFileSync(join(workDir, ".local/gates.env"), "GATES_MODE=remote_crabbox_aws_pending\n");
  const result = runGatesBash(
    [
      "require_active_org_admin_for_crabbox_gate() { :; }",
      `read_crabbox_gate_pr_binding() { printf '%s\\n' '${"a".repeat(40)}'; }`,
      `PR_HEAD=topic; LAST_VERIFIED_HEAD_SHA=${"b".repeat(40)}`,
      `node() { printf '%s\\n' '${JSON.stringify({
        actionsRunUrl: "https://github.com/openclaw/openclaw/actions/runs/99",
        backend: "crabbox",
        baseSha: "a".repeat(40),
        headSha: "b".repeat(40),
        leaseId: "cbx_stub",
        provider: "aws",
        runId: "run_stub",
        target: "linux",
      })}'; return 1; }`,
      `if finalize_remote_crabbox_aws_gate 424242 '${"b".repeat(40)}'; then exit 99; else exit "$?"; fi`,
    ].join("\n"),
    { cwd: workDir },
  );
  expect(result.status).not.toBe(0);
  expect(readFileSync(join(workDir, ".local/gates.env"), "utf8")).toBe(
    "GATES_MODE=remote_crabbox_aws_pending\n",
  );
});
it("scans changed files without temporary input storage", () => {
  const { repoDir: workDir, headSha } = makeRetryRepo();
  writeFileSync(join(workDir, ".local", "pr-meta.env"), "PR_AUTHOR=steipete\n");
  const result = runGatesBash(
    [
      "enter_worktree() { :; }",
      "checkout_prep_branch() { :; }",
      changePlan(headSha, "$'CHANGELOG.md\\nchangelog/fragments/stale.md'", true, true),
      "prepare_gates 4242",
    ].join("\n"),
    {
      cwd: workDir,
      env: { TMPDIR: join(workDir, "missing-tmp") },
    },
  );

  expect(result.status).toBe(1);
  expect(result.stdout, result.stderr).toContain("Unsupported changelog fragment files detected:");
  expect(result.stdout).toContain("changelog/fragments/stale.md");
  expect(result.stderr).not.toContain("cannot create temp file");
});

function runBuildGate(
  options: {
    qa?: string;
    workers?: string;
    failBuild?: boolean;
    conditional?: boolean;
  } = {},
) {
  const { repoDir, headSha } = makeRetryRepo();
  writeFileSync(join(repoDir, ".local", "pr-meta.env"), "PR_AUTHOR=fixture\n");
  const result = runGatesBash(
    [
      `enter_worktree() { PR_MAIN_SHA=${headSha}; }`,
      "checkout_prep_branch() { :; }",
      "prepare_local_gate_workspace() { :; }",
      changePlan(headSha),
      "run_quiet_logged() {",
      '  local label="$1"; shift 2',
      '  printf \'%s\\t%s\' "$label" "${OPENCLAW_BUILD_PRIVATE_QA-<unset>}" >> .local/commands',
      "  printf '\\t%s' \"$@\" >> .local/commands",
      "  printf '\\n' >> .local/commands",
      ...(options.failBuild ? ['  if [ "$label" = "pnpm build" ]; then return 23; fi'] : []),
      "}",
      options.conditional ? 'prepare_gates 4242 || exit "$?"' : "prepare_gates 4242",
    ].join("\n"),
    {
      cwd: repoDir,
      env: {
        OPENCLAW_PR_GATES_REMOTE: "local",
        OPENCLAW_BUILD_PRIVATE_QA: options.qa,
        OPENCLAW_VITEST_MAX_WORKERS: options.workers,
      },
    },
  );
  const commands = readFileSync(join(repoDir, ".local", "commands"), "utf8")
    .trimEnd()
    .split("\n")
    .map((line) => line.split("\t"));
  return { result, commands, headSha, stamp: join(repoDir, ".local", "gates.env") };
}

it("prepares local full-test artifacts without changing caller QA or explicit workers", () => {
  const { result, commands, headSha, stamp } = runBuildGate({ qa: "0", workers: "2" });
  expect(result.status, result.stderr).toBe(0);
  expect(commands).toEqual([
    ["pnpm build", "0", "env", "OPENCLAW_BUILD_PRIVATE_QA=1", "pnpm", "build"],
    ["pnpm check", "0", "pnpm", "check", "--base", headSha],
    ["pnpm test", "0", "env", "OPENCLAW_VITEST_MAX_WORKERS=2", "pnpm", "test"],
  ]);
  expect(readFileSync(stamp, "utf8")).toContain(`FULL_GATES_HEAD_SHA=${headSha}\n`);
});
it("stops at build failure without a success stamp in a conditional caller", () => {
  const { result, commands, stamp } = runBuildGate({ failBuild: true, conditional: true });
  expect(result.status, result.stderr).toBe(23);
  expect(commands.map(([label]) => label)).toEqual(["pnpm build"]);
  expect(existsSync(stamp)).toBe(false);
});
it.each([
  ["admin", "maintainer"],
  ["read", "external"],
  ["maintain", "unknown"],
])("maps GitHub permission %s to %s", (permission, expected) => {
  const result = runGatesBash(
    [
      "pr_gh() {",
      '  test "$*" = "author-permission fixture/repo github.com fixture" || return 99',
      `  printf '{"permission":"${permission}"}\\n'`,
      "}",
      "resolve_pr_author_access_at_prepare fixture fixture/repo github.com",
    ].join("\n"),
    { sourcePrepareCore: true },
  );

  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.trim()).toBe(expected);
});
it("publishes only appended fixups when main advances", () => {
  const f = createPublisher();
  f.git("update-ref", "refs/remotes/origin/main", f.advance);
  f.write("prep-context.env", f.read("prep-context.env") + "PR_AUTHOR_ACCESS_AT_PREP=external\n");
  const result = runPublisher(f, "prepare_sync_head 4242", [
    `enter_worktree() { PR_MAIN_SHA=${f.advance}; }`,
  ]);
  expect(result.status, result.stderr).toBe(0);
  expect(f.git("rev-parse", "HEAD")).toBe(f.candidate);
  expect(f.git("diff", "--name-only", f.source, "HEAD")).toBe("fixup.txt");
  expect(f.git("merge-base", f.advance, "HEAD")).toBe(f.source);
  expect(f.git("--git-dir", f.remote, "rev-parse", "refs/heads/topic")).toBe(f.candidate);
  expect(f.read("prep.md")).toContain("Preserved hosted PR ancestry");
  expect(f.read("prep.env")).toContain("PREP_REPLACED_HOSTED_ANCESTRY=false");
  expect(f.read("prep.env")).toContain("PREP_AUTHOR_ACCESS=external");
  expect(result.stdout).toContain("prepare-sync-head complete");
  expect(result.stdout).not.toContain("Rebase");
});
it("rebuilds a stale prep branch and reruns gates before push", () => {
  const f = createPublisher();
  const { repoDir, base: recordedHead, source: reviewedHead } = f;
  f.git("update-ref", "refs/remotes/origin/main", f.base);
  f.git("branch", "pr-4242", reviewedHead);
  f.write("prep-context.env", f.read("prep-context.env").replace(f.source, f.base));
  f.write("prep.env", "PREP_HEAD_SHA=stale\n");
  const result = runGatesBash(
    [
      "refresh_main_snapshot() { PR_MAIN_SHA=$(git rev-parse --verify refs/remotes/origin/main); }",
      "enter_worktree() { refresh_main_snapshot; }",
      `reviewed_head='${reviewedHead}'`,
      'pr_gh() { printf "%s\\n" "$reviewed_head"; }',
      "prepare_gates() {",
      "  touch .local/gates-reran",
      "  printf 'DOCS_ONLY=false\\nGATES_MODE=fresh\\n' > .local/gates.env",
      "}",
      "push_prep_head_to_pr_branch() {",
      '  local result_env="$5"',
      '  printf \'PUSH_PREP_HEAD_SHA=%q\\nPUSH_LOCAL_PREP_HEAD_SHA=%q\\nPUSHED_FROM_SHA=%q\\nPUSH_REPLACED_HOSTED_ANCESTRY=false\\nPR_HEAD_SHA_AFTER_PUSH=%q\\n\' "$3" "$3" "$reviewed_head" "$3" > "$result_env"',
      "}",
      "prepare_push 4242",
      'test "$(git rev-parse HEAD)" = "$reviewed_head"',
      "test -e .local/gates-reran",
      "test ! -e fixup.txt",
      'test "$(. .local/prep-context.env; printf "%s" "$PR_HEAD_SHA_BEFORE")" = "$reviewed_head"',
      `grep -F 'drifted from ${recordedHead} to ${reviewedHead}' .local/prep.md`,
      "grep -F 'Gate mode: fresh' .local/prep.md",
    ].join("\n"),
    { cwd: repoDir, sourcePrepareCore: true },
  );

  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain(
    `Prep source head changed from ${recordedHead} to reviewed head ${reviewedHead}.`,
  );
  expect(result.stdout).toContain(
    "Prep branch was refreshed for reviewed head drift; rerunning prepare gates before push.",
  );
  expect(result.stdout).toContain("prepare-push complete");
});
it.each([
  ["merge", "cannot preserve merge ancestry"],
  ["rewritten", "refused rewritten history"],
])("rejects %s history before encoding files or calling GitHub", (kind, diagnostic) => {
  const { repoDir, headSha } = makeRetryRepo();
  if (kind === "merge") {
    const baseBranch = fixtureGit(repoDir, ["branch", "--show-current"]);
    for (const args of [
      ["checkout", "-qb", "other"],
      ["commit", "-qm", "other", "--allow-empty"],
      ["checkout", "-q", baseBranch],
      ["merge", "-q", "--no-ff", "other", "-m", "merge other"],
    ]) {
      fixtureGit(repoDir, args);
    }
  } else {
    const tree = fixtureGit(repoDir, ["rev-parse", "HEAD^{tree}"]);
    const unrelatedHead = fixtureGit(repoDir, ["commit-tree", tree, "-m", "rewritten"]);
    fixtureGit(repoDir, ["checkout", "-q", "--detach", unrelatedHead]);
  }
  const result = runGatesBash(
    [
      "pr_gh_plain() { touch .local/gh-called; return 99; }",
      `graphql_push_to_fork example/repo topic ${headSha} 42 '{}' HEAD`,
    ].join("\n"),
    { cwd: repoDir, sourcePush: true },
  );

  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain(diagnostic);
  expect(existsSync(join(repoDir, ".local", "gh-called"))).toBe(false);
});

it("observes the exact PR branch without changing shared remotes and reports proved absence", () => {
  const f = createPublisher();
  f.git("push", "-q", "origin", `${f.candidate}:refs/heads/nested/refs/heads/topic`);
  const result = runGatesBash(
    [
      `resolve_head_push_url() { printf '%s\\n' '${f.remote}'; }`,
      'pr_git() { printf "%s\\n" "$*" >> .local/git-calls; command git "$@"; }',
      "setup_prhead_remote",
      `test "$PRHEAD_REMOTE_URL" = '${f.remote}'`,
      "test ! -e .local/git-calls",
      "resolve_prhead_remote_sha topic",
      `test "$PRHEAD_REMOTE_SHA" = '${f.source}'`,
      "command git push -q origin :refs/heads/topic",
      "if resolve_prhead_remote_sha topic; then exit 96; else status=$?; fi",
      'test "$status" -eq 2',
      'test -z "$PRHEAD_REMOTE_SHA"',
      "if resolve_prhead_remote_sha missing; then exit 97; else status=$?; fi",
      'test "$status" -eq 2',
      'test -z "$PRHEAD_REMOTE_SHA"',
      "if command git config --get remote.prhead.url; then exit 98; fi",
    ].join("\n"),
    { cwd: f.repoDir, env: f.env, sourcePush: true },
  );

  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).toContain("Remote branch refs/heads/missing not found on prhead");
  expect(f.read("git-calls").trim().split("\n")).toEqual([
    `ls-remote --exit-code --heads ${f.remote} refs/heads/topic`,
    `ls-remote --exit-code --heads ${f.remote} refs/heads/topic`,
    `ls-remote --exit-code --heads ${f.remote} refs/heads/missing`,
  ]);
});

it.each(["empty", "partial", "parse"])(
  "stops conditional publication after a failed %s observation",
  (fault) => {
    const f = createPublisher();
    const prep = f.read("prep.md");
    const gates = f.read("gates.env");
    const result = runPublisher(
      f,
      [
        `PRHEAD_REMOTE_SHA='${f.candidate}'`,
        `if push_prep_head_to_pr_branch 4242 topic '${f.candidate}' '${f.source}'; then exit 97; else status=$?; fi`,
        'test -z "$PRHEAD_REMOTE_SHA"',
        'exit "$status"',
      ].join("\n"),
      [
        "pr_git() {",
        '  if [ "$1" = ls-remote ]; then',
        ...(fault !== "empty" ? [`    printf '%s\\t%s\\n' '${f.candidate}' refs/heads/topic`] : []),
        ...(fault === "parse"
          ? ["    return 0"]
          : ["    echo fixture-transport-diagnostic >&2", "    return 99"]),
        "  fi",
        '  command git "$@"',
        "}",
        ...(fault === "parse" ? ["awk() { echo fixture-parse-diagnostic >&2; return 2; }"] : []),
        "revalidate_pr_publication() { touch .local/continued-publication; return 98; }",
        "push_prep_head_once() { touch .local/continued-publication; return 98; }",
      ],
    );

    const status = fault === "parse" ? 1 : 99;
    expect(result.status, result.stdout + result.stderr).toBe(status);
    expect(result.stderr).toContain(
      fault === "parse" ? "fixture-parse-diagnostic" : "fixture-transport-diagnostic",
    );
    expect(result.stderr).toContain(
      `Unable to inspect remote branch refs/heads/topic (remote branch probe exited ${status})`,
    );
    expect(result.stderr).not.toContain("not found");
    expect(f.exists("continued-publication")).toBe(false);
    expect(f.exists("push-result.env")).toBe(false);
    expect(f.read("prep.md")).toBe(prep);
    expect(f.read("gates.env")).toBe(gates);
    expect(f.read("events")).toBe("");
    expect(f.git("--git-dir", f.remote, "rev-parse", "refs/heads/topic")).toBe(f.source);
  },
);

const shardOwnershipPath = "test/tsconfig/tsconfig.core.test.agents-tools.json";
it.each([
  ["overlapping source changes", "src/subject.ts", true, "Hosted CI reuse declined"],
  ["test shard ownership changes", shardOwnershipPath, true, "Hosted CI reuse declined"],
  [
    "unreadable change facts",
    "src/unrelated.ts",
    false,
    "unable to evaluate mainline input changes",
  ],
] as const)(
  "declines hosted CI reuse for incorporated %s",
  (_name, mainPath, readable, diagnostic) => {
    const dir = tempDirs.make("openclaw-pr-reuse-context-");
    mkdirSync(join(dir, ".local"));
    const currentHead = "1".repeat(40);
    const reusedHead = "2".repeat(40);
    const reusedBase = "3".repeat(40);
    const mainSha = "4".repeat(40);
    const currentBase = "5".repeat(40);
    const remote = {
      headRefName: "topic",
      headRefOid: currentHead,
      isCrossRepository: false,
      baseRepository: { nameWithOwner: "example/project" },
    };
    writeLocal(
      dir,
      "gates-hosted-checks.json",
      JSON.stringify({ headSha: currentHead, reusedFromSha: reusedHead }),
    );
    writeFileSync(join(dir, "main-paths.txt"), mainPath + "\n");
    writeFileSync(join(dir, "incorporated-paths.txt"), mainPath + "\n");
    writeFileSync(join(dir, "prepared-paths.txt"), "src/subject.ts\n");
    const result = runGatesBash(
      `
source '${process.cwd()}/scripts/pr-lib/merge.sh'
PR_MAIN_SHA=${mainSha}
pr_gh() { echo 'carried observation must avoid another GitHub lookup' >&2; return 99; }
run_quiet_logged() { cat >/dev/null; }
pr_git() {
  case "$*" in
    "rev-parse ${currentHead}^") return 1 ;;
    "merge-base ${mainSha} ${reusedHead}") printf '%s\\n' ${reusedBase} ;;
    "merge-base ${mainSha} ${currentHead}") printf '%s\\n' ${currentBase} ;;
    "cat-file -e ${reusedBase}^{commit}"|"cat-file -e ${reusedHead}^{commit}") return 0 ;;
    "diff --name-only --no-renames ${reusedBase}..${mainSha}") cat main-paths.txt; return ${readable ? 0 : 1} ;;
    "diff --name-only --no-renames ${reusedBase}..${currentBase}") cat incorporated-paths.txt; return ${readable ? 0 : 1} ;;
    "diff --name-only --no-renames ${reusedBase}..${reusedHead}") cat prepared-paths.txt ;;
    *) echo "unexpected fixture Git query: $*" >&2; return 99 ;;
  esac
}
if run_hosted_prepare_gates 42 ${currentHead} false '${JSON.stringify(remote)}'; then
  exit 0
else
  exit 1
fi
`,
      { cwd: dir, env: { TMPDIR: dir } },
    );
    const output = result.stdout + result.stderr;
    expect(result.status, output).toBe(1);
    expect(output).toContain(diagnostic);
  },
);

it("does not stamp declined hosted proof in a conditional caller", () => {
  const dir = tempDirs.make("openclaw-pr-declined-proof-");
  mkdirSync(join(dir, ".local"));
  const currentHead = "a".repeat(40);
  writeFileSync(join(dir, ".local", "pr-meta.env"), "PR_NUMBER=42\nPR_AUTHOR=fixture\n");
  const result = runGatesBash(
    `
enter_worktree() { PR_MAIN_SHA=fixture-main; }
refresh_prep_branch_for_reviewed_head() { :; }
checkout_prep_branch() { PR_NUMBER=42; PR_HEAD=topic; PR_HEAD_SHA_BEFORE=${currentHead}; }
${changePlan("fixture-main", "src/subject.ts")}
pr_git() {
  case "$*" in
    "rev-parse HEAD") printf '%s\\n' ${currentHead} ;;
    *) echo "unexpected fixture Git query: $*" >&2; return 99 ;;
  esac
}
run_hosted_prepare_gates() { echo 'fixture context declined'; return 1; }
if prepare_gates 42; then
  exit 0
else
  exit 1
fi
`,
    { cwd: dir, env: { OPENCLAW_TESTBOX: "1" }, sourcePrepareCore: true },
  );
  expect(result.status, result.stdout + result.stderr).toBe(1);
  expect(result.stdout, result.stderr).toContain("fixture context declined");
  expect(existsSync(join(dir, ".local", "gates.env"))).toBe(false);
});

it("does not derive recent-parent evidence for a runtime commit", () => {
  const path = "changed.ts";
  const { repoDir } = makeRetryRepo();
  commitFile(repoDir, path, "change\n");
  const currentHead = fixtureGit(repoDir, ["rev-parse", "HEAD"]);
  writeLocal(repoDir, "gates-hosted-checks.json", JSON.stringify({ headSha: currentHead }));
  const result = runGatesBash(
    [
      `pr_gh() { test "$1" = pr || return 99; printf '{"headRefName":"topic","headRefOid":"${currentHead}","isCrossRepository":false,"baseRepository":{"nameWithOwner":"openclaw/openclaw"}}\\n'; }`,
      "run_quiet_logged() { cat >/dev/null; printf 'ARG:%s\\n' \"$@\"; }",
      "PR_MAIN_SHA=$(git rev-parse HEAD)",
      `run_hosted_prepare_gates 100606 ${currentHead} false`,
    ].join("\n"),
    { cwd: repoDir },
  );

  expect(result.status).toBe(0);
  expect(result.stdout).not.toContain("ARG:--recent-sha");
});
it.each(["docs", "hosted", "github"])(
  "clears stale proof when %s gates replace remote proof",
  (mode) => {
    const docsOnly = mode === "docs";
    const repoDir = makeStaleGateRepo(docsOnly);

    const result = runGatesBash(
      [
        "enter_worktree() { PR_MAIN_SHA=$(git rev-parse --verify refs/remotes/origin/main); }",
        "refresh_prep_branch_for_reviewed_head() { :; }",
        "checkout_prep_branch() { source .local/prep-context.env; }",
        `path_is_docsish() { return ${docsOnly ? 0 : 1}; }`,
        "changelog_required_for_changed_files() { return 1; }",
        ...(docsOnly
          ? ["prepare_local_gate_workspace() { :; }", "run_quiet_logged() { :; }"]
          : ["run_hosted_prepare_gates() { printf 'HOSTED\\n'; }"]),
        "prepare_gates 4242",
        "cat .local/gates.env",
      ].join("\n"),
      {
        cwd: repoDir,
        sourcePrepareCore: true,
        env: docsOnly
          ? { OPENCLAW_PR_GATES_REMOTE: "local" }
          : mode === "hosted"
            ? { OPENCLAW_TESTBOX: "1" }
            : {},
      },
    );

    expect(result.status).toBe(0);
    const gates = readFileSync(join(repoDir, ".local", "gates.env"), "utf8");
    if (mode === "github") {
      const currentHead = fixtureGit(repoDir, ["rev-parse", "HEAD"]);
      expect(gates).toContain("GATES_MODE=github_pending\n");
      expect(gates).toContain(`HOSTED_GATES_TARGET_HEAD_SHA=${currentHead}\n`);
      expect(gates).not.toMatch(/VERIFIED|PASSED|FULL_GATES|REMOTE_GATES/);
      expect(result.stdout).not.toMatch(/^HOSTED$/m);
    } else {
      expect(gates).toContain(
        `GATES_MODE=${docsOnly ? "docs_only" : "hosted_exact_or_recent_parent"}`,
      );
      if (docsOnly) {
        expect(gates).toContain("FULL_GATES_HEAD_SHA=''");
      } else {
        expect(result.stdout).toMatch(/^HOSTED$/m);
      }
      expect(gates).toContain("REMOTE_GATES_LEASE_ID=''");
    }
    expect(result.stdout).not.toContain("tbx_stale");
  },
);

function publishedAlias() {
  const f = createPublisher();
  f.git("push", "-q", "origin", `${f.sameTree}:refs/heads/topic`);
  const completed = runPublisher(
    f,
    `source .local/prep-context.env
PR_AUTHOR=fixture
PUSH_REPLACED_HOSTED_ANCESTRY=false
complete_prepare_push ${f.sameTree} ${f.candidate} ${f.base} ${f.source} ${f.sameTree}`,
  );
  expect(completed.status, completed.stdout + completed.stderr).toBe(0);
  rmSync(join(f.local, "gates.env"));
  return f;
}

it.each(["github", "hosted", "github fixup"])(
  "requalifies the authenticated publication target with %s gates",
  (mode) => {
    const f = publishedAlias();
    const prep = f.read("prep.env");
    let localHead = f.candidate;
    if (mode === "github fixup") {
      f.git("reset", "--hard", f.sameTree);
      f.git("commit", "-qm", "fixup after hosted publication", "--allow-empty");
      localHead = f.git("rev-parse", "HEAD");
    }
    const expectedTarget = mode === "github fixup" ? localHead : f.sameTree;
    if (mode === "hosted") {
      f.env.OPENCLAW_TESTBOX = "1";
    }
    const result = runPublisher(f, "prepare_gates 4242", [
      // Only the external verifier response is synthetic; its live-head check is real.
      "run_quiet_logged() { cat >/dev/null; printf 'HOSTED_ARG:%s\\n' \"$@\"; printf '{}\\n' >.local/gates-hosted-checks.json; }",
    ]);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(f.git("rev-parse", "HEAD")).toBe(localHead);
    expect(f.read("prep.env")).toBe(prep);
    const gates = f.read("gates.env");
    expect(gates).toContain(`HOSTED_GATES_TARGET_HEAD_SHA=${expectedTarget}\n`);
    if (mode !== "hosted") {
      expect(gates).not.toMatch(/VERIFIED|PASSED|FULL_GATES|REMOTE_GATES/u);
    } else {
      expect(result.stdout).toContain(`HOSTED_ARG:${f.sameTree}\n`);
      expect(gates).toContain(`LAST_VERIFIED_HEAD_SHA=${f.sameTree}\n`);
    }
  },
);

it.each(["foreign PR", "foreign branch", "different tree", "unpublished fixup"])(
  "refuses %s alias authority before writing fresh hosted gates",
  (fault) => {
    const f = publishedAlias();
    const prep = f.read("prep.env");
    if (fault === "foreign PR") {
      f.write("prep.env", prep.replace("PR_NUMBER=4242", "PR_NUMBER=99"));
    } else if (fault === "foreign branch") {
      f.write("prep.env", prep.replace("PR_HEAD=topic", "PR_HEAD=other"));
    } else if (fault === "different tree") {
      f.write(
        "prep.env",
        prep.replace(`PREP_HEAD_SHA=${f.sameTree}\n`, `PREP_HEAD_SHA=${f.source}\n`),
      );
    } else {
      f.git("commit", "-qm", "unpublished fixup", "--allow-empty");
    }
    const retained = f.read("prep.env");
    const result = runPublisher(f, "prepare_gates 4242");
    expect(result.status, result.stdout + result.stderr).not.toBe(0);
    expect(f.exists("gates.env")).toBe(false);
    expect(f.read("prep.env")).toBe(retained);
  },
);

it("pins the worktree before dependency bootstrap", () => {
  const result = runGatesBash(
    [
      "events=$(mktemp)",
      'pin_worktree_bundled_plugins_dir() { echo pin >> "$events"; }',
      'bootstrap_deps_if_needed() { echo bootstrap >> "$events"; }',
      "prepare_local_gate_workspace",
      'cat "$events"',
    ].join("\n"),
  );

  expect(result.status).toBe(0);
  expect(result.stdout.trim().split("\n")).toEqual(["pin", "bootstrap"]);
});
