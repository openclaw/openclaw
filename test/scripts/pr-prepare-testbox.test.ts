import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { runGatesBash } from "./pr-prepare.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const capturedBase = "b".repeat(40);

function writeExecutable(path: string, lines: string[]) {
  writeFileSync(path, ["#!/bin/sh", ...lines].join("\n"));
  chmodSync(path, 0o755);
}

const readLines = (path: string) => readFileSync(path, "utf8").trim().split("\n");

function runRemoteGate(env: NodeJS.ProcessEnv, prepareScript?: string) {
  const workDir = tempDirs.make("openclaw-pr-gates-remote-");
  const stubBin = join(workDir, "bin");
  mkdirSync(stubBin);
  writeExecutable(join(stubBin, "node"), [
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
  ]);

  if (prepareScript) {
    mkdirSync(join(workDir, ".local"));
    writeFileSync(join(workDir, ".local", "pr-meta.env"), "PR_AUTHOR=fixture\n");
    writeExecutable(join(stubBin, "corepack"), [
      'test "$1" = pnpm && test "$CI" = 1 && test "$OPENCLAW_TESTBOX_REMOTE_RUN" = 1 || exit 98',
      'printf "%s\\n" "$2" >> stages',
      'if [ "$2" = check ]; then printf "%s\\n" "$@" > check-args; fi',
      'if [ "$2" = "$FAIL_STAGE" ]; then echo "$2 failed (exit 73)" >&2; exit 73; fi',
    ]);
  }
  const result = runGatesBash(
    prepareScript ??
      `run_remote_testbox_gates 'prepare gates (blacksmith-testbox)' .local/gates-test.log pr-424242-gates false ${capturedBase}`,
    {
      cwd: workDir,
      gatesOnly: true,
      env: { PATH: `${stubBin}:${process.env.PATH ?? ""}`, ...env },
    },
  );

  return { result, workDir, logPath: join(workDir, ".local/gates-test.log") };
}

it.each([
  {
    name: "normalized integer controls with terminal colors",
    env: {
      FORCE_COLOR: "1",
      OPENCLAW_TEST_PROJECTS_PARALLEL: " 02 ",
      OPENCLAW_VITEST_MAX_WORKERS: "001",
    },
    expected: ["OPENCLAW_TEST_PROJECTS_PARALLEL=2", "OPENCLAW_VITEST_MAX_WORKERS=1"],
  },
  {
    name: "only the worker control",
    env: { OPENCLAW_VITEST_MAX_WORKERS: "3" },
    expected: ["OPENCLAW_VITEST_MAX_WORKERS=3"],
  },
])("runs the full worktree Testbox command with $name", ({ env, expected }) => {
  const { result, logPath } = runRemoteGate(env);
  expect(result.status, result.stderr).toBe(0);
  const args = readLines(logPath)
    .filter((line) => line.startsWith("ARG:"))
    .map((line) => line.slice(4));
  expect(args).toEqual([
    ...`scripts/crabbox-wrapper.mjs run --provider blacksmith-testbox --blacksmith-org openclaw
    --blacksmith-workflow .github/workflows/ci-check-high-memory-testbox.yml --blacksmith-job check --blacksmith-ref main
    --idle-timeout 15m --ttl 240m --timing-json --label pr-424242-gates -- env CI=1 OPENCLAW_TESTBOX_REMOTE_RUN=1 PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=false`.split(
      /\s+/,
    ),
    ...expected,
    "/bin/bash",
    "-c",
    `corepack pnpm build && corepack pnpm check --base ${capturedBase} && corepack pnpm test`,
  ]);
});

it("rejects injected worker controls before remote dispatch", () => {
  const name = "OPENCLAW_VITEST_MAX_WORKERS";
  const { result, workDir, logPath } = runRemoteGate({ [name]: "2; touch injected" });
  expect(result.status).toBe(2);
  expect(result.stderr).toContain(`${name} must be a positive integer`);
  expect(existsSync(logPath)).toBe(false);
  expect(existsSync(join(workDir, "injected"))).toBe(false);
});
it("rejects an uncaptured base before remote dispatch", () => {
  const { result, logPath } = runRemoteGate(
    {},
    `run_remote_testbox_gates gates .local/gates-test.log pr-424242-gates false '${capturedBase}; touch injected'`,
  );
  expect(result.status).toBe(2);
  expect(result.stderr).toContain("require the captured check-base commit");
  expect(existsSync(logPath)).toBe(false);
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
        `  PREPARE_GATE_BASE_SHA=${capturedBase}`,
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
        // Conditional callers disable errexit: failures and missing receipts must still prevent stamps.
        "prepare_local_gate_workspace() { echo unexpected-local-bootstrap >&2; return 97; }",
        "pnpm() { echo unexpected-local-pnpm >&2; return 96; }",
        "if prepare_gates 424242; then exit 0; else exit $?; fi",
      ].join("\n"),
    );
    expect(result.status, result.stdout + result.stderr).toBe(failure ? 1 : 0);
    expect(readLines(join(workDir, "stages"))).toEqual(stages);
    if (stages.includes("check")) {
      const args = readLines(join(workDir, "check-args"));
      expect(args).toEqual(["pnpm", "check", "--base", capturedBase]);
    }
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
  const log = join(tempDirs.make("openclaw-pr-gates-stamp-"), "gates-test.log");
  writeFileSync(
    log,
    `provider=blacksmith-testbox id=tbx_first sync=delegated auth=blacksmith
GitHub Actions run: https://github.com/openclaw/openclaw/actions/runs/1234
{"not":"a stamp"}
not json at all
{"provider":"blacksmith-testbox","leaseId":"tbx_first","exitCode":1,"runStatus":"failed"}
{"provider":"blacksmith-testbox","leaseId":"tbx_final","exitCode":0,"runStatus":"passed"}
GitHub Actions run: https://github.com/openclaw/openclaw/actions/runs/9999
GitHub Actions run: https://github.com/example/other/actions/runs/8888
`,
  );

  const result = runGatesBash(
    `require_remote_testbox_gate_stamp '${log}' | jq -r '[.leaseId, .actionsRunUrl] | @tsv'`,
  );
  expect(result.status).toBe(0);
  expect(result.stdout.trim()).toBe(
    "tbx_final\thttps://github.com/openclaw/openclaw/actions/runs/1234",
  );
});
