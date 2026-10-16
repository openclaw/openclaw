import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterAll, afterEach, expect, it } from "vitest";
import { parse } from "yaml";
import {
  assertAuthorizedEligibilityPlanDigest,
  assertAuthorizedBetaFocusedCandidate,
  digestAuthorizedBetaFocusedPolicy,
  digestAuthorizedPackageNames,
  readAuthorizedBetaFocusedPolicy,
  validateAuthorizedBetaFocusedArtifactShape,
  type AuthorizedBetaFocusedEvidence,
  type AuthorizedBetaFocusedPolicy,
  type AuthorizedBetaFocusedProducerIdentity,
} from "../../scripts/validate-authorized-beta-focused-evidence.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const seedDirs = useAutoCleanupTempDirTracker(afterAll);
let fixtureSeed: ReturnType<typeof buildFixturePolicy> | undefined;

type ParsedWorkflow = {
  jobs?: Record<
    string,
    {
      environment?: string;
      needs?: string | string[];
      outputs?: Record<string, string>;
      permissions?: Record<string, string>;
      steps?: Array<{
        env?: Record<string, string>;
        if?: string;
        name?: string;
        run?: string;
        uses?: string;
        with?: Record<string, unknown>;
      }>;
    }
  >;
  on: {
    workflow_dispatch: null | {
      inputs: Record<string, { options?: string[] }>;
    };
  };
  permissions?: Record<string, string>;
};

const REPO_ROOT = resolve(".");
const focusedPolicyFile = "authorized-beta-focused-policy.json";
const focusedWorkflow = "authorized-beta-focused-validation";
const candidateVerifier = "verify-authorized-beta-focused-candidate.mjs";
const focusedValidator = "validate-authorized-beta-focused-evidence.mts";
const workflowPath = (name: string) => `.github/workflows/${name}.yml`;
const workflowSource = (name: string) => readFileSync(workflowPath(name), "utf8");
const readWorkflow = (name: string) => parse(workflowSource(name)) as ParsedWorkflow;
const readJson = <T>(file: string): T => JSON.parse(readFileSync(file, "utf8"));
const writeJson = (file: string, value: unknown) => writeFileSync(file, JSON.stringify(value));
const producerIdentity: AuthorizedBetaFocusedProducerIdentity = {
  repository: "openclaw/openclaw",
  runId: "123",
  runAttempt: 1,
  workflowPath: workflowPath(focusedWorkflow),
  workflowFullRef: "refs/tags/release-publish/aaaaaaaaaaaa-1",
  workflowRef: "release-publish/aaaaaaaaaaaa-1",
  workflowSha: "a".repeat(40),
};

function expectContains(source: string | undefined, values: string[]) {
  for (const value of values) {
    expect(source).toContain(value);
  }
}

function expectCandidateVerification(step: ReturnType<typeof namedStep>) {
  expectContains(step.run, [candidateVerifier]);
  expect(step.run).not.toContain("--candidate-root .");
  expect(step.run?.indexOf("gh attestation verify")).toBeLessThan(
    step.run?.indexOf(candidateVerifier) ?? -1,
  );
}

const VALIDATOR_CLOSURE = [
  `scripts/${focusedPolicyFile}`,
  "scripts/lib/record-shared.mjs",
  `scripts/${focusedValidator}`,
  `scripts/${candidateVerifier}`,
] as const;

