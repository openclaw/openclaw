// Covers the scripts/pr prepare-gates remote testbox mode.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTempDirTracker } from "../helpers/temp-dir.js";
import { runGatesBash } from "./pr-prepare.test-support.js";

const repoRoot = process.cwd();

const tempDirs = createTempDirTracker();

function makeRetryRepo(): { repoDir: string; headSha: string } {
  const dir = tempDirs.make("openclaw-pr-gates-retry-");
  const repoDir = join(dir, "repo");
  mkdirSync(repoDir);
  for (const args of [
    ["init", "-q"],
    ["config", "user.name", "t"],
    ["config", "user.email", "t@example.com"],
    ["commit", "-q", "--allow-empty", "-m", "retry head"],
  ]) {
    const result = spawnSync("git", args, { cwd: repoDir, encoding: "utf8" });
    expect(result.status).toBe(0);
  }
  mkdirSync(join(repoDir, ".local"));

  const headSha = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: repoDir,
    encoding: "utf8",
  }).stdout.trim();
  return { repoDir, headSha };
}

function makeSyncRepo(options: { needsRebase: boolean }): string {
  const repoDir = join(tempDirs.make("openclaw-pr-sync-"), "repo");
  mkdirSync(repoDir);

  const git = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd: repoDir, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim();
  };
  git("init", "-q", "-b", "main");
  git("config", "user.name", "t");
  git("config", "user.email", "t@example.com");

  const base = ["shared: old", "one", "two", "three", "four", "five", "pr: old", ""].join("\n");
  const prChange = base.replace("shared: old", "shared: new").replace("pr: old", "pr: new");
  const mainChange = base.replace("shared: old", "shared: new");
  writeFileSync(join(repoDir, "config.yml"), base);
  git("add", "config.yml");
  git("commit", "-qm", "base");
  git("checkout", "-qb", "prep");
  writeFileSync(join(repoDir, "config.yml"), prChange);
  git("add", "config.yml");
  git("commit", "-qm", "pr change");
  git("checkout", "-q", "main");
  if (options.needsRebase) {
    writeFileSync(join(repoDir, "config.yml"), mainChange);
    git("add", "config.yml");
    git("commit", "-qm", "upstream shared hunk");
  }
  git("remote", "add", "origin", ".");
  git("fetch", "-q", "origin", "main");
  git("checkout", "-q", "prep");

  mkdirSync(join(repoDir, ".local"));
  writeFileSync(join(repoDir, ".local", "hosted-sha"), `${git("rev-parse", "HEAD")}\n`);
  writeFileSync(
    join(repoDir, ".local", "pr-meta.env"),
    "PR_NUMBER=4242\nPR_AUTHOR=steipete\nPR_URL=https://example.test/pr/4242\n",
  );
  writeFileSync(
    join(repoDir, ".local", "prep-context.env"),
    `PR_HEAD=topic\nPREP_BRANCH=prep\nPR_HEAD_SHA_BEFORE=${git("rev-parse", "HEAD")}\n`,
  );
  writeFileSync(join(repoDir, ".local", "prep.md"), "# Prepare\n");
  return repoDir;
}

function makePreparePushHeadDriftRepo(): {
  repoDir: string;
  recordedHead: string;
  reviewedHead: string;
} {
  const repoDir = join(tempDirs.make("openclaw-pr-prepare-drift-"), "repo");
  mkdirSync(repoDir);

  const git = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd: repoDir, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim();
  };
  git("init", "-q", "-b", "main");
  git("config", "user.name", "t");
  git("config", "user.email", "t@example.com");
  writeFileSync(join(repoDir, "base.txt"), "base\n");
  git("add", "base.txt");
  git("commit", "-qm", "base");
  const recordedHead = git("rev-parse", "HEAD");
  git("remote", "add", "origin", ".");
  git("fetch", "-q", "origin", "main");

  git("checkout", "-qb", "pr-4242");
  writeFileSync(join(repoDir, "reviewed.txt"), "new reviewed head\n");
  git("add", "reviewed.txt");
  git("commit", "-qm", "reviewed head update");
  const reviewedHead = git("rev-parse", "HEAD");

  git("checkout", "-qb", "prep", recordedHead);
  writeFileSync(join(repoDir, "stale-fixup.txt"), "belongs to stale prep head\n");
  git("add", "stale-fixup.txt");
  git("commit", "-qm", "stale prep fixup");

  mkdirSync(join(repoDir, ".local"));
  writeFileSync(
    join(repoDir, ".local", "pr-meta.env"),
    [
      "PR_NUMBER=4242",
      "PR_AUTHOR=steipete",
      "PR_URL=https://example.test/pr/4242",
      "PR_HEAD=topic",
      `PR_HEAD_SHA=${reviewedHead}`,
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(repoDir, ".local", "prep-context.env"),
    [
      "PR_NUMBER=4242",
      "PR_HEAD=topic",
      `PR_HEAD_SHA_BEFORE=${recordedHead}`,
      "PREP_BRANCH=prep",
      "PREP_STARTED_AT=2026-07-19T00:00:00Z",
      "",
    ].join("\n"),
  );
  writeFileSync(join(repoDir, ".local", "gates.env"), "GATES_MODE=stale\n");
  writeFileSync(join(repoDir, ".local", "prep.env"), "PREP_HEAD_SHA=stale\n");
  writeFileSync(join(repoDir, ".local", "prep.md"), "# Prepare\n");
  return { repoDir, recordedHead, reviewedHead };
}

