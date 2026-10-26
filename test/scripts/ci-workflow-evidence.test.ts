import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import * as qaEvidence from "../../extensions/qa-lab/test-api.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import {
  MATURITY_SCORECARD_WORKFLOW,
  TSX_IMPORT,
  expectIncludes,
  quoteShell,
  readMaturityScorecardWorkflow,
  readWorkflow,
  readWorkflowOutputs,
  runGit,
  runWorkflowShellScript,
  type WorkflowStep,
} from "./ci-workflow.test-support.js";

const MATURITY_SCORECARD_WORKFLOW_REF =
  "openclaw/openclaw/.github/workflows/maturity-scorecard.yml@refs/heads/main";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
// Reuse reader transforms while evidence and API fixtures remain local to each case.
const evidenceCompilerTempDir = useAutoCleanupTempDirTracker(afterAll).make(
  "openclaw-workflow-evidence-compiler-",
);
const TYPESCRIPT_NODE_MODULES = path.dirname(
  path.dirname(fileURLToPath(import.meta.resolve("typescript/package.json"))),
);
const MATURITY_GENERATED_PR_PATHS = [
  "qa/maturity-scores.yaml",
  "docs/maturity/scorecard.md",
  "docs/maturity/taxonomy.md",
];

function writeFixture(file: string, contents: string | Buffer) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, contents);
}
const writeJson = (file: string, value: unknown, suffix = "") =>
  writeFixture(file, JSON.stringify(value) + suffix);

function readJson(file: string) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function step<T extends { steps: WorkflowStep[] }>(job: T, name: string): T["steps"][number];
function step(job: { steps: WorkflowStep[] }, name: string) {
  return expectDefined(
    job.steps.find((entry) => entry.name === name),
    name,
  );
}

function expectSuccess(result: { status: number | null; stdout: string; stderr: string }) {
  expect(result.status, result.stdout + result.stderr).toBe(0);
}

function expectFailure(
  result: { status: number | null; stdout: string; stderr: string },
  message: string,
) {
  expect(result.status).toBe(1);
  expect(result.stdout + result.stderr).toContain(message);
}

function runBash(script: string, env: NodeJS.ProcessEnv, cwd?: string) {
  return spawnSync("bash", ["-c", script], {
    cwd,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", ...env },
  });
}

function legacyEvidence(
  scenarioId: string,
  statuses: qaEvidence.QaEvidenceStatus[],
  evidenceMode = "full",
) {
  return {
    kind: "openclaw.qa.evidence-summary",
    schemaVersion: 2,
    generatedAt: "2026-08-05T00:00:00.000Z",
    evidenceMode,
    entries: statuses.map((status) => ({
      test: { kind: "scenario", id: scenarioId, title: scenarioId },
      coverage: [],
      result: { status },
    })),
  };
}

function workflowOccurrenceEvidence(
  scenarioId: string,
  attempts: qaEvidence.QaEvidenceStatus[],
  selected: number,
) {
  const identity = {
    source: { ref: null, integrity: null },
    runtime: { id: null, version: null },
    package: null,
    protocol: null,
    accountRef: null,
    proofClass: null,
  };
  const occurrences: qaEvidence.QaEvidenceOccurrence[] = [];
  const entries: qaEvidence.QaEvidenceSummaryV3Entry[] = [];
  const anchorId = "instance";
  const parentCell = {
    scenarioId,
    executionKind: "flow" as const,
    channel: null,
  };
  const common = { parentCell, assertions: null, launch: identity };
  occurrences.push({
    ...common,
    id: anchorId,
    scenario: {
      kind: "instance",
      resultOccurrenceId: `${anchorId}-attempt-${selected}`,
    },
    retryOf: null,
    terminalStatus: null,
    receipts: [],
  });
  for (const [attempt, status] of attempts.entries()) {
    const id = `${anchorId}-attempt-${attempt}`;
    occurrences.push({
      ...common,
      id,
      scenario: { kind: "observation", instanceOccurrenceId: anchorId },
      retryOf: attempt === 0 ? null : `${anchorId}-attempt-${attempt - 1}`,
      terminalStatus: status,
      receipts: [],
    });
    entries.push({
      test: { kind: "scenario", id: scenarioId, title: scenarioId },
      coverage: [],
      result: { status },
      binding: { occurrenceId: id, assertionId: null, receiptId: null },
      effective: attempt === selected,
    });
  }
  return qaEvidence.buildQaOccurrenceEvidenceSummary({
    generatedAt: "2026-08-05T00:00:00.000Z",
    evidenceMode: "full",
    occurrences,
    entries,
  });
}

function writeWorkflowEvidenceApi(root: string, accessors = true) {
  writeJson(path.join(root, "tsconfig.json"), { extends: path.resolve("tsconfig.json") });
  const source = pathToFileURL(path.resolve("extensions/qa-lab/src/evidence-summary.ts")).href;
  // Historical checkouts can validate v2 without exporting the v3 readers.
  writeFixture(
    path.join(root, "extensions/qa-lab/api.ts"),
    `export { validateQaEvidenceSummaryJson${accessors ? ", getEffectiveQaEvidenceEntries, projectQaEvidenceScenarioOutcomes" : ""} } from ${JSON.stringify(source)};\n`,
  );
}