function stageValidatorClosure(root: string): string {
  for (const sourcePath of VALIDATOR_CLOSURE) {
    const relativePath = sourcePath.replace(/^scripts\//u, "");
    const targetPath = join(root, relativePath);
    mkdirSync(dirname(targetPath), { recursive: true });
    copyFileSync(join(REPO_ROOT, sourcePath), targetPath);
  }
  return join(root, focusedValidator);
}

function namedStep(workflow: ParsedWorkflow, jobName: string, stepName: string) {
  return expectDefined(
    workflow.jobs?.[jobName]?.steps?.find((entry) => entry.name === stepName),
    `workflow step missing: ${jobName}/${stepName}`,
  );
}

const stepNames = (workflow: ParsedWorkflow, job: string) =>
  (workflow.jobs?.[job]?.steps ?? []).map((step) => step.name);

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function commit(root: string, message: string): string {
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-qm", message], { cwd: root });
  return git(root, ["rev-parse", "HEAD"]);
}

function fixturePolicy(): { policy: AuthorizedBetaFocusedPolicy; root: string } {
  const seed = (fixtureSeed ??= buildFixturePolicy(seedDirs.make("authorized-beta-focused-seed-")));
  const root = tempDirs.make("authorized-beta-focused-");
  // Copy the complete Git state so each case owns its refs, hooks, index, and objects.
  cpSync(seed.root, root, { recursive: true, mode: 0 });
  return { root, policy: structuredClone(seed.policy) };
}

function buildFixturePolicy(root: string): { policy: AuthorizedBetaFocusedPolicy; root: string } {
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
  writeFileSync(join(root, "published.txt"), "published\n");
  const historicalToolingSha = commit(root, "historical tooling");
  mkdirSync(join(root, ".github", "workflows"), { recursive: true });
  mkdirSync(join(root, "scripts"));
  writeFileSync(
    join(root, workflowPath(focusedWorkflow)),
    "name: Authorized Beta Focused Validation\n",
  );
  writeJson(join(root, "scripts", focusedPolicyFile), { historicalToolingSha });
  mkdirSync(join(root, "tests"));
  writeFileSync(join(root, "tests", "proof.test.ts"), "one\n");
  const baseCandidateSha = commit(root, "base");
  writeFileSync(join(root, "tests", "proof.test.ts"), "one\ntwo\n");
  const candidateSha = commit(root, "proof");
  const candidateTreeSha = git(root, ["rev-parse", `${candidateSha}^{tree}`]);
  const baseTreeSha = git(root, ["rev-parse", `${baseCandidateSha}^{tree}`]);
  const projection = git(root, ["ls-tree", "-r", candidateSha])
    .split("\n")
    .filter((line) => !line.endsWith("\ttests/proof.test.ts"))
    .join("\n");
  const packageProjectionSha256 = createHash("sha256").update(`${projection}\n`).digest("hex");
  return {
    root,
    policy: {
      ...readAuthorizedBetaFocusedPolicy(),
      baseCandidateSha,
      candidateSha,
      historicalToolingSha,
      reviewedHeadSha: candidateSha,
      candidateTreeSha,
      baseTreeSha,
      packageProjectionSha256,
      changedPaths: [{ path: "tests/proof.test.ts", status: "M", added: 1, deleted: 0 }],
    },
  };
}

function focusedEvidence(
  policy: AuthorizedBetaFocusedPolicy,
  producer: AuthorizedBetaFocusedProducerIdentity,
): AuthorizedBetaFocusedEvidence {
  const { historicalFrv: history, focusedProof: proof } = policy;
  return {
    schema: "openclaw.authorized-beta-focused-evidence.v1",
    mode: "authorized-beta-focused-v1",
    policySha256: digestAuthorizedBetaFocusedPolicy(policy),
    releaseTag: policy.releaseTag,
    candidate: {
      sha: policy.candidateSha,
      parentSha: policy.baseCandidateSha,
      treeSha: policy.candidateTreeSha,
      packageProjectionSha256: policy.packageProjectionSha256,
      changedPaths: policy.changedPaths,
    },
    producer,
    historical: {
      frvRunId: history.runId,
      frvRunAttempt: history.runAttempt,
      releaseChecksRunId: history.releaseChecksRunId,
      performanceRunId: history.performanceRunId,
    },
    focused: {
      ciRunId: proof.ciRunId,
      ciJobId: proof.ciSuccessJobId,
      pluginRunId: proof.pluginRunId,
      pluginJobId: proof.pluginSuccessJobId,
      reviewedHeadSha: policy.reviewedHeadSha,
    },
    inventory: { eligibilityPlanDigest: policy.eligibilityPlanDigest, ...policy.inventory },
  };
}

function runFocusedValidatorLogProbe(
  outcome: "flagged" | "legacy" | "unrelated",
  skippedHistoricalChild = false,
) {
  const { policy, root } = fixturePolicy();
  const trustedRoot = tempDirs.make("authorized-beta-focused-job-log-");
  const validatorPath = stageValidatorClosure(trustedRoot);
  const artifactPath = join(trustedRoot, "evidence.json");
  const callsPath = join(trustedRoot, "gh-log-calls.jsonl");
  const historical = policy.historicalFrv;
  const focused = policy.focusedProof;
  const producer = producerIdentity;
  const { workflowSha: producerSha, workflowRef: producerRef } = producer;
  const createRun = (
    id: string,
    name: string,
    path: string,
    conclusion: string,
    headBranch = historical.workflowRef,
    headSha = policy.historicalToolingSha,
  ) => ({
    id,
    name,
    path,
    conclusion,
    run_attempt: 1,
    event: "workflow_dispatch",
    status: "completed",
    head_branch: headBranch,
    head_sha: headSha,
  });
  const createJob = (id: string, runId: string, name: string, conclusion: string) => ({
    id,
    run_id: runId,
    name,
    conclusion,
    status: "completed",
    head_sha: policy.historicalToolingSha,
  });
  const historicalTitle = `full-release-validation-${historical.runId}-${historical.runAttempt}`;
  const runs = [
    createRun(
      producer.runId,
      "Authorized Beta Focused Validation",
      producer.workflowPath,
      "success",
      producerRef,
      producerSha,
    ),
    createRun(historical.runId, "Full Release Validation", historical.workflowPath, "failure"),
    ...(
      [
        [historical.ciRunId, `CI ${historicalTitle}-ci`, "ci", "failure"],
        [
          historical.pluginRunId,
          `Plugin Prerelease ${historicalTitle}-plugin-prerelease`,
          "plugin-prerelease",
          "failure",
        ],
        [
          historical.releaseChecksRunId,
          `OpenClaw Release Checks ${historicalTitle}-release-checks`,
          "openclaw-release-checks",
          "success",
        ],
        [
          historical.performanceRunId,
          `OpenClaw Performance ${historicalTitle}`,
          "openclaw-performance",
          "failure",
        ],
      ] as const
    ).map(([id, name, workflow, conclusion]) =>
      createRun(id, name, workflowPath(workflow), conclusion),
    ),
    ...(
      [
        [focused.ciRunId, "CI beta3-slack-proof-e347223a", "ci", "success"],
        [
          focused.pluginRunId,
          "Plugin Prerelease beta3-slack-proof-e347223a",
          "plugin-prerelease",
          "failure",
        ],
      ] as const
    ).map(([id, name, workflow, conclusion]) =>
      createRun(
        id,
        name,
        workflowPath(workflow),
        conclusion,
        policy.historicalToolingRef.replace("refs/tags/", ""),
      ),
    ),
  ];
  const h = historical;
  const f = focused;
  const jobs = [
    createJob(h.ciFailedJobId, h.ciRunId, "check-lint", "failure"),
    createJob(h.ciAggregateJobId, h.ciRunId, "openclaw/ci-gate", "failure"),
    createJob(h.pluginFailedJobId, h.pluginRunId, "checks-node-extensions-shard-7", "failure"),
    createJob(h.pluginAggregateJobId, h.pluginRunId, "plugin-prerelease-suite", "failure"),
    createJob(
      h.releaseChecksVerifierJobId,
      h.releaseChecksRunId,
      "Verify release checks",
      "success",
    ),
    createJob(
      h.performanceFailedJobId,
      h.performanceRunId,
      "OpenClaw source performance probes",
      "failure",
    ),
    createJob(f.ciSuccessJobId, f.ciRunId, "check-lint", "success"),
    createJob(f.ciTargetLogJobId, f.ciRunId, "preflight", "success"),
    createJob(f.pluginSuccessJobId, f.pluginRunId, "checks-node-extensions-shard-7", "success"),
    createJob(f.pluginTargetLogJobId, f.pluginRunId, "Build plugin prerelease plan", "success"),
  ];
  const plan = {
    parentRunId: historical.runId,
    parentRunAttempt: historical.runAttempt,
    workflowRef: historical.workflowRef,
    workflowSha: policy.historicalToolingSha,
    targetSha: historical.targetSha,
    releaseProfile: "beta",
    rerunGroup: "all",
    children: [
      { key: "normalCi", selected: true, runId: historical.ciRunId },
      { key: "pluginPrerelease", selected: true, runId: historical.pluginRunId },
      { key: "releaseChecks", selected: true, runId: historical.releaseChecksRunId },
      { key: "productPerformance", selected: true, runId: historical.performanceRunId },
      ...(skippedHistoricalChild ? [{ key: "npmTelegram", selected: false, runId: "" }] : []),
    ],
  };
  const evidence = focusedEvidence(policy, producer);
  writeJson(join(trustedRoot, focusedPolicyFile), policy);
  writeJson(artifactPath, evidence);
  const apiResponses = [
    ...runs.map((run) => [`repos/openclaw/openclaw/actions/runs/${run.id}`, run] as const),
    ...jobs.map((job) => [`repos/openclaw/openclaw/actions/jobs/${job.id}`, job] as const),
    [
      `repos/openclaw/openclaw/git/ref/tags/${producerRef}`,
      { object: { type: "commit", sha: producerSha } },
    ] as const,
  ];
  writeFileSync(
    join(trustedRoot, "gh"),
    [
      "#!/bin/sh",
      'command="$1"; route="$2"; shift 2',
      'if [ "$command" = run ] && [ "$route" = download ]; then',
      '  while [ "$1" != --dir ]; do shift; done',
      `  printf '%s' '${JSON.stringify(plan)}' > "$2/full-release-execution-plan.json"`,
      "  exit 0",
      "fi",
      'if [ "$command" = api ] && [ "${route%/logs}" != "$route" ]; then',
      '  if [ "$1" = --allow-escape-sequences ]; then',
      `    printf '["api","%s","--allow-escape-sequences"]\\n' "$route" >> '${callsPath}'`,
      `    if [ "$route" = 'repos/openclaw/openclaw/actions/jobs/${focused.ciTargetLogJobId}/logs' ] && [ '${outcome}' != flagged ]; then`,
      `      if [ '${outcome}' = legacy ]; then`,
      "        printf 'unknown flag: --allow-escape-sequences\\r\\n\\r\\nUsage: gh api <endpoint> [flags]\\r\\n' >&2",
      "      else",
      "        printf 'error: unknown flag: --allow-escape-sequences\\n' >&2",
      "      fi",
      "      exit 1",
      "    fi",
      "  else",
      `    printf '["api","%s"]\\n' "$route" >> '${callsPath}'`,
      "  fi",
      `  printf '\\033[32m${policy.reviewedHeadSha}\\033[0m'`,
      "  exit 0",
      "fi",
      'if [ "$command" = api ]; then',
      '  case "$route" in',
      ...apiResponses.map(
        ([route, response]) => `    '${route}') printf '%s' '${JSON.stringify(response)}' ;;`,
      ),
      "    *) printf 'unexpected GitHub API route: %s\\n' \"$route\" >&2; exit 1 ;;",
      "  esac",
      "  exit 0",
      "fi",
      'printf \'unexpected gh invocation: %s %s\\n\' "$command" "$route" >&2',
      "exit 1",
    ].join("\n"),
    { mode: 0o755 },
  );

  const result = spawnSync(
    process.execPath,
    [
      validatorPath,
      "verify",
      "--candidate-root",
      root,
      "--artifact",
      artifactPath,
      ...producerArgs(producer),
    ],
    {
      encoding: "utf8",
      env: { ...process.env, PATH: `${trustedRoot}:${process.env.PATH ?? ""}` },
    },
  );
  const calls = readFileSync(callsPath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as string[]);
  return { calls, policy, result };
}

function stageCandidateVerifier(policy: AuthorizedBetaFocusedPolicy, shouldFail = false) {
  const trustedRoot = tempDirs.make("authorized-beta-focused-trusted-");
  const validatorPath = stageValidatorClosure(trustedRoot);
  const policyPath = join(trustedRoot, focusedPolicyFile);
  const markerPath = join(trustedRoot, "candidate-verifier.json");
  writeJson(policyPath, policy);
  const fixtureValidatorPath = join(trustedRoot, "candidate-verifier.mjs");
  writeFileSync(
    fixtureValidatorPath,
    [
      `import { readdirSync, writeFileSync } from "node:fs";`,
      `import { assertAuthorizedBetaFocusedCandidate, readAuthorizedBetaFocusedPolicy } from ${JSON.stringify(pathToFileURL(validatorPath).href)};`,
      `const args = process.argv.slice(2);`,
      `const candidateRoot = args[args.indexOf("--candidate-root") + 1];`,
      `assertAuthorizedBetaFocusedCandidate(readAuthorizedBetaFocusedPolicy(), candidateRoot);`,
      `writeFileSync(${JSON.stringify(markerPath)}, JSON.stringify({ args, candidateRoot, entries: readdirSync(candidateRoot) }));`,
      shouldFail ? `throw new Error("trusted fixture verifier rejected evidence");` : "",
    ].join("\n"),
  );
  return {
    fixtureValidatorPath,
    helperPath: join(trustedRoot, candidateVerifier),
    markerPath,
    policyPath,
    validatorPath,
  };
}

function runCandidateVerifier(params: {
  helperPath?: string;
  policyPath: string;
  repositoryRoot: string;
  validatorPath: string;
  verifierArgs?: string[];
}) {
  return spawnSync(
    process.execPath,
    [
      params.helperPath ?? join(REPO_ROOT, "scripts", candidateVerifier),
      "--repository-root",
      params.repositoryRoot,
      "--validator",
      params.validatorPath,
      "--policy",
      params.policyPath,
      ...(params.verifierArgs ?? []),
    ],
    { encoding: "utf8" },
  );
}

function producerArgs(producer = producerIdentity) {
  return [
    "--producer-run-id",
    producer.runId,
    "--producer-run-attempt",
    String(producer.runAttempt),
    "--producer-workflow-full-ref",
    producer.workflowFullRef,
    "--producer-workflow-sha",
    producer.workflowSha,
  ];
}

function candidateFixture(
  shouldFail = false,
  overrides: Partial<AuthorizedBetaFocusedPolicy> = {},
) {
  const { policy, root } = fixturePolicy();
  const staged = stageCandidateVerifier({ ...policy, ...overrides }, shouldFail);
  const originalWorktrees = git(root, ["worktree", "list", "--porcelain"]);
  const run = (runOverrides: Partial<Parameters<typeof runCandidateVerifier>[0]> = {}) =>
    runCandidateVerifier({
      policyPath: staged.policyPath,
      repositoryRoot: root,
      validatorPath: staged.fixtureValidatorPath,
      ...runOverrides,
    });
  const expectWorktreesUnchanged = () =>
    expect(git(root, ["worktree", "list", "--porcelain"])).toBe(originalWorktrees);
  return { policy, root, staged, run, expectWorktreesUnchanged };
}

function divergeRelease(root: string, policy: AuthorizedBetaFocusedPolicy) {
  git(root, ["checkout", "--quiet", "--detach", policy.baseCandidateSha]);
  writeFileSync(join(root, "published.txt"), "divergent release\n");
  return commit(root, "divergent release");
}

function resolveFocusedProducer(
  options: {
    boundary?: "docker" | "resolve";
    consumer?: "diverged";
    producer?: "policy-drift" | "unanchored";
    run?: Record<string, unknown>;
    tag?: Record<string, unknown>;
  } = {},
) {
  const { policy, root } = fixturePolicy();
  let producerSha = policy.baseCandidateSha;
  const consumerSha = policy.candidateSha;
  if (options.consumer === "diverged" || options.producer) {
    if (options.producer === "unanchored") {
      git(root, ["checkout", "--quiet", "--orphan", "unanchored-producer"]);
    } else {
      git(root, ["checkout", "--quiet", "--detach", policy.baseCandidateSha]);
    }
    if (options.producer === "policy-drift") {
      writeJson(join(root, "scripts", focusedPolicyFile), { historicalToolingSha: "f".repeat(40) });
    } else {
      writeFileSync(join(root, "published.txt"), "protected producer branch\n");
    }
    producerSha = commit(root, "protected producer");
    git(root, ["checkout", "--quiet", "--detach", consumerSha]);
  }
  const producerRef = `release-publish/${producerSha.slice(0, 12)}-123`;
  const outputPath = join(root, "github-output");
  const isDockerBoundary = options.boundary === "docker";
  const workflow = readWorkflow(isDockerBoundary ? "docker-release" : "openclaw-release-publish");
  const run = {
    id: 123,
    run_attempt: 2,
    name: "Authorized Beta Focused Validation",
    path: workflowPath(focusedWorkflow),
    event: "workflow_dispatch",
    status: "completed",
    conclusion: "success",
    head_branch: producerRef,
    head_sha: producerSha,
    ...options.run,
  };
  const tag = {
    ref: `refs/tags/${producerRef}`,
    object: { sha: producerSha, type: "commit" },
    ...options.tag,
  };
  const result = spawnSync(
    "bash",
    [
      "-c",
      [
        "gh() {",
        '  if [[ "$2" == */actions/runs/* ]]; then',
        '    if [[ "${3:-}" == --jq ]]; then',
        '      printf "%s\\n" "$MOCK_RUN_JSON" | jq -r "$4"',
        "    else",
        '      printf "%s\\n" "$MOCK_RUN_JSON"',
        "    fi",
        '  elif [[ "$2" == */git/ref/tags/* && "$MOCK_TAG_MISSING" != true ]]; then',
        '    printf "%s\\n" "$MOCK_TAG_JSON" | jq -r "$4"',
        "  else",
        "    return 1",
        "  fi",
        "}",
        namedStep(
          workflow,
          isDockerBoundary ? "publish" : "resolve_release_target",
          isDockerBoundary
            ? "Revalidate focused evidence producer after Docker approval"
            : "Resolve focused release evidence run",
        ).run,
      ].join("\n"),
    ],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        FOCUSED_RELEASE_EVIDENCE_RUN_ATTEMPT: "2",
        FOCUSED_RELEASE_EVIDENCE_RUN_ID: "123",
        GITHUB_OUTPUT: outputPath,
        GITHUB_REPOSITORY: "openclaw/openclaw",
        MOCK_RUN_JSON: JSON.stringify(run),
        MOCK_TAG_JSON: JSON.stringify(tag),
        MOCK_TAG_MISSING: "false",
        PRODUCER_WORKFLOW_FULL_REF: `refs/tags/${producerRef}`,
        PRODUCER_WORKFLOW_SHA: producerSha,
        WORKFLOW_SHA: consumerSha,
      },
    },
  );
  return { consumerSha, outputPath, producerRef, producerSha, result };
}

