import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import * as qaEvidence from "../../extensions/qa-lab/test-api.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import {
  CHECKOUT_V6,
  DOWNLOAD_ARTIFACT_V8,
  MANTIS_GITHUB_APP_CLIENT_ID,
  MATURITY_SCORECARD_WORKFLOW,
  TSX_IMPORT,
  UPLOAD_ARTIFACT_V7,
  evaluateWorkflowRunner,
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
    occurrences.push({
      id: anchorId,
      parentCell,
      scenario: {
        kind: "instance",
        resultOccurrenceId:
          instance.selected === undefined ? null : `${anchorId}-attempt-${instance.selected}`,
      },
      retryOf: null,
      terminalStatus: null,
      assertions: null,
      launch: identity,
      receipts: [],
    });
    for (const [attempt, status] of instance.attempts.entries()) {
      const id = `${anchorId}-attempt-${attempt}`;
      occurrences.push({
        id,
        parentCell,
        scenario: { kind: "observation", instanceOccurrenceId: anchorId },
        retryOf:
          attempt === 0 || instance.retry === false ? null : `${anchorId}-attempt-${attempt - 1}`,
        terminalStatus: status,
        assertions: null,
        launch: identity,
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
  writeFileSync(
    path.join(root, "tsconfig.json"),
    JSON.stringify({ extends: path.resolve("tsconfig.json") }),
  );
  const source = pathToFileURL(path.resolve("extensions/qa-lab/src/evidence-summary.ts")).href;
  // Historical checkouts can validate v2 without exporting the v3 readers.
  writeFileSync(
    apiPath,
    `export { validateQaEvidenceSummaryJson${accessors ? ", getEffectiveQaEvidenceEntries, projectQaEvidenceScenarioOutcomes" : ""} } from ${JSON.stringify(source)};\n`,
  );
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
  const scenarioId =
    kind === "status-reactions"
      ? "discord-status-reactions-tool-only"
      : "discord-thread-reply-filepath-attachment";
  writeFileSync(
    path.join(outputDir, "discord-qa-summary.json"),
    JSON.stringify({ scenarios: [{ id: scenarioId, status: "pass" }] }),
  );
  const workflow = readWorkflow(`.github/workflows/mantis-discord-${kind}.yml`);
  const job = kind === "status-reactions" ? "run_status_reactions" : "run_thread_attachment";
  const script = expectDefined(
    workflow.jobs[job].steps.find((step: WorkflowStep) => step.id === "run_mantis")?.run,
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
      env: { ...process.env, GITHUB_WORKSPACE: root },
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
  const authorizeStep = workflow.jobs.validate_selected_ref.steps.find(
    (step: { name?: string }) => step.name === "Authorize workflow invocation",
  );
  const authorizeRun = spawnSync("bash", ["-c", authorizeStep.run], {
    encoding: "utf8",
    env: {
      CALLER_EVENT_NAME: options.callerEventName,
      CALLER_WORKFLOW_REF: options.callerWorkflowRef,
      JOB_WORKFLOW_FILE_PATH: MATURITY_SCORECARD_WORKFLOW,
      JOB_WORKFLOW_REF: options.jobWorkflowRef ?? MATURITY_SCORECARD_WORKFLOW_REF,
      JOB_WORKFLOW_REPOSITORY: "openclaw/openclaw",
      PATH: process.env.PATH ?? "",
      PUBLISH_PULL_REQUEST: String(options.publishPullRequest),
    },
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
  const copyStep = workflow.jobs.publish_generated_pr.steps.find(
    (step: { name?: string }) => step.name === "Validate and copy generated PR files",
  );
  const root = mkdtempSync(path.join(tmpdir(), "openclaw-maturity-copy-"));
  const staging = path.join(root, "staging");
  try {
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
    const run = spawnSync("bash", ["-c", copyStep.run], {
      cwd: root,
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", STAGING_DIR: staging },
    });
    return {
      copied: MATURITY_GENERATED_PR_PATHS.map((generatedPath) =>
        readFileSync(path.join(root, "selected", generatedPath), "utf8"),
      ),
      escaped: existsSync(escaped) ? readFileSync(escaped, "utf8") : "",
      output: `${run.stdout}${run.stderr}`,
      status: run.status,
    };
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

function readQaProfileEvidenceWorkflow() {
  return parse(readFileSync(".github/workflows/qa-profile-evidence.yml", "utf8"));
}

type QaProfileTimeoutFixtureMode = "natural-124" | "self-kill" | "term" | "kill";

function runQaProfileTimeoutFixture(mode: QaProfileTimeoutFixtureMode) {
  const root = mkdtempSync(path.join(tmpdir(), "openclaw-qa-profile-timeout-"));
  try {
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
    const runProfileStep = expectDefined(
      workflow.jobs.run_qa_profile_shard.steps.find(
        (step: WorkflowStep) => step.name === "Run QA profile shard",
      ),
      "Run QA profile shard step",
    );
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
    const outputDir = path.join(
      selectedRoot,
      ".artifacts",
      "qa-e2e",
      "profile-all-42-1",
      "shard-01",
    );
    const status = JSON.parse(
      readFileSync(path.join(outputDir, "qa-profile-run-status.json"), "utf8"),
    ) as {
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
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

function runQaProfileFailureGate(options: { allowFailures: boolean; qaExitCode?: string }) {
  const workflow = readQaProfileEvidenceWorkflow();
  const failStep = workflow.jobs.aggregate_qa_profile.steps.find(
    (step: WorkflowStep) => step.name === "Fail if QA profile failed",
  );
  return spawnSync("bash", ["-c", failStep.run], {
    encoding: "utf8",
    env: {
      ALLOW_FAILURES: String(options.allowFailures),
      PATH: process.env.PATH ?? "",
      QA_EXIT_CODE: options.qaExitCode ?? "",
      QA_PROFILE: "all",
    },
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

  writeProtocolDescriptor(origin, [{ name: "sessions.patchMany", since: "2026.8" }]);
  const mainHead = commitProtocolFixture(origin, "add main protocol method");
  runGit(origin, ["tag", mainReleaseTag]);
  writeFileSync(path.join(origin, "main-tip.txt"), "later main tip\n");
  commitProtocolFixture(origin, "advance main");

  runGit(origin, ["checkout", "-q", "-b", "compatibility/restore", mainBase]);
  writeProtocolDescriptor(origin, [
    {
      name: "gateway.restart.preflight",
      since: "<=2026.7",
      compatibilityRestored: true,
    },
  ]);
  const compatibilityHead = commitProtocolFixture(origin, "restore compatibility method");

  runGit(origin, ["checkout", "-q", "-b", "compatibility/invalid", mainBase]);
  writeProtocolDescriptor(origin, [
    {
      name: "gateway.restart.invalid",
      since: "2026.8",
      compatibilityRestored: true,
    },
  ]);
  const invalidCompatibilityHead = commitProtocolFixture(
    origin,
    "mislabel new method as compatibility",
  );

  runGit(origin, ["checkout", "-q", "-b", releaseBranch, mainBase]);
  writeProtocolDescriptor(origin, [{ name: "sessions.releaseOnly" }]);
  const releaseHead = commitProtocolFixture(origin, "add release protocol method");

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
  const validateStep = expectDefined(
    readQaProfileEvidenceWorkflow().jobs.validate_selected_ref.steps.find(
      (step: WorkflowStep) => step.name === "Validate selected ref",
    ),
    "QA profile selected-ref validation step",
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
  ]) {
    const target = path.join(checkout, scriptPath);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, readFileSync(scriptPath, "utf8"));
  }
  writeFileSync(
    path.join(checkout, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        paths: {
          "@openclaw/normalization-core/record-coerce": [
            "./packages/normalization-core/src/record-coerce.ts",
          ],
        },
      },
    }),
  );
  const nodeModules = path.join(checkout, "node_modules");
  if (!existsSync(nodeModules)) {
    symlinkSync(TYPESCRIPT_NODE_MODULES, nodeModules, "dir");
  }
  return runWorkflowShellScript(
    `${quoteShell(process.execPath)} --import ${quoteShell(TSX_IMPORT)} scripts/check-protocol-since.mts`,
    {
      cwd: checkout,
      env: { ...process.env, PROTOCOL_SINCE_BASE_SHA: baseSha },
    },
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
        expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
        expect(result.outputs).toEqual({
          protocol_base_revision: protocolBase,
          selected_revision: revision,
          trusted_reason: trustedReason,
        });
      }

      runGit(topology.checkout, ["checkout", "-q", "--detach", topology.mainHead]);
      const mainCheck = runProtocolSinceFixture(topology.checkout, topology.mainBase);
      expect(mainCheck.status, `${mainCheck.stdout}${mainCheck.stderr}`).toBe(0);
      expect(mainCheck.stdout).toContain("1 new core method");

      runGit(topology.checkout, ["checkout", "-q", "--detach", topology.compatibilityHead]);
      const compatibilityCheck = runProtocolSinceFixture(topology.checkout, topology.mainBase);
      expect(
        compatibilityCheck.status,
        `${compatibilityCheck.stdout}${compatibilityCheck.stderr}`,
      ).toBe(0);
      expect(compatibilityCheck.stdout).toContain("1 restored compatibility method");

      runGit(topology.checkout, ["checkout", "-q", "--detach", topology.invalidCompatibilityHead]);
      const invalidCompatibilityCheck = runProtocolSinceFixture(
        topology.checkout,
        topology.mainBase,
      );
      expect(invalidCompatibilityCheck.status).not.toBe(0);
      expect(invalidCompatibilityCheck.stderr).toContain(
        "restored compatibility methods must retain <= vintage metadata",
      );

      runGit(topology.checkout, ["checkout", "-q", "--detach", topology.releaseHead]);
      const releaseCheck = runProtocolSinceFixture(topology.checkout, topology.mainBase);
      expect(releaseCheck.status).not.toBe(0);
      expect(releaseCheck.stderr).toContain("sessions.releaseOnly is missing since metadata");

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
      const stepNames = runJob.steps.map((step: WorkflowStep) => step.name);
      const buildStep = expectDefined(
        runJob.steps.find((step: WorkflowStep) => step.name === "Build private QA runtime"),
        "private QA runtime build",
      );
      const fetchStep = expectDefined(
        runJob.steps.find((step: WorkflowStep) => step.name === "Fetch protocol comparison base"),
        "protocol comparison base fetch",
      );
      const runStep = expectDefined(
        runJob.steps.find((step: WorkflowStep) => step.name === "Run QA profile shard"),
        "QA profile shard run",
      );
      const evidenceStep = expectDefined(
        aggregateJob.steps.find(
          (step: WorkflowStep) => step.name === "Finalize QA profile evidence",
        ),
        "QA profile evidence finalization",
      );
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
      const validateStep = expectDefined(
        validateJob.steps.find((step: WorkflowStep) => step.name === "Validate selected ref"),
        "QA selected-ref validation",
      );
      expect(validateStep.env.INPUT_REF).toBe(trustedInput);
      const ordered = [
        "Checkout trusted QA harness",
        "Restore trusted QA harness revision",
        "Setup Node environment",
        "Checkout selected ref",
        "Install selected dependencies",
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
      expect(success.status, `${success.stdout}${success.stderr}`).toBe(0);
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

  it("pins the QA Git owner before checkouts and preserves all ten terminal fetch contracts", () => {
    const workflow = readQaProfileEvidenceWorkflow();
    const gitJobs = [
      "validate_selected_ref",
      "plan_qa_profile",
      "run_qa_profile_shard",
      "aggregate_qa_profile",
    ];
    const calls: string[] = [];
    for (const job of gitJobs) {
      const steps = workflow.jobs[job].steps as WorkflowStep[];
      const ownerIndex = steps.findIndex((step) => step.name === "Prepare Git owner");
      expect(steps.filter((step) => step.name === "Prepare Git owner")).toHaveLength(1);
      expect(steps[ownerIndex]).toEqual({
        name: "Prepare Git owner",
        uses: "openclaw/openclaw/.github/actions/git-owner@dd4528b6393e7d00063067a080ca7241b48ce475",
      });
      expect(steps[ownerIndex - 1]?.name).toBe(
        job === "validate_selected_ref"
          ? "Resolve job workflow identity"
          : "Require authorized workflow actor",
      );
      expect(steps[ownerIndex + 1]?.name).toBe(
        job === "validate_selected_ref" ? "Checkout selected ref" : "Checkout trusted QA harness",
      );
      expect(steps.some((step) => step.uses?.startsWith("actions/setup-python@"))).toBe(false);
      for (const step of steps) {
        const run = (step.run ?? "").replace(/[ \t]*\\\n[ \t]*/gu, " ");
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
        calls.push(...fetches);
      }
    }
    expect(calls).toHaveLength(10);
    expect(calls.filter((call) => call.includes("--checkout-git 120 fetch"))).toHaveLength(4);
    expect(calls.filter((call) => call.includes("--checkout-git 0 fetch"))).toHaveLength(6);
    const validateSelectedRef = expectDefined(
      workflow.jobs.validate_selected_ref.steps.find(
        (step: WorkflowStep) => step.name === "Validate selected ref",
      ),
      "QA profile selected-ref validation step",
    );
    expect(validateSelectedRef["working-directory"]).toBeUndefined();
    expect(calls.slice(0, 3)).toEqual([
      'python3 -I -S "$CI_GIT_OWNER" --checkout-git 120 fetch --no-tags origin +refs/heads/main:refs/remotes/origin/main',
      'python3 -I -S "$CI_GIT_OWNER" --checkout-git 120 fetch --no-tags origin "+refs/tags/${tag_candidate}:refs/tags/${tag_candidate}"',
      'python3 -I -S "$CI_GIT_OWNER" --checkout-git 120 fetch --no-tags origin "+refs/heads/${branch_candidate}:refs/remotes/origin/${branch_candidate}"',
    ]);
    expect(validateSelectedRef.run).toContain(
      'release_tag_sha="$(git rev-parse "refs/tags/${tag_candidate}^{commit}")"',
    );
    expect(validateSelectedRef.run).toContain(
      'release_branch_sha="$(git rev-parse "refs/remotes/origin/${branch_candidate}")"',
    );
    for (const name of ["Restore trusted QA harness revision", "Checkout selected ref"]) {
      const bodies = gitJobs
        .slice(1)
        .map(
          (job) => workflow.jobs[job].steps.find((step: WorkflowStep) => step.name === name)?.run,
        );
      expect(bodies[0]).toBeTypeOf("string");
      expect(new Set(bodies).size).toBe(1);
    }
    const protocolFetch = workflow.jobs.run_qa_profile_shard.steps.find(
      (step: WorkflowStep) => step.name === "Fetch protocol comparison base",
    );
    expect(protocolFetch["working-directory"]).toBe("selected");
    expect(calls[7]).toBe(
      'python3 -I -S "$CI_GIT_OWNER" --checkout-git 120 fetch --no-tags --no-recurse-submodules --depth=1 origin "+${PROTOCOL_SINCE_BASE_SHA}:refs/remotes/origin/qa-protocol-base"',
    );
    expect(protocolFetch.run).toContain(
      'test "$(git rev-parse refs/remotes/origin/qa-protocol-base^{commit})" = "$PROTOCOL_SINCE_BASE_SHA"',
    );
    expect(readFileSync(".github/workflows/qa-profile-evidence.yml", "utf8")).not.toMatch(
      /\bgit(?: -C selected)? fetch\b/u,
    );
  });

  it.skipIf(process.platform !== "linux")(
    "classifies QA timeouts only from isolated supervisor diagnostics",
    () => {
      const scenarios = [
        {
          exitCode: 124,
          mode: "natural-124",
          supervisorSignals: [],
          timedOut: false,
          timeoutOutcome: "none",
        },
        {
          exitCode: 137,
          mode: "self-kill",
          supervisorSignals: [],
          timedOut: false,
          timeoutOutcome: "none",
        },
        {
          exitCode: 124,
          mode: "term",
          supervisorSignals: ["TERM"],
          timedOut: true,
          timeoutOutcome: "term",
        },
        {
          exitCode: 137,
          mode: "kill",
          supervisorSignals: ["TERM", "KILL"],
          timedOut: true,
          timeoutOutcome: "kill",
        },
      ] as const;

      for (const scenario of scenarios) {
        const result = runQaProfileTimeoutFixture(scenario.mode);
        expect(result.commandStatus, `${result.stdout}\n${result.stderr}`).toBe(0);
        expect(result.status).toMatchObject({
          exitCode: scenario.exitCode,
          target: { protocolBaseSha: "b".repeat(40) },
          timedOut: scenario.timedOut,
          timeoutOutcome: scenario.timeoutOutcome,
        });
        expect(result.githubOutput).toContain(`qa_exit_code=${scenario.exitCode}`);
        expect(result.stderr).toContain(`child-stderr-sentinel:${scenario.mode}`);
        expect(result.stderr).toContain("child-locale:POSIX");
        expect(result.timeoutVersion).not.toBe("");

        const supervisorSignals: readonly ("TERM" | "KILL")[] = scenario.supervisorSignals;
        for (const signal of ["TERM", "KILL"] as const) {
          const diagnostic = `timeout: sending signal ${signal} to command 'env'`;
          if (supervisorSignals.includes(signal)) {
            expect(result.timeoutSupervisorLog).toContain(diagnostic);
          } else {
            expect(result.timeoutSupervisorLog).not.toContain(diagnostic);
          }
        }

        if (scenario.mode === "natural-124") {
          expect(result.stderr).toContain(
            "timeout: sending signal KILL to command 'spoofed-child'",
          );
          expect(result.timeoutSupervisorLog).not.toContain("spoofed-child");
        }
        if (scenario.timeoutOutcome === "term") {
          expect(result.stdout).toContain(
            "::warning::QA profile 'all' timed out after 0.4 seconds and was terminated",
          );
        } else if (scenario.timeoutOutcome === "kill") {
          expect(result.stdout).toContain(
            "::warning::QA profile 'all' timed out after 0.4 seconds and required SIGKILL after the 0.05-second grace period",
          );
        } else {
          expect(result.stdout).not.toContain("::warning::QA profile");
        }
      }
    },
  );

  it("keeps maturity scorecard generated QA evidence handoff strict", () => {
    const maturityWorkflow = readMaturityScorecardWorkflow();
    const qaEvidenceWorkflow = readQaProfileEvidenceWorkflow();
    const generateJob = maturityWorkflow.jobs.generate_qa_evidence;
    const publisherPreflight = maturityWorkflow.jobs.publisher_preflight;
    const publishJob = maturityWorkflow.jobs.publish;
    const publishPrJob = maturityWorkflow.jobs.publish_generated_pr;
    const qaAuthorizeJob = qaEvidenceWorkflow.jobs.authorize_actor;
    const qaPlanJob = qaEvidenceWorkflow.jobs.plan_qa_profile;
    const qaShardJob = qaEvidenceWorkflow.jobs.run_qa_profile_shard;
    const qaAggregateJob = qaEvidenceWorkflow.jobs.aggregate_qa_profile;
    const qaValidateJob = qaEvidenceWorkflow.jobs.validate_selected_ref;

    expect(maturityWorkflow.on.workflow_call.inputs).toMatchObject({
      qa_evidence_run_id: {
        description: "Optional workflow run id containing qa-evidence.json",
        required: false,
        default: "",
        type: "string",
      },
      ref: {
        description: "OpenClaw branch, tag, or SHA containing the maturity score source",
        required: true,
        type: "string",
      },
      expected_sha: {
        description: "Optional full SHA that ref must resolve to",
        required: false,
        default: "",
        type: "string",
      },
      allow_failures: {
        description: "Allow rendering from valid incomplete QA evidence",
        required: false,
        default: false,
        type: "boolean",
      },
    });
    expect(maturityWorkflow.on.workflow_dispatch.inputs.allow_failures).toEqual({
      description: "Allow rendering from valid incomplete QA evidence",
      required: false,
      default: true,
      type: "boolean",
    });
    expect(maturityWorkflow.on.workflow_dispatch.inputs.publish_pull_request).toEqual({
      description: "Open or update a pull request for generated maturity files",
      required: false,
      default: true,
      type: "boolean",
    });
    expect(maturityWorkflow.on.workflow_call.inputs).not.toHaveProperty("publish_pull_request");
    expect(maturityWorkflow.on.workflow_call.secrets.OPENAI_API_KEY.required).toBe(true);
    expect(
      maturityWorkflow.on.workflow_call.secrets.OPENCLAW_MATURITY_SCORECARD_AGENT_OPENAI_API_KEY
        .required,
    ).toBe(false);
    expect(Object.keys(maturityWorkflow.on.workflow_call.secrets).toSorted()).toEqual([
      "CLAWSWEEPER_APP_PRIVATE_KEY",
      "MANTIS_GITHUB_APP_PRIVATE_KEY",
      "OPENAI_API_KEY",
      "OPENCLAW_MATURITY_SCORECARD_AGENT_OPENAI_API_KEY",
      "OPENCLAW_QA_CONVEX_SECRET_CI",
      "OPENCLAW_QA_CONVEX_SITE_URL",
    ]);
    for (const secret of [
      "CLAWSWEEPER_APP_PRIVATE_KEY",
      "MANTIS_GITHUB_APP_PRIVATE_KEY",
      "OPENCLAW_QA_CONVEX_SECRET_CI",
      "OPENCLAW_QA_CONVEX_SITE_URL",
    ]) {
      expect(maturityWorkflow.on.workflow_call.secrets[secret].required).toBe(false);
    }
    expect(qaEvidenceWorkflow.on.workflow_dispatch.inputs).not.toHaveProperty("fail_on_qa_failure");
    expect(qaEvidenceWorkflow.on.workflow_call.inputs).not.toHaveProperty("fail_on_qa_failure");
    for (const trigger of ["workflow_dispatch", "workflow_call"] as const) {
      expect(qaEvidenceWorkflow.on[trigger].inputs.allow_failures).toEqual({
        description: "Continue after validated QA result failures",
        required: false,
        default: false,
        type: "boolean",
      });
    }
    expect(qaEvidenceWorkflow.on.workflow_dispatch.inputs.qa_profile).not.toHaveProperty("options");
    expect(qaEvidenceWorkflow.on.workflow_dispatch.inputs.qa_profile.default).toBe("all");
    expect(qaEvidenceWorkflow.on.workflow_call.inputs.qa_profile.type).toBe("string");
    for (const outputName of [
      "artifact_name",
      "qa_profile",
      "qa_exit_code",
      "qa_passed",
      "target_sha",
      "trusted_reason",
      "qa_evidence_path",
    ]) {
      expect(qaEvidenceWorkflow.on.workflow_call.outputs[outputName].value).toContain(
        `jobs.aggregate_qa_profile.outputs.${outputName}`,
      );
    }
    expect(qaPlanJob.needs).toBe("validate_selected_ref");
    expect(qaPlanJob.outputs).toEqual({
      channel_driver: "${{ steps.plan.outputs.channel_driver }}",
      matrix: "${{ steps.plan.outputs.matrix }}",
      profile: "${{ steps.plan.outputs.profile }}",
      shard_count: "${{ steps.plan.outputs.shard_count }}",
    });
    const qaAuthorizeStep = expectDefined(
      qaAuthorizeJob.steps.find(
        (step: WorkflowStep) => step.name === "Require maintainer-level repository access",
      ),
      "QA workflow actor authorization",
    );
    expect(qaAuthorizeStep.env).toEqual({
      CALLER_WORKFLOW_REF: "${{ github.workflow_ref }}",
      JOB_CONTEXT: "${{ toJSON(job) }}",
    });
    expect(qaAuthorizeStep.with?.script).toContain("callerWorkflowRef !== calledWorkflowRef");
    expect(qaAuthorizeStep.with?.script).toContain(
      'job.workflow_repository === "openclaw/openclaw"',
    );
    expect(qaAuthorizeStep.with?.script).toContain("job.workflow_ref === calledWorkflowRef");
    expect(qaAuthorizeStep.with?.script).toContain(
      'core.setOutput("authorized", trustedMainCaller ? "true" : "false")',
    );
    expect(qaValidateJob.outputs.workflow_sha).toBe("${{ steps.workflow.outputs.workflow_sha }}");
    expect(qaValidateJob.outputs).not.toHaveProperty("workflow_repository");
    expect(qaValidateJob.steps[0]).toEqual({
      name: "Setup supported Node runtime",
      uses: "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
      with: { "node-version": "24.19.0", "package-manager-cache": false },
    });
    const workflowIdentityStep = qaValidateJob.steps[1];
    expect(workflowIdentityStep).toMatchObject({
      name: "Resolve job workflow identity",
      id: "workflow",
      env: { JOB_CONTEXT: "${{ toJSON(job) }}" },
    });
    expect(workflowIdentityStep.run).toContain("job.workflow_repository");
    expect(workflowIdentityStep.run).toContain("job.workflow_sha");
    expect(workflowIdentityStep.run).toContain("^[A-Za-z0-9_.-]+\\/[A-Za-z0-9_.-]+$");
    expect(workflowIdentityStep.run).toContain("^[0-9a-f]{40}$");

    const selectedCodeSteps = new Map([
      [qaPlanJob, ["Build private QA runtime", "Resolve taxonomy profile shards"]],
      [
        qaShardJob,
        [
          "Fetch protocol comparison base",
          "Build private QA runtime",
          "Ensure Playwright Chromium",
          "Run QA profile shard",
          "Validate QA profile shard evidence",
        ],
      ],
      [
        qaAggregateJob,
        [
          "Build private QA runtime",
          "Aggregate validated shard evidence",
          "Finalize QA profile evidence",
        ],
      ],
    ]);
    for (const [job, codeStepNames] of selectedCodeSteps) {
      expect(job.environment).toBe("qa-live-shared");
      const stepIndex = (name: string) =>
        job.steps.findIndex((step: WorkflowStep) => step.name === name);
      const permissionStep = expectDefined(
        job.steps.find((step: WorkflowStep) => step.name === "Require authorized workflow actor"),
        "selected QA actor permission check",
      );
      const trustedCheckout = expectDefined(
        job.steps.find((step: WorkflowStep) => step.name === "Checkout trusted QA harness"),
        "trusted QA harness checkout",
      );
      const restoreTrusted = expectDefined(
        job.steps.find((step: WorkflowStep) => step.name === "Restore trusted QA harness revision"),
        "trusted QA harness revision restore",
      );
      const setupStep = expectDefined(
        job.steps.find((step: WorkflowStep) => step.name === "Setup Node environment"),
        "trusted QA harness Node setup",
      );
      const selectedCheckout = expectDefined(
        job.steps.find((step: WorkflowStep) => step.name === "Checkout selected ref"),
        "selected QA checkout",
      );
      const installSelected = expectDefined(
        job.steps.find((step: WorkflowStep) => step.name === "Install selected dependencies"),
        "selected QA dependency install",
      );

      expect(permissionStep).toMatchObject({
        uses: "actions/github-script@3a2844b7e9c422d3c10d287c895573f7108da1b3",
        env: {
          CALLER_WORKFLOW_REF: "${{ github.workflow_ref }}",
          JOB_CONTEXT: "${{ toJSON(job) }}",
        },
      });
      expect(permissionStep.with?.script).toContain("getCollaboratorPermissionLevel");
      expect(permissionStep.with?.script).toContain('new Set(["admin", "maintain", "write"])');
      expect(permissionStep.with?.script).toContain("callerWorkflowRef !== calledWorkflowRef");
      expect(permissionStep.with?.script).toContain(
        'job.workflow_repository === "openclaw/openclaw"',
      );
      expect(permissionStep.with?.script).toContain("job.workflow_ref === calledWorkflowRef");
      expect(permissionStep.with?.script).toContain("if (!trustedMainCaller)");
      expect(trustedCheckout).toMatchObject({
        name: "Checkout trusted QA harness",
        uses: CHECKOUT_V6,
        with: {
          repository: "openclaw/openclaw",
          ref: "main",
          "fetch-depth": 1,
          "persist-credentials": false,
        },
      });
      const checkoutSteps = job.steps.filter((step: WorkflowStep) =>
        step.uses?.startsWith("actions/checkout@"),
      );
      expect(checkoutSteps).toHaveLength(1);
      expect(checkoutSteps[0]?.with).toMatchObject({
        repository: "openclaw/openclaw",
        ref: "main",
      });
      expect(restoreTrusted).toMatchObject({
        env: {
          EXPECTED_WORKFLOW_SHA: "${{ needs.validate_selected_ref.outputs.workflow_sha }}",
        },
        shell: "bash",
      });
      expect(restoreTrusted["working-directory"]).toBeUndefined();
      expect(restoreTrusted.run).toContain("^[0-9a-f]{40}$");
      expect(restoreTrusted.run).toContain(
        'python3 -I -S "$CI_GIT_OWNER" --checkout-git 0 fetch --no-tags --no-recurse-submodules --depth=1 origin "$EXPECTED_WORKFLOW_SHA"',
      );
      expect(restoreTrusted.run).toContain('git checkout --detach "$EXPECTED_WORKFLOW_SHA"');
      expect(restoreTrusted.run).toContain(
        'test "$(git rev-parse HEAD)" = "$EXPECTED_WORKFLOW_SHA"',
      );
      expect(job.steps.some((step: WorkflowStep) => step.uses?.startsWith("actions/cache/"))).toBe(
        false,
      );
      expect(setupStep.with?.["install-deps"]).toBe("false");
      expect(setupStep.with?.["cache-mode"]).toBe("off");
      expect(selectedCheckout).toMatchObject({
        env: {
          EXPECTED_SHA: "${{ needs.validate_selected_ref.outputs.selected_revision }}",
        },
        shell: "bash",
      });
      expect(selectedCheckout).not.toHaveProperty("uses");
      expect(selectedCheckout["working-directory"]).toBeUndefined();
      expect(selectedCheckout.run).toContain("^[0-9a-f]{40}$");
      expect(selectedCheckout.run).toContain("[[ ! -e selected ]]");
      expect(selectedCheckout.run).toContain("git init selected");
      expect(selectedCheckout.run).toContain(
        'git -C selected remote add origin "$GITHUB_SERVER_URL/$GITHUB_REPOSITORY"',
      );
      expect(selectedCheckout.run).toContain(
        'cd selected\npython3 -I -S "$CI_GIT_OWNER" --checkout-git 0 fetch --no-tags --no-recurse-submodules --depth=1 origin "$EXPECTED_SHA"',
      );
      expect(selectedCheckout.run).toContain("git checkout --detach FETCH_HEAD");
      expect(selectedCheckout.run).toContain('test "$(git rev-parse HEAD)" = "$EXPECTED_SHA"');
      expect(
        job.steps.some((step: WorkflowStep) => step.name === "Verify selected checkout SHA"),
      ).toBe(false);
      expect(installSelected["working-directory"]).toBe("selected");
      expect(installSelected.run).toContain(
        '--store-dir "$RUNNER_TEMP/openclaw-qa-selected-pnpm-store"',
      );
      for (const installFlag of [
        "--frozen-lockfile",
        "--config.ignore-scripts=false",
        "--config.engine-strict=false",
        "--config.enable-pre-post-scripts=true",
        "--config.side-effects-cache=true",
      ]) {
        expect(installSelected.run).toContain(installFlag);
      }
      const securitySequence = [
        "Require authorized workflow actor",
        "Prepare Git owner",
        "Checkout trusted QA harness",
        "Restore trusted QA harness revision",
        "Setup Node environment",
        "Checkout selected ref",
        "Install selected dependencies",
      ];
      expect(
        job.steps.slice(0, securitySequence.length).map((step: WorkflowStep) => step.name),
      ).toEqual(securitySequence);
      const ordered = securitySequence.map(stepIndex);
      expect(ordered.every((index, position) => index > (ordered[position - 1] ?? -1))).toBe(true);
      for (const codeStepName of codeStepNames) {
        const codeStep = expectDefined(
          job.steps.find((step: WorkflowStep) => step.name === codeStepName),
          `selected QA step ${codeStepName}`,
        );
        expect(codeStep["working-directory"], codeStepName).toBe("selected");
      }
    }
    const validateProfileStep = qaPlanJob.steps.find(
      (step: WorkflowStep) => step.name === "Resolve taxonomy profile shards",
    );
    expect(validateProfileStep.run).toContain("createQaProfileEvidenceShardPlan(requested)");
    expect(validateProfileStep.run).toContain("matrix=${JSON.stringify({ include: plan.shards })}");
    expect(validateProfileStep.run).toContain("shard_count=${plan.shards.length}");

    expect(qaShardJob["timeout-minutes"]).toBe(150);
    expect(qaShardJob.needs).toEqual(["validate_selected_ref", "plan_qa_profile"]);
    expect(qaShardJob.strategy).toMatchObject({
      "fail-fast": false,
      "max-parallel": 8,
      matrix: "${{ fromJSON(needs.plan_qa_profile.outputs.matrix) }}",
    });
    const ensurePlaywrightStep = qaShardJob.steps.find(
      (step: WorkflowStep) => step.name === "Ensure Playwright Chromium",
    );
    expect(ensurePlaywrightStep.run).toContain("scripts/ensure-playwright-chromium.mts");
    expect(ensurePlaywrightStep.run).toContain("scripts/ensure-playwright-chromium.mjs");
    const prepareSandboxStep = expectDefined(
      qaShardJob.steps.find(
        (step: WorkflowStep) => step.name === "Prepare Docker sandbox image when selected",
      ),
      "QA sandbox image preparation",
    );
    expect(prepareSandboxStep["working-directory"]).toBe("selected");
    expect(prepareSandboxStep.env?.SCENARIO_IDS_JSON).toBe("${{ toJSON(matrix.scenarioIds) }}");
    expect(prepareSandboxStep.run).toBe(`set -euo pipefail
if jq -e '
  index("openclaw-sandbox-workspace-isolation") != null or
  index("agent-sandboxed-exec-behavior") != null
' <<<"$SCENARIO_IDS_JSON" >/dev/null; then
  scripts/sandbox-setup.sh
fi
`);
    expect(qaShardJob.steps.indexOf(prepareSandboxStep)).toBeLessThan(
      qaShardJob.steps.findIndex((step: WorkflowStep) => step.name === "Run QA profile shard"),
    );
    const runProfileStep = qaShardJob.steps.find(
      (step: WorkflowStep) => step.name === "Run QA profile shard",
    );
    expect(runProfileStep.env?.OPENCLAW_QA_CREDENTIAL_ACQUIRE_TIMEOUT_MS).toBe("120000");
    expect(runProfileStep.env?.PROTOCOL_SINCE_BASE_SHA).toBe(
      "${{ needs.validate_selected_ref.outputs.protocol_base_revision }}",
    );
    expect(runProfileStep.env?.REQUESTED_REF).toBe("${{ inputs.trusted_ref || inputs.ref }}");
    expect(runProfileStep.env?.TARGET_SHA).toBe(
      "${{ needs.validate_selected_ref.outputs.selected_revision }}",
    );
    expect(runProfileStep.run).toContain("--concurrency 3");
    expect(runProfileStep.run).toContain("--fast");
    expect(runProfileStep.run).toContain('qa_output_dir=".artifacts/qa-e2e/');
    expect(runProfileStep.run).toContain(
      'published_output_dir="${GITHUB_WORKSPACE}/selected/${qa_output_dir}"',
    );
    expect(runProfileStep.run).toContain('mkdir -p "$qa_output_dir"');
    expect(runProfileStep.run).toContain('echo "output_dir=${published_output_dir}"');
    expect(runProfileStep.run).toContain('--output-dir "$qa_output_dir"');
    expect(runProfileStep.run).toContain('OUTPUT_DIR="$published_output_dir"');
    expect(runProfileStep.run.indexOf('mkdir -p "$qa_output_dir"')).toBeLessThan(
      runProfileStep.run.indexOf('echo "output_dir=${published_output_dir}"'),
    );
    expect(runProfileStep.run).toContain(
      "LC_ALL=C timeout --verbose --signal=TERM --kill-after=30s 110m",
    );
    expect(runProfileStep.run).toContain("qa_exit_code=$?");
    expect(runProfileStep.run).toContain('timeout_child_env+=("LC_ALL=$LC_ALL")');
    expect(runProfileStep.run).toContain('timeout_child_env+=("-u" "LC_ALL")');
    expect(runProfileStep.run).toContain(`bash -c 'exec "$@" 2>&3' bash`);
    expect(runProfileStep.run).toContain('3>&2 2>"$timeout_supervisor_fifo"');
    expect(runProfileStep.run).toContain('mkfifo "$timeout_supervisor_fifo"');
    expect(runProfileStep.run).toContain(
      'tee "$timeout_supervisor_log" <"$timeout_supervisor_fifo" >&2 &',
    );
    expect(runProfileStep.run).toContain("supervisor_tee_pid=$!");
    expect(runProfileStep.run).toContain("trap cleanup_timeout_supervisor EXIT");
    expect(runProfileStep.run).toContain(
      'rm -f "$timeout_supervisor_fifo" "$timeout_supervisor_log"',
    );
    expect(runProfileStep.run).not.toContain(">(tee");
    const teeWait = runProfileStep.run.indexOf('wait "$supervisor_tee_pid"');
    const timeoutClassification = runProfileStep.run.indexOf(
      'grep -Eq "^timeout: sending signal KILL',
    );
    expect(teeWait).toBeGreaterThan(-1);
    expect(teeWait).toBeLessThan(timeoutClassification);
    expect(runProfileStep.run).toContain(
      `[[ "$qa_exit_code" -eq 137 ]] && grep -Eq "^timeout: sending signal KILL to command '[A-Za-z0-9_./+-]+'$"`,
    );
    expect(runProfileStep.run).toContain(
      `[[ "$qa_exit_code" -eq 124 ]] && grep -Eq "^timeout: sending signal TERM to command '[A-Za-z0-9_./+-]+'$"`,
    );
    expect(runProfileStep.run).not.toContain('case "$qa_exit_code"');
    expect(runProfileStep.run).toContain('TIMEOUT_OUTCOME="$timeout_outcome"');
    expect(runProfileStep.run).toContain("qa-profile-run-status.json");
    expect(runProfileStep.run).toContain("protocolBaseSha: process.env.PROTOCOL_SINCE_BASE_SHA");
    expect(runProfileStep.run).toContain("exitCode: Number(process.env.QA_EXIT_CODE)");
    expect(runProfileStep.run).toContain('timedOut: process.env.TIMEOUT_OUTCOME !== "none"');
    expect(runProfileStep.run).toContain("timeoutOutcome: process.env.TIMEOUT_OUTCOME");
    expect(runProfileStep.run).toContain("completedAt: new Date().toISOString()");
    expect(runProfileStep.run).toContain("id: process.env.QA_SHARD_ID");
    expect(runProfileStep.run).toContain("scenarioIds: JSON.parse(process.env.SCENARIO_IDS_JSON)");
    expect(runProfileStep.run).not.toContain("--allow-failures");

    const shardEvidenceStep = qaShardJob.steps.find(
      (step: WorkflowStep) => step.name === "Validate QA profile shard evidence",
    );
    expect(shardEvidenceStep.if).toBe("always()");
    expect(shardEvidenceStep.run).toContain("qaProfileEvidencePlan.attest");
    const shardUploadStep = qaShardJob.steps.find(
      (step: WorkflowStep) => step.name === "Upload QA profile shard evidence",
    );
    expect(shardUploadStep.if).toBe("always()");
    expect(shardUploadStep.with).toMatchObject({
      name: "qa-profile-evidence-shard-${{ matrix.id }}-${{ needs.validate_selected_ref.outputs.selected_revision }}",
      path: "${{ steps.run_profile.outputs.output_dir }}",
      "if-no-files-found": "error",
    });

    expect(qaAggregateJob.needs).toEqual([
      "validate_selected_ref",
      "plan_qa_profile",
      "run_qa_profile_shard",
    ]);
    expect(qaAggregateJob.if.replace(/\s+/gu, " ")).toBe(
      "${{ always() && needs.validate_selected_ref.result == 'success' && needs.plan_qa_profile.result == 'success' }}",
    );
    const aggregateDownloadStep = qaAggregateJob.steps.find(
      (step: WorkflowStep) => step.name === "Download QA profile shard evidence",
    );
    expect(aggregateDownloadStep.with).toMatchObject({
      pattern:
        "qa-profile-evidence-shard-*-${{ needs.validate_selected_ref.outputs.selected_revision }}",
      path: "selected/.artifacts/qa-profile-shards",
      "merge-multiple": false,
    });
    const aggregateStep = qaAggregateJob.steps.find(
      (step: WorkflowStep) => step.name === "Aggregate validated shard evidence",
    );
    expect(aggregateStep.run).toContain(
      "Expected ${SHARD_COUNT} completed status and evidence files",
    );
    expect(aggregateStep.run).toContain("Timed-out QA shard cannot contribute partial evidence");
    expect(aggregateStep.run).toContain("-mindepth 2 -maxdepth 2");
    expect(aggregateStep.run).toContain("aggregateQaProfileEvidenceShards");
    expect(aggregateStep.run).toContain(
      `jq -s --argjson exitCode "$qa_exit_code" 'map(.shard + {})' "\${status_paths[@]}" >/dev/null`,
    );
    expect(aggregateStep.run).toContain("if jq -e '.timedOut == true'");
    expect(aggregateStep.env?.OUTPUT_DIR).toContain(
      "${{ github.workspace }}/selected/.artifacts/qa-e2e/",
    );
    const aggregateUploadStep = qaAggregateJob.steps.find(
      (step: WorkflowStep) => step.name === "Upload QA profile evidence",
    );
    expect(aggregateUploadStep.with?.path).toBe("${{ steps.aggregate.outputs.output_dir }}");

    const diagnosticStep = qaAggregateJob.steps.find(
      (step: WorkflowStep) => step.name === "Collect QA profile diagnostics",
    );
    expect(diagnosticStep.if).toBe("always()");
    expect(diagnosticStep["continue-on-error"]).toBe(true);
    expect(diagnosticStep).not.toHaveProperty("working-directory");
    expect(diagnosticStep.run).toContain('test "$(git rev-parse HEAD)" = "$EXPECTED_WORKFLOW_SHA"');
    expect(diagnosticStep.run).toContain("node scripts/qa/qa-profile-run-status.mjs");
    expect(diagnosticStep.env.EXPECTED_WORKFLOW_SHA).toBe(
      "${{ needs.validate_selected_ref.outputs.workflow_sha }}",
    );
    expect(diagnosticStep.env.PLAN_MATRIX_JSON).toBe("${{ needs.plan_qa_profile.outputs.matrix }}");
    expect(diagnosticStep.env.QA_EXIT_CODE).toBe("${{ steps.aggregate.outputs.qa_exit_code }}");
    expect(diagnosticStep.env.FINALIZE_OUTCOME).toBe("${{ steps.evidence.outcome }}");
    const diagnosticUpload = qaAggregateJob.steps.find(
      (step: WorkflowStep) => step.name === "Upload QA profile diagnostics",
    );
    expect(diagnosticUpload.if).toBe("always()");
    expect(diagnosticUpload["continue-on-error"]).toBe(true);
    expect(diagnosticUpload.with.name).toBe(
      "qa-profile-diagnostics-${{ needs.plan_qa_profile.outputs.profile }}-${{ needs.validate_selected_ref.outputs.selected_revision }}-${{ github.run_id }}-${{ github.run_attempt }}",
    );
    expect(diagnosticUpload.with.name).not.toMatch(/^qa-profile-evidence-/u);
    expect(diagnosticUpload.with.path).toBe(
      `${diagnosticStep.env.OUTPUT_DIR}/qa-profile-run-status.json`,
    );
    expect(diagnosticUpload.with["if-no-files-found"]).toBe("warn");
    const finalizerIndex = qaAggregateJob.steps.findIndex(
      (step: WorkflowStep) => step.name === "Finalize QA profile evidence",
    );
    expect(qaAggregateJob.steps.indexOf(diagnosticStep)).toBeGreaterThan(finalizerIndex);
    expect(qaAggregateJob.steps.indexOf(diagnosticUpload)).toBeLessThan(
      qaAggregateJob.steps.indexOf(aggregateUploadStep),
    );
    expect(JSON.stringify(qaAggregateJob.outputs)).not.toContain("diagnostics");
    const diagnosticWarning = qaAggregateJob.steps.find(
      (step: WorkflowStep) => step.name === "Warn if QA profile diagnostics were not retained",
    );
    expect(diagnosticWarning.if).toBe(
      "always() && (steps.collect_diagnostics.outcome == 'failure' || steps.upload_diagnostics.outcome == 'failure')",
    );

    const failProfileStep = qaAggregateJob.steps.find(
      (step: WorkflowStep) => step.name === "Fail if QA profile failed",
    );
    expect(failProfileStep.env?.ALLOW_FAILURES).toBe("${{ inputs.allow_failures }}");
    expect(failProfileStep.run).toContain('[[ -z "${QA_EXIT_CODE:-}" ]]');
    expect(failProfileStep.run).toContain(
      '[[ "$QA_EXIT_CODE" != "0" && "$ALLOW_FAILURES" != "true" ]]',
    );
    expect(failProfileStep.run).toContain('exit "$QA_EXIT_CODE"');
    expect(generateJob.needs).toEqual(["validate_selected_ref", "publisher_preflight"]);
    expect(generateJob.if.replace(/\s+/gu, " ")).toBe(
      "${{ always() && needs.validate_selected_ref.result == 'success' && (!inputs.publish_pull_request || needs.publisher_preflight.result == 'success') && inputs.qa_evidence_run_id == '' }}",
    );
    expect(generateJob.uses).toBe("./.github/workflows/qa-profile-evidence.yml");
    expect(generateJob.with).toMatchObject({
      ref: "${{ needs.validate_selected_ref.outputs.selected_revision }}",
      trusted_ref: "${{ inputs.ref }}",
      expected_sha: "${{ needs.validate_selected_ref.outputs.selected_revision }}",
      qa_profile: "all",
      allow_failures: "${{ inputs.allow_failures }}",
    });
    expect(generateJob.with).not.toHaveProperty("fail_on_qa_failure");
    expect(generateJob.secrets).toMatchObject({
      OPENAI_API_KEY: "${{ secrets.OPENAI_API_KEY }}",
      OPENCLAW_QA_CONVEX_SECRET_CI: "${{ secrets.OPENCLAW_QA_CONVEX_SECRET_CI }}",
      OPENCLAW_QA_CONVEX_SITE_URL: "${{ secrets.OPENCLAW_QA_CONVEX_SITE_URL }}",
    });

    const maturityPermissionStep = expectDefined(
      maturityWorkflow.jobs.validate_selected_ref.steps.find(
        (step: WorkflowStep) => step.name === "Require authorized workflow actor",
      ),
      "maturity workflow actor authorization",
    );
    const workflowStep = maturityWorkflow.jobs.validate_selected_ref.steps.find(
      (step: WorkflowStep) => step.name === "Resolve job workflow identity",
    );
    const authorizeStep = maturityWorkflow.jobs.validate_selected_ref.steps.find(
      (step: WorkflowStep) => step.name === "Authorize workflow invocation",
    );
    const validateRefStep = maturityWorkflow.jobs.validate_selected_ref.steps.find(
      (step: WorkflowStep) => step.name === "Validate selected ref",
    );
    expect(maturityPermissionStep).toMatchObject({
      uses: "actions/github-script@3a2844b7e9c422d3c10d287c895573f7108da1b3",
      env: {
        CALLER_WORKFLOW_REF: "${{ github.workflow_ref }}",
        JOB_CONTEXT: "${{ toJSON(job) }}",
      },
    });
    expect(maturityPermissionStep.with?.script).toContain("getCollaboratorPermissionLevel");
    expect(maturityPermissionStep.with?.script).toContain(
      "callerWorkflowRef !== calledWorkflowRef",
    );
    expect(maturityPermissionStep.with?.script).toContain(`"${MATURITY_SCORECARD_WORKFLOW_REF}"`);
    expect(maturityPermissionStep.with?.script).toContain(
      'job.workflow_repository === "openclaw/openclaw"',
    );
    expect(maturityPermissionStep.with?.script).toContain("job.workflow_ref === calledWorkflowRef");
    expect(workflowStep.env.JOB_CONTEXT).toBe("${{ toJSON(job) }}");
    expect(workflowStep.run).toContain("job.workflow_sha must be a full lowercase commit SHA");
    expect(authorizeStep.env).toEqual({
      CALLER_EVENT_NAME: "${{ github.event_name }}",
      CALLER_WORKFLOW_REF: "${{ github.workflow_ref }}",
      JOB_WORKFLOW_FILE_PATH: "${{ steps.workflow.outputs.workflow_file_path }}",
      JOB_WORKFLOW_REF: "${{ steps.workflow.outputs.workflow_ref }}",
      JOB_WORKFLOW_REPOSITORY: "${{ steps.workflow.outputs.workflow_repository }}",
      PUBLISH_PULL_REQUEST: "${{ inputs.publish_pull_request || false }}",
    });
    expect(authorizeStep.run).toContain(
      `expected_workflow_ref="${MATURITY_SCORECARD_WORKFLOW_REF}"`,
    );
    expect(authorizeStep.run).toContain(
      '[[ "$PUBLISH_PULL_REQUEST" == "true" && "$canonical_direct" != "true" ]]',
    );
    expect(authorizeStep.run).toContain(
      "Reusable maturity workflows are artifact-only and cannot publish pull requests.",
    );
    expect(validateRefStep.env.EXPECTED_SHA).toBe("${{ inputs.expected_sha }}");
    expect(validateRefStep.env.PUBLISH_PULL_REQUEST).toBe("${{ inputs.publish_pull_request }}");
    expect(validateRefStep.env).not.toHaveProperty("TRUSTED_WORKFLOW_SHA");
    expect(validateRefStep.env.EVIDENCE_RUN_ID).toBe(
      "${{ inputs.qa_evidence_run_id || github.run_id }}",
    );
    for (const fragment of [
      "expected_sha must be a full 40-character SHA",
      'input_ref.removeprefix("refs/heads/")',
      "floating_default_branch = False",
      'not expected_sha.replace(" ", "") and branch_candidate == default_branch',
      'selected_revision = revision("refs/remotes/origin/main")',
      "floating_default_branch and publication_base == default_branch",
      "if code != 2:",
      "Unable to determine whether '{input_ref}' is a remote branch",
      'probe("merge-base", "--is-ancestor", selected_revision',
      '":(exclude)qa/maturity-scores.yaml"',
      '":(exclude)docs/maturity/scorecard.md"',
      '":(exclude)docs/maturity/taxonomy.md"',
      "qa_evidence_run_id must be a numeric GitHub Actions run id",
      'publication_head = f"automation/maturity-scorecard-',
    ]) {
      expect(validateRefStep.run).toContain(fragment);
    }
    expect(maturityWorkflow.jobs.validate_selected_ref.outputs).toMatchObject({
      publication_base: "${{ steps.validate.outputs.publication_base }}",
      publication_head: "${{ steps.validate.outputs.publication_head }}",
      workflow_file_path: "${{ steps.workflow.outputs.workflow_file_path }}",
      workflow_ref: "${{ steps.workflow.outputs.workflow_ref }}",
      workflow_repository: "${{ steps.workflow.outputs.workflow_repository }}",
      workflow_sha: "${{ steps.workflow.outputs.workflow_sha }}",
    });

    const trustedPublisherCondition = [
      "${{ inputs.publish_pull_request &&",
      "github.event_name == 'workflow_dispatch' &&",
      `github.workflow_ref == '${MATURITY_SCORECARD_WORKFLOW_REF}' &&`,
      `needs.validate_selected_ref.outputs.workflow_file_path == '${MATURITY_SCORECARD_WORKFLOW}' &&`,
      `needs.validate_selected_ref.outputs.workflow_ref == '${MATURITY_SCORECARD_WORKFLOW_REF}' &&`,
      "needs.validate_selected_ref.outputs.workflow_repository == 'openclaw/openclaw' }}",
    ].join(" ");
    expect(publisherPreflight.needs).toBe("validate_selected_ref");
    expect(publisherPreflight.if).toBe("${{ inputs.publish_pull_request }}");
    const preflightCheckoutStep = publisherPreflight.steps.find(
      (step: WorkflowStep) => step.name === "Checkout trusted workflow source",
    );
    const preflightTokensStep = publisherPreflight.steps.find(
      (step: WorkflowStep) => step.name === "Create generated PR tokens",
    );
    expect(preflightCheckoutStep).toMatchObject({
      uses: CHECKOUT_V6,
      with: {
        repository: "${{ needs.validate_selected_ref.outputs.workflow_repository }}",
        ref: "${{ needs.validate_selected_ref.outputs.workflow_sha }}",
        "persist-credentials": false,
        submodules: false,
      },
    });
    expect(preflightTokensStep.if.replace(/\s+/gu, " ")).toBe(trustedPublisherCondition);
    expect(preflightTokensStep).toMatchObject({
      uses: "./.github/actions/create-generated-pr-tokens",
      with: {
        "contents-client-id": "Iv23liOECG0slfuhz093",
        "contents-private-key": "${{ secrets.CLAWSWEEPER_APP_PRIVATE_KEY }}",
        "pull-request-client-id": MANTIS_GITHUB_APP_CLIENT_ID,
        "pull-request-private-key": "${{ secrets.MANTIS_GITHUB_APP_PRIVATE_KEY }}",
      },
    });
    expect(publishJob.needs).toEqual([
      "validate_selected_ref",
      "publisher_preflight",
      "generate_qa_evidence",
    ]);
    expect(publishJob.if.replace(/\s+/gu, " ")).toBe(
      "${{ always() && needs.validate_selected_ref.result == 'success' && (!inputs.publish_pull_request || needs.publisher_preflight.result == 'success') && (inputs.qa_evidence_run_id != '' || needs.generate_qa_evidence.result == 'success') }}",
    );
    expect(JSON.stringify(publishJob)).not.toMatch(
      /CLAWSWEEPER_APP_PRIVATE_KEY|MANTIS_GITHUB_APP/u,
    );

    const generatedDownloadStep = publishJob.steps.find(
      (step: WorkflowStep) => step.name === "Download generated QA evidence artifact",
    );
    expect(generatedDownloadStep.if).toBe("${{ inputs.qa_evidence_run_id == '' }}");
    expect(generatedDownloadStep.env.GENERATED_ARTIFACT_NAME).toBe(
      "${{ needs.generate_qa_evidence.outputs.artifact_name }}",
    );
    expect(generatedDownloadStep.run).toContain('gh run download "$GITHUB_RUN_ID"');
    expect(generatedDownloadStep.run).toContain('--name "$GENERATED_ARTIFACT_NAME"');
    expect(generatedDownloadStep.run).not.toContain("--pattern");

    const requireEvidenceStep = publishJob.steps.find(
      (step: WorkflowStep) => step.name === "Require one QA evidence file",
    );
    expect(requireEvidenceStep.run).toContain(
      "Expected exactly one aggregate QA evidence manifest",
    );
    expect(requireEvidenceStep.run).toContain("qa-profile-evidence-manifest.json");
    expect(requireEvidenceStep.run).toContain(
      'evidence_path="$(dirname "${manifest_paths[0]}")/qa-evidence.json"',
    );
    expect(requireEvidenceStep.run).toContain('[[ ! -f "$evidence_path" || -L "$evidence_path" ]]');

    const validateManifestStep = publishJob.steps.find(
      (step: WorkflowStep) => step.name === "Validate QA evidence manifest",
    );
    expect(validateManifestStep.id).toBe("validate_evidence");
    expect(validateManifestStep.run).toContain("qa-profile-evidence-manifest.json");
    expect(validateManifestStep.run).toContain("qa-evidence.json profile must be all");
    expect(validateManifestStep.run).toContain("QA evidence manifest profile must be all");
    expect(validateManifestStep.run).toContain("manifest.targetSha !== targetSha");
    expect(validateManifestStep.run).toMatch(
      /qaProfileEvidencePlan\.attest\(\s*evidence\.profilePlan,\s*manifest\.qaPassed === true,\s*evidence,?\s*\)/u,
    );
    expect(validateManifestStep.run).toContain("profilePlanSha256");
    expect(validateManifestStep.run).toContain("rerun the QA Profile Evidence workflow");
    expect(validateManifestStep.run).toContain("counts.fail === 0 && counts.blocked === 0");
    expect(validateManifestStep.run).toContain("scorecard_passed=");
    expect(validateManifestStep.run).toContain("### Maturity scorecard result");
    expect(publishJob.outputs).toEqual({
      blocked_count: "${{ steps.validate_evidence.outputs.blocked_count }}",
      failed_count: "${{ steps.validate_evidence.outputs.failed_count }}",
      scorecard_passed: "${{ steps.validate_evidence.outputs.scorecard_passed }}",
    });

    expect(qaAggregateJob.outputs.artifact_name).toBe(
      "${{ steps.evidence.outputs.artifact_name }}",
    );
    const qaEvidenceStep = qaAggregateJob.steps.find(
      (step: WorkflowStep) => step.name === "Finalize QA profile evidence",
    );
    expect(qaEvidenceStep.env.ARTIFACT_NAME).toBe(
      "qa-profile-evidence-${{ needs.plan_qa_profile.outputs.profile }}-${{ needs.validate_selected_ref.outputs.selected_revision }}",
    );
    expect(qaEvidenceStep.run).toContain("qa-profile-evidence-manifest.json");
    expect(qaEvidenceStep.run).toContain("validateQaEvidenceSummaryJson");
    expect(qaEvidenceStep.run).toMatch(
      /qaProfileEvidencePlan\.attest\(\s*payload\.profilePlan,\s*process\.env\.QA_EXIT_CODE === "0",?\s*\)/u,
    );
    expect(qaEvidenceStep.run).toContain("profilePlanSha256");
    expect(qaEvidenceStep.env.PROTOCOL_BASE_SHA).toBe(
      "${{ needs.validate_selected_ref.outputs.protocol_base_revision }}",
    );
    expect(qaEvidenceStep.env.REQUESTED_REF).toBe("${{ inputs.trusted_ref || inputs.ref }}");
    expect(qaEvidenceStep.env.ALLOW_FAILURES).toBe("${{ inputs.allow_failures }}");
    expect(qaEvidenceStep.run).toContain("qaExitCode: Number(process.env.QA_EXIT_CODE)");
    expect(qaEvidenceStep.run).toContain('qaPassed: process.env.QA_EXIT_CODE === "0"');
    expect(qaEvidenceStep.run).toContain('allowFailures: process.env.ALLOW_FAILURES === "true"');
    expect(qaEvidenceStep.run).toContain("protocolBaseSha: process.env.PROTOCOL_BASE_SHA");

    const qaUploadStep = qaAggregateJob.steps.find(
      (step: WorkflowStep) => step.name === "Upload QA profile evidence",
    );
    expect(qaUploadStep.if).toBe("always() && steps.evidence.outcome == 'success'");
    expect(qaUploadStep.with).toMatchObject({
      name: "qa-profile-evidence-${{ needs.plan_qa_profile.outputs.profile }}-${{ needs.validate_selected_ref.outputs.selected_revision }}",
      path: "${{ steps.aggregate.outputs.output_dir }}",
      "if-no-files-found": "error",
    });

    const renderCheckoutStep = publishJob.steps.find(
      (step: WorkflowStep) => step.name === "Checkout selected ref",
    );
    const generatedPrUploadStep = publishJob.steps.find(
      (step: WorkflowStep) => step.name === "Upload generated PR files",
    );
    expect(renderCheckoutStep.with["fetch-depth"]).toBe(0);
    expect(generatedPrUploadStep).toMatchObject({
      if: "${{ inputs.publish_pull_request }}",
      uses: UPLOAD_ARTIFACT_V7,
      with: {
        name: "maturity-scorecard-pr-${{ github.run_id }}-${{ github.run_attempt }}",
        "retention-days": 1,
        "if-no-files-found": "error",
      },
    });
    expect(generatedPrUploadStep.with.path.trim().split("\n")).toEqual(MATURITY_GENERATED_PR_PATHS);

    const prepareRenderEvidenceStep = publishJob.steps.find(
      (step: WorkflowStep) => step.name === "Prepare aggregate QA evidence for rendering",
    );
    expect(prepareRenderEvidenceStep.env.QA_EVIDENCE_PATH).toBe(
      "${{ steps.evidence.outputs.qa_evidence_path }}",
    );
    expect(prepareRenderEvidenceStep.run).toContain(
      'render_evidence_dir=".artifacts/maturity-render-evidence"',
    );
    expect(prepareRenderEvidenceStep.run).toContain(
      'install -m 0644 "$QA_EVIDENCE_PATH" "$render_evidence_dir/qa-evidence.json"',
    );
    for (const stepName of ["Render artifact docs", "Render committed docs preview"]) {
      const renderStep = publishJob.steps.find((step: WorkflowStep) => step.name === stepName);
      expect(renderStep.env.ALLOW_FAILURES).toBe("${{ inputs.allow_failures }}");
      expect(renderStep.run).toContain('[[ "$ALLOW_FAILURES" == "true" ]]');
      expect(renderStep.run).toContain("allow_failures_args+=(--allow-failures)");
      expect(renderStep.run).toContain("--evidence-dir .artifacts/maturity-render-evidence");
      expect(renderStep.run).not.toContain("--evidence-dir .artifacts/maturity-evidence");
      expect(renderStep.run).toContain('"${allow_failures_args[@]}"');
    }
    const renderArtifactStep = publishJob.steps.find(
      (step: WorkflowStep) => step.name === "Render artifact docs",
    );
    expect(renderArtifactStep.run).toContain("QA failures allowed:");

    expect(publishPrJob.needs).toEqual(["validate_selected_ref", "publisher_preflight", "publish"]);
    // Routed through the optional release runner group; the baseline label is unchanged.
    expect(evaluateWorkflowRunner(publishPrJob["runs-on"])).toBe("ubuntu-24.04");
    expect(publishPrJob.permissions).toEqual({ actions: "read", contents: "read" });
    for (const fragment of [
      "needs.publisher_preflight.result == 'success'",
      "needs.publish.result == 'success'",
      `github.workflow_ref == '${MATURITY_SCORECARD_WORKFLOW_REF}'`,
      `needs.validate_selected_ref.outputs.workflow_ref == '${MATURITY_SCORECARD_WORKFLOW_REF}'`,
    ]) {
      expect(publishPrJob.if).toContain(fragment);
    }
    expect(publishPrJob.if).not.toContain("needs.publish.outputs.scorecard_passed");

    const resultJob = maturityWorkflow.jobs.maturity_result;
    expect(resultJob.needs).toEqual(["publish", "publish_generated_pr"]);
    expect(resultJob.if.replace(/\s+/gu, " ")).toBe(
      "${{ always() && needs.publish.result == 'success' && (needs.publish_generated_pr.result == 'success' || needs.publish_generated_pr.result == 'skipped') }}",
    );
    const resultGateStep = resultJob.steps.find(
      (step: WorkflowStep) => step.name === "Fail incomplete maturity evidence",
    );
    expect(resultGateStep.env).toEqual({
      BLOCKED_COUNT: "${{ needs.publish.outputs.blocked_count }}",
      FAILED_COUNT: "${{ needs.publish.outputs.failed_count }}",
      SCORECARD_PASSED: "${{ needs.publish.outputs.scorecard_passed }}",
    });
    expect(resultGateStep.run).toContain('[[ "$SCORECARD_PASSED" != "true" ]]');
    expect(resultGateStep.run).toContain(
      "Generated maturity PR was still published when requested.",
    );
    const trustedPublishCheckoutStep = publishPrJob.steps.find(
      (step: WorkflowStep) => step.name === "Checkout trusted workflow source",
    );
    const selectedCheckoutStep = publishPrJob.steps.find(
      (step: WorkflowStep) => step.name === "Checkout selected ref",
    );
    const downloadPrFilesStep = publishPrJob.steps.find(
      (step: WorkflowStep) => step.name === "Download generated PR files",
    );
    const openDocsPrStep = publishPrJob.steps.find(
      (step: WorkflowStep) => step.name === "Open or update generated docs PR",
    );
    expect(trustedPublishCheckoutStep).toMatchObject({
      uses: CHECKOUT_V6,
      with: {
        repository: "${{ needs.validate_selected_ref.outputs.workflow_repository }}",
        ref: "${{ needs.validate_selected_ref.outputs.workflow_sha }}",
        "persist-credentials": false,
      },
    });
    expect(selectedCheckoutStep).toMatchObject({
      uses: CHECKOUT_V6,
      with: {
        ref: "${{ needs.validate_selected_ref.outputs.selected_revision }}",
        path: "selected",
        "fetch-depth": 0,
        "persist-credentials": false,
      },
    });
    expect(downloadPrFilesStep).toMatchObject({
      uses: DOWNLOAD_ARTIFACT_V8,
      with: {
        name: "maturity-scorecard-pr-${{ github.run_id }}-${{ github.run_attempt }}",
        path: "${{ steps.staging.outputs.path }}",
      },
    });
    expect(openDocsPrStep.if.replace(/\s+/gu, " ")).toBe(trustedPublisherCondition);
    expect(openDocsPrStep.uses).toBe("./.github/actions/publish-generated-pr");
    expect(openDocsPrStep.with).toMatchObject({
      "contents-client-id": "Iv23liOECG0slfuhz093",
      "contents-private-key": "${{ secrets.CLAWSWEEPER_APP_PRIVATE_KEY }}",
      "pull-request-client-id": MANTIS_GITHUB_APP_CLIENT_ID,
      "pull-request-private-key": "${{ secrets.MANTIS_GITHUB_APP_PRIVATE_KEY }}",
      "base-branch": "${{ needs.validate_selected_ref.outputs.publication_base }}",
      "head-branch": "${{ needs.validate_selected_ref.outputs.publication_head }}",
      "working-directory": "selected",
      "commit-message": "docs: update maturity scorecard",
      "pr-title": "docs: update maturity scorecard",
      "invalidation-paths": "",
      "overlap-policy": "fail",
    });
    expect(openDocsPrStep.with["generated-paths"].trim().split("\n")).toEqual(
      MATURITY_GENERATED_PR_PATHS,
    );
    for (const heading of [
      "## What Problem This Solves",
      "## Why This Change Was Made",
      "## User Impact",
      "## Evidence",
    ]) {
      expect(openDocsPrStep.with["pr-body"]).toContain(heading);
    }
    expect(publishPrJob.steps).not.toContainEqual(
      expect.objectContaining({ name: "Create generated docs PR app token" }),
    );
    const maturityWorkflowSource = readFileSync(".github/workflows/maturity-scorecard.yml", "utf8");
    expect(maturityWorkflowSource).not.toContain("permission-pull-requests: write");
    expect(maturityWorkflowSource).not.toContain("GH_APP_PRIVATE_KEY");
    expect(maturityWorkflowSource).not.toContain("gh auth setup-git");
    expect(maturityWorkflowSource).not.toContain("git push --force-with-lease");
  });

  it.skipIf(process.platform === "win32")(
    "Mantis evidence readers project a passing retry from the canonical owner",
    () => {
      for (const kind of ["status-reactions", "thread-attachment"] as const) {
        const scenarioId =
          kind === "status-reactions"
            ? "discord-status-reactions-tool-only"
            : "discord-thread-reply-filepath-attachment";
        const evidence = workflowOccurrenceEvidence([
          { scenarioId, attempts: ["fail", "pass"], selected: 1 },
        ]);
        const result = runMantisEvidenceReader(kind, evidence);
        expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
        expect(result.stdout.trim()).toBe("pass");
      }
    },
  );

  it.skipIf(process.platform === "win32").each(["full", "slim"] as const)(
    "Mantis evidence readers preserve v2 %s rows without new API exports",
    (evidenceMode) => {
      for (const kind of ["status-reactions", "thread-attachment"] as const) {
        const scenarioId =
          kind === "status-reactions"
            ? "discord-status-reactions-tool-only"
            : "discord-thread-reply-filepath-attachment";
        const evidence = {
          kind: "openclaw.qa.evidence-summary",
          schemaVersion: 2,
          generatedAt: "2026-08-05T00:00:00.000Z",
          evidenceMode,
          entries: ["fail", "pass"].map((status) => ({
            test: { kind: "scenario", id: scenarioId, title: scenarioId },
            coverage: [],
            result: { status },
          })),
        };
        const result = runMantisEvidenceReader(kind, evidence, false);
        expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
        expect(result.stdout.trim()).toBe(kind === "status-reactions" ? "fail" : "fail\npass");
      }
    },
  );

  it.skipIf(process.platform === "win32").each([
    { name: "unresolved first", firstId: null, attempts: [], selected: undefined, first: "null" },
    {
      name: "foreign first owner",
      firstId: "another-scenario",
      attempts: ["pass"],
      selected: 0,
      first: "null",
    },
    {
      name: "nonpassing retry",
      firstId: null,
      attempts: ["fail", "blocked"],
      selected: 0,
      first: "fail",
    },
  ] as const)("Mantis evidence readers retain $name and independent instances", (testCase) => {
    for (const kind of ["status-reactions", "thread-attachment"] as const) {
      const scenarioId =
        kind === "status-reactions"
          ? "discord-status-reactions-tool-only"
          : "discord-thread-reply-filepath-attachment";
      const evidence = workflowOccurrenceEvidence(
        [
          {
            scenarioId: testCase.firstId ?? scenarioId,
            attempts: [...testCase.attempts],
            selected: testCase.selected,
          },
          { scenarioId, attempts: ["pass"], selected: 0 },
        ],
        "slim",
      );
      const result = runMantisEvidenceReader(kind, evidence);
      expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
      expect(result.stdout.trim()).toBe(
        kind === "status-reactions"
          ? testCase.first
          : testCase.firstId
            ? "pass"
            : `${testCase.first}\npass`,
      );
    }
  });

  it
    .skipIf(process.platform === "win32")
    .each(["invalid JSON", "null", "invalid binding", "missing v3 accessor"])(
    "Mantis evidence readers reject %s without legacy fallback",
    (invalid) => {
      for (const kind of ["status-reactions", "thread-attachment"] as const) {
        const scenarioId =
          kind === "status-reactions"
            ? "discord-status-reactions-tool-only"
            : "discord-thread-reply-filepath-attachment";
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
    "Mantis evidence readers use legacy summaries only when evidence is absent",
    () => {
      for (const kind of ["status-reactions", "thread-attachment"] as const) {
        const result = runMantisEvidenceReader(kind, undefined);
        expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
        expect(result.stdout.trim()).toBe("pass");
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "round-trips profile evidence and rejects digest drift",
    () => {
      const qaWorkflow = readQaProfileEvidenceWorkflow();
      const maturityWorkflow = readMaturityScorecardWorkflow();
      const producerStep = qaWorkflow.jobs.aggregate_qa_profile.steps.find(
        (step: WorkflowStep) => step.name === "Finalize QA profile evidence",
      );
      const consumerStep = maturityWorkflow.jobs.publish.steps.find(
        (step: WorkflowStep) => step.name === "Validate QA evidence manifest",
      );
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
      const expectedCell = {
        scenarioId: "scenario-one",
        executionKind: "flow",
        channel: null,
      };
      const scorecard = {
        filters: { surface: null, category: null },
        run: { evidenceEntryCount: 0 },
        categories: { total: 1, fulfilled: 1, partial: 0, missing: 0, fulfillmentPercent: 100 },
        features: { total: 1, fulfilled: 1, partial: 0, missing: 0, fulfillmentPercent: 100 },
        coverageIds: {
          total: 1,
          fulfilled: 1,
          missing: 0,
          fulfillmentPercent: 100,
        },
        categoryReports: [
          {
            id: "surface.category",
            surfaceId: "surface",
            name: "Category",
            status: "fulfilled",
            features: {
              total: 1,
              fulfilled: 1,
              partial: 0,
              missing: 0,
              fulfillmentPercent: 100,
            },
            coverageIds: {
              total: 1,
              fulfilled: 1,
              missing: 0,
              fulfillmentPercent: 100,
              secondaryOnly: 0,
            },
            missingCoverageIds: [],
          },
        ],
      };

      const writeEvidence = (status: "pass" | "fail" = "pass") => {
        writeFileSync(
          evidencePath,
          `${JSON.stringify({
            kind: "openclaw.qa.evidence-summary",
            schemaVersion: 2,
            generatedAt: "2026-08-05T00:00:00.000Z",
            evidenceMode: "full",
            entries: [
              {
                test: { kind: "scenario", id: "scenario-one", title: "Scenario one" },
                coverage: [],
                result: { status },
              },
            ],
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
          })}\n`,
          "utf8",
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

      try {
        writeEvidence();
        const completeProducer = runProducer("0");
        expect(
          completeProducer.status,
          `${completeProducer.stdout}${completeProducer.stderr}`,
        ).toBe(0);
        const completeManifest = readFileSync(manifestPath, "utf8");
        expect(JSON.parse(completeManifest)).toMatchObject({
          protocolBaseSha,
          targetSha,
        });
        const completeConsumer = runConsumer();
        expect(
          completeConsumer.status,
          `${completeConsumer.stdout}${completeConsumer.stderr}`,
        ).toBe(0);
        expect(readFileSync(path.join(root, "consumer-output"), "utf8")).toContain(
          "scorecard_passed=true",
        );

        const originalEvidence = JSON.parse(readFileSync(evidencePath, "utf8"));
        writeFileSync(evidencePath, JSON.stringify({ ...originalEvidence, evidenceMode: "slim" }));
        const oldApiSlim = runConsumer();
        expect(oldApiSlim.status, `${oldApiSlim.stdout}${oldApiSlim.stderr}`).toBe(0);
        expect(readFileSync(manifestPath, "utf8")).toBe(completeManifest);

        const retryEvidence = {
          ...originalEvidence,
          ...workflowOccurrenceEvidence([
            { scenarioId: "scenario-one", attempts: ["fail", "pass"], selected: 1 },
          ]),
          profile: originalEvidence.profile,
          profilePlan: originalEvidence.profilePlan,
          scorecard,
        };
        writeFileSync(evidencePath, JSON.stringify(retryEvidence));
        const missingReader = runConsumer();
        expect(missingReader.status).toBe(1);
        expect(`${missingReader.stdout}${missingReader.stderr}`).toContain(
          "requires the selected checkout's effective-entry reader",
        );
        writeWorkflowEvidenceApi(selectedRoot);

        for (const evidenceMode of ["full", "slim"] as const) {
          writeFileSync(evidencePath, JSON.stringify({ ...retryEvidence, evidenceMode }));
          const producer = runProducer("0");
          expect(producer.status, `${producer.stdout}${producer.stderr}`).toBe(0);
          expect(JSON.parse(readFileSync(manifestPath, "utf8")).profilePlanSha256).toBe(
            JSON.parse(completeManifest).profilePlanSha256,
          );
          writeFileSync(path.join(root, "consumer-output"), "");
          const consumer = runConsumer();
          expect(consumer.status, `${consumer.stdout}${consumer.stderr}`).toBe(0);
          const output = readFileSync(path.join(root, "consumer-output"), "utf8");
          expect(output).toContain("scorecard_passed=true");
          expect(output).toContain("passed_count=1");
          expect(output).toContain("failed_count=0");
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
          writeFileSync(evidencePath, JSON.stringify(declared));
          const producer = runProducer("0");
          expect(producer.status, `${producer.stdout}${producer.stderr}`).toBe(0);
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
          const parentFailure = {
            ...originalEvidence,
            ...workflowOccurrenceEvidence([
              // Parent failure is independent of the child, not a retry of its pass.
              { scenarioId: "scenario-one", attempts: ["pass", status], selected: 1, retry: false },
            ]),
            profile: originalEvidence.profile,
            profilePlan: originalEvidence.profilePlan,
            scorecard,
          };
          writeFileSync(evidencePath, JSON.stringify(parentFailure));
          writeFileSync(path.join(root, "consumer-output"), "");
          const consumer = runConsumer();
          expect(consumer.status, `${consumer.stdout}${consumer.stderr}`).toBe(0);
          const output = readFileSync(path.join(root, "consumer-output"), "utf8");
          expect(output).toContain("scorecard_passed=false");
          expect(output).toContain("passed_count=1");
          expect(output).toContain(`${status === "fail" ? "failed" : "blocked"}_count=1`);
        }

        writeFileSync(evidencePath, JSON.stringify(retryEvidence));
        writeFileSync(
          manifestPath,
          JSON.stringify({ ...JSON.parse(completeManifest), qaPassed: false }),
        );
        writeFileSync(path.join(root, "consumer-output"), "");
        const failedProducer = runConsumer();
        expect(failedProducer.status, `${failedProducer.stdout}${failedProducer.stderr}`).toBe(0);
        expect(readFileSync(path.join(root, "consumer-output"), "utf8")).toContain(
          "scorecard_passed=false",
        );
        writeFileSync(
          manifestPath,
          JSON.stringify({ ...JSON.parse(completeManifest), targetSha: protocolBaseSha }),
        );
        const wrongSource = runConsumer();
        expect(wrongSource.status).toBe(1);
        expect(`${wrongSource.stdout}${wrongSource.stderr}`).toContain(
          "does not match selected ref",
        );
        writeFileSync(manifestPath, completeManifest);
        const invalidBinding = structuredClone(retryEvidence);
        invalidBinding.entries[0]!.binding.occurrenceId = "foreign";
        writeFileSync(evidencePath, JSON.stringify(invalidBinding));
        expect(runConsumer().status).toBe(1);

        writeEvidence("fail");
        writeFileSync(path.join(root, "consumer-output"), "", "utf8");
        const failedEvidenceConsumer = runConsumer();
        expect(
          failedEvidenceConsumer.status,
          `${failedEvidenceConsumer.stdout}${failedEvidenceConsumer.stderr}`,
        ).toBe(0);
        expect(readFileSync(path.join(root, "consumer-output"), "utf8")).toContain(
          "scorecard_passed=false",
        );
        expect(readFileSync(path.join(root, "consumer-output"), "utf8")).toContain(
          "failed_count=1",
        );

        const manifest = JSON.parse(completeManifest) as Record<string, unknown>;
        manifest.profilePlanSha256 = "0".repeat(64);
        writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`, "utf8");
        const mismatched = runConsumer();
        expect(mismatched.status).toBe(1);
        expect(`${mismatched.stdout}${mismatched.stderr}`).toContain(
          "QA evidence profilePlan digest does not match the manifest",
        );
      } finally {
        rmSync(root, { force: true, recursive: true });
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "fails the maturity workflow result gate when evidence is not passing",
    () => {
      const maturityWorkflow = readMaturityScorecardWorkflow();
      const gateStep = maturityWorkflow.jobs.maturity_result.steps.find(
        (step: WorkflowStep) => step.name === "Fail incomplete maturity evidence",
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
        env: {
          ...process.env,
          BLOCKED_COUNT: "0",
          FAILED_COUNT: "0",
          SCORECARD_PASSED: "true",
        },
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
    "authorizes maturity PR publication only for a canonical direct dispatch",
    () => {
      const direct = runMaturityInvocationScenario({
        callerEventName: "workflow_dispatch",
        callerWorkflowRef: MATURITY_SCORECARD_WORKFLOW_REF,
        publishPullRequest: true,
      });

      expect(direct.status).toBe(0);
    },
  );

  it.skipIf(process.platform === "win32")(
    "keeps a reusable maturity call artifact-only even when its caller was dispatched",
    () => {
      const callerWorkflowRef =
        "openclaw/openclaw/.github/workflows/openclaw-release-checks.yml@refs/heads/main";
      const artifactOnly = runMaturityInvocationScenario({
        callerEventName: "workflow_dispatch",
        callerWorkflowRef,
        publishPullRequest: false,
      });

      expect(artifactOnly.status).toBe(0);
      for (const identity of [
        { callerWorkflowRef },
        { callerWorkflowRef: MATURITY_SCORECARD_WORKFLOW_REF, jobWorkflowRef: callerWorkflowRef },
      ]) {
        const rejected = runMaturityInvocationScenario({
          callerEventName: "workflow_dispatch",
          publishPullRequest: true,
          ...identity,
        });
        expect(rejected.status).not.toBe(0);
        expect(rejected.output).toContain(
          "Reusable maturity workflows are artifact-only and cannot publish pull requests.",
        );
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

      const extra = runMaturityArtifactCopyScenario({ extraFile: true });
      expect(extra.status).not.toBe(0);
      expect(extra.output).toContain("Generated PR artifact must contain exactly 3 files.");

      const sourceSymlink = runMaturityArtifactCopyScenario({ sourceSymlink: true });
      expect(sourceSymlink.status).not.toBe(0);
      expect(sourceSymlink.output).toContain(
        "Generated PR artifact path must be a regular file: qa/maturity-scores.yaml",
      );

      const destinationSymlink = runMaturityArtifactCopyScenario({ destinationSymlink: true });
      expect(destinationSymlink.status).not.toBe(0);
      expect(destinationSymlink.output).toContain(
        "Selected worktree destination must be a regular file: qa/maturity-scores.yaml",
      );
      expect(destinationSymlink.escaped).toBe("outside\n");
    },
  );

  it("keeps exact release validation identity separate from release context", () => {
    const fullReleaseWorkflow = readWorkflow(".github/workflows/full-release-validation.yml");
    const releaseWorkflow = readReleaseChecksWorkflow();
    const telegramWorkflow = readWorkflow(".github/workflows/openclaw-release-telegram-qa.yml");
    const fullReleaseDispatchStep = fullReleaseWorkflow.jobs.release_checks_candidate.steps.find(
      (step: WorkflowStep) => step.name === "Dispatch release checks candidate phase",
    );
    const dispatchStep = releaseWorkflow.jobs.qa_live_telegram_release_checks.steps.find(
      (step: WorkflowStep) => step.name === "Dispatch and await trusted Telegram QA",
    );
    const identityStep = telegramWorkflow.jobs.trusted_identity.steps.find(
      (step: WorkflowStep) => step.name === "Verify dispatched workflow identity",
    );
    const provenanceSteps = [
      telegramWorkflow.jobs.build_candidate.steps.find(
        (step: WorkflowStep) => step.name === "Validate candidate release provenance",
      ),
      telegramWorkflow.jobs.run_telegram.steps.find(
        (step: WorkflowStep) => step.name === "Revalidate candidate release provenance",
      ),
    ];

    expect(fullReleaseWorkflow.on.workflow_dispatch.inputs.target_context_ref).toMatchObject({
      required: false,
      default: "",
      type: "string",
    });
    expect(fullReleaseDispatchStep.run).toContain('-f ref="$TARGET_SHA"');
    expect(fullReleaseDispatchStep.run).toContain('-f target_context_ref="$TARGET_CONTEXT_REF"');
    expect(fullReleaseDispatchStep.run).not.toContain(
      'release_checks_target_ref="${TARGET_CONTEXT_REF:-$TARGET_REF}"',
    );
    expect(releaseWorkflow.on.workflow_dispatch.inputs.target_context_ref).toMatchObject({
      required: false,
      default: "",
      type: "string",
    });
    expect(telegramWorkflow.on.workflow_dispatch.inputs.target_context_ref).toMatchObject({
      required: false,
      default: "",
      type: "string",
    });
    expect(dispatchStep.env.TARGET_SHA).toBe("${{ needs.resolve_target.outputs.revision }}");
    expect(dispatchStep.env.TARGET_CONTEXT_REF).toBe("${{ inputs.target_context_ref }}");
    expect(dispatchStep.run).toContain('-f target_context_ref="$TARGET_CONTEXT_REF"');
    expect(dispatchStep.run).toContain('-f target_ref="$TARGET_SHA"');
    expect(dispatchStep.run).not.toContain("telegram_target_ref=");
    expect(identityStep.run).toContain(
      "Telegram QA target context must be a canonical release branch or tag.",
    );
    expect(identityStep.run).toContain(
      "Telegram QA release context requires an exact-SHA target ref.",
    );
    for (const provenanceStep of provenanceSteps) {
      expect(provenanceStep.env.TARGET_CONTEXT_REF).toBe("${{ inputs.target_context_ref }}");
      expect(provenanceStep.run.trim()).toBe(
        'bash "${GITHUB_WORKSPACE}/scripts/release-telegram-provenance.sh"',
      );
    }
  });

  it("checks out the complete trusted Release Decision scripts tree", () => {
    const workflow = readWorkflow(".github/workflows/full-release-validation.yml");
    const checkout = workflow.jobs.release_decision.steps.find(
      (step: WorkflowStep) => step.name === "Checkout release decision tooling",
    );

    expect(checkout?.with).toMatchObject({
      ref: "${{ github.sha }}",
      "sparse-checkout": "scripts",
      "sparse-checkout-cone-mode": false,
      "persist-credentials": false,
    });
  });

  it("keeps maturity scorecard release docs opt-in from release checks", () => {
    const releaseWorkflow = readReleaseChecksWorkflow();
    const job = releaseWorkflow.jobs.maturity_scorecard_release_checks;
    const summaryJob = releaseWorkflow.jobs.summary;
    const verifyStep = summaryJob.steps.find(
      (step: WorkflowStep) => step.name === "Verify release check results",
    );
    const inputs = releaseWorkflow.on.workflow_dispatch.inputs;
    const resolveJob = releaseWorkflow.jobs.resolve_target;
    const summarizeStep = resolveJob.steps.find(
      (step: WorkflowStep) => step.name === "Summarize validated ref",
    );

    expect(releaseWorkflow.jobs).not.toHaveProperty("qa_profile_release_evidence_release_checks");
    expect(inputs.run_maturity_scorecard).toMatchObject({
      required: false,
      default: false,
      type: "boolean",
    });
    expect(resolveJob.outputs.run_maturity_scorecard).toBe(
      "${{ steps.inputs.outputs.run_maturity_scorecard }}",
    );
    expect(summarizeStep.env.RUN_MATURITY_SCORECARD).toBe(
      "${{ steps.inputs.outputs.run_maturity_scorecard }}",
    );
    expect(summarizeStep.run).toContain("- Maturity scorecard docs:");
    expect(job.name).toBe("Render maturity scorecard release docs");
    expect(job.if).toBe(
      "contains(fromJSON('[\"all\",\"qa\"]'), needs.resolve_target.outputs.rerun_group) && needs.resolve_target.outputs.run_maturity_scorecard == 'true'",
    );
    expect(job.permissions).toMatchObject({
      actions: "read",
      contents: "read",
    });
    expect(job.uses).toBe("./.github/workflows/maturity-scorecard.yml");
    expect(job.with).toMatchObject({
      ref: "${{ needs.resolve_target.outputs.ref }}",
      expected_sha: "${{ needs.resolve_target.outputs.revision }}",
    });
    expect(job.with).not.toHaveProperty("qa_profile");
    expect(job.with).not.toHaveProperty("publish_pull_request");
    expect(job.secrets).toMatchObject({
      OPENAI_API_KEY: "${{ secrets.OPENAI_API_KEY }}",
      OPENCLAW_QA_CONVEX_SECRET_CI: "${{ secrets.OPENCLAW_QA_CONVEX_SECRET_CI }}",
      OPENCLAW_QA_CONVEX_SITE_URL: "${{ secrets.OPENCLAW_QA_CONVEX_SITE_URL }}",
    });
    expect(summaryJob.needs).toContain("maturity_scorecard_release_checks");
    expect(verifyStep.env.MATURITY_SCORECARD_RELEASE_CHECKS_RESULT).toBe(
      "${{ needs.maturity_scorecard_release_checks.result }}",
    );
    expect(verifyStep.run).toContain(
      '"maturity_scorecard_release_checks=${MATURITY_SCORECARD_RELEASE_CHECKS_RESULT}"',
    );
    expect(verifyStep.run).not.toContain("qa_profile_release_evidence_release_checks");
  });
});
