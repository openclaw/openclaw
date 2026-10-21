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
  CHECKOUT_V6,
  MANTIS_GITHUB_APP_CLIENT_ID,
  MATURITY_SCORECARD_WORKFLOW,
  TSX_IMPORT,
  expectExcludes,
  expectIncludes,
  quoteShell,
  readMaturityScorecardWorkflow,
  readReleaseChecksWorkflow,
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
const TRUSTED_QA_STEPS = [
  "Require authorized workflow actor",
  "Prepare Git owner",
  "Checkout trusted QA harness",
  "Restore trusted QA harness revision",
  "Setup Node environment",
  "Checkout selected ref",
  "Install selected dependencies",
];

function writeJson(file: string, value: unknown, suffix = "") {
  writeFileSync(file, JSON.stringify(value) + suffix, "utf8");
}

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
  instances: {
    scenarioId: string;
    attempts: qaEvidence.QaEvidenceStatus[];
    selected?: number;
    retry?: boolean;
  }[],
  evidenceMode: "full" | "slim" = "full",
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
  for (const [index, instance] of instances.entries()) {
    const anchorId = `instance-${index}`;
    const parentCell = {
      scenarioId: instance.scenarioId,
      executionKind: "flow" as const,
      channel: null,
    };
    const common = { parentCell, assertions: null, launch: identity };
    occurrences.push({
      ...common,
      id: anchorId,
      scenario: {
        kind: "instance",
        resultOccurrenceId:
          instance.selected === undefined ? null : `${anchorId}-attempt-${instance.selected}`,
      },
      retryOf: null,
      terminalStatus: null,
      receipts: [],
    });
    for (const [attempt, status] of instance.attempts.entries()) {
      const id = `${anchorId}-attempt-${attempt}`;
      occurrences.push({
        ...common,
        id,
        scenario: { kind: "observation", instanceOccurrenceId: anchorId },
        retryOf:
          attempt === 0 || instance.retry === false ? null : `${anchorId}-attempt-${attempt - 1}`,
        terminalStatus: status,
        receipts: [],
      });
      entries.push({
        test: { kind: "scenario", id: instance.scenarioId, title: instance.scenarioId },
        coverage: [],
        result: { status },
        binding: { occurrenceId: id, assertionId: null, receiptId: null },
        effective: instance.retry === false || attempt === instance.selected,
      });
    }
  }
  return qaEvidence.buildQaOccurrenceEvidenceSummary({
    generatedAt: "2026-08-05T00:00:00.000Z",
    evidenceMode,
    occurrences,
    entries,
  });
}