it("accepts an exact protected focused producer from diverged trusted tooling", () => {
  const { outputPath, producerRef, producerSha, result } = resolveFocusedProducer({
    consumer: "diverged",
  });
  expect(result).toMatchObject({ stderr: "", status: 0 });
  expect(readFileSync(outputPath, "utf8")).toBe(
    `attempt=2\nworkflow_full_ref=refs/tags/${producerRef}\nworkflow_sha=${producerSha}\n`,
  );
});

it.each([
  ["unanchored producer", { producer: "unanchored" }],
  ["producer policy drift", { producer: "policy-drift" }],
  ["moved producer tag", { tag: { object: { sha: "f".repeat(40), type: "commit" } } }],
  ["producer SHA prefix mismatch", { run: { head_branch: "release-publish/ffffffffffff-123" } }],
  ["malformed producer tag", { run: { head_branch: "release-publish/ffffffffffff-0" } }],
  ["wrong producer workflow path", { run: { path: workflowPath("openclaw-release-publish") } }],
] as const)("rejects %s before focused artifact download", (_name, options) => {
  expect(resolveFocusedProducer(options).result.status).not.toBe(0);
});

it.each([
  ["moved producer tag", { tag: { object: { sha: "f".repeat(40), type: "commit" } } }],
  ["rerun producer", { run: { run_attempt: 3 } }],
] as const)("rejects %s after Docker approval before registry access", (_name, options) => {
  expect(resolveFocusedProducer({ ...options, boundary: "docker" }).result.status).not.toBe(0);
});

