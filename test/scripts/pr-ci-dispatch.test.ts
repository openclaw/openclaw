import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { formatCrabboxGateCheckSummary } from "../../scripts/pr-lib/crabbox-gate-contract.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const dispatchScript = join(process.cwd(), "scripts/pr-lib/ci-dispatch.mjs");
const headSha = "0123456789abcdef0123456789abcdef01234567";
const baseSha = "1111111111111111111111111111111111111111";
const workflowSha = "2222222222222222222222222222222222222222";
const changedSha = "fedcba9876543210fedcba9876543210fedcba98";
const runUrl = "https://github.com/openclaw/openclaw/actions/runs/99";
const summary = formatCrabboxGateCheckSummary({
  baseSha,
  headSha,
  leaseId: "cbx_def456",
  planDigest: "a".repeat(64),
  runId: "run_abc123",
  targetCount: 7,
  workflowSha,
});
const describePosix = process.platform === "win32" ? describe.skip : describe;

function createFakeGh() {
  const tempDir = tempDirs.make("openclaw-pr-ci-dispatch-");
  const binDir = join(tempDir, "bin");
  const pathGh = join(binDir, "gh");
  const realGh = join(tempDir, "real-gh");
  const calls = join(tempDir, "calls.log");
  const dispatched = join(tempDir, "dispatched");
  const pollingPreload = join(tempDir, "immediate-poll.mjs");
  mkdirSync(binDir);
  mkdirSync(join(tempDir, ".local"));
  const fakeGhScript = `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\t%s\\n' "$(basename "$0")" "$*" >> "$OPENCLAW_TEST_GH_CALLS"
case "$1 $2" in
  "auth token") printf 'forwarded-test-token\\n' ;;
  "api repos/openclaw/openclaw/pulls/12345")
    if [ -e "$OPENCLAW_TEST_GH_DISPATCHED" ] && [ "\${OPENCLAW_TEST_GH_MODE:-}" = "head-change" ]; then
      printf '%s\\n' "$OPENCLAW_TEST_CHANGED_HEAD_SHA"
    else
      printf '%s\\n' "$OPENCLAW_TEST_HEAD_SHA"
    fi
    ;;
  "workflow run")
    test "\${GH_TOKEN-}" = "forwarded-test-token"
    : > "$OPENCLAW_TEST_GH_DISPATCHED"
    if [ "\${OPENCLAW_TEST_DISPATCH_FAIL:-}" = true ]; then exit 1; fi
    ;;
  "api --method")
    case "$4" in
      *"/actions/workflows/"*"/runs")
        if [ -e "$OPENCLAW_TEST_GH_DISPATCHED" ]; then
          printf '%s\\n' "$OPENCLAW_TEST_RUN_LIST"
        else
          printf '{"workflow_runs":[]}\\n'
        fi
        ;;
      *"/actions/runs/99")
        if [ -e "$OPENCLAW_TEST_GH_DISPATCHED.checked" ]; then
          printf '%s\\n' "$OPENCLAW_TEST_FINAL_RUN"
        else
          printf '%s\\n' "$OPENCLAW_TEST_RUN"
        fi
        ;;
      *) echo "unexpected API: $*" >&2; exit 2 ;;
    esac
    ;;
  "api --paginate") : > "$OPENCLAW_TEST_GH_DISPATCHED.checked"; printf '%s\\n' "$OPENCLAW_TEST_CHECK_PAGES" ;;
  *) echo "unexpected gh invocation: $*" >&2; exit 2 ;;
esac
`;
  writeFileSync(pathGh, fakeGhScript);
  writeFileSync(realGh, fakeGhScript);
  chmodSync(pathGh, 0o755);
  chmodSync(realGh, 0o755);
  // The GitHub fixture is synchronous; keep poll scheduling without real backoff waits.
  writeFileSync(
    pollingPreload,
    `const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (callback, _delay, ...args) => realSetTimeout(callback, 0, ...args);
`,
  );
  return { binDir, calls, dispatched, pollingPreload, realGh, tempDir };
}