function writeWorkflowEvidenceApi(root: string, accessors = true) {
  const apiPath = path.join(root, "extensions/qa-lab/api.ts");
  mkdirSync(path.dirname(apiPath), { recursive: true });
  writeJson(path.join(root, "tsconfig.json"), { extends: path.resolve("tsconfig.json") });
  const source = pathToFileURL(path.resolve("extensions/qa-lab/src/evidence-summary.ts")).href;
  // Historical checkouts can validate v2 without exporting the v3 readers.
  writeFileSync(
    apiPath,
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
  mkdirSync(outputDir, { recursive: true });
  const moduleRoot = kind === "status-reactions" ? root : laneRoot;
  writeWorkflowEvidenceApi(moduleRoot, accessors);
  // A reader must not silently use a newer neighboring checkout's API.
  const otherRoot = kind === "status-reactions" ? laneRoot : root;
  writeWorkflowEvidenceApi(otherRoot);
  writeFileSync(
    path.join(otherRoot, "extensions/qa-lab/api.ts"),
    'throw new Error("wrong evidence API owner");\n',
  );
  if (evidence !== undefined) {
    writeFileSync(
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
    mkdirSync(path.dirname(staged), { recursive: true });
    mkdirSync(path.dirname(selected), { recursive: true });
    writeFileSync(staged, `new ${generatedPath}\n`, "utf8");
    writeFileSync(selected, `old ${generatedPath}\n`, "utf8");
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
  mkdirSync(binDir);
  const fakePnpm = path.join(binDir, "pnpm");
  writeFileSync(
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
    "utf8",
  );
  chmodSync(fakePnpm, 0o755);
  const fixturePath = `${binDir}:${process.env.PATH ?? ""}`;
  const timeoutVersion = spawnSync("timeout", ["--version"], {
    encoding: "utf8",
    env: { ...process.env, PATH: fixturePath },
  });
  if (timeoutVersion.status !== 0) {
    throw new Error(
      `QA timeout fixture requires timeout --version: ${timeoutVersion.stdout}${timeoutVersion.stderr}`,
    );
  }

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
    timeoutVersion: `${timeoutVersion.stdout}${timeoutVersion.stderr}`.trim(),
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
  const rows = [{ name: "health", since: "2026.7" }, ...additions].map(
    ({ name, since, compatibilityRestored }) => {
      const sinceProperty = since === undefined ? "" : `, since: ${JSON.stringify(since)}`;
      const compatibilityProperty = compatibilityRestored ? ", compatibilityRestored: true" : "";
      return `  { name: ${JSON.stringify(name)}${sinceProperty}${compatibilityProperty} },`;
    },
  );
  const descriptor = path.join(repo, "src/gateway/methods/core-descriptors.ts");
  mkdirSync(path.dirname(descriptor), { recursive: true });
  writeFileSync(
    descriptor,
    `export const CORE_GATEWAY_METHOD_SPECS = [\n${rows.join("\n")}\n] as const;\n`,
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
  const releaseBranch = "release/2026.8.1";
  const releaseTag = "v2026.8.1";
  const mainReleaseTag = "v2026.8.2";

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
  const branch = (
    name: string,
    additions: Parameters<typeof writeProtocolDescriptor>[1],
    message: string,
  ) => {
    runGit(origin, ["checkout", "-q", "-b", name, mainBase]);
    writeProtocolDescriptor(origin, additions);
    return commitProtocolFixture(origin, message);
  };

  writeProtocolDescriptor(origin, [{ name: "sessions.patchMany", since: "2026.8" }]);
  const mainHead = commitProtocolFixture(origin, "add main protocol method");
  runGit(origin, ["tag", mainReleaseTag]);
  writeFileSync(path.join(origin, "main-tip.txt"), "later main tip\n");
  commitProtocolFixture(origin, "advance main");

  const compatibilityHead = branch(
    "compatibility/restore",
    [{ name: "gateway.restart.preflight", since: "<=2026.7", compatibilityRestored: true }],
    "restore compatibility method",
  );
  const invalidCompatibilityHead = branch(
    "compatibility/invalid",
    [{ name: "gateway.restart.invalid", since: "2026.8", compatibilityRestored: true }],
    "mislabel new method as compatibility",
  );
  const releaseHead = branch(
    releaseBranch,
    [{ name: "sessions.releaseOnly" }],
    "add release protocol method",
  );

  runGit(origin, ["checkout", "-q", "--detach", mainBase]);
  writeFileSync(path.join(origin, "tag.txt"), "release tag\n");
  const releaseTagHead = commitProtocolFixture(origin, "create release tag target");
  runGit(origin, ["tag", releaseTag]);

  runGit(origin, ["checkout", "-q", "-b", "feature/untrusted", mainBase]);
  writeFileSync(path.join(origin, "feature.txt"), "untrusted\n");
  const featureHead = commitProtocolFixture(origin, "add untrusted feature");
  runGit(origin, ["checkout", "-q", "main"]);

  runGit(root, ["clone", "-q", "--no-local", origin, checkout]);
  const gitOwner = path.join(root, "ci-git-owner.py");
  writeFileSync(gitOwner, readFileSync(".github/actions/git-owner/owner.py"));

  return {
    checkout,
    compatibilityHead,
    gitOwner,
    featureHead,
    invalidCompatibilityHead,
    mainBase,
    mainHead,
    mainReleaseTag,
    origin,
    releaseBranch,
    releaseHead,
    releaseTag,
    releaseTagHead,
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
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, readFileSync(scriptPath, "utf8"));
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
    "resolves topology-aware protocol bases and drives the real guard",
    () => {
      const topology = createQaProtocolTopology();
      const cases = [
        ["main", topology.mainHead, "main-ancestor", topology.mainBase],
        [topology.releaseBranch, topology.releaseHead, "release-branch-head", topology.mainBase],
        [topology.releaseTag, topology.releaseTagHead, "release-tag", topology.mainBase],
        [topology.releaseTagHead, topology.releaseTagHead, "release-tag", topology.mainBase],
        [topology.mainReleaseTag, topology.mainHead, "release-tag", topology.mainHead],
      ] as const;

      for (const [inputRef, revision, trustedReason, protocolBase] of cases) {
        const result = runQaSelectedRefValidation(topology, inputRef, revision);
        expectSuccess(result);
        expect(result.outputs).toEqual({
          protocol_base_revision: protocolBase,
          selected_revision: revision,
          trusted_reason: trustedReason,
        });
      }

      for (const [revision, success, message] of [
        [topology.mainHead, true, "1 new core method"],
        [topology.compatibilityHead, true, "1 restored compatibility method"],
        [
          topology.invalidCompatibilityHead,
          false,
          "restored compatibility methods must retain <= vintage metadata",
        ],
        [topology.releaseHead, false, "sessions.releaseOnly is missing since metadata"],
      ] as const) {
        runGit(topology.checkout, ["checkout", "-q", "--detach", revision]);
        const result = runProtocolSinceFixture(topology.checkout, topology.mainBase);
        if (success) {
          expectSuccess(result);
          expect(result.stdout).toContain(message);
        } else {
          expect(result.status).not.toBe(0);
          expect(result.stderr).toContain(message);
        }
      }

      for (const [expectedSha, inputRef, revision] of [
        ["not-a-sha", "main", topology.mainHead],
        [topology.featureHead, topology.featureHead, topology.featureHead],
        [topology.mainHead, topology.releaseTag, topology.releaseTagHead],
      ] as const) {
        const result = runQaSelectedRefValidation(topology, inputRef, revision, expectedSha);
        expect(result.status, `${result.stdout}${result.stderr}`).not.toBe(0);
        expect(result.outputs).toEqual({});
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "wires and fetches one explicit protocol base before QA execution",
    () => {
      const qaWorkflow = readQaProfileEvidenceWorkflow();
      const maturityWorkflow = readMaturityScorecardWorkflow();
      const validateJob = qaWorkflow.jobs.validate_selected_ref;
      const runJob = qaWorkflow.jobs.run_qa_profile_shard;
      const aggregateJob = qaWorkflow.jobs.aggregate_qa_profile;
      const stepNames = runJob.steps.map((entry: WorkflowStep) => entry.name);
      const buildStep = step(runJob, "Build private QA runtime");
      const fetchStep = step(runJob, "Fetch protocol comparison base");
      const runStep = step(runJob, "Run QA profile shard");
      const evidenceStep = step(aggregateJob, "Finalize QA profile evidence");
      const protocolOutput = "${{ needs.validate_selected_ref.outputs.protocol_base_revision }}";
      const trustedInput = "${{ inputs.trusted_ref || inputs.ref }}";

      expect(qaWorkflow.env.OPENCLAW_TSDOWN_MAX_OLD_SPACE_MB).toBe("8192");

      expect(qaWorkflow.on.workflow_call.inputs.trusted_ref).toEqual({
        description: "Optional trusted branch, tag, or SHA identity for an immutable ref",
        required: false,
        default: "",
        type: "string",
      });
      expect(validateJob.outputs.protocol_base_revision).toBe(
        "${{ steps.validate.outputs.protocol_base_revision }}",
      );
      const validateStep = step(validateJob, "Validate selected ref");
      expect(validateStep.env.INPUT_REF).toBe(trustedInput);
      const ordered = [
        ...TRUSTED_QA_STEPS.slice(2),
        "Fetch protocol comparison base",
        "Build private QA runtime",
        "Run QA profile shard",
      ].map((name) => stepNames.indexOf(name));
      expect(ordered.every((index, position) => index > (ordered[position - 1] ?? -1))).toBe(true);
      expect(fetchStep.env?.PROTOCOL_SINCE_BASE_SHA).toBe(protocolOutput);
      expect(buildStep.run).toBe("pnpm build qaRuntime");
      expect(runStep.env?.PROTOCOL_SINCE_BASE_SHA).toBe(protocolOutput);
      expect(runStep.env?.REQUESTED_REF).toBe(trustedInput);
      expect(runStep.run).toContain("protocolBaseSha: process.env.PROTOCOL_SINCE_BASE_SHA");
      expect(evidenceStep.env?.PROTOCOL_BASE_SHA).toBe(protocolOutput);
      expect(evidenceStep.env?.REQUESTED_REF).toBe(trustedInput);
      expect(evidenceStep.run).toContain("protocolBaseSha: process.env.PROTOCOL_BASE_SHA");
      expect(maturityWorkflow.jobs.generate_qa_evidence.with.trusted_ref).toBe("${{ inputs.ref }}");

      const topology = createQaProtocolTopology();
      const checkout = tempDirs.make("openclaw-qa-protocol-fetch-");
      runGit(checkout, ["init", "-q", "-b", "main"]);
      runGit(checkout, ["remote", "add", "origin", topology.origin]);
      runGit(checkout, [
        "fetch",
        "-q",
        "--depth=1",
        "origin",
        `+${topology.mainHead}:refs/remotes/origin/selected`,
      ]);
      runGit(checkout, ["checkout", "-q", "--detach", "refs/remotes/origin/selected"]);
      const sentinel = path.join(checkout, "qa-sentinel");
      const runFetch = (baseSha: string) =>
        runWorkflowShellScript(
          `${expectDefined(fetchStep.run, "protocol fetch script")}\nprintf 'ran\\n' > "$QA_SENTINEL"\n`,
          {
            cwd: checkout,
            env: {
              ...process.env,
              CI_GIT_OWNER: topology.gitOwner,
              PROTOCOL_SINCE_BASE_SHA: baseSha,
              QA_SENTINEL: sentinel,
            },
          },
        );

      const success = runFetch(topology.mainBase);
      expectSuccess(success);
      expect(runGit(checkout, ["rev-parse", "refs/remotes/origin/qa-protocol-base"])).toBe(
        topology.mainBase,
      );
      expect(existsSync(sentinel)).toBe(true);

      rmSync(sentinel);
      const failure = runFetch("f".repeat(40));
      expect(failure.status, `${failure.stdout}${failure.stderr}`).not.toBe(0);
      expect(existsSync(sentinel)).toBe(false);
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
        expect(result.timeoutVersion).not.toBe("");

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
    const maturity = readMaturityScorecardWorkflow();
    const qa = readQaProfileEvidenceWorkflow();
    const selectedJobs = [
      qa.jobs.plan_qa_profile,
      qa.jobs.run_qa_profile_shard,
      qa.jobs.aggregate_qa_profile,
    ];
    const actorSteps = [
      step(qa.jobs.authorize_actor, "Require maintainer-level repository access"),
      step(maturity.jobs.validate_selected_ref, "Require authorized workflow actor"),
      ...selectedJobs.map((job) => step(job, "Require authorized workflow actor")),
    ];
    for (const permission of actorSteps) {
      expect(permission.env).toEqual({
        CALLER_WORKFLOW_REF: "${{ github.workflow_ref }}",
        JOB_CONTEXT: "${{ toJSON(job) }}",
      });
      expectIncludes(permission.with?.script, [
        "getCollaboratorPermissionLevel",
        'new Set(["admin", "maintain", "write"])',
        "callerWorkflowRef !== calledWorkflowRef",
        'job.workflow_repository === "openclaw/openclaw"',
        "job.workflow_ref === calledWorkflowRef",
      ]);
    }
    expect(actorSteps[0]?.with?.script).toContain(
      'core.setOutput("authorized", trustedMainCaller ? "true" : "false")',
    );
    expect(qa.jobs.validate_selected_ref.outputs.workflow_sha).toBe(
      "${{ steps.workflow.outputs.workflow_sha }}",
    );
    const identity = step(qa.jobs.validate_selected_ref, "Resolve job workflow identity");
    expect(identity.env).toEqual({ JOB_CONTEXT: "${{ toJSON(job) }}" });
    expectIncludes(identity.run, [
      "job.workflow_repository",
      "job.workflow_sha",
      "^[A-Za-z0-9_.-]+\\/[A-Za-z0-9_.-]+$",
      "^[0-9a-f]{40}$",
    ]);

    const fetchCalls: string[] = [];
    for (const job of [qa.jobs.validate_selected_ref, ...selectedJobs]) {
      const ownerIndex = job.steps.findIndex(
        (entry: WorkflowStep) => entry.name === "Prepare Git owner",
      );
      expect(
        job.steps.filter((entry: WorkflowStep) => entry.name === "Prepare Git owner"),
      ).toHaveLength(1);
      expect(job.steps[ownerIndex]).toEqual({
        name: "Prepare Git owner",
        uses: "openclaw/openclaw/.github/actions/git-owner@88095dc00eef288c3829909d4dc64a9e249fa7ef",
      });
      expect(job.steps[ownerIndex - 1]?.name).toBe(
        job === qa.jobs.validate_selected_ref
          ? "Resolve job workflow identity"
          : "Require authorized workflow actor",
      );
      expect(job.steps[ownerIndex + 1]?.name).toBe(
        job === qa.jobs.validate_selected_ref
          ? "Checkout selected ref"
          : "Checkout trusted QA harness",
      );
      for (const entry of job.steps as WorkflowStep[]) {
        const run = (entry.run ?? "").replace(/[ \t]*\\\n[ \t]*/gu, " ");
        const fetches = run
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => /\bfetch\b/u.test(line));
        if (fetches.length === 0) {
          continue;
        }
        expect(run.startsWith("set -euo pipefail\n")).toBe(true);
        for (const fetch of fetches) {
          expect(fetch).toMatch(/^python3 -I -S "\$CI_GIT_OWNER" --checkout-git (?:0|120) fetch /u);
          expect(fetch).not.toMatch(/\|\||&&|;|\$\?/u);
        }
        expect(run).not.toMatch(/^\s*(?:timeout|for|while|until)\b|\$\?/mu);
        fetchCalls.push(...fetches);
      }
    }
    expect(fetchCalls).toHaveLength(10);
    expect(fetchCalls.filter((call) => call.includes("--checkout-git 120 fetch"))).toHaveLength(4);
    expect(fetchCalls.filter((call) => call.includes("--checkout-git 0 fetch"))).toHaveLength(6);
    for (const job of selectedJobs) {
      expect(job.environment).toBe("qa-live-shared");
      expect(job.steps.slice(0, 7).map((entry: WorkflowStep) => entry.name)).toEqual(
        TRUSTED_QA_STEPS,
      );
      const checkouts = job.steps.filter((entry: WorkflowStep) =>
        entry.uses?.startsWith("actions/checkout@"),
      );
      expect(checkouts).toHaveLength(1);
      expect(checkouts[0]).toMatchObject({
        uses: CHECKOUT_V6,
        with: { repository: "openclaw/openclaw", ref: "main", "persist-credentials": false },
      });
      const restore = step(job, "Restore trusted QA harness revision");
      expect(restore.env).toMatchObject({
        EXPECTED_WORKFLOW_SHA: "${{ needs.validate_selected_ref.outputs.workflow_sha }}",
      });
      expect(restore["working-directory"]).toBeUndefined();
      expect(restore.run).toContain('test "$(git rev-parse HEAD)" = "$EXPECTED_WORKFLOW_SHA"');
      expect(
        job.steps.some((entry: WorkflowStep) => entry.uses?.startsWith("actions/cache/")),
      ).toBe(false);
      expect(step(job, "Setup Node environment").with).toMatchObject({
        "install-deps": "false",
        "cache-mode": "off",
      });
      const selected = step(job, "Checkout selected ref");
      expect(selected.env?.EXPECTED_SHA).toBe(
        "${{ needs.validate_selected_ref.outputs.selected_revision }}",
      );
      expect(selected).not.toHaveProperty("uses");
      expect(selected["working-directory"]).toBeUndefined();
      expectIncludes(selected.run, [
        "[[ ! -e selected ]]",
        'test "$(git rev-parse HEAD)" = "$EXPECTED_SHA"',
      ]);
      const install = step(job, "Install selected dependencies");
      expect(install["working-directory"]).toBe("selected");
      expect(install.run).toContain('--store-dir "$RUNNER_TEMP/openclaw-qa-selected-pnpm-store"');
      for (const name of [
        "Build private QA runtime",
        ...(job === qa.jobs.plan_qa_profile
          ? ["Resolve taxonomy profile shards"]
          : job === qa.jobs.run_qa_profile_shard
            ? [
                "Fetch protocol comparison base",
                "Ensure Playwright Chromium",
                "Run QA profile shard",
                "Validate QA profile shard evidence",
              ]
            : ["Aggregate validated shard evidence", "Finalize QA profile evidence"]),
      ]) {
        expect(step(job, name)["working-directory"]).toBe("selected");
      }
    }

    for (const trigger of ["workflow_dispatch", "workflow_call"]) {
      expect(qa.on[trigger].inputs.allow_failures).toMatchObject({
        default: false,
        type: "boolean",
      });
    }
    expect(maturity.on.workflow_call.inputs.allow_failures).toMatchObject({
      default: false,
      type: "boolean",
    });
    expect(maturity.on.workflow_dispatch.inputs.allow_failures).toMatchObject({
      default: true,
      type: "boolean",
    });
    expect(maturity.on.workflow_call.inputs).not.toHaveProperty("publish_pull_request");
    expect(maturity.jobs.generate_qa_evidence.with).toMatchObject({
      ref: "${{ needs.validate_selected_ref.outputs.selected_revision }}",
      trusted_ref: "${{ inputs.ref }}",
      expected_sha: "${{ needs.validate_selected_ref.outputs.selected_revision }}",
      allow_failures: "${{ inputs.allow_failures }}",
    });
    expect(
      step(qa.jobs.aggregate_qa_profile, "Fail if QA profile failed").env?.ALLOW_FAILURES,
    ).toBe("${{ inputs.allow_failures }}");
    const aggregate = step(qa.jobs.aggregate_qa_profile, "Aggregate validated shard evidence");
    expectIncludes(aggregate.run, [
      "Expected ${SHARD_COUNT} completed status and evidence files",
      "Timed-out QA shard cannot contribute partial evidence",
    ]);
    expect(step(qa.jobs.aggregate_qa_profile, "Upload QA profile evidence").if).toBe(
      "always() && steps.evidence.outcome == 'success'",
    );

    const publisherCondition = [
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
      expect(step(job, name).if?.replace(/\s+/gu, " ")).toBe(publisherCondition);
      expect(step(job, name).with).toMatchObject({
        "contents-client-id": "Iv23liOECG0slfuhz093",
        "contents-private-key": "${{ secrets.CLAWSWEEPER_APP_PRIVATE_KEY }}",
        "pull-request-client-id": MANTIS_GITHUB_APP_CLIENT_ID,
        "pull-request-private-key": "${{ secrets.MANTIS_GITHUB_APP_PRIVATE_KEY }}",
      });
      expect(step(job, "Checkout trusted workflow source")).toMatchObject({
        uses: CHECKOUT_V6,
        with: {
          repository: "${{ needs.validate_selected_ref.outputs.workflow_repository }}",
          ref: "${{ needs.validate_selected_ref.outputs.workflow_sha }}",
          "persist-credentials": false,
        },
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
    expect(step(maturity.jobs.publish_generated_pr, "Checkout selected ref")).toMatchObject({
      uses: CHECKOUT_V6,
      with: {
        ref: "${{ needs.validate_selected_ref.outputs.selected_revision }}",
        path: "selected",
        "persist-credentials": false,
      },
    });
    const publish = step(maturity.jobs.publish_generated_pr, "Open or update generated docs PR");
    expect(publish).toMatchObject({
      uses: "./.github/actions/publish-generated-pr",
      with: {
        "base-branch": "${{ needs.validate_selected_ref.outputs.publication_base }}",
        "head-branch": "${{ needs.validate_selected_ref.outputs.publication_head }}",
        "working-directory": "selected",
        "invalidation-paths": "",
        "overlap-policy": "fail",
      },
    });
    expect(String(publish.with?.["generated-paths"]).trim().split("\n")).toEqual(
      MATURITY_GENERATED_PR_PATHS,
    );
    const source = readFileSync(".github/workflows/maturity-scorecard.yml", "utf8");
    expectExcludes(source, [
      "permission-pull-requests: write",
      "GH_APP_PRIVATE_KEY",
      "gh auth setup-git",
      "git push --force-with-lease",
    ]);
  });

  it.skipIf(process.platform === "win32").each<{
    name: string;
    evidence: (scenarioId: string) => unknown;
    expected: readonly [string, string];
    accessors?: boolean;
  }>([
    {
      name: "passing retry from the canonical owner",
      evidence: (scenarioId) =>
        workflowOccurrenceEvidence([{ scenarioId, attempts: ["fail", "pass"], selected: 1 }]),
      expected: ["pass", "pass"],
    },
    ...(["full", "slim"] as const).map((evidenceMode) => ({
      name: `v2 ${evidenceMode} without new API exports`,
      evidence: (scenarioId: string) => legacyEvidence(scenarioId, ["fail", "pass"], evidenceMode),
      expected: ["fail", "fail\npass"] as const,
      accessors: false,
    })),
    ...(
      [
        ["unresolved first", null, [], undefined, ["null", "null\npass"]],
        ["foreign first owner", "another-scenario", ["pass"], 0, ["null", "pass"]],
        ["nonpassing retry", null, ["fail", "blocked"], 0, ["fail", "fail\npass"]],
      ] as const
    ).map(([name, firstId, attempts, selected, expected]) => ({
      name,
      evidence: (scenarioId: string) =>
        workflowOccurrenceEvidence(
          [
            { scenarioId: firstId ?? scenarioId, attempts: [...attempts], selected },
            { scenarioId, attempts: ["pass"], selected: 0 },
          ],
          "slim",
        ),
      expected,
    })),
    {
      name: "legacy summary only when evidence is absent",
      evidence: () => undefined,
      expected: ["pass", "pass"],
    },
  ])("Mantis evidence readers retain $name", ({ evidence, expected, accessors = true }) => {
    for (const [index, kind] of (["status-reactions", "thread-attachment"] as const).entries()) {
      const scenarioId = mantisScenarioId(kind);
      const result = runMantisEvidenceReader(kind, evidence(scenarioId), accessors);
      expectSuccess(result);
      expect(result.stdout.trim()).toBe(expected[index]);
    }
  });

  it
    .skipIf(process.platform === "win32")
    .each(["invalid JSON", "null", "invalid binding", "missing v3 accessor"])(
    "Mantis evidence readers reject %s without legacy fallback",
    (invalid) => {
      for (const kind of ["status-reactions", "thread-attachment"] as const) {
        const scenarioId = mantisScenarioId(kind);
        const evidence = workflowOccurrenceEvidence([
          { scenarioId, attempts: ["pass"], selected: 0 },
        ]);
        if (invalid === "invalid binding") {
          evidence.entries[0]!.binding.occurrenceId = "foreign";
        }
        const input = invalid === "invalid JSON" ? "{" : invalid === "null" ? null : evidence;
        const result = runMantisEvidenceReader(kind, input, invalid !== "missing v3 accessor");
        expect(result.status, `${result.stdout}${result.stderr}`).not.toBe(0);
        expect(result.stderr).toContain(
          invalid === "invalid JSON"
            ? "SyntaxError"
            : invalid === "missing v3 accessor"
              ? "scenario reader"
              : "ZodError",
        );
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
      mkdirSync(path.join(selectedRoot, "extensions/qa-lab/src"), { recursive: true });
      writeFileSync(
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
      writeJson(evidencePath, { ...originalEvidence, evidenceMode: "slim" });
      expectSuccess(runConsumer());
      expect(readFileSync(manifestPath, "utf8")).toBe(completeManifest);

      const profileOccurrences = (attempts: qaEvidence.QaEvidenceStatus[], retry = true) => ({
        ...originalEvidence,
        ...workflowOccurrenceEvidence([
          { scenarioId: "scenario-one", attempts, selected: 1, retry },
        ]),
        profile: originalEvidence.profile,
        profilePlan: originalEvidence.profilePlan,
        scorecard,
      });
      const retryEvidence = profileOccurrences(["fail", "pass"]);
      writeJson(evidencePath, retryEvidence);
      expectFailure(runConsumer(), "requires the selected checkout's effective-entry reader");
      writeWorkflowEvidenceApi(selectedRoot);

      for (const evidenceMode of ["full", "slim"] as const) {
        writeJson(evidencePath, { ...retryEvidence, evidenceMode });
        expectSuccess(runProducer("0"));
        expect(readJson(manifestPath).profilePlanSha256).toBe(
          JSON.parse(completeManifest).profilePlanSha256,
        );
        expectConsumerOutput({ scorecard_passed: true, passed_count: 1, failed_count: 0 });
      }

      for (const obligation of ["required", "advisory"] as const) {
        const declared = {
          ...retryEvidence,
          profilePlan: {
            ...retryEvidence.profilePlan,
            proofRequirements: [
              {
                id: "observed-protocol",
                coverageId: "qa.reporting",
                obligation,
                owner: "fixture-owner",
                acceptedRef: "qa/fixtures/acceptance",
                retryAcceptance: "selected-attempt",
                alternatives: [{ protocol: "gateway:3" }],
              },
            ],
          },
        };
        writeJson(evidencePath, declared);
        const producer = runProducer("0");
        expectSuccess(producer);
        const consumer = runConsumer();
        expect(consumer.status, `${consumer.stdout}${consumer.stderr}`).toBe(
          obligation === "required" ? 1 : 0,
        );
        if (obligation === "required") {
          expect(`${consumer.stdout}${consumer.stderr}`).toContain(
            "observed-protocol (insufficient)",
          );
        }
      }
      writeFileSync(manifestPath, completeManifest);

      for (const status of ["fail", "blocked"] as const) {
        // Parent failure is independent of the child, not a retry of its pass.
        writeJson(evidencePath, profileOccurrences(["pass", status], false));
        expectConsumerOutput({
          scorecard_passed: false,
          passed_count: 1,
          [`${status === "fail" ? "failed" : "blocked"}_count`]: 1,
        });
      }

      writeJson(evidencePath, retryEvidence);
      writeJson(manifestPath, { ...JSON.parse(completeManifest), qaPassed: false });
      expectConsumerOutput({ scorecard_passed: false });
      writeJson(manifestPath, { ...JSON.parse(completeManifest), targetSha: protocolBaseSha });
      expectFailure(runConsumer(), "does not match selected ref");
      writeFileSync(manifestPath, completeManifest);
      const invalidBinding = structuredClone(retryEvidence);
      invalidBinding.entries[0]!.binding.occurrenceId = "foreign";
      writeJson(evidencePath, invalidBinding);
      expect(runConsumer().status).toBe(1);

      writeEvidence("fail");
      expectConsumerOutput({ scorecard_passed: false, failed_count: 1 });

      const manifest = JSON.parse(completeManifest) as Record<string, unknown>;
      manifest.profilePlanSha256 = "0".repeat(64);
      writeJson(manifestPath, manifest, "\n");
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

  it("keeps exact release validation identity separate from release context", () => {
    const fullReleaseWorkflow = readWorkflow(".github/workflows/full-release-validation.yml");
    const releaseWorkflow = readReleaseChecksWorkflow();
    const telegramWorkflow = readWorkflow(".github/workflows/openclaw-release-telegram-qa.yml");
    const fullReleaseDispatchStep = step(
      fullReleaseWorkflow.jobs.release_checks_candidate,
      "Dispatch release checks candidate phase",
    );
    const dispatchStep = step(
      releaseWorkflow.jobs.qa_live_telegram_release_checks,
      "Dispatch and await trusted Telegram QA",
    );
    const identityStep = step(
      telegramWorkflow.jobs.trusted_identity,
      "Verify dispatched workflow identity",
    );
    const provenanceSteps = [
      step(telegramWorkflow.jobs.build_candidate, "Validate candidate release provenance"),
      step(telegramWorkflow.jobs.run_telegram, "Revalidate candidate release provenance"),
    ];

    for (const workflow of [fullReleaseWorkflow, releaseWorkflow, telegramWorkflow]) {
      expect(workflow.on.workflow_dispatch.inputs.target_context_ref).toMatchObject({
        required: false,
        default: "",
        type: "string",
      });
    }
    expectIncludes(fullReleaseDispatchStep.run, [
      '-f ref="$TARGET_SHA"',
      '-f target_context_ref="$TARGET_CONTEXT_REF"',
    ]);
    expect(fullReleaseDispatchStep.run).not.toContain(
      'release_checks_target_ref="${TARGET_CONTEXT_REF:-$TARGET_REF}"',
    );
    expect(dispatchStep.env).toMatchObject({
      TARGET_SHA: "${{ needs.resolve_target.outputs.revision }}",
      TARGET_CONTEXT_REF: "${{ inputs.target_context_ref }}",
    });
    expectIncludes(dispatchStep.run, [
      '-f target_context_ref="$TARGET_CONTEXT_REF"',
      '-f target_ref="$TARGET_SHA"',
    ]);
    expect(dispatchStep.run).not.toContain("telegram_target_ref=");
    expectIncludes(identityStep.run, [
      "Telegram QA target context must be a canonical release branch or tag.",
      "Telegram QA release context requires an exact-SHA target ref.",
    ]);
    for (const provenanceStep of provenanceSteps) {
      expect(provenanceStep.env.TARGET_CONTEXT_REF).toBe("${{ inputs.target_context_ref }}");
      expect(provenanceStep.run.trim()).toBe(
        'bash "${GITHUB_WORKSPACE}/scripts/release-telegram-provenance.sh"',
      );
    }
  });

  it("checks out the complete trusted Release Decision scripts tree", () => {
    const workflow = readWorkflow(".github/workflows/full-release-validation.yml");
    const checkout = step(workflow.jobs.release_decision, "Checkout release decision tooling");

    expect(checkout?.with).toMatchObject({
      ref: "${{ github.sha }}",
      "sparse-checkout": "scripts",
      "sparse-checkout-cone-mode": false,
      "persist-credentials": false,
    });
  });
});