function mantisScenarioId(kind: "status-reactions" | "thread-attachment") {
  return kind === "status-reactions"
    ? "discord-status-reactions-tool-only"
    : "discord-thread-reply-filepath-attachment";
}

function runMantisEvidenceReader(
  kind: "status-reactions" | "thread-attachment",
  evidence: unknown,
  accessors = true,
) {
  const root = tempDirs.make("openclaw-mantis-reader-");
  const laneRoot = path.join(root, "lanes/baseline");
  const outputDir = path.join(root, "evidence/baseline");
  const moduleRoot = kind === "status-reactions" ? root : laneRoot;
  writeWorkflowEvidenceApi(moduleRoot, accessors);
  // A reader must not silently use a newer neighboring checkout's API.
  const otherRoot = kind === "status-reactions" ? laneRoot : root;
  writeWorkflowEvidenceApi(otherRoot);
  writeFixture(
    path.join(otherRoot, "extensions/qa-lab/api.ts"),
    'throw new Error("wrong evidence API owner");\n',
  );
  if (evidence !== undefined) {
    writeFixture(
      path.join(outputDir, "qa-evidence.json"),
      typeof evidence === "string" ? evidence : JSON.stringify(evidence),
    );
  }
  const scenarioId = mantisScenarioId(kind);
  writeJson(path.join(outputDir, "discord-qa-summary.json"), {
    scenarios: [{ id: scenarioId, status: "pass" }],
  });
  const workflow = readWorkflow(`.github/workflows/mantis-discord-${kind}.yml`);
  const job = kind === "status-reactions" ? "run_status_reactions" : "run_thread_attachment";
  const script = expectDefined(
    workflow.jobs[job].steps.find((entry: WorkflowStep) => entry.id === "run_mantis")?.run,
    "Mantis run script",
  );
  const functionName =
    kind === "status-reactions"
      ? "read_discord_status_reaction_status"
      : "read_discord_thread_attachment_status";
  const start = script.indexOf(`${functionName}()`);
  const end = script.indexOf("\nbaseline_status=", start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return runWorkflowShellScript(
    `set -euo pipefail\nroot=${quoteShell(path.join(root, "evidence"))}\nworktree_root=lanes\n${script.slice(start, end)}\n${functionName} baseline\n`,
    {
      cwd: root,
      env: { ...process.env, FORCE_COLOR: "1", GITHUB_WORKSPACE: root },
      tempDir: evidenceCompilerTempDir,
    },
  );
}

function runMaturityInvocationScenario(options: {
  callerEventName: string;
  callerWorkflowRef: string;
  jobWorkflowRef?: string;
  publishPullRequest: boolean;
}) {
  const workflow = readMaturityScorecardWorkflow();
  const authorizeStep = step(workflow.jobs.validate_selected_ref, "Authorize workflow invocation");
  const authorizeRun = runBash(authorizeStep.run, {
    CALLER_EVENT_NAME: options.callerEventName,
    CALLER_WORKFLOW_REF: options.callerWorkflowRef,
    JOB_WORKFLOW_FILE_PATH: MATURITY_SCORECARD_WORKFLOW,
    JOB_WORKFLOW_REF: options.jobWorkflowRef ?? MATURITY_SCORECARD_WORKFLOW_REF,
    JOB_WORKFLOW_REPOSITORY: "openclaw/openclaw",
    PUBLISH_PULL_REQUEST: String(options.publishPullRequest),
  });
  return {
    output: `${authorizeRun.stdout}${authorizeRun.stderr}`,
    status: authorizeRun.status,
  };
}

function runMaturityArtifactCopyScenario(
  options: { destinationSymlink?: boolean; extraFile?: boolean; sourceSymlink?: boolean } = {},
) {
  const workflow = readMaturityScorecardWorkflow();
  const copyStep = step(workflow.jobs.publish_generated_pr, "Validate and copy generated PR files");
  const root = tempDirs.make("openclaw-maturity-copy-");
  const staging = path.join(root, "staging");
  for (const generatedPath of MATURITY_GENERATED_PR_PATHS) {
    const staged = path.join(staging, generatedPath);
    const selected = path.join(root, "selected", generatedPath);
    writeFixture(staged, `new ${generatedPath}\n`);
    writeFixture(selected, `old ${generatedPath}\n`);
  }
  if (options.extraFile) {
    writeFileSync(path.join(staging, "unexpected.txt"), "unexpected\n", "utf8");
  }
  const firstGeneratedPath = expectDefined(
    MATURITY_GENERATED_PR_PATHS[0],
    "first maturity generated PR path",
  );
  if (options.sourceSymlink) {
    const staged = path.join(staging, firstGeneratedPath);
    rmSync(staged);
    symlinkSync("missing-score-source", staged);
  }
  const escaped = path.join(root, "escaped.txt");
  if (options.destinationSymlink) {
    const selected = path.join(root, "selected", firstGeneratedPath);
    writeFileSync(escaped, "outside\n", "utf8");
    rmSync(selected);
    symlinkSync(escaped, selected);
  }
  const run = runBash(copyStep.run, { STAGING_DIR: staging }, root);
  return {
    copied: MATURITY_GENERATED_PR_PATHS.map((generatedPath) =>
      readFileSync(path.join(root, "selected", generatedPath), "utf8"),
    ),
    escaped: existsSync(escaped) ? readFileSync(escaped, "utf8") : "",
    output: `${run.stdout}${run.stderr}`,
    status: run.status,
  };
}

function readQaProfileEvidenceWorkflow() {
  return readWorkflow(".github/workflows/qa-profile-evidence.yml");
}

type QaProfileTimeoutFixtureMode = "natural-124" | "self-kill" | "term" | "kill";

function runQaProfileTimeoutFixture(mode: QaProfileTimeoutFixtureMode) {
  const root = tempDirs.make("openclaw-qa-profile-timeout-");
  const selectedRoot = path.join(root, "selected");
  mkdirSync(selectedRoot);
  const binDir = path.join(root, "bin");
  const fakePnpm = path.join(binDir, "pnpm");
  writeFixture(
    fakePnpm,
    `#!/usr/bin/env bash
set -u
echo "child-stderr-sentinel:\${FAKE_PNPM_MODE}" >&2
echo "child-locale:\${LC_ALL-unset}" >&2
case "\${FAKE_PNPM_MODE}" in
  natural-124)
    echo "timeout: sending signal KILL to command 'spoofed-child'" >&2
    exit 124
    ;;
  self-kill)
    kill -KILL "$$"
    ;;
  term)
    trap 'exit 0' TERM
    while :; do sleep 0.01; done
    ;;
  kill)
    trap '' TERM
    while :; do sleep 0.01 || true; done
    ;;
esac
`,
  );
  chmodSync(fakePnpm, 0o755);
  const fixturePath = `${binDir}:${process.env.PATH ?? ""}`;
  const workflow = readQaProfileEvidenceWorkflow();
  const runProfileStep = step(workflow.jobs.run_qa_profile_shard, "Run QA profile shard");
  let script = runProfileStep.run
    .replace("--kill-after=30s 110m", "--kill-after=0.05s 0.4s")
    .replaceAll("110 minutes", "0.4 seconds")
    .replaceAll("30-second", "0.05-second");
  const timeoutSupervisorCapture = path.join(root, "timeout-supervisor.log");
  const timeoutClassificationStart = `supervisor_tee_pid=""

timeout_outcome="none"`;
  // Bash writes killed-job diagnostics outside timeout's redirected stream. Capture the
  // authoritative supervisor log before the workflow's EXIT trap removes it.
  const capturedScript = script.replace(
    timeoutClassificationStart,
    `supervisor_tee_pid=""
cp "$timeout_supervisor_log" "$TIMEOUT_SUPERVISOR_CAPTURE"

timeout_outcome="none"`,
  );
  if (capturedScript === script) {
    throw new Error("QA timeout fixture could not capture the timeout supervisor log");
  }
  script = capturedScript;
  const githubOutput = path.join(root, "github-output");
  const run = runWorkflowShellScript(script, {
    cwd: selectedRoot,
    env: {
      ...process.env,
      FAKE_PNPM_MODE: mode,
      GITHUB_OUTPUT: githubOutput,
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_RUN_ID: "42",
      GITHUB_WORKSPACE: root,
      LC_ALL: "POSIX",
      PATH: fixturePath,
      CATEGORY_IDS_JSON: '["fixture.category"]',
      PROTOCOL_SINCE_BASE_SHA: "b".repeat(40),
      QA_PROFILE: "all",
      QA_SHARD_ID: "shard-01",
      REQUESTED_REF: "fixture",
      SCENARIO_IDS_JSON: '["fixture-scenario"]',
      TARGET_SHA: "a".repeat(40),
      TIMEOUT_SUPERVISOR_CAPTURE: timeoutSupervisorCapture,
    },
  });
  const outputDir = path.join(selectedRoot, ".artifacts", "qa-e2e", "profile-all-42-1", "shard-01");
  const status = readJson(path.join(outputDir, "qa-profile-run-status.json")) as {
    exitCode: number;
    target: { protocolBaseSha: string };
    timedOut: boolean;
    timeoutOutcome: "none" | "term" | "kill";
  };
  return {
    commandStatus: run.status,
    githubOutput: readFileSync(githubOutput, "utf8"),
    status,
    stderr: run.stderr,
    stdout: run.stdout,
    timeoutSupervisorLog: readFileSync(timeoutSupervisorCapture, "utf8"),
  };
}

function runQaProfileFailureGate(options: { allowFailures: boolean; qaExitCode?: string }) {
  const workflow = readQaProfileEvidenceWorkflow();
  const failStep = step(workflow.jobs.aggregate_qa_profile, "Fail if QA profile failed");
  return runBash(failStep.run, {
    ALLOW_FAILURES: String(options.allowFailures),
    QA_EXIT_CODE: options.qaExitCode ?? "",
    QA_PROFILE: "all",
  });
}

function writeProtocolDescriptor(
  repo: string,
  additions: Array<{
    name: string;
    since?: string;
    compatibilityRestored?: boolean;
  }> = [],
): void {
  writeFixture(
    path.join(repo, "src/gateway/methods/core-descriptors.ts"),
    `export const CORE_GATEWAY_METHOD_SPECS = ${JSON.stringify([{ name: "health", since: "2026.7" }, ...additions])} as const;\n`,
  );
}

function commitProtocolFixture(repo: string, message: string): string {
  runGit(repo, ["add", "-A"]);
  runGit(repo, ["commit", "-q", "-m", message]);
  return runGit(repo, ["rev-parse", "HEAD"]);
}

function createQaProtocolTopology() {
  const root = tempDirs.make("openclaw-qa-protocol-topology-");
  const origin = path.join(root, "origin");
  const checkout = path.join(root, "checkout");

  runGit(root, ["init", "-q", "-b", "main", origin]);
  runGit(origin, ["config", "commit.gpgsign", "false"]);
  runGit(origin, ["config", "user.email", "qa-protocol@example.invalid"]);
  runGit(origin, ["config", "user.name", "QA Protocol Fixture"]);
  writeFileSync(
    path.join(origin, "package.json"),
    '{"name":"qa-protocol-fixture","version":"2026.8.0"}\n',
  );
  writeProtocolDescriptor(origin);
  const mainBase = commitProtocolFixture(origin, "base protocol");
  runGit(origin, ["checkout", "-q", "-b", "untrusted"]);
  writeProtocolDescriptor(origin, [{ name: "untrusted" }]);
  const untrusted = commitProtocolFixture(origin, "untrusted branch");
  runGit(origin, ["checkout", "-q", "main"]);
  writeProtocolDescriptor(origin, [{ name: "sessions.patchMany", since: "2026.8" }]);
  const mainHead = commitProtocolFixture(origin, "add main protocol method");

  runGit(root, ["clone", "-q", "--no-local", origin, checkout]);
  const gitOwner = path.join(root, "ci-git-owner.py");
  writeFileSync(gitOwner, readFileSync(".github/actions/git-owner/owner.py"));

  return {
    checkout,
    gitOwner,
    mainBase,
    mainHead,
    untrusted,
  };
}

function runQaSelectedRefValidation(
  topology: ReturnType<typeof createQaProtocolTopology>,
  inputRef: string,
  revision: string,
  expectedSha = revision,
) {
  runGit(topology.checkout, ["checkout", "-q", "--detach", revision]);
  const githubOutput = path.join(topology.checkout, "github-output");
  rmSync(githubOutput, { force: true });
  const validateStep = step(
    readQaProfileEvidenceWorkflow().jobs.validate_selected_ref,
    "Validate selected ref",
  );
  const result = runWorkflowShellScript(expectDefined(validateStep.run, "validation script"), {
    cwd: topology.checkout,
    env: {
      ...process.env,
      EXPECTED_SHA: expectedSha,
      GITHUB_OUTPUT: githubOutput,
      GITHUB_STEP_SUMMARY: path.join(topology.checkout, "github-summary"),
      INPUT_REF: inputRef,
      CI_GIT_OWNER: topology.gitOwner,
    },
  });
  return { ...result, outputs: readWorkflowOutputs(githubOutput) };
}

function runProtocolSinceFixture(checkout: string, baseSha: string) {
  for (const scriptPath of [
    "packages/normalization-core/src/record-coerce.ts",
    "scripts/check-protocol-since.mts",
    "scripts/lib/native-typescript.mts",
    "scripts/lib/repo-root.mjs",
    "scripts/lib/ts-guard-utils.mts",
  ]) {
    const target = path.join(checkout, scriptPath);
    writeFixture(target, readFileSync(scriptPath, "utf8"));
  }
  writeJson(path.join(checkout, "tsconfig.json"), {
    compilerOptions: {
      paths: {
        "@openclaw/normalization-core/record-coerce": [
          "./packages/normalization-core/src/record-coerce.ts",
        ],
      },
    },
  });
  const nodeModules = path.join(checkout, "node_modules");
  if (!existsSync(nodeModules)) {
    symlinkSync(TYPESCRIPT_NODE_MODULES, nodeModules, "dir");
  }
  return runWorkflowShellScript(
    `${quoteShell(process.execPath)} --import ${quoteShell(TSX_IMPORT)} scripts/check-protocol-since.mts`,
    { cwd: checkout, env: { ...process.env, PROTOCOL_SINCE_BASE_SHA: baseSha } },
  );
}
describe("ci workflow guards", () => {
  it.skipIf(process.platform === "win32")(
    "drives the protocol vintage guard and rejects untrusted selected revisions",
    () => {
      const topology = createQaProtocolTopology();
      for (const [expectedSha, inputRef, revision] of [
        ["not-a-sha", "main", topology.mainHead],
        [topology.untrusted, topology.untrusted, topology.untrusted],
        [topology.mainBase, "main", topology.mainHead],
      ] as const) {
        const result = runQaSelectedRefValidation(topology, inputRef, revision, expectedSha);
        expect(result.status, `${result.stdout}${result.stderr}`).not.toBe(0);
        expect(result.outputs).toEqual({});
      }
      for (const [method, success, message] of [
        [{ name: "new", since: "2026.8" }, true, "1 new core method"],
        [
          { name: "restored", since: "<=2026.7", compatibilityRestored: true },
          true,
          "1 restored compatibility method",
        ],
        [
          { name: "invalid", since: "2026.8", compatibilityRestored: true },
          false,
          "restored compatibility methods must retain <= vintage metadata",
        ],
        [{ name: "missing" }, false, "missing is missing since metadata"],
      ] as const) {
        writeProtocolDescriptor(topology.checkout, [method]);
        const result = runProtocolSinceFixture(topology.checkout, topology.mainBase);
        if (success) {
          expectSuccess(result);
          expect(result.stdout).toContain(message);
        } else {
          expect(result.status).not.toBe(0);
          expect(result.stderr).toContain(message);
        }
      }
    },
  );

  it.skipIf(process.platform !== "linux")(
    "classifies QA timeouts only from isolated supervisor diagnostics",
    () => {
      for (const [mode, exitCode, signals, timedOut, timeoutOutcome] of [
        ["natural-124", 124, [], false, "none"],
        ["self-kill", 137, [], false, "none"],
        ["term", 124, ["TERM"], true, "term"],
        ["kill", 137, ["TERM", "KILL"], true, "kill"],
      ] as const) {
        const result = runQaProfileTimeoutFixture(mode);
        expect(result.commandStatus, `${result.stdout}\n${result.stderr}`).toBe(0);
        expect(result.status).toMatchObject({
          exitCode,
          target: { protocolBaseSha: "b".repeat(40) },
          timedOut,
          timeoutOutcome,
        });
        expect(result.githubOutput).toContain(`qa_exit_code=${exitCode}`);
        expectIncludes(result.stderr, [`child-stderr-sentinel:${mode}`, "child-locale:POSIX"]);

        const supervisorSignals: readonly ("TERM" | "KILL")[] = signals;
        for (const signal of ["TERM", "KILL"] as const) {
          const diagnostic = `timeout: sending signal ${signal} to command 'env'`;
          if (supervisorSignals.includes(signal)) {
            expect(result.timeoutSupervisorLog).toContain(diagnostic);
          } else {
            expect(result.timeoutSupervisorLog).not.toContain(diagnostic);
          }
        }

        if (mode === "natural-124") {
          expect(result.stderr).toContain(
            "timeout: sending signal KILL to command 'spoofed-child'",
          );
          expect(result.timeoutSupervisorLog).not.toContain("spoofed-child");
        }
        if (timeoutOutcome === "term") {
          expect(result.stdout).toContain(
            "::warning::QA profile 'all' timed out after 0.4 seconds and was terminated",
          );
        } else if (timeoutOutcome === "kill") {
          expect(result.stdout).toContain(
            "::warning::QA profile 'all' timed out after 0.4 seconds and required SIGKILL after the 0.05-second grace period",
          );
        } else {
          expect(result.stdout).not.toContain("::warning::QA profile");
        }
      }
    },
  );

  it("isolates trusted QA and publication authority across the evidence handoff", () => {
    const qa = readQaProfileEvidenceWorkflow();
    const maturity = readMaturityScorecardWorkflow();
    const selectedJobs = [
      qa.jobs.plan_qa_profile,
      qa.jobs.run_qa_profile_shard,
      qa.jobs.aggregate_qa_profile,
    ];
    for (const job of [qa.jobs.validate_selected_ref, ...selectedJobs]) {
      const names = job.steps.map((entry: WorkflowStep) => entry.name);
      expect(names.indexOf(step(job, "Prepare Git owner").name)).toBeLessThan(
        names.indexOf("Checkout selected ref"),
      );
      for (const entry of job.steps as WorkflowStep[]) {
        if (entry.uses?.startsWith("actions/checkout@")) {
          expect(entry.with?.["persist-credentials"]).toBe(false);
        }
        if (entry.uses && !entry.uses.startsWith("./")) {
          expect(entry.uses).toMatch(/@[0-9a-f]{40}$/u);
        }
      }
    }
    for (const job of selectedJobs) {
      expect(job.environment).toBe("qa-live-shared");
      const names = job.steps.map((entry: WorkflowStep) => entry.name);
      expect(names.indexOf("Require authorized workflow actor")).toBeLessThan(
        names.indexOf("Checkout trusted QA harness"),
      );
      expect(names.indexOf("Restore trusted QA harness revision")).toBeLessThan(
        names.indexOf("Checkout selected ref"),
      );
      expect(step(job, "Setup Node environment").with).toMatchObject({
        "install-deps": "false",
        "cache-mode": "off",
      });
      expect(step(job, "Install selected dependencies")["working-directory"]).toBe("selected");
      expect(step(job, "Restore trusted QA harness revision").env?.EXPECTED_WORKFLOW_SHA).toBe(
        "${{ needs.validate_selected_ref.outputs.workflow_sha }}",
      );
      expect(step(job, "Checkout selected ref").env?.EXPECTED_SHA).toBe(
        "${{ needs.validate_selected_ref.outputs.selected_revision }}",
      );
    }
    for (const permission of [
      step(qa.jobs.authorize_actor, "Require maintainer-level repository access"),
      step(maturity.jobs.validate_selected_ref, "Require authorized workflow actor"),
      ...selectedJobs.map((job) => step(job, "Require authorized workflow actor")),
    ]) {
      expectIncludes(permission.with?.script, [
        "getCollaboratorPermissionLevel",
        'new Set(["admin", "maintain", "write"])',
        "callerWorkflowRef !== calledWorkflowRef",
        'job.workflow_repository === "openclaw/openclaw"',
        "job.workflow_ref === calledWorkflowRef",
      ]);
    }
    expect(maturity.on.workflow_call.inputs).not.toHaveProperty("publish_pull_request");
    const publicationCondition = [
      "${{ inputs.publish_pull_request &&",
      "github.event_name == 'workflow_dispatch' &&",
      `github.workflow_ref == '${MATURITY_SCORECARD_WORKFLOW_REF}' &&`,
      `needs.validate_selected_ref.outputs.workflow_file_path == '${MATURITY_SCORECARD_WORKFLOW}' &&`,
      `needs.validate_selected_ref.outputs.workflow_ref == '${MATURITY_SCORECARD_WORKFLOW_REF}' &&`,
      "needs.validate_selected_ref.outputs.workflow_repository == 'openclaw/openclaw' }}",
    ].join(" ");
    for (const [job, name] of [
      [maturity.jobs.publisher_preflight, "Create generated PR tokens"],
      [maturity.jobs.publish_generated_pr, "Open or update generated docs PR"],
    ] as const) {
      const publish = step(job, name);
      expect(publish.if?.replace(/\s+/gu, " ")).toBe(publicationCondition);
      expect(publish.with).toMatchObject({
        "contents-private-key": "${{ secrets.CLAWSWEEPER_APP_PRIVATE_KEY }}",
        "pull-request-private-key": "${{ secrets.MANTIS_GITHUB_APP_PRIVATE_KEY }}",
      });
      expect(step(job, "Checkout trusted workflow source").with).toMatchObject({
        repository: "${{ needs.validate_selected_ref.outputs.workflow_repository }}",
        ref: "${{ needs.validate_selected_ref.outputs.workflow_sha }}",
        "persist-credentials": false,
      });
    }
    expect(maturity.jobs.publish_generated_pr.permissions).toEqual({
      actions: "read",
      contents: "read",
    });
    expect(JSON.stringify(maturity.jobs.publish)).not.toMatch(
      /CLAWSWEEPER_APP_PRIVATE_KEY|MANTIS_GITHUB_APP/u,
    );
    expect(step(maturity.jobs.publish, "Require one QA evidence file").run).toContain(
      '[[ ! -f "$evidence_path" || -L "$evidence_path" ]]',
    );
    expect(step(qa.jobs.aggregate_qa_profile, "Aggregate validated shard evidence").run).toContain(
      "Timed-out QA shard cannot contribute partial evidence",
    );
  });

  // Projection and schema variants belong to evidence-summary.test.ts; these
  // exercise each workflow's historical API, selected API and absent-artifact paths.
  it.skipIf(process.platform === "win32").each(["v2", "v3", "absent"] as const)(
    "Mantis readers use the owning API for %s evidence",
    (mode) => {
      for (const kind of ["status-reactions", "thread-attachment"] as const) {
        const scenarioId = mantisScenarioId(kind);
        const evidence =
          mode === "v2"
            ? legacyEvidence(scenarioId, ["fail", "pass"])
            : mode === "v3"
              ? workflowOccurrenceEvidence(scenarioId, ["fail", "pass"], 1)
              : undefined;
        const result = runMantisEvidenceReader(kind, evidence, mode !== "v2");
        expectSuccess(result);
        expect(result.stdout.trim()).toBe(
          mode === "v2" ? (kind === "status-reactions" ? "fail" : "fail\npass") : "pass",
        );
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "Mantis v3 readers require the owning API accessor",
    () => {
      for (const kind of ["status-reactions", "thread-attachment"] as const) {
        const evidence = workflowOccurrenceEvidence(mantisScenarioId(kind), ["pass"], 0);
        const result = runMantisEvidenceReader(kind, evidence, false);
        expect(result.status, result.stdout + result.stderr).not.toBe(0);
        expect(result.stderr).toContain("scenario reader");
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "round-trips profile evidence and rejects digest drift",
    () => {
      const qaWorkflow = readQaProfileEvidenceWorkflow();
      const maturityWorkflow = readMaturityScorecardWorkflow();
      const producerStep = step(
        qaWorkflow.jobs.aggregate_qa_profile,
        "Finalize QA profile evidence",
      );
      const consumerStep = step(maturityWorkflow.jobs.publish, "Validate QA evidence manifest");
      const producerScript = expectDefined(producerStep?.run, "QA evidence producer script");
      const consumerScript = expectDefined(consumerStep?.run, "QA evidence consumer script");
      const root = tempDirs.make("openclaw-qa-profile-artifact-");
      const selectedRoot = path.join(root, "selected");
      writeWorkflowEvidenceApi(selectedRoot, false);
      writeFixture(
        path.join(selectedRoot, "extensions/qa-lab/src/profile-evidence-plan.ts"),
        `export { qaProfileEvidencePlan } from ${JSON.stringify(pathToFileURL(path.resolve("extensions/qa-lab/src/profile-evidence-plan.ts")).href)};\n`,
      );
      const evidencePath = path.join(root, "qa-evidence.json");
      const manifestPath = path.join(root, "qa-profile-evidence-manifest.json");
      const protocolBaseSha = "b".repeat(40);
      const targetSha = "a".repeat(40);
      const expectedCell = { scenarioId: "scenario-one", executionKind: "flow", channel: null };
      const fulfillment = { total: 1, fulfilled: 1, missing: 0, fulfillmentPercent: 100 };
      const features = { ...fulfillment, partial: 0 };
      const scorecard = {
        filters: { surface: null, category: null },
        run: { evidenceEntryCount: 0 },
        categories: features,
        features,
        coverageIds: fulfillment,
        categoryReports: [],
      };

      const writeEvidence = (status: "pass" | "fail" = "pass") => {
        writeJson(
          evidencePath,
          {
            ...legacyEvidence("scenario-one", [status]),
            profile: "all",
            profilePlan: {
              profile: "all",
              membership: ["scenario-one"],
              selected: ["scenario-one"],
              excluded: [],
              expectedCells: [expectedCell],
              observedCells: [expectedCell],
              missingCells: [],
              proofRequirements: [
                {
                  id: "observed-protocol",
                  coverageId: "qa.reporting",
                  obligation: "advisory",
                  owner: "fixture-owner",
                  acceptedRef: "qa/fixtures/acceptance",
                  retryAcceptance: "selected-attempt",
                  alternatives: [{ protocol: "gateway:3" }],
                },
              ],
              counts: {
                membership: 1,
                selected: 1,
                excluded: 0,
                expectedCells: 1,
                observedCells: 1,
                missingCells: 0,
              },
            },
            scorecard,
          },
          "\n",
        );
      };
      const runProducer = (qaExitCode: string) =>
        runWorkflowShellScript(producerScript, {
          tempDir: evidenceCompilerTempDir,
          env: {
            ...process.env,
            ALLOW_FAILURES: "true",
            ARTIFACT_NAME: `qa-profile-evidence-all-${targetSha}`,
            GITHUB_OUTPUT: path.join(root, "github-output"),
            GITHUB_STEP_SUMMARY: path.join(root, "github-summary"),
            OUTPUT_DIR: root,
            PROTOCOL_BASE_SHA: protocolBaseSha,
            QA_EXIT_CODE: qaExitCode,
            QA_PROFILE: "all",
            REQUESTED_REF: targetSha,
            TARGET_SHA: targetSha,
            TRUSTED_REASON: "fixture",
          },
        });
      const runConsumer = () =>
        runWorkflowShellScript(consumerScript, {
          tempDir: evidenceCompilerTempDir,
          cwd: selectedRoot,
          env: {
            ...process.env,
            GITHUB_OUTPUT: path.join(root, "consumer-output"),
            GITHUB_STEP_SUMMARY: path.join(root, "consumer-summary"),
            QA_EVIDENCE_PATH: evidencePath,
            TARGET_SHA: targetSha,
          },
        });
      const outputPath = path.join(root, "consumer-output");
      const expectConsumerOutput = (expected: Record<string, string | number | boolean>) => {
        writeFileSync(outputPath, "");
        expectSuccess(runConsumer());
        const output = readFileSync(outputPath, "utf8");
        for (const [key, value] of Object.entries(expected)) {
          expect(output).toContain(`${key}=${value}`);
        }
      };

      writeEvidence();
      expectSuccess(runProducer("0"));
      const completeManifest = readFileSync(manifestPath, "utf8");
      expect(JSON.parse(completeManifest)).toMatchObject({ protocolBaseSha, targetSha });
      expectConsumerOutput({ scorecard_passed: true });

      const originalEvidence = readJson(evidencePath);
      const retryEvidence = {
        ...originalEvidence,
        ...workflowOccurrenceEvidence("scenario-one", ["fail", "pass"], 1),
        profile: originalEvidence.profile,
        profilePlan: originalEvidence.profilePlan,
        scorecard,
      };
      writeJson(evidencePath, retryEvidence);
      expectFailure(runConsumer(), "requires the selected checkout's effective-entry reader");
      writeWorkflowEvidenceApi(selectedRoot);
      expectSuccess(runProducer("0"));
      expect(readJson(manifestPath).profilePlanSha256).toBe(
        JSON.parse(completeManifest).profilePlanSha256,
      );
      expectConsumerOutput({ scorecard_passed: true, passed_count: 1, failed_count: 0 });

      writeJson(manifestPath, { ...JSON.parse(completeManifest), targetSha: protocolBaseSha });
      expectFailure(runConsumer(), "does not match selected ref");
      writeFileSync(manifestPath, completeManifest);
      writeEvidence("fail");
      expectConsumerOutput({ scorecard_passed: false, failed_count: 1 });

      writeJson(manifestPath, {
        ...JSON.parse(completeManifest),
        profilePlanSha256: "0".repeat(64),
      });
      expectFailure(runConsumer(), "QA evidence profilePlan digest does not match the manifest");
    },
  );

  it.skipIf(process.platform === "win32")(
    "fails the maturity workflow result gate when evidence is not passing",
    () => {
      const maturityWorkflow = readMaturityScorecardWorkflow();
      const gateStep = step(
        maturityWorkflow.jobs.maturity_result,
        "Fail incomplete maturity evidence",
      );
      const gateScript = expectDefined(gateStep?.run, "maturity result gate");
      const failed = runWorkflowShellScript(gateScript, {
        env: {
          ...process.env,
          BLOCKED_COUNT: "51",
          FAILED_COUNT: "28",
          SCORECARD_PASSED: "false",
        },
      });
      expect(failed.status).toBe(1);
      expect(`${failed.stdout}${failed.stderr}`).toContain(
        "28 failed and 51 blocked scenarios. Generated maturity PR was still published when requested.",
      );

      const passed = runWorkflowShellScript(gateScript, {
        env: { ...process.env, BLOCKED_COUNT: "0", FAILED_COUNT: "0", SCORECARD_PASSED: "true" },
      });
      expect(passed.status).toBe(0);
    },
  );

  it.skipIf(process.platform === "win32")(
    "suppresses only reported QA result failures when explicitly allowed",
    () => {
      expect(runQaProfileFailureGate({ allowFailures: false, qaExitCode: "7" }).status).toBe(7);
      expect(runQaProfileFailureGate({ allowFailures: true, qaExitCode: "7" }).status).toBe(0);
      expect(runQaProfileFailureGate({ allowFailures: true }).status).toBe(1);
      expect(runQaProfileFailureGate({ allowFailures: false, qaExitCode: "0" }).status).toBe(0);
    },
  );

  it.skipIf(process.platform === "win32")(
    "authorizes maturity publication only for canonical direct dispatches",
    () => {
      const otherWorkflow =
        "openclaw/openclaw/.github/workflows/openclaw-release-checks.yml@refs/heads/main";
      for (const [callerWorkflowRef, jobWorkflowRef, publishPullRequest, allowed] of [
        [MATURITY_SCORECARD_WORKFLOW_REF, undefined, true, true],
        [otherWorkflow, undefined, false, true],
        [otherWorkflow, undefined, true, false],
        [MATURITY_SCORECARD_WORKFLOW_REF, otherWorkflow, true, false],
      ] as const) {
        const result = runMaturityInvocationScenario({
          callerEventName: "workflow_dispatch",
          callerWorkflowRef,
          jobWorkflowRef,
          publishPullRequest,
        });
        if (allowed) {
          expect(result.status).toBe(0);
        } else {
          expect(result.status).not.toBe(0);
          expect(result.output).toContain(
            "Reusable maturity workflows are artifact-only and cannot publish pull requests.",
          );
        }
      }
    },
  );

  // Replay the Ubuntu workflow shell only where its Bash 4 and GNU install contract exists.
  it.skipIf(process.platform !== "linux")(
    "copies only regular allowlisted maturity publication files",
    () => {
      const valid = runMaturityArtifactCopyScenario();
      expect(valid.status).toBe(0);
      expect(valid.copied).toEqual(
        MATURITY_GENERATED_PR_PATHS.map((generatedPath) => `new ${generatedPath}\n`),
      );

      for (const [option, message] of [
        ["extraFile", "Generated PR artifact must contain exactly 3 files."],
        [
          "sourceSymlink",
          "Generated PR artifact path must be a regular file: qa/maturity-scores.yaml",
        ],
        [
          "destinationSymlink",
          "Selected worktree destination must be a regular file: qa/maturity-scores.yaml",
        ],
      ] as const) {
        const result = runMaturityArtifactCopyScenario({ [option]: true });
        expect(result.status).not.toBe(0);
        expect(result.output).toContain(message);
        if (option === "destinationSymlink") {
          expect(result.escaped).toBe("outside\n");
        }
      }
    },
  );
});