function runDispatch(
  fakeGh: ReturnType<typeof createFakeGh>,
  options: {
    backend?: "ci" | "crabbox";
    checkOnLaterPage?: boolean;
    mode?: "head-change";
    runTitle?: string;
    wrongCheck?: boolean;
    pending?: boolean;
    resume?: string;
    run?: Record<string, unknown>;
    finalRun?: Record<string, unknown>;
    proofBase?: string;
    dispatchFails?: boolean;
  } = {},
) {
  const crabbox = options.backend === "crabbox";
  const runList = {
    workflow_runs: [
      {
        display_title: crabbox ? (options.runTitle ?? `PR Crabbox gate #12345 / ${headSha}`) : "CI",
        head_branch: crabbox ? "main" : "contributor/fix-hosted-gates",
        head_sha: crabbox ? workflowSha : headSha,
        html_url: runUrl,
        id: 99,
      },
    ],
  };
  const check = {
    app: { id: options.wrongCheck ? 1 : 15368 },
    conclusion: "success",
    details_url: runUrl,
    head_sha: headSha,
    id: 88,
    name: "openclaw/crabbox-gate",
    output: {
      summary: options.proofBase
        ? formatCrabboxGateCheckSummary({
            baseSha: options.proofBase,
            headSha,
            workflowSha,
            runId: "run_abc123",
            leaseId: "cbx_def456",
            planDigest: "a".repeat(64),
            targetCount: 7,
          })
        : summary,
    },
    status: "completed",
  };
  const run = {
    conclusion: "success",
    display_title: `PR Crabbox gate #12345 / ${headSha}`,
    event: "workflow_dispatch",
    head_branch: "main",
    head_sha: workflowSha,
    html_url: runUrl,
    id: 99,
    run_attempt: 1,
    path: ".github/workflows/pr-crabbox-gate-publisher.yml",
    status: "completed",
    ...options.run,
  };
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    OPENCLAW_GH_BIN: fakeGh.realGh,
    OPENCLAW_TEST_CHANGED_HEAD_SHA: changedSha,
    OPENCLAW_TEST_CHECK_PAGES: JSON.stringify([
      {
        check_runs: options.checkOnLaterPage
          ? [{ ...check, id: 77, name: "unrelated/check" }]
          : [check],
      },
      ...(options.checkOnLaterPage ? [{ check_runs: [check] }] : []),
    ]),
    OPENCLAW_TEST_GH_CALLS: fakeGh.calls,
    OPENCLAW_TEST_GH_DISPATCHED: fakeGh.dispatched,
    OPENCLAW_TEST_GH_MODE: options.mode ?? "",
    OPENCLAW_TEST_HEAD_SHA: headSha,
    OPENCLAW_TEST_RUN: JSON.stringify(run),
    OPENCLAW_TEST_FINAL_RUN: JSON.stringify({ ...run, ...options.finalRun }),
    OPENCLAW_TEST_DISPATCH_FAIL: String(options.dispatchFails ?? false),
    OPENCLAW_TEST_RUN_LIST: JSON.stringify(runList),
    PATH: `${fakeGh.binDir}:${process.env.PATH ?? ""}`,
  };
  for (const name of [
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "GH_ENTERPRISE_TOKEN",
    "GITHUB_ENTERPRISE_TOKEN",
  ]) {
    delete env[name];
  }
  return spawnSync(
    process.execPath,
    [
      "--import",
      fakeGh.pollingPreload,
      dispatchScript,
      "12345",
      "contributor/fix-hosted-gates",
      headSha,
      baseSha,
      "false",
      ...(crabbox ? ["--backend", "crabbox"] : []),
      ...(options.pending ? ["--pending-gates"] : []),
      ...(options.resume ? ["--resume-crabbox-run", options.resume] : []),
    ],
    { cwd: fakeGh.tempDir, encoding: "utf8", env },
  );
}

function writePending(fakeGh: ReturnType<typeof createFakeGh>, extra = "") {
  writeFileSync(
    join(fakeGh.tempDir, ".local/gates.env"),
    `PR_NUMBER=12345\nGATES_MODE=remote_crabbox_aws_pending\nLAST_VERIFIED_HEAD_SHA=${headSha}\nFULL_GATES_HEAD_SHA=''\n${extra}`,
  );
}