it("gates Docker registry access on post-approval focused evidence revalidation", () => {
  const docker = readWorkflow("docker-release");
  const gate = expectDefined(docker.jobs?.publish, "Docker publication gate is missing");

  expect(docker.jobs?.approve?.environment).toBe("docker-release");
  expect(gate.environment).toBeUndefined();
  expect(gate.needs).toContain("approve");
  expect(gate.permissions).toMatchObject({
    actions: "read",
    attestations: "read",
    contents: "read",
  });
  const names = stepNames(docker, "publish");
  const revalidation = names.indexOf("Revalidate focused evidence producer after Docker approval");
  const download = names.indexOf("Download focused release evidence after Docker approval");
  const verification = names.indexOf("Verify focused release evidence after Docker approval");
  const credentials = names.indexOf("Log in to GHCR");
  expect(revalidation).toBeGreaterThan(-1);
  expect(revalidation).toBeLessThan(download);
  expect(download).toBeLessThan(verification);
  expect(verification).toBeLessThan(credentials);
  const verifyStep = namedStep(
    docker,
    "publish",
    "Verify focused release evidence after Docker approval",
  );
  expectCandidateVerification(verifyStep);
});

it("accepts skipped historical release-plan children without run identities", () => {
  const { result } = runFocusedValidatorLogProbe("flagged", true);
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain("authorized beta focused evidence verified");
});