function prepareSyncHeadStubs(): string[] {
  return [
    "enter_worktree() { PR_MAIN_SHA=$(git rev-parse --verify refs/remotes/origin/main); }",
    "hosted_sha=$(cat .local/hosted-sha)",
    'pr_gh() { printf "%s\\n" "$hosted_sha"; }',
    'verify_prep_head_extends_hosted_head() { git merge-base --is-ancestor "$1" HEAD; }',
    "push_prep_head_to_pr_branch() {",
    '  local result_env="$5"',
    "  touch .local/published",
    '  printf \'PUSH_PREP_HEAD_SHA=%q\\nPUSH_LOCAL_PREP_HEAD_SHA=%q\\nPUSHED_FROM_SHA=%q\\nPUSH_REPLACED_HOSTED_ANCESTRY=false\\nPR_HEAD_SHA_AFTER_PUSH=%q\\n\' "$3" "$3" "$hosted_sha" "$3" > "$result_env"',
    "}",
  ];
}

afterEach(() => {
  tempDirs.cleanup();
});

describe("remote Crabbox AWS gate contract", () => {
  it("builds the canonical deterministic proof command", () => {
    const planPath = join(tempDirs.make("openclaw-crabbox-command-"), "plan.json");
    writeFileSync(
      planPath,
      JSON.stringify({
        baseSha: "a".repeat(40),
        changedPaths: [{ path: "scripts/pr-lib/gates.sh", status: "M" }],
        headSha: "b".repeat(40),
        targets: ["test/scripts/pr-prepare-gates.test.ts"],
        version: 1,
      }),
    );
    const result = spawnSync(
      process.execPath,
      [
        join(repoRoot, "scripts/pr-crabbox-gate-publisher.mjs"),
        "--print-command",
        planPath,
        "c".repeat(64),
      ],
      { encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("umask 022");
    expect(result.stdout).toContain("pnpm build");
    expect(result.stdout).toContain("pnpm check");
    expect(result.stdout).toContain("test/scripts/pr-prepare-gates.test.ts");
    expect(result.stdout).toContain(`OPENCLAW_CRABBOX_GATE_BASE=${"a".repeat(40)}`);
    expect(result.stdout).toContain(`OPENCLAW_CRABBOX_GATE_HEAD=${"b".repeat(40)}`);
    expect(result.stdout).not.toContain("OPENCLAW_CRABBOX_GATE_WORKFLOW=");
    expect(result.stdout).not.toContain("test/scripts/pr-wrappers.test.ts");
    expect(result.stdout).not.toContain("OPENCLAW_TEST_PROJECTS_PARALLEL");
    expect(result.stdout).not.toContain("pnpm test");
    expect(result.stdout).not.toContain("pnpm check:changed");
  });

  it("records only trusted publisher metadata after synchronous success", () => {
    const dir = tempDirs.make("openclaw-pr-gates-aws-publisher-");
    const workDir = join(dir, "work");
    mkdirSync(workDir);
    mkdirSync(join(workDir, ".local"));
    const base = "a".repeat(40);
    const head = "b".repeat(40);
    const runUrl = "https://github.com/openclaw/openclaw/actions/runs/99";

    const result = runGatesBash(
      [
        "require_active_org_admin_for_crabbox_gate() { :; }",
        `read_crabbox_gate_pr_binding() { printf '%s\\n' '${base}'; }`,
        `PR_HEAD=topic; LAST_VERIFIED_HEAD_SHA=${head}`,
        "node() {",
        `  printf '%s\\n' '${JSON.stringify({
          actionsRunUrl: runUrl,
          actionsRunAttempt: 1,
          workflowSha: "c".repeat(40),
          backend: "crabbox",
          baseSha: base,
          headSha: head,
          leaseId: "cbx_stub",
          provider: "aws",
          runId: "run_stub",
          target: "linux",
        })}'`,
        "}",
        `finalize_remote_crabbox_aws_gate 424242 '${head}'`,
        "cat .local/gates.env",
      ].join("\n"),
      { cwd: workDir },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("GATES_MODE=remote_crabbox_aws");
    expect(result.stdout).toContain(`FULL_GATES_HEAD_SHA=${head}`);
    expect(result.stdout).toContain("REMOTE_GATES_PROVIDER=aws");
    expect(result.stdout).toContain("REMOTE_GATES_RUN_ID=run_stub");
    expect(result.stdout).toContain("REMOTE_GATES_LEASE_ID=cbx_stub");
    expect(result.stdout).toContain(`REMOTE_GATES_RUN_URL=${runUrl}`);
  });

  it.each([false, true])(
    "keeps pending evidence when the protected publisher fails, conditional=%s",
    (conditional) => {
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
          conditional
            ? `if finalize_remote_crabbox_aws_gate 424242 '${"b".repeat(40)}'; then exit 99; else exit "$?"; fi`
            : `finalize_remote_crabbox_aws_gate 424242 '${"b".repeat(40)}'`,
        ].join("\n"),
        { cwd: workDir },
      );
      expect(result.status).not.toBe(0);
      expect(readFileSync(join(workDir, ".local/gates.env"), "utf8")).toBe(
        "GATES_MODE=remote_crabbox_aws_pending\n",
      );
    },
  );
});

describe("prepare gate changed-file plan", () => {
  it.each([
    { paths: [] as string[], docsOnly: false, changelogOnly: false },
    { paths: ["docs/guide.md"], docsOnly: true, changelogOnly: false },
    { paths: ["CHANGELOG.md"], docsOnly: true, changelogOnly: true },
    { paths: ["src/index.ts"], docsOnly: false, changelogOnly: false },
    {
      paths: ["docs/guide.md", "src/index.ts"],
      docsOnly: false,
      changelogOnly: false,
    },
  ])("derives the coupled plan for $paths", ({ paths, docsOnly, changelogOnly }) => {
    const gitStub =
      paths.length === 0
        ? "pr_git() { :; }"
        : `pr_git() { printf '%s\\n' ${paths.map((path) => `'${path}'`).join(" ")}; }`;
    const result = runGatesBash(
      [
        gitStub,
        `PR_MAIN_SHA=${"a".repeat(40)}`,
        "derive_prepare_gate_change_plan",
        'printf "%s\\t%s\\t%s\\t%s\\n" "$PREPARE_GATE_CHANGED_FILES" "$PREPARE_GATE_DOCS_ONLY" "$PREPARE_GATE_CHANGELOG_ONLY" "$PREPARE_GATE_CHANGELOG_REQUIRED"',
      ].join("\n"),
    );

    expect(result.status).toBe(0);
    const fields = result.stdout.trimEnd().split("\t");
    expect(fields).toEqual([paths.join("\n"), String(docsOnly), String(changelogOnly), "false"]);
  });

  it("carries the changelog policy decision into the plan", () => {
    const result = runGatesBash(
      [
        "pr_git() { printf 'src/index.ts\\n'; }",
        "changelog_required_for_changed_files() { return 0; }",
        `PR_MAIN_SHA=${"a".repeat(40)}`,
        "derive_prepare_gate_change_plan",
        'printf "%s\\n" "$PREPARE_GATE_CHANGELOG_REQUIRED"',
      ].join("\n"),
    );

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("true");
  });

  it("scans changed files without temporary input storage", () => {
    const { repoDir: workDir, headSha } = makeRetryRepo();
    writeFileSync(join(workDir, ".local", "pr-meta.env"), "PR_AUTHOR=steipete\n");
    const result = runGatesBash(
      [
        "enter_worktree() { :; }",
        "checkout_prep_branch() { :; }",
        "derive_prepare_gate_change_plan() {",
        `  PREPARE_GATE_BASE_SHA=${headSha}`,
        "  PREPARE_GATE_CHANGED_FILES=$'CHANGELOG.md\\nchangelog/fragments/stale.md'",
        "  PREPARE_GATE_DOCS_ONLY=true",
        "  PREPARE_GATE_CHANGELOG_ONLY=false",
        "  PREPARE_GATE_CHANGELOG_UPDATE=true",
        "  PREPARE_GATE_CHANGELOG_REQUIRED=false",
        "}",
        "prepare_gates 4242",
      ].join("\n"),
      {
        cwd: workDir,
        env: { TMPDIR: join(workDir, "missing-tmp") },
      },
    );

    expect(result.status).toBe(1);
    expect(result.stdout, result.stderr).toContain(
      "Unsupported changelog fragment files detected:",
    );
    expect(result.stdout).toContain("changelog/fragments/stale.md");
    expect(result.stderr).not.toContain("cannot create temp file");
    expect(readFileSync(join(repoRoot, "scripts/pr-lib/gates.sh"), "utf8")).not.toMatch(
      /done\s+(?:<<<|<\s*<\()/u,
    );
  });
});

describe("remote testbox gate delegation", () => {
  function runRemoteGate(env: NodeJS.ProcessEnv) {
    const dir = tempDirs.make("openclaw-pr-gates-remote-");
    const stubBin = join(dir, "bin");
    mkdirSync(stubBin);
    writeFileSync(
      join(stubBin, "node"),
      [
        "#!/bin/sh",
        `if [ "$1" != scripts/crabbox-wrapper.mjs ]; then exec '${process.execPath}' "$@"; fi`,
        "printf 'ARG:%s\\n' \"$@\"",
        `printf '{"provider":"blacksmith-testbox","leaseId":"tbx_stub","exitCode":0,"runStatus":"passed"}\\n' >&2`,
      ].join("\n"),
    );
    chmodSync(join(stubBin, "node"), 0o755);

    const workDir = join(dir, "work");
    mkdirSync(workDir);
    const result = runGatesBash(
      "run_remote_testbox_full_test_gate 'pnpm test (blacksmith-testbox)' .local/gates-test.log pr-424242-gates",
      {
        cwd: workDir,
        env: { PATH: `${stubBin}:${process.env.PATH ?? ""}`, ...env },
      },
    );

    return { result, workDir, logPath: join(workDir, ".local/gates-test.log") };
  }

  it.each([
    { name: "absent controls", env: {}, expected: [] },
    {
      name: "explicit controls",
      env: { OPENCLAW_TEST_PROJECTS_PARALLEL: "2", OPENCLAW_VITEST_MAX_WORKERS: "1" },
      expected: ["OPENCLAW_TEST_PROJECTS_PARALLEL=2", "OPENCLAW_VITEST_MAX_WORKERS=1"],
    },
    {
      name: "normalized integer controls",
      env: { OPENCLAW_TEST_PROJECTS_PARALLEL: " 02 ", OPENCLAW_VITEST_MAX_WORKERS: "001" },
      expected: ["OPENCLAW_TEST_PROJECTS_PARALLEL=2", "OPENCLAW_VITEST_MAX_WORKERS=1"],
    },
    {
      name: "empty controls",
      env: { OPENCLAW_TEST_PROJECTS_PARALLEL: "", OPENCLAW_VITEST_MAX_WORKERS: " \t " },
      expected: [],
    },
    {
      name: "only the worker control",
      env: { OPENCLAW_VITEST_MAX_WORKERS: "3" },
      expected: ["OPENCLAW_VITEST_MAX_WORKERS=3"],
    },
  ])("runs the full worktree Testbox command with $name", ({ env, expected }) => {
    const { result, logPath } = runRemoteGate(env);
    expect(result.status, result.stderr).toBe(0);
    const args = readFileSync(logPath, "utf8")
      .split("\n")
      .filter((line) => line.startsWith("ARG:"))
      .map((line) => line.slice(4));
    expect(args).toEqual([
      "scripts/crabbox-wrapper.mjs",
      "run",
      "--provider",
      "blacksmith-testbox",
      "--blacksmith-org",
      "openclaw",
      "--blacksmith-workflow",
      ".github/workflows/ci-check-testbox.yml",
      "--blacksmith-job",
      "check",
      "--blacksmith-ref",
      "main",
      "--idle-timeout",
      "90m",
      "--ttl",
      "240m",
      "--timing-json",
      "--label",
      "pr-424242-gates",
      "--",
      "env",
      "CI=1",
      "OPENCLAW_TESTBOX_REMOTE_RUN=1",
      "PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=false",
      ...expected,
      "corepack",
      "pnpm",
      "test",
    ]);
  });

  it.each(
    ["OPENCLAW_TEST_PROJECTS_PARALLEL", "OPENCLAW_VITEST_MAX_WORKERS"].flatMap((name) =>
      ["0", "-1", "1.5", "9007199254740992", "2; touch injected"].map((value) => ({ name, value })),
    ),
  )("rejects $name=$value before remote dispatch", ({ name, value }) => {
    const { result, workDir, logPath } = runRemoteGate({ [name]: value });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(`${name} must be a positive integer`);
    expect(existsSync(logPath)).toBe(false);
    expect(existsSync(join(workDir, "injected"))).toBe(false);
  });

  it("extracts the last successful blacksmith-testbox timing stamp", () => {
    const dir = tempDirs.make("openclaw-pr-gates-stamp-");
    const log = join(dir, "gates-test.log");
    writeFileSync(
      log,
      [
        "provider=blacksmith-testbox id=tbx_first sync=delegated auth=blacksmith",
        "GitHub Actions run: https://github.com/openclaw/openclaw/actions/runs/1234",
        '{"not":"a stamp"}',
        "not json at all",
        '{"provider":"blacksmith-testbox","leaseId":"tbx_first","exitCode":1,"runStatus":"failed"}',
        '{"provider":"blacksmith-testbox","leaseId":"tbx_final","exitCode":0,"runStatus":"passed"}',
        "GitHub Actions run: https://github.com/openclaw/openclaw/actions/runs/9999",
        "GitHub Actions run: https://github.com/example/other/actions/runs/8888",
        "",
      ].join("\n"),
    );

    const result = runGatesBash(
      `require_remote_testbox_gate_stamp '${log}' | jq -r '[.leaseId, .actionsRunUrl] | @tsv'`,
    );
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(
      "tbx_final\thttps://github.com/openclaw/openclaw/actions/runs/1234",
    );
  });

  it("fails when the gate log has no successful stamp", () => {
    const dir = tempDirs.make("openclaw-pr-gates-stamp-");
    const log = join(dir, "gates-test.log");
    writeFileSync(
      log,
      '{"provider":"blacksmith-testbox","leaseId":"tbx_only","exitCode":1,"runStatus":"failed"}\n',
    );

    const result = runGatesBash(`require_remote_testbox_gate_stamp '${log}'`);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("no successful blacksmith-testbox timing stamp");
  });
});

describe("prepare author access snapshot", () => {
  it.each([
    ["admin", "maintainer"],
    ["write", "maintainer"],
    ["read", "external"],
    ["none", "external"],
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

  it.each(["error", "malformed"])("maps %s permission evidence to unknown", (mode) => {
    const result = runGatesBash(
      [
        "pr_gh() {",
        '  test "$*" = "author-permission fixture/repo github.com fixture" || return 99',
        mode === "error" ? "  return 1" : "  printf '{}\\n'",
        "}",
        "resolve_pr_author_access_at_prepare fixture fixture/repo github.com",
      ].join("\n"),
      { sourcePrepareCore: true },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("unknown");
  });
});

describe("prepare sync-head transitions", () => {
  it("publishes only appended fixups when main advances", () => {
    const repoDir = makeSyncRepo({ needsRebase: true });
    const contextPath = join(repoDir, ".local", "prep-context.env");
    writeFileSync(
      contextPath,
      `${readFileSync(contextPath, "utf8")}PR_AUTHOR_ACCESS_AT_PREP=external\n`,
    );
    writeFileSync(join(repoDir, "fixup.ts"), "export const fixed = true;\n");
    for (const args of [
      ["add", "fixup.ts"],
      ["commit", "-qm", "reviewed fixup"],
    ]) {
      const commit = spawnSync("git", args, { cwd: repoDir, encoding: "utf8" });
      expect(commit.status, commit.stderr).toBe(0);
    }
    const localHead = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: repoDir,
      encoding: "utf8",
    }).stdout.trim();

    const result = runGatesBash(
      [
        ...prepareSyncHeadStubs(),
        "prepare_sync_head 4242",
        `test "$(git rev-parse HEAD)" = "${localHead}"`,
        'test "$(git diff --name-only "$hosted_sha" HEAD)" = "fixup.ts"',
        'git merge-base --is-ancestor "$hosted_sha" HEAD',
        "! git merge-base --is-ancestor origin/main HEAD",
        "test -e .local/published",
        "grep -F 'Preserved hosted PR ancestry' .local/prep.md",
        "grep -F 'PREP_REPLACED_HOSTED_ANCESTRY=false' .local/prep.env",
        "grep -F 'PREP_AUTHOR_ACCESS=external' .local/prep.env",
      ].join("\n"),
      { cwd: repoDir, env: { OPENCLAW_TESTBOX: "1" }, sourcePrepareCore: true },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("prepare-sync-head complete");
    expect(result.stdout).not.toContain("Rebase");
  });
});

describe("prepare push head drift", () => {
  it("rebuilds a stale prep branch and reruns gates before push", () => {
    const { repoDir, recordedHead, reviewedHead } = makePreparePushHeadDriftRepo();
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
        "test ! -e stale-fixup.txt",
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
});

describe("GraphQL fork publication", () => {
  it("classifies appended and replaced hosted ancestry without tree heuristics", () => {
    const { repoDir, headSha } = makeRetryRepo();
    spawnSync("git", ["commit", "-qm", "appended", "--allow-empty"], { cwd: repoDir });
    const appendedHead = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: repoDir,
      encoding: "utf8",
    }).stdout.trim();
    const tree = spawnSync("git", ["rev-parse", "HEAD^{tree}"], {
      cwd: repoDir,
      encoding: "utf8",
    }).stdout.trim();
    const replacedHead = spawnSync("git", ["-c", "commit.gpgsign=false", "commit-tree", tree], {
      cwd: repoDir,
      input: "replacement\n",
      encoding: "utf8",
    }).stdout.trim();

    const result = runGatesBash(
      [
        `test "$(classify_replaced_hosted_ancestry ${headSha} ${appendedHead})" = false`,
        `test "$(classify_replaced_hosted_ancestry ${headSha} ${replacedHead})" = true`,
        `! classify_replaced_hosted_ancestry ${headSha} deadbeef 2>.local/ancestry-error`,
        "grep -F 're-run prepare-init' .local/ancestry-error",
      ].join("\n"),
      { cwd: repoDir, sourcePush: true },
    );

    expect(result.status, result.stderr).toBe(0);
  });

  it("accepts appended fixups and preserves the commit body", () => {
    const { repoDir, headSha } = makeRetryRepo();
    writeFileSync(join(repoDir, "fixup.ts"), "export const fixed = true;\n");
    for (const args of [
      ["add", "fixup.ts"],
      ["commit", "-qm", "reviewed fixup\n\nCo-authored-by: Helper <helper@example.com>"],
    ]) {
      const commit = spawnSync("git", args, { cwd: repoDir, encoding: "utf8" });
      expect(commit.status, commit.stderr).toBe(0);
    }

    const result = runGatesBash(
      [
        'pr_gh_plain() { cp "$4" .local/graphql-payload.json; printf \'%s\\n\' \'{"data":{"createCommitOnBranch":{"commit":{"oid":"signed-head","url":"https://example.test/commit"}}}}\'; }',
        "revalidate_pr_publication() { :; }",
        `graphql_push_to_fork example/repo topic ${headSha} 42 '{}' HEAD`,
        'test "$(jq -r .variables.input.message.headline .local/graphql-payload.json)" = "reviewed fixup"',
        'test "$(jq -r .variables.input.message.body .local/graphql-payload.json)" = "Co-authored-by: Helper <helper@example.com>"',
      ].join("\n"),
      { cwd: repoDir, sourcePush: true },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("signed-head");
  });

  it("rejects merge commits before encoding files or calling GitHub", () => {
    const { repoDir, headSha } = makeRetryRepo();
    const baseBranch = spawnSync("git", ["branch", "--show-current"], {
      cwd: repoDir,
      encoding: "utf8",
    }).stdout.trim();
    for (const args of [
      ["checkout", "-qb", "other"],
      ["commit", "-qm", "other", "--allow-empty"],
      ["checkout", "-q", baseBranch],
      ["merge", "-q", "--no-ff", "other", "-m", "merge other"],
    ]) {
      const command = spawnSync("git", args, { cwd: repoDir, encoding: "utf8" });
      expect(command.status, command.stderr).toBe(0);
    }

    const result = runGatesBash(
      [
        "pr_gh_plain() { touch .local/gh-called; return 99; }",
        `graphql_push_to_fork example/repo topic ${headSha} 42 '{}' HEAD`,
      ].join("\n"),
      { cwd: repoDir, sourcePush: true },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("cannot preserve merge ancestry");
    expect(existsSync(join(repoDir, ".local", "gh-called"))).toBe(false);
  });

  it("rejects rewritten history before encoding files or calling GitHub", () => {
    const { repoDir, headSha } = makeRetryRepo();
    const tree = spawnSync("git", ["rev-parse", "HEAD^{tree}"], {
      cwd: repoDir,
      encoding: "utf8",
    }).stdout.trim();
    const unrelatedHead = spawnSync(
      "git",
      [
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@example.com",
        "commit-tree",
        tree,
        "-m",
        "rewritten",
      ],
      { cwd: repoDir, encoding: "utf8" },
    ).stdout.trim();
    const checkout = spawnSync("git", ["checkout", "-q", "--detach", unrelatedHead], {
      cwd: repoDir,
      encoding: "utf8",
    });
    expect(checkout.status, checkout.stderr).toBe(0);

    const result = runGatesBash(
      [
        "pr_gh_plain() { touch .local/gh-called; return 99; }",
        `graphql_push_to_fork example/repo topic ${headSha} 42 '{}' HEAD`,
      ].join("\n"),
      { cwd: repoDir, sourcePush: true },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("refused rewritten history");
    expect(existsSync(join(repoDir, ".local", "gh-called"))).toBe(false);
  });
});

describe("fork publication transport", () => {
  it("keeps the PR push URL process-local and reports a missing branch", () => {
    const { repoDir } = makeRetryRepo();
    const result = runGatesBash(
      [
        "resolve_head_push_url() { printf '%s\\n' https://github.com/contributor/repo.git; }",
        "pr_git() { touch .local/git-called; return 99; }",
        "setup_prhead_remote",
        'test "$PRHEAD_REMOTE_URL" = https://github.com/contributor/repo.git',
        "test ! -e .local/git-called",
        "if remote_error=$(resolve_prhead_remote_sha topic 2>&1); then exit 97; fi",
        'test "$remote_error" = "Remote branch refs/heads/topic not found on prhead"',
        "test -e .local/git-called",
      ].join("\n"),
      { cwd: repoDir, sourcePush: true },
    );

    expect(result.status, result.stderr).toBe(0);
  });

  it("uses git transport automatically for a verified signed prep commit", () => {
    const { repoDir } = makeRetryRepo();
    const result = runGatesBash(
      [
        "PR_HEAD_OWNER=contributor",
        "PR_HEAD_REPO_NAME=repo",
        "PRHEAD_REMOTE_URL=https://github.com/contributor/repo.git",
        "pr_git() { printf '%s\\n' \"$*\" >> .local/git-calls; case \"$1\" in rev-list) printf '%s\\n' prepared;; esac; return 0; }",
        "graphql_push_to_fork() { touch .local/graphql-called; return 99; }",
        "revalidate_pr_publication() { :; }",
        "push_prep_head_once topic hosted prepared 42 '{}'",
        "grep -F 'verify-commit prepared' .local/git-calls",
        "grep -F 'push --force-with-lease=refs/heads/topic:hosted https://github.com/contributor/repo.git prepared:refs/heads/topic' .local/git-calls",
        "test ! -e .local/graphql-called",
      ].join("\n"),
      { cwd: repoDir, sourcePush: true },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("prepared");
  });

  it("keeps unsigned single-parent fixups on GitHub-signed GraphQL publication", () => {
    const { repoDir } = makeRetryRepo();
    const result = runGatesBash(
      [
        "PR_HEAD_OWNER=contributor",
        "PR_HEAD_REPO_NAME=repo",
        "PRHEAD_REMOTE_URL=https://github.com/contributor/repo.git",
        "pr_git() { case \"$1\" in rev-list) printf '%s\\n' prepared;; verify-commit) return 1;; esac; return 0; }",
        "graphql_push_to_fork() { touch .local/graphql-called; printf '%s\\n' signed-head; }",
        "push_prep_head_once topic hosted prepared 42 '{}'",
        "test -e .local/graphql-called",
      ].join("\n"),
      { cwd: repoDir, sourcePush: true },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("signed-head");
  });
});

describe("prepare gate stamp transitions", () => {
  it.each([
    {
      name: "exact-head proof",
      evidence: "exact",
      incorporated: true,
      mainPath: "src/subject.ts",
      readable: true,
      expected: 0,
      diagnostic: "",
    },
    {
      name: "scheduled recent-parent evidence",
      evidence: "recent-parent",
      incorporated: false,
      mainPath: "src/subject.ts",
      readable: true,
      expected: 0,
      diagnostic: "",
    },
    {
      name: "unchanged base despite relevant later main changes",
      evidence: "reuse",
      incorporated: false,
      mainPath: "src/subject.ts",
      readable: true,
      expected: 0,
      diagnostic: "",
    },
    {
      name: "incorporated disjoint main changes",
      evidence: "reuse",
      incorporated: true,
      mainPath: "src/unrelated.ts",
      readable: true,
      expected: 0,
      diagnostic: "",
    },
    {
      name: "incorporated overlapping source changes",
      evidence: "reuse",
      incorporated: true,
      mainPath: "src/subject.ts",
      readable: true,
      expected: 1,
      diagnostic: "Hosted CI reuse declined",
    },
    {
      name: "incorporated test shard ownership changes",
      evidence: "reuse",
      incorporated: true,
      mainPath: "test/tsconfig/tsconfig.core.test.agents-tools.json",
      readable: true,
      expected: 1,
      diagnostic: "Hosted CI reuse declined",
    },
    {
      name: "unreadable incorporated change facts",
      evidence: "reuse",
      incorporated: true,
      mainPath: "src/unrelated.ts",
      readable: false,
      expected: 1,
      diagnostic: "unable to evaluate mainline input changes",
    },
  ])(
    "qualifies selected hosted CI reuse: $name",
    ({ evidence, incorporated, mainPath, readable, expected, diagnostic }) => {
      const dir = tempDirs.make("openclaw-pr-reuse-context-");
      mkdirSync(join(dir, ".local"));
      const currentHead = "1".repeat(40);
      const reusedHead = "2".repeat(40);
      const reusedBase = "3".repeat(40);
      const mainSha = "4".repeat(40);
      const currentBase = incorporated ? "5".repeat(40) : reusedBase;
      const remote = {
        headRefName: "topic",
        headRefOid: currentHead,
        isCrossRepository: false,
        baseRepository: { nameWithOwner: "example/project" },
      };
      writeFileSync(
        join(dir, ".local", "gates-hosted-checks.json"),
        JSON.stringify({
          headSha: currentHead,
          ...(evidence === "reuse" ? { reusedFromSha: reusedHead } : {}),
          ...(evidence === "recent-parent" ? { evidenceHeadSha: reusedHead } : {}),
        }),
      );
      writeFileSync(join(dir, "main-paths.txt"), mainPath + "\n");
      writeFileSync(join(dir, "incorporated-paths.txt"), incorporated ? mainPath + "\n" : "");
      writeFileSync(join(dir, "prepared-paths.txt"), "src/subject.ts\n");
      const result = runGatesBash(
        `
source '${repoRoot}/scripts/pr-lib/merge.sh'
PR_MAIN_SHA=${mainSha}
pr_gh() { echo 'carried observation must avoid another GitHub lookup' >&2; return 99; }
run_quiet_logged() { cat >/dev/null; }
pr_git() {
  case "$*" in
    "rev-parse ${currentHead}^") return 1 ;;
    "merge-base ${mainSha} ${reusedHead}") printf '%s\\n' ${reusedBase} ;;
    "merge-base ${mainSha} ${currentHead}") printf '%s\\n' ${currentBase} ;;
    "cat-file -e ${reusedBase}^{commit}"|"cat-file -e ${reusedHead}^{commit}") return 0 ;;
    "diff --name-only ${reusedBase}..${mainSha}") cat main-paths.txt; return ${readable ? 0 : 1} ;;
    "diff --name-only ${reusedBase}..${currentBase}") cat incorporated-paths.txt; return ${readable ? 0 : 1} ;;
    "diff --name-only ${reusedBase}..${reusedHead}") cat prepared-paths.txt ;;
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
      expect(result.status, output).toBe(expected);
      if (diagnostic) {
        expect(output).toContain(diagnostic);
      }
    },
  );

  it("does not stamp declined hosted proof in a conditional caller", () => {
    const dir = tempDirs.make("openclaw-pr-declined-proof-");
    mkdirSync(join(dir, ".local"));
    writeFileSync(join(dir, ".local", "pr-meta.env"), "PR_AUTHOR=fixture\n");
    const result = runGatesBash(
      `
enter_worktree() { PR_MAIN_SHA=fixture-main; }
checkout_prep_branch() { :; }
derive_prepare_gate_change_plan() {
  PREPARE_GATE_BASE_SHA=fixture-main
  PREPARE_GATE_CHANGED_FILES=src/subject.ts
  PREPARE_GATE_DOCS_ONLY=false
  PREPARE_GATE_CHANGELOG_ONLY=false
  PREPARE_GATE_CHANGELOG_UPDATE=false
  PREPARE_GATE_CHANGELOG_REQUIRED=false
}
pr_git() {
  case "$*" in
    "rev-parse HEAD") printf '%s\\n' fixture-head ;;
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
      { cwd: dir, env: { OPENCLAW_TESTBOX: "1" } },
    );
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stdout, result.stderr).toContain("fixture context declined");
    expect(existsSync(join(dir, ".local", "gates.env"))).toBe(false);
  });

  it.each([
    ["CHANGELOG.md", true],
    ["changed.ts", false],
  ])("derives recent parent evidence for a %s commit: %s", (path, expected) => {
    const { repoDir, headSha: parentSha } = makeRetryRepo();
    writeFileSync(join(repoDir, path), "change\n");
    spawnSync("git", ["add", path], { cwd: repoDir });
    spawnSync(
      "git",
      ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "change"],
      { cwd: repoDir },
    );
    const currentHead = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: repoDir,
      encoding: "utf8",
    }).stdout.trim();
    writeFileSync(
      join(repoDir, ".local", "gates-hosted-checks.json"),
      JSON.stringify({ headSha: currentHead }),
    );
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
    if (expected) {
      expect(result.stdout).toContain(`ARG:--recent-sha\nARG:${parentSha}`);
    } else {
      expect(result.stdout).not.toContain("ARG:--recent-sha");
    }
  });

  it("prints the exact recovery command when hosted CI is missing", () => {
    const { repoDir, headSha } = makeRetryRepo();
    const result = runGatesBash(
      [
        `pr_gh() { test "$1" = pr || return 99; printf '{"headRefName":"topic","headRefOid":"${headSha}","isCrossRepository":false,"baseRepository":{"nameWithOwner":"openclaw/openclaw"}}\\n'; }`,
        'rg() { command grep -F -q "$3" "$4"; }',
        `run_quiet_logged() { cat >/dev/null; printf 'Missing successful recent CI workflow for ${headSha}. Observed: none\\n' > "$2"; return 1; }`,
        "PR_MAIN_SHA=$(git rev-parse HEAD)",
        `run_hosted_prepare_gates 100606 ${headSha} false`,
      ].join("\n"),
      { cwd: repoDir },
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("scripts/pr ci-dispatch 100606");
    expect(result.stdout).toContain(
      `gh workflow run ci.yml --ref topic -f target_ref=${headSha} -f release_gate=true -f pull_request_number=100606`,
    );
  });

  it("does not advertise an unusable dispatch command for fork PRs", () => {
    const { repoDir, headSha } = makeRetryRepo();
    const result = runGatesBash(
      [
        `pr_gh() { test "$1" = pr || return 99; printf '{"headRefName":"topic","headRefOid":"${headSha}","isCrossRepository":true,"baseRepository":{"nameWithOwner":"openclaw/openclaw"}}\\n'; }`,
        'rg() { command grep -F -q "$3" "$4"; }',
        `run_quiet_logged() { cat >/dev/null; printf 'Missing successful recent CI workflow for ${headSha}. Observed: none\\n' > "$2"; return 1; }`,
        "PR_MAIN_SHA=$(git rev-parse HEAD)",
        `run_hosted_prepare_gates 100606 ${headSha} false`,
      ].join("\n"),
      { cwd: repoDir },
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("scripts/pr ci-dispatch 100606");
    expect(result.stdout).toContain("unavailable: PR #100606 comes from a fork");
    expect(result.stdout).not.toContain("gh workflow run");
  });

  it("clears remote stamps when fresh docs-only gates do not reuse prior proof", () => {
    const { repoDir } = makeRetryRepo();
    spawnSync("git", ["update-ref", "refs/remotes/origin/main", "HEAD"], { cwd: repoDir });
    mkdirSync(join(repoDir, "docs"), { recursive: true });
    writeFileSync(join(repoDir, "docs", "proof.md"), "fresh docs\n");
    spawnSync("git", ["add", "docs/proof.md"], { cwd: repoDir });
    spawnSync(
      "git",
      ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "docs"],
      { cwd: repoDir },
    );
    writeFileSync(join(repoDir, ".local", "pr-meta.env"), "PR_AUTHOR=steipete\n");
    writeFileSync(
      join(repoDir, ".local", "gates.env"),
      [
        "LAST_VERIFIED_HEAD_SHA=deadbeef",
        "FULL_GATES_HEAD_SHA=deadbeef",
        "REMOTE_GATES_PROVIDER=blacksmith-testbox",
        "REMOTE_GATES_LEASE_ID=tbx_stale",
        "REMOTE_GATES_RUN_URL=https://example.test/runs/1",
        "",
      ].join("\n"),
    );

    const result = runGatesBash(
      [
        "enter_worktree() { PR_MAIN_SHA=$(git rev-parse --verify refs/remotes/origin/main); }",
        "checkout_prep_branch() { :; }",
        "path_is_docsish() { return 0; }",
        "changelog_required_for_changed_files() { return 1; }",
        "prepare_local_gate_workspace() { :; }",
        "run_quiet_logged() { :; }",
        "prepare_gates 4242",
        "cat .local/gates.env",
      ].join("\n"),
      { cwd: repoDir },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("GATES_MODE=docs_only");
    expect(result.stdout).toContain("FULL_GATES_HEAD_SHA=''");
    expect(result.stdout).toContain("REMOTE_GATES_LEASE_ID=''");
    expect(result.stdout).not.toContain("tbx_stale");
  });

  it.each(["hosted", "github"])("clears stale proof when %s gates replace remote proof", (mode) => {
    const { repoDir } = makeRetryRepo();
    spawnSync("git", ["update-ref", "refs/remotes/origin/main", "HEAD"], { cwd: repoDir });
    writeFileSync(join(repoDir, "changed.ts"), "export {};\n");
    spawnSync("git", ["add", "changed.ts"], { cwd: repoDir });
    spawnSync(
      "git",
      ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "change"],
      { cwd: repoDir },
    );
    writeFileSync(join(repoDir, ".local", "pr-meta.env"), "PR_AUTHOR=steipete\n");
    writeFileSync(
      join(repoDir, ".local", "gates.env"),
      [
        "LAST_VERIFIED_HEAD_SHA=deadbeef",
        "FULL_GATES_HEAD_SHA=deadbeef",
        "HOSTED_GATES_TARGET_HEAD_SHA=deadbeef",
        "GATES_PASSED_AT=2026-09-01T00:00:00Z",
        "REMOTE_GATES_PROVIDER=blacksmith-testbox",
        "REMOTE_GATES_LEASE_ID=tbx_stale",
        "REMOTE_GATES_RUN_URL=https://example.test/runs/1",
        "",
      ].join("\n"),
    );

    const result = runGatesBash(
      [
        "enter_worktree() { PR_MAIN_SHA=$(git rev-parse --verify refs/remotes/origin/main); }",
        "checkout_prep_branch() { :; }",
        "path_is_docsish() { return 1; }",
        "changelog_required_for_changed_files() { return 1; }",
        "run_hosted_prepare_gates() { printf 'HOSTED\\n'; }",
        "prepare_gates 4242",
        "cat .local/gates.env",
      ].join("\n"),
      {
        cwd: repoDir,
        env: mode === "hosted" ? { OPENCLAW_TESTBOX: "1" } : { OPENCLAW_PR_GATES_REMOTE: "github" },
      },
    );

    expect(result.status).toBe(0);
    const gates = readFileSync(join(repoDir, ".local", "gates.env"), "utf8");
    if (mode === "github") {
      const currentHead = spawnSync("git", ["rev-parse", "HEAD"], {
        cwd: repoDir,
        encoding: "utf8",
      }).stdout.trim();
      expect(gates).toContain("GATES_MODE=github_pending\n");
      expect(gates).toContain(`HOSTED_GATES_TARGET_HEAD_SHA=${currentHead}\n`);
      expect(gates).not.toMatch(/VERIFIED|PASSED|FULL_GATES|REMOTE_GATES/);
      expect(result.stdout).not.toMatch(/^HOSTED$/m);
    } else {
      expect(gates).toContain("GATES_MODE=hosted_exact_or_recent_parent");
      expect(result.stdout).toMatch(/^HOSTED$/m);
      expect(gates).toContain("REMOTE_GATES_LEASE_ID=''");
    }
    expect(result.stdout).not.toContain("tbx_stale");
  });
});

describe("gates.sh local gate workspace", () => {
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
});