function pendingText(fakeGh: ReturnType<typeof createFakeGh>) {
  return readFileSync(join(fakeGh.tempDir, ".local/gates.env"), "utf8");
}

function writeCompleted(fakeGh: ReturnType<typeof createFakeGh>, provenance = "") {
  // Literal receipt shape from the pre-resume gate writer, including its empty
  // hosted stamp. New provenance is optional only as one complete group.
  writeFileSync(
    join(fakeGh.tempDir, ".local/gates.env"),
    [
      "PR_NUMBER=12345",
      "DOCS_ONLY=false",
      "CHANGELOG_REQUIRED=false",
      "GATES_MODE=remote_crabbox_aws",
      "HOSTED_GATES_TARGET_HEAD_SHA=''",
      `LAST_VERIFIED_HEAD_SHA=${headSha}`,
      `FULL_GATES_HEAD_SHA=${headSha}`,
      "REMOTE_GATES_PROVIDER=aws",
      "REMOTE_GATES_RUN_ID=run_abc123",
      "REMOTE_GATES_LEASE_ID=cbx_def456",
      `REMOTE_GATES_RUN_URL=${runUrl}`,
      "GATES_PASSED_AT=2026-09-26T00:00:00Z",
      provenance,
      "",
    ].join("\n"),
  );
}

