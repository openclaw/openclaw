// Covers the native prepare-gates Testbox capsule boundary.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const repoRoot = process.cwd();
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function runGatesBash(script: string, options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  const env = { ...process.env };
  for (const name of [
    "OPENCLAW_PR_GATES_REMOTE",
    "OPENCLAW_TESTBOX",
    "OPENCLAW_TEST_PROJECTS_PARALLEL",
    "OPENCLAW_VITEST_MAX_WORKERS",
  ]) {
    delete env[name];
  }
  return spawnSync(
    "/bin/bash",
    [
      "-c",
      [
        "set -euo pipefail",
        `script_parent_dir='${repoRoot}/scripts'`,
        `source '${repoRoot}/scripts/pr-lib/common.sh'`,
        `source '${repoRoot}/scripts/pr-lib/gates.sh'`,
        script,
      ].join("\n"),
    ],
    { cwd: options.cwd ?? repoRoot, encoding: "utf8", env: { ...env, ...options.env } },
  );
}

describe("remote testbox gate delegation", () => {
  function runRemoteGate(env: NodeJS.ProcessEnv, prepareScript?: string) {
    const dir = tempDirs.make("openclaw-pr-gates-remote-");
    const stubBin = join(dir, "bin");
    mkdirSync(stubBin);
    writeFileSync(
      join(stubBin, "node"),
      [
        "#!/bin/sh",
        `if [ "$1" != scripts/crabbox-wrapper.mjs ]; then exec '${process.execPath}' "$@"; fi`,
        "printf 'ARG:%s\\n' \"$@\"",
        ...(prepareScript
          ? [
              'while [ "$1" != -- ]; do shift; done',
              "shift",
              '"$@" || exit "$?"',
              'test "${OMIT_STAMP:-}" != 1 || exit 0',
            ]
          : []),
        `printf '{"provider":"blacksmith-testbox","leaseId":"tbx_stub","exitCode":0,"runStatus":"passed"}\\n' >&2`,
      ].join("\n"),
    );
    chmodSync(join(stubBin, "node"), 0o755);

    const workDir = join(dir, "work");
    mkdirSync(workDir);
    if (prepareScript) {
      mkdirSync(join(workDir, ".local"));
      writeFileSync(join(workDir, ".local", "pr-meta.env"), "PR_AUTHOR=fixture\n");
      writeFileSync(
        join(stubBin, "corepack"),
        [
          "#!/bin/sh",
          'test "$1" = pnpm && test "$CI" = 1 && test "$OPENCLAW_TESTBOX_REMOTE_RUN" = 1 || exit 98',
          'printf "%s\\n" "$2" >> stages',
          'if [ "$2" = "$FAIL_STAGE" ]; then echo "$2 failed (exit 73)" >&2; exit 73; fi',
        ].join("\n"),
      );
      chmodSync(join(stubBin, "corepack"), 0o755);
    }
    const result = runGatesBash(
      prepareScript ??
        "run_remote_testbox_gates 'prepare gates (blacksmith-testbox)' .local/gates-test.log pr-424242-gates",
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
      "/bin/bash",
      "-c",
      "corepack pnpm build && corepack pnpm check && corepack pnpm test",
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

  it.each([
    { failure: "", stages: ["build", "check", "test"], docsOnly: false },
    { failure: "build", stages: ["build"], docsOnly: false },
    { failure: "check", stages: ["build", "check"], docsOnly: false },
    { failure: "test", stages: ["build", "check", "test"], docsOnly: false },
    { failure: "", stages: ["build", "check"], docsOnly: true },
    { failure: "stamp", stages: ["build", "check", "test"], docsOnly: false },
    { failure: "head", stages: ["build", "check", "test"], docsOnly: false },
    { failure: "review", stages: ["build", "check", "test"], docsOnly: false },
  ])(
    "isolates ordered prepare gates (failure=$failure, docsOnly=$docsOnly)",
    ({ failure, stages, docsOnly }) => {
      const head = "a".repeat(40);
      const { result, workDir, logPath } = runRemoteGate(
        {
          OPENCLAW_PR_GATES_REMOTE: "testbox",
          FAIL_STAGE: failure,
          OMIT_STAMP: failure === "stamp" ? "1" : "",
        },
        [
          "enter_worktree() { PR_MAIN_SHA=fixture-main; }",
          "refresh_prep_branch_for_reviewed_head() { :; }",
          "checkout_prep_branch() { :; }",
          "reviews=0",
          "require_prepared_review() {",
          "  reviews=$((reviews + 1))",
          `  [ '${failure}' != review ] || [ "$reviews" -lt 2 ]`,
          "}",
          "derive_prepare_gate_change_plan() {",
          `  PREPARE_GATE_CHANGED_FILES=${docsOnly ? "docs/guide.md" : "src/subject.ts"}`,
          `  PREPARE_GATE_DOCS_ONLY=${docsOnly}`,
          "  PREPARE_GATE_CHANGELOG_ONLY=false",
          "  PREPARE_GATE_CHANGELOG_UPDATE=false",
          "  PREPARE_GATE_CHANGELOG_REQUIRED=false",
          "}",
          "pr_git() {",
          '  test "$*" = "rev-parse HEAD" || return 99',
          `  if [ '${failure}' = head ] && [ -f stages ]; then printf 'changed-head\\n'; else printf '%s\\n' '${head}'; fi`,
          "}",
          // A conditional caller disables errexit inside functions: the gate owner
          // must still refuse a failed command or missing receipt before stamping.
          "prepare_local_gate_workspace() { echo unexpected-local-bootstrap >&2; return 97; }",
          "pnpm() { echo unexpected-local-pnpm >&2; return 96; }",
          "if prepare_gates 424242; then exit 0; else exit $?; fi",
        ].join("\n"),
      );
      expect(result.status, result.stdout + result.stderr).toBe(failure ? 1 : 0);
      expect(readFileSync(join(workDir, "stages"), "utf8").trim().split("\n")).toEqual(stages);
      expect(result.stdout + result.stderr).not.toContain("unexpected-local");
      const stampPath = join(workDir, ".local", "gates.env");
      expect(existsSync(stampPath)).toBe(!failure);
      if (failure) {
        if (["build", "check", "test"].includes(failure)) {
          expect(readFileSync(logPath, "utf8")).toContain(`${failure} failed (exit 73)`);
        }
        return;
      }
      const stamp = readFileSync(stampPath, "utf8");
      expect(stamp).toContain(`LAST_VERIFIED_HEAD_SHA=${head}`);
      expect(stamp).toContain(`GATES_MODE=${docsOnly ? "docs_only" : "remote_testbox"}`);
      expect(stamp).toContain(`FULL_GATES_HEAD_SHA=${docsOnly ? "''" : head}`);
      expect(stamp).toContain(`REMOTE_GATES_LEASE_ID=${docsOnly ? "''" : "tbx_stub"}`);
    },
  );

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