it.each(["legacy", "unrelated"] as const)("handles %s gh job-log errors", (outcome) => {
  const { calls, policy, result } = runFocusedValidatorLogProbe(outcome);
  const ciLogArgs = [
    "api",
    `repos/openclaw/openclaw/actions/jobs/${policy.focusedProof.ciTargetLogJobId}/logs`,
  ];
  const pluginLogArgs = [
    "api",
    `repos/openclaw/openclaw/actions/jobs/${policy.focusedProof.pluginTargetLogJobId}/logs`,
  ];
  const flaggedCiLogArgs = [...ciLogArgs, "--allow-escape-sequences"];
  const flaggedPluginLogArgs = [...pluginLogArgs, "--allow-escape-sequences"];

  if (outcome === "unrelated") {
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("error: unknown flag: --allow-escape-sequences");
    expect(calls).toEqual([flaggedCiLogArgs]);
    return;
  }

  expect(result.stderr).toBe(
    outcome === "legacy"
      ? "unknown flag: --allow-escape-sequences\r\n\r\nUsage: gh api <endpoint> [flags]\r\n"
      : "",
  );
  expect(result.status).toBe(0);
  expect(result.stdout).toBe(
    `authorized beta focused evidence verified for ${policy.releaseTag} at ${policy.candidateSha}\n`,
  );
  expect(calls).toEqual(
    outcome === "legacy"
      ? [flaggedCiLogArgs, ciLogArgs, flaggedPluginLogArgs]
      : [flaggedCiLogArgs, flaggedPluginLogArgs],
  );
});