describePosix("scripts/pr ci-dispatch", () => {
  it("dispatches ordinary CI for the exact remote head", () => {
    const fakeGh = createFakeGh();
    const result = runDispatch(fakeGh);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain(`observed_run_url=${runUrl}`);
    const calls = readFileSync(fakeGh.calls, "utf8");
    expect(calls).toContain("gh\tapi repos/openclaw/openclaw/pulls/12345 --jq .head.sha");
    expect(calls).not.toContain("pr view");
    expect(calls).toContain(
      `real-gh\tworkflow run ci.yml --ref contributor/fix-hosted-gates -f target_ref=${headSha} -f release_gate=true -f pull_request_number=12345`,
    );
  });

  it("finds the publisher-owned Crabbox proof on a later check-run page", () => {
    const fakeGh = createFakeGh();
    const result = runDispatch(fakeGh, { backend: "crabbox", checkOnLaterPage: true });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain(
      JSON.stringify({
        actionsRunId: 99,
        actionsRunAttempt: 1,
        actionsRunUrl: runUrl,
        backend: "crabbox",
        checkId: 88,
        provider: "aws",
        target: "linux",
        baseSha,
        headSha,
        leaseId: "cbx_def456",
        planDigest: "a".repeat(64),
        runId: "run_abc123",
        targetCount: 7,
        workflowSha,
      }),
    );
    const calls = readFileSync(fakeGh.calls, "utf8");
    expect(calls).toContain(
      `real-gh\tworkflow run pr-crabbox-gate-publisher.yml --ref main -f pr_number=12345 -f head_sha=${headSha} -f base_sha=${baseSha}`,
    );
    expect(calls).toContain(`gh\tapi --method GET repos/openclaw/openclaw/actions/runs/99`);
    expect(calls).toContain(
      `gh\tapi --paginate --slurp repos/openclaw/openclaw/commits/${headSha}/check-runs?filter=latest&per_page=100`,
    );
  });

  it.each(["PR Crabbox gate", "PR Crabbox gate #12345"])(
    "does not accept a generic or truncated Crabbox run title: %s",
    (runTitle) => {
      const result = runDispatch(createFakeGh(), { backend: "crabbox", runTitle });
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.stdout).toContain("run_url=pending");
      expect(result.stdout).not.toContain('"backend":"crabbox"');
    },
    40_000,
  );

  it("rejects caller-supplied proof handles", () => {
    const fakeGh = createFakeGh();
    const result = spawnSync(
      process.execPath,
      [
        dispatchScript,
        "12345",
        "contributor/fix-hosted-gates",
        headSha,
        baseSha,
        "false",
        "--backend",
        "crabbox",
        "--run-id",
        "run_attacker",
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          OPENCLAW_GH_BIN: fakeGh.realGh,
          OPENCLAW_TEST_GH_CALLS: fakeGh.calls,
          PATH: `${fakeGh.binDir}:${process.env.PATH ?? ""}`,
        },
      },
    );
    expect(result.status).not.toBe(0);
    expect(existsSync(fakeGh.dispatched)).toBe(false);
  });

  it("fails closed for a check from the wrong app", () => {
    const result = runDispatch(createFakeGh(), { backend: "crabbox", wrongCheck: true });
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(
      /without the exact-head GitHub Actions check/u,
    );
  });

  it("rechecks the remote head after dispatch", () => {
    const result = runDispatch(createFakeGh(), { mode: "head-change" });
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/head changed/u);
  });

  it("rejects fork PRs before invoking GitHub", () => {
    const fakeGh = createFakeGh();
    const result = spawnSync(
      process.execPath,
      [dispatchScript, "12345", "fix", headSha, baseSha, "true"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          OPENCLAW_GH_BIN: fakeGh.realGh,
          OPENCLAW_TEST_GH_CALLS: fakeGh.calls,
          PATH: `${fakeGh.binDir}:${process.env.PATH ?? ""}`,
        },
      },
    );
    expect(result.status).not.toBe(0);
    expect(existsSync(fakeGh.calls)).toBe(false);
  });
  it("resumes a legacy pending run without dispatch or discovery and retains only pending provenance", () => {
    const fakeGh = createFakeGh();
    writePending(fakeGh);
    const result = runDispatch(fakeGh, { backend: "crabbox", pending: true, resume: "99" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('"actionsRunId":99');
    const calls = readFileSync(fakeGh.calls, "utf8");
    expect(calls).not.toContain("workflow run");
    expect(calls).not.toContain("actions/workflows/");
    expect(pendingText(fakeGh)).toContain("PENDING_CRABBOX_ACTIONS_RUN_ID=99");
    expect(pendingText(fakeGh)).toContain("PENDING_CRABBOX_ATTEMPT=1");
    expect(pendingText(fakeGh)).toContain("FULL_GATES_HEAD_SHA=''");
    expect(pendingText(fakeGh)).toContain("GATES_MODE=remote_crabbox_aws_pending");
  });

  it("retains dispatch uncertainty and refuses an automatic second allocation", () => {
    const fakeGh = createFakeGh();
    writePending(fakeGh);
    const first = runDispatch(fakeGh, { backend: "crabbox", pending: true, dispatchFails: true });
    expect(first.status).not.toBe(0);
    expect(pendingText(fakeGh)).toContain("PENDING_CRABBOX_STATE=dispatching");
    const second = runDispatch(fakeGh, { backend: "crabbox", pending: true });
    expect(second.status).not.toBe(0);
    expect(second.stderr).toContain("No new proof dispatched");
    expect(readFileSync(fakeGh.calls, "utf8").match(/workflow run/gu)).toHaveLength(1);
    const resumed = runDispatch(fakeGh, { backend: "crabbox", pending: true, resume: "99" });
    expect(resumed.status, resumed.stderr).toBe(0);
    expect(readFileSync(fakeGh.calls, "utf8").match(/workflow run/gu)).toHaveLength(1);
  });

  it.each([
    ["writeFileSync", false],
    ["fsyncSync", false],
    ["closeSync", false],
    ["renameSync", false],
    ["fsyncSync", true],
  ] as const)("does not dispatch after %s fails, cleanup failure=%s", (operation, cleanupFails) => {
    const fakeGh = createFakeGh();
    writePending(fakeGh);
    const before = pendingText(fakeGh);
    writeFileSync(
      fakeGh.pollingPreload,
      readFileSync(fakeGh.pollingPreload, "utf8") +
        `import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const open = fs.openSync;
let owned;
fs.openSync = (path, ...args) => {
  const fd = open(path, ...args);
  if (String(path).endsWith(".tmp")) owned = fd;
  return fd;
};
const operation = ${JSON.stringify(operation)};
const original = fs[operation];
fs[operation] = (...args) => {
  if (operation === "renameSync" ? String(args[0]).endsWith(".tmp") : args[0] === owned) {
    if (operation === "closeSync") original(...args);
    throw new Error("injected-" + operation);
  }
  return original(...args);
};
if (${cleanupFails}) fs.unlinkSync = () => { throw new Error("injected-cleanup"); };
syncBuiltinESMExports();
`,
    );
    const result = runDispatch(fakeGh, { backend: "crabbox", pending: true });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`injected-${operation}`);
    if (cleanupFails) {
      expect(result.stderr).toContain("injected-cleanup");
    }
    expect(pendingText(fakeGh)).toBe(before);
    expect(existsSync(fakeGh.dispatched)).toBe(false);
    expect(
      readdirSync(join(fakeGh.tempDir, ".local")).filter((name) => name.endsWith(".tmp")),
    ).toHaveLength(cleanupFails ? 1 : 0);
  });

  it("records selection before terminal observation and resumes the same attempt", () => {
    const fakeGh = createFakeGh();
    writePending(fakeGh);
    const first = runDispatch(fakeGh, {
      backend: "crabbox",
      pending: true,
      run: { conclusion: "failure" },
    });
    expect(first.status).not.toBe(0);
    expect(pendingText(fakeGh)).toContain("PENDING_CRABBOX_STATE=selected");
    const changedAttempt = runDispatch(fakeGh, {
      backend: "crabbox",
      pending: true,
      resume: "99",
      run: { run_attempt: 2 },
    });
    expect(changedAttempt.status).not.toBe(0);
    const resumed = runDispatch(fakeGh, { backend: "crabbox", pending: true, resume: "99" });
    expect(resumed.status, resumed.stderr).toBe(0);
    expect(readFileSync(fakeGh.calls, "utf8").match(/workflow run/gu)).toHaveLength(1);
  });

  it.each([
    { id: 100 },
    { html_url: "https://example.invalid/run/99" },
    { display_title: "PR Crabbox gate #999 / " + headSha },
    { event: "pull_request" },
    { head_branch: "topic" },
    { path: ".github/workflows/ci.yml" },
    { run_attempt: 0 },
    { head_sha: "bad" },
    { conclusion: "failure" },
  ])("rejects a mismatched or failed resume run %j without dispatch", (run) => {
    const fakeGh = createFakeGh();
    writePending(fakeGh);
    const result = runDispatch(fakeGh, { backend: "crabbox", pending: true, resume: "99", run });
    expect(result.status).not.toBe(0);
    expect(existsSync(fakeGh.dispatched)).toBe(false);
    expect(pendingText(fakeGh)).toContain("FULL_GATES_HEAD_SHA=''");
  });

  it("rejects a rerun racing the exact check lookup", () => {
    const fakeGh = createFakeGh();
    writePending(fakeGh);
    const result = runDispatch(fakeGh, {
      backend: "crabbox",
      pending: true,
      resume: "99",
      finalRun: { run_attempt: 2 },
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("run identity changed");
    expect(existsSync(fakeGh.dispatched)).toBe(false);
  });

  it("does not adopt the check's base instead of retained preparation provenance", () => {
    const fakeGh = createFakeGh();
    writePending(fakeGh);
    const result = runDispatch(fakeGh, {
      backend: "crabbox",
      pending: true,
      resume: "99",
      proofBase: changedSha,
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("does not bind the dispatched PR base");
    expect(existsSync(fakeGh.dispatched)).toBe(false);
  });

  it.each(["0", "01", "-1", "9007199254740992", "run_abc"])(
    "rejects invalid numeric resume selector %s before GitHub",
    (resume) => {
      const fakeGh = createFakeGh();
      writePending(fakeGh);
      const result = runDispatch(fakeGh, { backend: "crabbox", pending: true, resume });
      expect(result.status).not.toBe(0);
      expect(existsSync(fakeGh.calls)).toBe(false);
    },
  );

  it.each([
    "PENDING_CRABBOX_STATE=selected\n",
    "PENDING_CRABBOX_STATE=dispatching\nPENDING_CRABBOX_STATE=dispatching\n",
    "PENDING_CRABBOX_STATE=$(false)\n",
    "PENDING_CRABBOX_UNKNOWN=1\n",
  ])("rejects malformed retained provenance before GitHub: %s", (extra) => {
    const fakeGh = createFakeGh();
    writePending(fakeGh, extra);
    const before = pendingText(fakeGh);
    const result = runDispatch(fakeGh, { backend: "crabbox", pending: true, resume: "99" });
    expect(result.status).not.toBe(0);
    expect(existsSync(fakeGh.calls)).toBe(false);
    expect(pendingText(fakeGh)).toBe(before);
  });
  it("reverifies completed gates after interrupted preparation without dispatch", () => {
    const fakeGh = createFakeGh();
    writeCompleted(
      fakeGh,
      [
        `REMOTE_GATES_BASE_SHA=${baseSha}`,
        `REMOTE_GATES_WORKFLOW_SHA=${workflowSha}`,
        "REMOTE_GATES_ACTIONS_RUN_ATTEMPT=1",
      ].join("\n"),
    );
    const before = pendingText(fakeGh);
    const result = runDispatch(fakeGh, { backend: "crabbox", pending: true, resume: "99" });
    expect(result.status, result.stderr).toBe(0);
    expect(pendingText(fakeGh)).toBe(before);
    expect(existsSync(fakeGh.dispatched)).toBe(false);
    const mismatch = runDispatch(fakeGh, {
      backend: "crabbox",
      pending: true,
      resume: "99",
      run: { run_attempt: 2 },
    });
    expect(mismatch.status).not.toBe(0);
    expect(pendingText(fakeGh)).toBe(before);
    expect(existsSync(fakeGh.dispatched)).toBe(false);
    const wrongRun = runDispatch(fakeGh, { backend: "crabbox", pending: true, resume: "100" });
    expect(wrongRun.status).not.toBe(0);
    expect(wrongRun.stderr).toContain("does not match the selected pending publisher");
  });

  it("reverifies an old completed stamp using its retained broker pair and observed attempt", () => {
    const fakeGh = createFakeGh();
    writeCompleted(fakeGh);
    const before = pendingText(fakeGh);
    const result = runDispatch(fakeGh, {
      backend: "crabbox",
      pending: true,
      resume: "99",
      run: { run_attempt: 3 },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('"actionsRunAttempt":3');
    expect(pendingText(fakeGh)).toBe(before);
    const calls = readFileSync(fakeGh.calls, "utf8");
    expect(calls).not.toContain("workflow run");
    expect(calls).not.toContain("actions/workflows/");
  });

  it.each(["run", "lease", "base", "selector", "partial", "failed", "attempt-race"])(
    "refuses old completed stamp %s mismatch without changing it or dispatching",
    (mode) => {
      const fakeGh = createFakeGh();
      writeCompleted(fakeGh, mode === "partial" ? `REMOTE_GATES_BASE_SHA=${baseSha}` : "");
      const path = join(fakeGh.tempDir, ".local/gates.env");
      if (mode === "run" || mode === "lease") {
        writeFileSync(
          path,
          pendingText(fakeGh).replace(
            mode === "run" ? "run_abc123" : "cbx_def456",
            mode === "run" ? "run_other" : "cbx_other",
          ),
        );
      }
      const before = pendingText(fakeGh);
      const result = runDispatch(fakeGh, {
        backend: "crabbox",
        pending: true,
        resume: mode === "selector" ? "100" : "99",
        proofBase: mode === "base" ? changedSha : undefined,
        run: mode === "failed" ? { conclusion: "failure" } : undefined,
        finalRun: mode === "attempt-race" ? { run_attempt: 2 } : undefined,
      });
      expect(result.status).not.toBe(0);
      expect(result.stdout).not.toContain('"backend":"crabbox"');
      expect(pendingText(fakeGh)).toBe(before);
      expect(existsSync(fakeGh.dispatched)).toBe(false);
      if (mode === "run" || mode === "lease") {
        expect(result.stderr).toContain("retained completed broker run and lease");
      }
      if (mode === "base") {
        expect(result.stderr).toContain("does not bind the dispatched PR base");
      }
    },
  );
});