it("binds the direct-child tree, exact diff, and unchanged published projection", () => {
  const { policy, root } = fixturePolicy();
  const changedPath = expectDefined(
    policy.changedPaths[0],
    "fixture policy must include one changed path",
  );
  expect(() => assertAuthorizedBetaFocusedCandidate(policy, root)).not.toThrow();
  expect(() =>
    assertAuthorizedBetaFocusedCandidate(
      { ...policy, changedPaths: [{ ...changedPath, added: 2 }] },
      root,
    ),
  ).toThrow("candidate diff does not match authorized path");
});

it("verifies the policy candidate when the release checkout has diverged", () => {
  const { policy, root, staged, run } = candidateFixture();
  const releaseSha = divergeRelease(root, policy);
  const ancestry = spawnSync(
    "git",
    ["merge-base", "--is-ancestor", policy.candidateSha, releaseSha],
    { cwd: root },
  );
  expect(ancestry.status).toBe(1);

  const checkoutHookMarker = join(root, "checkout-hook-ran");
  writeFileSync(
    join(root, ".git", "hooks", "post-checkout"),
    `#!/bin/sh\n: > ${JSON.stringify(checkoutHookMarker)}\n`,
    { mode: 0o755 },
  );
  const verifierArgs = ["--artifact", join(root, "evidence.json"), ...producerArgs()];
  const direct = spawnSync(
    process.execPath,
    [staged.validatorPath, "verify", "--candidate-root", root, ...verifierArgs],
    { encoding: "utf8" },
  );
  expect(direct.status).toBe(1);
  expect(direct.stderr).toContain(
    `candidate checkout must be ${policy.candidateSha}, got ${releaseSha}`,
  );

  const originalWorktrees = git(root, ["worktree", "list", "--porcelain"]);
  const stagedResult = run({ helperPath: staged.helperPath, verifierArgs });
  expect(stagedResult.status).toBe(0);
  const invocation = readJson<{
    args: string[];
    candidateRoot: string;
    entries: string[];
  }>(staged.markerPath);
  expect(invocation.args).toEqual([
    "verify",
    "--candidate-root",
    invocation.candidateRoot,
    ...verifierArgs,
  ]);
  expect(invocation.entries).toEqual([".git"]);
  expect(existsSync(checkoutHookMarker)).toBe(false);
  expect(existsSync(invocation.candidateRoot)).toBe(false);
  expect(git(root, ["worktree", "list", "--porcelain"])).toBe(originalWorktrees);
  expect(git(root, ["rev-parse", "HEAD"])).toBe(releaseSha);
});

it("rejects a short candidate before touching the repository or verifier", () => {
  const trustedRoot = tempDirs.make("authorized-beta-focused-invalid-");
  const policyPath = join(trustedRoot, focusedPolicyFile);
  writeJson(policyPath, {
    schema: "openclaw.authorized-beta-focused-policy.v1",
    mode: "authorized-beta-focused-v1",
    candidateSha: "abc",
  });
  const result = runCandidateVerifier({
    policyPath,
    repositoryRoot: join(trustedRoot, "missing-repository"),
    validatorPath: join(trustedRoot, "missing-verifier.mjs"),
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("invalid trusted focused evidence policy");
  expect(result.stderr).not.toContain("missing-repository");
});

it("rejects a policy that is not adjacent to the trusted verifier", () => {
  const { policy, staged, run } = candidateFixture();
  const otherRoot = tempDirs.make("authorized-beta-focused-other-policy-");
  const policyPath = join(otherRoot, focusedPolicyFile);
  writeJson(policyPath, policy);
  const result = run({ policyPath });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("trusted validator's adjacent policy");
  expect(existsSync(staged.markerPath)).toBe(false);
});

it("rejects an unavailable policy candidate without invoking the verifier", () => {
  const { root, staged, run, expectWorktreesUnchanged } = candidateFixture(false, {
    candidateSha: "f".repeat(40),
  });
  git(root, ["remote", "add", "origin", root]);
  const result = run();
  expect(result.status).toBe(1);
  expect(existsSync(staged.markerPath)).toBe(false);
  expectWorktreesUnchanged();
});

it("fetches only the exact policy candidate when the release clone does not contain it", () => {
  const { policy, root, staged, run } = candidateFixture();
  const releaseSha = divergeRelease(root, policy);
  git(root, ["branch", "release-candidate", releaseSha]);
  const releaseRoot = tempDirs.make("authorized-beta-focused-release-clone-");
  execFileSync("git", [
    "clone",
    "--quiet",
    "--no-local",
    "--depth",
    "1",
    "--branch",
    "release-candidate",
    root,
    releaseRoot,
  ]);
  expect(
    spawnSync("git", ["cat-file", "-e", `${policy.candidateSha}^{commit}`], {
      cwd: releaseRoot,
    }).status,
  ).not.toBe(0);

  const originalWorktrees = git(releaseRoot, ["worktree", "list", "--porcelain"]);
  const result = run({ repositoryRoot: releaseRoot });
  expect(result.status).toBe(0);
  expect(existsSync(staged.markerPath)).toBe(true);
  expect(git(releaseRoot, ["rev-parse", "HEAD"])).toBe(releaseSha);
  expect(git(releaseRoot, ["worktree", "list", "--porcelain"])).toBe(originalWorktrees);
});

it("rejects candidate-root overrides before staging a trusted candidate", () => {
  const { root, staged, run, expectWorktreesUnchanged } = candidateFixture();
  const result = run({ verifierArgs: ["--candidate-root", root] });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("invalid focused evidence verifier option: --candidate-root");
  expect(existsSync(staged.markerPath)).toBe(false);
  expectWorktreesUnchanged();
});

it("removes and prunes the candidate worktree when trusted verification fails", () => {
  const { staged, run, expectWorktreesUnchanged } = candidateFixture(true);
  const result = run();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("trusted fixture verifier rejected evidence");
  const invocation = readJson<{ candidateRoot: string }>(staged.markerPath);
  expect(existsSync(invocation.candidateRoot)).toBe(false);
  expectWorktreesUnchanged();
});

it("hashes sorted unique package inventories and rejects duplicates", () => {
  expect(digestAuthorizedPackageNames(["b", "a"])).toBe(
    createHash("sha256").update("a\nb\n").digest("hex"),
  );
  expect(() => digestAuthorizedPackageNames(["a", "a"])).toThrow(
    "package inventory contains duplicate names",
  );
});

it("derives the eligibility digest from the canonical full release plan", async () => {
  const plan = readJson<unknown>("test/fixtures/release-plan-v1.source.json");
  const lock = readJson<{ digest: string }>(
    "test/fixtures/release-plan-lock-v1.compatibility.json",
  );
  await expect(assertAuthorizedEligibilityPlanDigest(plan, lock.digest)).resolves.toBe(lock.digest);
  await expect(
    assertAuthorizedEligibilityPlanDigest(plan, `sha256:${"0".repeat(64)}`),
  ).rejects.toThrow("authorized eligibility plan digest mismatch");
});

it("accepts the exact artifact shape and rejects inventory drift", () => {
  const policy = readAuthorizedBetaFocusedPolicy();
  const producer = producerIdentity;
  const expectedInventory = {
    eligibilityPlanDigest: policy.eligibilityPlanDigest,
    ...policy.inventory,
  };
  const evidence = focusedEvidence(policy, producer);
  const validate = (value: AuthorizedBetaFocusedEvidence) =>
    validateAuthorizedBetaFocusedArtifactShape(value, policy, producer, expectedInventory);
  expect(() => validate(evidence)).not.toThrow();
  expect(() =>
    validate({ ...evidence, inventory: { ...evidence.inventory, npmCount: 92 } }),
  ).toThrow("focused evidence inventory");
});

it("wires a no-input attested producer and explicit parent/child evidence mode", () => {
  const producer = readWorkflow(focusedWorkflow);
  expect(producer.on.workflow_dispatch).toBeNull();
  expect(producer.permissions).toMatchObject({
    actions: "read",
    attestations: "write",
    contents: "read",
    "id-token": "write",
  });
  expectContains(workflowSource(focusedWorkflow), [
    "3fbe94065c2b94f4c08acb6742a69938bf408d94",
    "actions/attest@",
  ]);

  const parentWorkflow = readWorkflow("openclaw-release-publish");
  const npmWorkflow = readWorkflow("openclaw-npm-release");
  for (const [name, workflow] of [
    ["openclaw-release-publish", parentWorkflow],
    ["openclaw-npm-release", npmWorkflow],
  ] as const) {
    const inputs = expectDefined(
      workflow.on.workflow_dispatch?.inputs,
      `workflow inputs missing: ${name}`,
    );
    expect(inputs).toBeDefined();
    const evidenceMode = expectDefined(
      inputs.release_evidence_mode,
      `release evidence mode input missing: ${name}`,
    );
    expect(evidenceMode.options).toEqual(["full-release-validation", "authorized-beta-focused-v1"]);
    expect(inputs.focused_release_evidence_run_id).toBeDefined();
    expect(inputs.focused_release_evidence_run_attempt).toBeDefined();
    const source = workflowSource(name);
    const signerSha =
      name === "openclaw-release-publish" ? "PRODUCER_WORKFLOW_SHA" : "WORKFLOW_SHA";
    expectContains(source, [
      "Verify focused release evidence",
      "gh attestation verify",
      `--signer-digest "\${${signerSha}}"`,
      `--source-digest "\${${signerSha}}"`,
      focusedValidator,
      "inputs.release_evidence_mode == 'full-release-validation'",
      "validate-full-release-validation-evidence.mjs",
    ]);
  }
  const parentSource = readFileSync("scripts/lib/release-publish-children.sh", "utf8");
  expect(parentSource).toContain('proof_label="authorized beta focused validation"');
  expect(parentSource).toContain('proof_run_id="${FOCUSED_RELEASE_EVIDENCE_RUN_ID}"');
  expect(parentSource).toContain(
    "${process.env.RELEASE_VALIDATION_LABEL}: https://github.com/${process.env.RELEASE_REPO}/actions/runs/${process.env.RELEASE_VALIDATION_RUN_ID}",
  );
  const toolingCheckout = namedStep(
    parentWorkflow,
    "resolve_release_target",
    "Checkout trusted release validation tooling",
  );
  expect(toolingCheckout.with).toMatchObject({
    ref: "${{ github.workflow_sha }}",
    path: ".release-validation-tooling",
    "persist-credentials": false,
    "sparse-checkout": "scripts",
  });
  expect(stepNames(parentWorkflow, "resolve_release_target")).not.toContain(
    "Install focused release verifier dependency",
  );
  expect(parentWorkflow.jobs?.resolve_release_target?.outputs).toMatchObject({
    focused_release_evidence_workflow_full_ref:
      "${{ steps.focused_run.outputs.workflow_full_ref }}",
    focused_release_evidence_workflow_sha: "${{ steps.focused_run.outputs.workflow_sha }}",
  });
  for (const [jobName, stepName] of [
    ["resolve_release_target", "Verify focused release evidence"],
    ["publish", "Verify focused release evidence after approval"],
  ] as const) {
    const verifyStep = namedStep(parentWorkflow, jobName, stepName);
    const outputPrefix =
      jobName === "publish"
        ? "needs.resolve_release_target.outputs.focused_release_evidence_"
        : "steps.focused_run.outputs.";
    expect(verifyStep.env).toMatchObject({
      PRODUCER_WORKFLOW_FULL_REF: `\${{ ${outputPrefix}workflow_full_ref }}`,
      PRODUCER_WORKFLOW_SHA: `\${{ ${outputPrefix}workflow_sha }}`,
    });
    expectContains(verifyStep.run, [
      '--source-ref "${PRODUCER_WORKFLOW_FULL_REF}"',
      '--producer-workflow-full-ref "${PRODUCER_WORKFLOW_FULL_REF}"',
      '--producer-workflow-sha "${PRODUCER_WORKFLOW_SHA}"',
      "--repository-root .",
    ]);
    expectCandidateVerification(verifyStep);
  }
  const publishStepNames = stepNames(parentWorkflow, "publish");
  expect(publishStepNames.indexOf("Verify focused release evidence after approval")).toBeLessThan(
    publishStepNames.indexOf("Setup Node environment"),
  );
  const npmStepNames = stepNames(npmWorkflow, "publish_openclaw_npm");
  expect(npmStepNames.indexOf("Setup Node environment")).toBeLessThan(
    npmStepNames.indexOf("Verify focused release evidence"),
  );
  expect(
    namedStep(npmWorkflow, "publish_openclaw_npm", "Checkout trusted validation verifier").with,
  ).toMatchObject({ "sparse-checkout": "scripts" });
  const validatorSource = readFileSync(join("scripts", focusedValidator), "utf8");
  expectContains(validatorSource, [
    '"--intent",',
    '"--tooling-sha",',
    "policy.historicalToolingSha",
    "policy.historicalToolingRef",
    "assertAuthorizedEligibilityPlanDigest(",
  ]);
});
