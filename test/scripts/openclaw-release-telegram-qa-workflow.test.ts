import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { evaluateWorkflowRunner } from "./ci-workflow.test-support.js";

const RELEASE_CHECKS_PATH = ".github/workflows/openclaw-release-checks.yml";
const WORKFLOW_PATH = ".github/workflows/openclaw-release-telegram-qa.yml";
const HELPER = "scripts/release-telegram-qa.mjs";
const SOURCE_SHA = "a".repeat(40);
const TRUSTED_SHA = "b".repeat(40);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

type WorkflowStep = {
  env?: Record<string, unknown>;
  id?: string;
  if?: string;
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
};

type WorkflowJob = {
  "continue-on-error"?: boolean;
  environment?: string;
  if?: string;
  needs?: string[];
  outputs?: Record<string, unknown>;
  permissions?: Record<string, string>;
  "runs-on"?: unknown;
  "timeout-minutes"?: unknown;
  steps?: WorkflowStep[];
};

function workflow(path = WORKFLOW_PATH) {
  return parse(readFileSync(path, "utf8")) as { jobs?: Record<string, WorkflowJob> };
}

function job(name: string, path = WORKFLOW_PATH): WorkflowJob {
  const value = workflow(path).jobs?.[name];
  if (!value) {
    throw new Error(`Expected workflow job ${name}`);
  }
  return value;
}

function step(jobName: string, name: string, path = WORKFLOW_PATH): WorkflowStep {
  const value = job(jobName, path).steps?.find((candidate) => candidate.name === name);
  if (!value) {
    throw new Error(`Expected ${jobName} step ${name}`);
  }
  return value;
}

function requireRun(jobName: string, name: string): string {
  const value = step(jobName, name).run;
  if (!value) {
    throw new Error(`Expected ${jobName} step ${name} to run a script`);
  }
  return value;
}

function sutScript(delimiter?: string) {
  const script = requireRun("run_telegram", "Create isolated Telegram SUT identity and launcher");
  return delimiter ? extractHereDocument(script, delimiter) : script;
}

function containsAll(source: string, fragments: string[]) {
  for (const fragment of fragments) {
    expect(source).toContain(fragment);
  }
}

const PROVENANCE_BLOCKS = [
  { jobName: "build_candidate", stepName: "Validate candidate release provenance" },
  { jobName: "run_telegram", stepName: "Revalidate candidate release provenance" },
] as const;

type ProvenanceBlock = (typeof PROVENANCE_BLOCKS)[number];

function extractHereDocument(script: string, delimiter: string): string {
  const match = script.match(
    new RegExp(`<<'${delimiter}'\\n([\\s\\S]*?)\\n${delimiter}(?:\\n|$)`, "u"),
  );
  if (!match?.[1]) {
    throw new Error(`Expected ${delimiter} heredoc`);
  }
  return match[1];
}

function runIdentityVerification(
  params: {
    invocation?: "dispatch" | "reusable";
    oidcJobWorkflowSha?: string;
    oidcWorkflowSha?: string;
    targetContextRef?: string;
    workflowBranch?: string;
  } = {},
) {
  const repository = "openclaw/openclaw";
  const workflowBranch = params.workflowBranch ?? "main";
  const workflowRefName = `refs/heads/${workflowBranch}`;
  const trustedWorkflowRef = `${repository}/.github/workflows/openclaw-release-telegram-qa.yml@${workflowRefName}`;
  const invocation = params.invocation ?? "dispatch";
  const workflowRef =
    invocation === "dispatch"
      ? trustedWorkflowRef
      : `${repository}/.github/workflows/openclaw-release-checks.yml@${workflowRefName}`;
  const workdir = tempDirs.make("openclaw-telegram-identity-");
  const fakeBin = join(workdir, "bin");
  const githubOutput = join(workdir, "github-output");
  mkdirSync(fakeBin);
  const workflowSha = TRUSTED_SHA;
  const payload = {
    aud: "openclaw-release-telegram-qa",
    event_name: "workflow_dispatch",
    iss: "https://token.actions.githubusercontent.com",
    ...(invocation === "reusable"
      ? {
          job_workflow_ref: trustedWorkflowRef,
          job_workflow_sha: params.oidcJobWorkflowSha ?? TRUSTED_SHA,
        }
      : {}),
    ref: workflowRefName,
    repository,
    runner_environment: "github-hosted",
    sha: workflowSha,
    workflow_ref: workflowRef,
    workflow_sha: params.oidcWorkflowSha ?? workflowSha,
  };
  const token = ["{}", JSON.stringify(payload), "signature"]
    .map((part) => Buffer.from(part).toString("base64url"))
    .join(".");
  writeFileSync(
    join(fakeBin, "curl"),
    "#!/usr/bin/env bash\nprintf '%s\\n' \"$FAKE_OIDC_JSON\"\n",
    {
      mode: 0o755,
    },
  );
  return spawnSync(
    "bash",
    ["-c", requireRun("trusted_identity", "Verify dispatched workflow identity")],
    {
      cwd: workdir,
      encoding: "utf8",
      env: {
        ...process.env,
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: "test-token",
        ACTIONS_ID_TOKEN_REQUEST_URL: "https://example.invalid/oidc?",
        CALLER_WORKFLOW_REF: workflowRef,
        CALLER_WORKFLOW_SHA: workflowSha,
        EXPECTED_TRUSTED_WORKFLOW_SHA: TRUSTED_SHA,
        FAKE_OIDC_JSON: JSON.stringify({ value: token }),
        GITHUB_EVENT_NAME: "workflow_dispatch",
        GITHUB_OUTPUT: githubOutput,
        GITHUB_REF: workflowRefName,
        GITHUB_REPOSITORY: repository,
        GITHUB_SHA: workflowSha,
        JOB_CONTEXT: JSON.stringify({
          workflow_ref: trustedWorkflowRef,
          workflow_repository: repository,
          workflow_sha: TRUSTED_SHA,
        }),
        PATH: `${fakeBin}:${process.env.PATH}`,
        TARGET_CONTEXT_REF: params.targetContextRef ?? "",
        TARGET_REF: params.targetContextRef ? SOURCE_SHA : "refs/heads/release/2026.7.1",
        TARGET_SHA: SOURCE_SHA,
        WORKFLOW_REF: workflowRef,
        WORKFLOW_SHA: workflowSha,
      },
    },
  );
}

function runAdvisoryStatus(overrides: Record<string, string> = {}) {
  const runId = "123456";
  const runAttempt = "1";
  const effectiveRunAttempt = overrides.GITHUB_RUN_ATTEMPT ?? runAttempt;
  const targetSha = "a".repeat(40);
  const workdir = tempDirs.make("openclaw-telegram-advisory-status-");
  const githubOutput = join(workdir, "github-output");
  const result = spawnSync(process.execPath, [join(process.cwd(), HELPER), "advisory-status"], {
    cwd: workdir,
    encoding: "utf8",
    env: {
      ...process.env,
      ARCHIVE_NAME: `release-telegram-candidate-${runId}-${runAttempt}-${targetSha}.tar.zst`,
      ARCHIVE_SHA256: "c".repeat(64),
      ATTESTATION_RESULT: "success",
      ATTESTATION_STATUS: "success",
      BUILD_RESULT: "success",
      BUILD_STATUS: "success",
      CANDIDATE_ARTIFACT_DIGEST: "d".repeat(64),
      CANDIDATE_ARTIFACT_ID: "123",
      CANDIDATE_RUN_ATTEMPT: runAttempt,
      CANDIDATE_VERSION: "2026.7.1-beta.3",
      EVIDENCE_ARTIFACT_DIGEST: "e".repeat(64),
      EVIDENCE_ARTIFACT_ID: "456",
      EVIDENCE_ARTIFACT_NAME: `release-qa-live-telegram-${runId}-${runAttempt}-${targetSha}`,
      EXECUTION_STATUS: "success",
      GITHUB_OUTPUT: githubOutput,
      GITHUB_RUN_ATTEMPT: runAttempt,
      GITHUB_RUN_ID: runId,
      IDENTITY_RESULT: "success",
      IDENTITY_STATUS: "success",
      RUN_RESULT: "success",
      TARGET_SHA: targetSha,
      WORKFLOW_SHA: "b".repeat(40),
      ...overrides,
    },
  });
  const statusFile = join(
    workdir,
    ".artifacts",
    "release-check-status",
    `qa_live_telegram_release_checks-${runId}-${effectiveRunAttempt}.env`,
  );
  const evidenceFile = statusFile.replace(/\.env$/u, ".json");
  return {
    evidence: result.status === 0 ? JSON.parse(readFileSync(evidenceFile, "utf8")) : null,
    result,
    statusFile: result.status === 0 ? readFileSync(statusFile, "utf8") : "",
  };
}

type PullRequestFixture = {
  state?: string;
  baseRefName?: string;
  baseRepository?: string;
  mergeCommitOid?: string;
  mergedBy?: string;
};

function mergedPullRequest(value: PullRequestFixture = {}) {
  return {
    state: value.state ?? "MERGED",
    baseRefName: value.baseRefName ?? "release/2026.7.1",
    baseRepository: { nameWithOwner: value.baseRepository ?? "openclaw/openclaw" },
    mergeCommit: { oid: value.mergeCommitOid ?? SOURCE_SHA },
    mergedBy: { login: value.mergedBy ?? "release-maintainer" },
  };
}

function runCandidateProvenance(
  provenanceBlock: ProvenanceBlock,
  params: {
    branchHeads?: string[];
    releaseCompareStatus?: "ahead" | "behind" | "diverged" | "identical";
    candidateVersion?: string;
    messageHeadline?: string;
    directPullRequest?: PullRequestFixture;
    mergedPullRequests?: PullRequestFixture[];
    openPr?: boolean;
    permission?: "admin" | "maintain" | "write";
    remoteSha?: string;
    signature?: "invalid" | "maintainer" | "missing" | "web-flow";
    targetContextRef?: string;
    targetRef?: string;
    unrelatedOpenPullRequests?: number;
  } = {},
) {
  const candidateSha = SOURCE_SHA;
  const signature = params.signature ?? "maintainer";
  const targetContextRef = params.targetContextRef ?? "";
  const normalizedContextRef = targetContextRef
    .replace(/^refs\/heads\//u, "")
    .replace(/^refs\/tags\//u, "");
  const remoteRef = normalizedContextRef.startsWith("v")
    ? `refs/tags/${normalizedContextRef}`
    : `refs/heads/${normalizedContextRef || "release/2026.7.1"}`;
  const workdir = tempDirs.make("openclaw-telegram-provenance-");
  const fakeBin = join(workdir, "bin");
  mkdirSync(fakeBin);
  mkdirSync(join(workdir, ".candidate"));
  writeFileSync(
    join(workdir, ".candidate", "package.json"),
    JSON.stringify({ version: params.candidateVersion ?? "2026.7.1-beta.3" }),
  );
  const metadata = {
    data: {
      repository: {
        object: {
          oid: candidateSha,
          messageHeadline: params.messageHeadline ?? "release fixture",
          signature:
            signature === "missing"
              ? null
              : signature === "invalid"
                ? { isValid: false, state: "INVALID", signer: { login: "release-maintainer" } }
                : {
                    isValid: true,
                    state: "VALID",
                    signer: {
                      login: signature === "web-flow" ? "web-flow" : "release-maintainer",
                    },
                  },
          associatedPullRequests: {
            nodes: [
              ...(params.openPr
                ? [
                    {
                      state: "OPEN",
                      headRefOid: candidateSha,
                      headRepository: { nameWithOwner: "openclaw/openclaw" },
                    },
                  ]
                : []),
              ...Array.from({ length: params.unrelatedOpenPullRequests ?? 0 }, (_, index) => ({
                state: "OPEN",
                headRefOid: `${index + 1}`.repeat(40),
                headRepository: { nameWithOwner: "openclaw/openclaw" },
              })),
              ...(params.mergedPullRequests ?? []).map(mergedPullRequest),
            ],
          },
        },
      },
    },
  };
  writeFileSync(
    join(fakeBin, "gh"),
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == *"number="* ]]; then printf '%s\\n' "$FAKE_DIRECT_PR"; exit 0; fi
if [[ "$*" == *"api graphql"* ]]; then printf '%s\\n' "$FAKE_METADATA"; exit 0; fi
if [[ "$*" == *"/branches-where-head"* ]]; then printf '%s\\n' "$FAKE_BRANCH_HEADS"; exit 0; fi
if [[ "$*" == *"/compare/"* ]]; then printf '%s\\n' "behind"; exit 0; fi
if [[ "$*" == *"/collaborators/"*"/permission"* ]]; then printf '%s\\n' "$FAKE_PERMISSION"; exit 0; fi
exit 64
`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(fakeBin, "git"),
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == *"init --bare"* || "$*" == *"fetch --quiet"* ]]; then [[ -n "$FAKE_REMOTE_SHA" ]]; exit; fi
if [[ "$*" == *"FETCH_HEAD^{commit}"* ]]; then printf '%s\\n' "$FAKE_REMOTE_SHA"; exit 0; fi
if [[ "$*" == *"merge-base --is-ancestor"* ]]; then
  [[ "$TARGET_SHA" == "$FAKE_REMOTE_SHA" || "$FAKE_RELEASE_COMPARE_STATUS" == ahead ]]; exit
fi
if [[ "$*" == *"rev-parse HEAD"* ]]; then printf '%s\\n' "$TARGET_SHA"; exit 0; fi
if [[ "$*" == *"ls-remote"* ]]; then
  if [[ "$*" == *"refs/tags/"* && "$FAKE_REMOTE_REF" != refs/tags/* ]]; then exit 0; fi
  printf '%s\\t%s\\n' "$FAKE_REMOTE_SHA" "$FAKE_REMOTE_REF"
  exit 0
fi
exit 64
`,
    { mode: 0o755 },
  );
  return spawnSync("bash", ["-c", requireRun(provenanceBlock.jobName, provenanceBlock.stepName)], {
    cwd: workdir,
    encoding: "utf8",
    env: {
      ...process.env,
      FAKE_BRANCH_HEADS: (params.branchHeads ?? ["release/2026.7.1"]).join("\n"),
      FAKE_METADATA: JSON.stringify(metadata),
      FAKE_DIRECT_PR: JSON.stringify({
        data: {
          repository: {
            pullRequest: params.directPullRequest
              ? mergedPullRequest(params.directPullRequest)
              : null,
          },
        },
      }),
      FAKE_PERMISSION: JSON.stringify({
        permission: params.permission === "admin" ? "admin" : "write",
        role_name: params.permission ?? "maintain",
      }),
      FAKE_RELEASE_COMPARE_STATUS: params.releaseCompareStatus ?? "diverged",
      FAKE_REMOTE_REF: remoteRef,
      FAKE_REMOTE_SHA: params.remoteSha ?? candidateSha,
      CANDIDATE_GIT_DIR:
        provenanceBlock.jobName === "build_candidate" ? join(workdir, ".candidate") : "",
      CANDIDATE_ROOT: join(workdir, ".candidate"),
      GH_TRANSIENT_SERVER_OR_NETWORK_PATTERN: "HTTP 5[0-9][0-9]",
      GITHUB_WORKSPACE: process.cwd(),
      GITHUB_REPOSITORY: "openclaw/openclaw",
      PATH: `${fakeBin}:${process.env.PATH}`,
      TARGET_CONTEXT_REF: targetContextRef,
      TARGET_REF:
        params.targetRef ?? (targetContextRef ? candidateSha : "refs/heads/release/2026.7.1"),
      TARGET_SHA: candidateSha,
    },
  });
}

type ProvenanceCase = NonNullable<Parameters<typeof runCandidateProvenance>[1]> & {
  exit?: 0 | 1 | "nonzero";
  stdout?: string;
  stderr?: string;
};

function checkProvenance(
  block: ProvenanceBlock,
  { exit = 0, stdout, stderr, ...params }: ProvenanceCase,
) {
  const result = runCandidateProvenance(block, params);
  const assertion = expect(
    result.status,
    `${block.stepName}: ${JSON.stringify(params)}: ${result.stderr}`,
  );
  if (exit === "nonzero") {
    assertion.not.toBe(0);
  } else {
    assertion.toBe(exit);
  }
  for (const [actual, expected] of [
    [result.stdout, stdout],
    [result.stderr, stderr],
  ]) {
    if (expected !== undefined) {
      expect(actual).toContain(expected);
    }
  }
}

function provenanceScenario(block: ProvenanceBlock, defaults: ProvenanceCase) {
  return (overrides: ProvenanceCase = {}) => checkProvenance(block, { ...defaults, ...overrides });
}

describe("release Telegram QA workflow", () => {
  it("keeps the workflow wiring explicit and secret-scoped", () => {
    const release = workflow(RELEASE_CHECKS_PATH);
    const caller = release.jobs?.qa_live_telegram_release_checks;
    expect(caller).toMatchObject({
      needs: ["resolve_target"],
      permissions: { actions: "write", contents: "read" },
      "timeout-minutes": 210,
    });
    expect(evaluateWorkflowRunner(caller?.["runs-on"])).toBe("ubuntu-24.04");
    expect(caller?.environment).toBeUndefined();
    expect(caller?.outputs?.conclusion).toBe(
      "${{ steps.dispatch.outputs.conclusion || steps.dispatch.outcome }}",
    );
    expect(caller?.["continue-on-error"]).toBeUndefined();

    const trusted = job("trusted_identity");
    expect(trusted).toMatchObject({
      permissions: { contents: "read", "id-token": "write" },
      "runs-on": "ubuntu-24.04",
      "timeout-minutes": 5,
    });
    expect(step("trusted_identity", "Verify dispatched workflow identity").id).toBe("identity");

    const candidateBuild = requireRun(
      "build_candidate",
      "Build candidate runtime without runner credentials",
    );
    expect(candidateBuild).toContain("pnpm build qaRuntime");
    expect(candidateBuild).not.toContain("scripts/build-all.mts");
    expect(requireRun("build_candidate", "Archive bounded candidate tree")).toContain(
      '--arg buildCommand "pnpm build qaRuntime"',
    );
    expect(requireRun("attest_candidate", "Bounded extract and validate candidate")).toContain(
      '.buildCommand == "pnpm build qaRuntime"',
    );
    expect(requireRun("run_telegram", "Build trusted QA harness").trim()).toBe(
      "pnpm build qaRuntime",
    );
    const extractCandidate = step("run_telegram", "Verify attestation and bounded extract");
    expect(extractCandidate.env?.CALLED_WORKFLOW_REF).toBe(
      "${{ needs.trusted_identity.outputs.workflow_ref }}",
    );
    expect(extractCandidate.run).toContain(
      '--cert-identity "https://github.com/${CALLED_WORKFLOW_REF}"',
    );
    expect(extractCandidate.run).not.toContain("openclaw-release-telegram-qa.yml@refs/heads/main");

    const runJob = job("run_telegram");
    expect(runJob.environment).toBe("qa-live-shared");
    expect(runJob["timeout-minutes"]).toBe(90);
    const advisoryStatusStep = step("advisory_status", "Record advisory status");
    expect(advisoryStatusStep.env?.CANDIDATE_RUN_ATTEMPT).toBe(
      "${{ needs.build_candidate.outputs.run_attempt }}",
    );
    expect(requireRun("advisory_status", "Record advisory status").trim()).toBe(
      "set -euo pipefail\nnode scripts/release-telegram-qa.mjs advisory-status",
    );
    expect(
      PROVENANCE_BLOCKS.map(({ jobName, stepName }) => requireRun(jobName, stepName).trim()),
    ).toEqual([
      'bash "${GITHUB_WORKSPACE}/scripts/release-telegram-provenance.sh"',
      'bash "${GITHUB_WORKSPACE}/scripts/release-telegram-provenance.sh"',
    ]);
    for (const [jobName, value] of Object.entries(workflow().jobs ?? {})) {
      for (const checkout of value.steps?.filter((candidate) =>
        candidate.uses?.startsWith("actions/checkout@"),
      ) ?? []) {
        expect(checkout.with?.["persist-credentials"], `${jobName}:${checkout.name}`).toBe(false);
      }
    }
  });

  it("routes every documented workflow ref through exact direct and reusable identity", () => {
    const releaseCiBranch = `release-ci/${TRUSTED_SHA.slice(0, 12)}-1787215404735`;
    for (const workflowBranch of [
      "main",
      "release/2026.7.1",
      "extended-stable/2026.7.33",
      releaseCiBranch,
    ]) {
      for (const invocation of ["dispatch", "reusable"] as const) {
        const result = runIdentityVerification({
          invocation,
          workflowBranch,
        });
        expect(result.status, `${workflowBranch}/${invocation}: ${result.stderr}`).toBe(0);
      }
    }
  });

  it("accepts only canonical exact-SHA workflow and target identities", () => {
    for (const targetContextRef of [
      "release/2026.7.1",
      "extended-stable/2026.7.33",
      "v2026.7.1",
      "v2026.7.1-beta.3",
    ]) {
      const accepted = runIdentityVerification({ targetContextRef });
      expect(accepted.status, `${targetContextRef}: ${accepted.stderr}`).toBe(0);
    }
    const rejected: Array<[Parameters<typeof runIdentityVerification>[0], string]> = [
      [{ oidcWorkflowSha: "c".repeat(40) }, "OIDC workflow_sha mismatch"],
      [
        { invocation: "reusable", oidcJobWorkflowSha: "c".repeat(40) },
        "OIDC job_workflow_sha mismatch",
      ],
      [
        { workflowBranch: `release-ci/${"c".repeat(12)}-1787215404735` },
        "release-ci ref does not match the authorized tooling SHA",
      ],
      ...[
        "release-ci/not-canonical",
        "release/2026.0.1",
        "release/2026.07.1",
        "extended-stable/2026.13.33",
        "extended-stable/2026.7.32",
      ].map((workflowBranch): [Parameters<typeof runIdentityVerification>[0], string] => [
        { workflowBranch },
        "must be exact main, canonical release or extended-stable",
      ]),
    ];
    for (const [params, message] of rejected) {
      expect(runIdentityVerification(params).stderr).toContain(message);
    }
  });

  it("accepts only same-line extended-stable successors in both provenance blocks", () => {
    for (const provenanceBlock of PROVENANCE_BLOCKS) {
      checkProvenance(provenanceBlock, {
        candidateVersion: "2026.7.35",
        targetContextRef: "extended-stable/2026.7.33",
      });

      for (const candidateVersion of ["2026.7.32", "2026.8.35", "2026.7.35-beta.1"]) {
        checkProvenance(provenanceBlock, {
          candidateVersion,
          targetContextRef: "extended-stable/2026.7.33",
          exit: 1,
          stderr: "PATCH >= 33",
        });
      }
    }
  });

  it("keeps exact release candidates trusted when the canonical branch advances", () => {
    for (const provenanceBlock of PROVENANCE_BLOCKS) {
      for (const targetContextRef of ["release/2026.7.35", "extended-stable/2026.7.33"]) {
        for (const signature of ["maintainer", "web-flow", "missing"] as const) {
          checkProvenance(provenanceBlock, {
            candidateVersion: "2026.7.35",
            remoteSha: "b".repeat(40),
            releaseCompareStatus: "ahead",
            targetContextRef,
            signature,
            mergedPullRequests: [{ baseRefName: targetContextRef }],
            stdout: "Telegram candidate trust reason: release-branch",
          });
        }
      }
    }
  });

  it("rejects untrusted or uncontained candidates after the release branch advances", () => {
    const cases = [
      { releaseCompareStatus: "behind" as const },
      { releaseCompareStatus: "diverged" as const },
      { targetRef: "extended-stable/2026.7.33" },
      { remoteSha: "" },
      { openPr: true },
      { signature: "invalid" as const },
      { permission: "write" as const },
      { mergedPullRequests: [] },
      { mergedPullRequests: [{ mergeCommitOid: "c".repeat(40) }] },
      { mergedPullRequests: [{ baseRepository: "fork/openclaw" }] },
    ];
    for (const provenanceBlock of PROVENANCE_BLOCKS) {
      for (const params of cases) {
        checkProvenance(provenanceBlock, {
          candidateVersion: "2026.7.35",
          remoteSha: "b".repeat(40),
          releaseCompareStatus: "ahead",
          targetContextRef: "extended-stable/2026.7.33",
          signature: "web-flow",
          mergedPullRequests: [{ baseRefName: "extended-stable/2026.7.33" }],
          ...params,
          exit: "nonzero",
        });
      }
    }
  });

  it("accepts only strict signed frozen beta branch heads in both provenance blocks", () => {
    for (const provenanceBlock of PROVENANCE_BLOCKS) {
      const run = provenanceScenario(provenanceBlock, {
        branchHeads: ["release/2026.7.1-beta.3-code-frozen-r13"],
        candidateVersion: "2026.7.1-beta.3",
        remoteSha: "b".repeat(40),
        targetContextRef: "release/2026.7.1",
        exit: "nonzero",
      });
      run({ exit: 0, stdout: "Telegram candidate trust reason: frozen-release-branch-head" });

      const rejectedCases: Record<string, Parameters<typeof runCandidateProvenance>[1]> = {
        "stale frozen branch": { branchHeads: [] },
        "duplicate frozen branches": {
          branchHeads: [
            "release/2026.7.1-beta.3-code-frozen",
            "release/2026.7.1-beta.3-code-frozen-r13",
          ],
        },
        "wrong-version frozen branch": {
          branchHeads: ["release/2026.7.1-beta.2-code-frozen-r13"],
        },
        "non-exact target ref": { targetRef: "refs/heads/release/2026.7.1-beta.3-code-frozen-r13" },
        "missing signature": { signature: "missing" },
        "invalid signature": { signature: "invalid" },
        "web-flow signature": { signature: "web-flow" },
        "low-permission signer": { permission: "write" },
        "same-repository PR head": { openPr: true },
      };
      for (const params of Object.values(rejectedCases)) {
        run(params);
      }
    }
  });

  it("verifies an exact merged PR directly when commit associations omit it", () => {
    for (const provenanceBlock of PROVENANCE_BLOCKS) {
      for (const signature of ["web-flow", "missing"] as const) {
        checkProvenance(provenanceBlock, {
          candidateVersion: "2026.7.33",
          targetContextRef: "extended-stable/2026.7.33",
          signature,
          messageHeadline: "fix(release): keep survivor sessions inside retention (#149710)",
          directPullRequest: {},
          unrelatedOpenPullRequests: 2,
          stdout: "Telegram candidate trust reason: release-branch",
        });
      }
    }
  });

  it("uses one exact associated merge without consulting the PR hint", () => {
    for (const provenanceBlock of PROVENANCE_BLOCKS) {
      checkProvenance(provenanceBlock, {
        candidateVersion: "2026.7.33",
        directPullRequest: { state: "OPEN" },
        mergedPullRequests: [{}],
        messageHeadline: "fixture (#149710)",
        signature: "web-flow",
        targetContextRef: "extended-stable/2026.7.33",
        unrelatedOpenPullRequests: 2,
      });
    }
  });

  it("never treats a commit's PR hint as release authorization", () => {
    const cases = [
      { label: "missing PR", directPullRequest: undefined },
      { label: "open PR", directPullRequest: { state: "OPEN" } },
      { label: "closed unmerged PR", directPullRequest: { state: "CLOSED" } },
      { label: "foreign base repository", directPullRequest: { baseRepository: "fork/openclaw" } },
      { label: "different merge SHA", directPullRequest: { mergeCommitOid: "b".repeat(40) } },
      { label: "missing merger", directPullRequest: { mergedBy: "" } },
      { label: "insufficient merger permission", permission: "write" as const },
      { label: "invalid signature", signature: "invalid" as const },
      { label: "open candidate head", openPr: true },
      { label: "stale context branch", remoteSha: "b".repeat(40) },
      { label: "wrong version", candidateVersion: "2026.8.33" },
      { label: "no canonical PR suffix", messageHeadline: "claimed #149710 elsewhere" },
      { label: "ambiguous existing associations", mergedPullRequests: [{}, {}] },
    ];
    for (const provenanceBlock of PROVENANCE_BLOCKS) {
      for (const { label: _label, ...params } of cases) {
        checkProvenance(provenanceBlock, {
          candidateVersion: "2026.7.33",
          targetContextRef: "extended-stable/2026.7.33",
          signature: "web-flow",
          messageHeadline: "fixture (#149710)",
          directPullRequest: {},
          ...params,
          exit: "nonzero",
        });
      }
    }
  });

  it("keeps release provenance attribution fail-closed in both blocks", () => {
    for (const provenanceBlock of PROVENANCE_BLOCKS) {
      const run = provenanceScenario(provenanceBlock, {
        candidateVersion: "2026.7.1",
        targetContextRef: "release/2026.7.1",
        exit: "nonzero",
      });
      const cases: Record<string, Parameters<typeof runCandidateProvenance>[1]> = {
        "stale canonical branch": {
          candidateVersion: "2026.7.1-beta.3",
          remoteSha: "b".repeat(40),
        },
        "missing merge attribution": { signature: "missing" },
        "ambiguous merge attribution": {
          mergedPullRequests: [
            { baseRefName: "release-integration/2026.7.1-a" },
            { baseRefName: "release-integration/2026.7.1-b" },
          ],
          signature: "web-flow",
        },
        "foreign repository attribution": {
          mergedPullRequests: [{ baseRepository: "fork/openclaw" }],
          signature: "web-flow",
        },
        "different merge commit attribution": {
          mergedPullRequests: [{ mergeCommitOid: "b".repeat(40) }],
          signature: "web-flow",
        },
        "insufficient actor permission": {
          mergedPullRequests: [{ baseRefName: "release-integration/2026.7.1-repair" }],
          permission: "write",
          signature: "web-flow",
        },
        "invalid signature": { signature: "invalid" },
      };
      for (const params of Object.values(cases)) {
        run(params);
      }

      run({
        mergedPullRequests: [{ baseRefName: "release-integration/2026.7.1-repair" }],
        permission: "admin",
        signature: "missing",
        exit: 0,
      });

      run({
        candidateVersion: "2026.7.1-alpha.1",
        exit: 1,
        stderr: "Telegram candidate version 2026.7.1-alpha.1 does not belong to release 2026.7.1.",
      });
    }
  });

  it("binds every release context to candidate version and SHA", () => {
    for (const [targetContextRef, candidateVersion] of [
      ["release/2026.7.1", "2026.7.1"],
      ["extended-stable/2026.7.33", "2026.7.33"],
      ["v2026.7.1", "2026.7.1"],
      ["v2026.7.1-alpha.2", "2026.7.1-alpha.2"],
      ["v2026.7.1-beta.3", "2026.7.1-beta.3"],
    ] as const) {
      for (const provenanceBlock of PROVENANCE_BLOCKS) {
        const run = provenanceScenario(provenanceBlock, {
          candidateVersion,
          targetContextRef,
        });
        run();
        run({ candidateVersion: "2026.8.1", exit: 1 });
        run({ remoteSha: "b".repeat(40), exit: 1 });
      }
    }
  });

  it("records reused candidate and fresh evidence attempts independently", () => {
    const runId = "123456";
    const targetSha = "a".repeat(40);
    const rerun = runAdvisoryStatus({
      GITHUB_RUN_ATTEMPT: "2",
      EVIDENCE_ARTIFACT_NAME: `release-qa-live-telegram-${runId}-2-${targetSha}`,
    });

    expect(rerun.result.status, rerun.result.stderr).toBe(0);
    expect(rerun.evidence).toMatchObject({
      runAttempt: 2,
      candidateArtifact: { runAttempt: 1 },
      evidenceArtifact: { runAttempt: 2 },
    });
    expect(rerun.statusFile).toContain("run_attempt=2");
  });

  it.runIf(process.platform === "linux")("retains only bounded, allowlisted diagnostics", () => {
    const source = extractHereDocument(
      requireRun("run_telegram", "Capture isolated Telegram runtime diagnostics"),
      "NODE",
    );
    const workdir = tempDirs.make("openclaw-telegram-diagnostics-");
    const scriptPath = join(workdir, "redact-gateway-tail.mts");
    const outputPath = join(workdir, "gateway.log");
    writeFileSync(scriptPath, source);
    const records = [
      { 0: '{"subsystem":"gateway"}', 1: "ordinary info", _meta: { logLevelName: "INFO" } },
      {
        0: '{"subsystem":"agents/embedded"}',
        1: "embedded run start: safe",
        _meta: { logLevelName: "DEBUG" },
      },
      {
        0: '{"subsystem":"agents/embedded"}',
        1: "private trace",
        _meta: { logLevelName: "TRACE" },
      },
    ];
    const result = spawnSync(process.execPath, ["--import", "tsx", scriptPath, outputPath], {
      cwd: process.cwd(),
      encoding: "utf8",
      input: `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
    });
    expect(result.status, result.stderr).toBe(0);
    const output = readFileSync(outputPath, "utf8");
    expect(output).toContain("ordinary info");
    expect(output).toContain("embedded run start: safe");
    expect(output).not.toContain("private trace");
  });

  it("shares only the isolated workspace with the trusted scenario host", () => {
    const createSut = sutScript();
    containsAll(createSut, [
      'workspace="${temp_root}/workspace"',
      'chown -R "$RUNNER_UID:$SUT_GID" "$workspace"',
      'chmod -R u=rwX,g=rwX,o= "$workspace"',
      'find "$workspace" -type d -exec chmod g+s {} +',
    ]);
    expect(createSut).not.toContain(
      'for path in \\\n            "$temp_root/workspace" \\\n            "${OPENCLAW_HOME:?}"',
    );
  });

  it("lets the SUT create suite locks without exposing the runner-owned config", () => {
    const createSut = sutScript();
    containsAll(createSut, [
      'chown "$RUNNER_UID:$SUT_GID" "$temp_root"',
      'chmod 1770 "$temp_root"',
      '"$(stat -c \'%F:%a:%u:%g\' "$temp_root")" == "directory:1770:${RUNNER_UID}:${SUT_GID}"',
      'chown "$RUNNER_UID:$SUT_GID" "$config_path"',
      'chmod 0640 "$config_path"',
      '"$(stat -c \'%F:%a:%u:%g\' "$config_path")" == "regular file:640:${RUNNER_UID}:${SUT_GID}"',
      '"${temp_root}/state/qa-auth-bootstrap/openclaw.json")',
      '"$(stat -c \'%F:%a:%u:%g\' "$requested_config_path")" == "regular file:600:${SUT_UID}:${SUT_GID}"',
      'generation_dir="${RUNTIME_ROOT}/config-generations"',
      'install -d -o root -g root -m 0700 "$generation_dir"',
      '"regular file:600:0:0"',
      '/usr/bin/setpriv --reuid="$SUT_UID" --regid="$SUT_GID"',
      'export OPENCLAW_CONFIG_PATH="$projection_dir/openclaw.json"',
    ]);
    expect(createSut).not.toContain('chmod 0711 "$temp_root"');
    expect(createSut).not.toContain('chmod 1777 "$temp_root"');
  });

  it.runIf(process.platform === "linux").each(["directory", "symlink"])(
    "projects a %s run fixture through the actual SUT config seeder",
    (kind) => {
      const launcher = sutScript("LAUNCHER");
      const source = launcher.match(
        /\/bin\/bash --noprofile --norc -ceu '\n\s*(umask 077\n[\s\S]*?)\n\s*' openclaw-config-projection/u,
      )?.[1];
      if (!source) {
        throw new Error("Expected the unprivileged SUT config seeder");
      }
      const program = source.replaceAll("'\\''", "'");
      const root = tempDirs.make("openclaw-telegram-plugin-projection-");
      const plugin = join(root, "hook");
      mkdirSync(plugin);
      writeFileSync(join(plugin, "index.js"), "export default { register() {} };\n");
      if (kind === "symlink") {
        symlinkSync(join(plugin, "index.js"), join(plugin, "escape.js"));
      }
      const configPath = join(root, "openclaw.json");
      const external = "/outside/run/fixture";
      const config = JSON.stringify({ plugins: { load: { paths: [plugin, external] } } });
      writeFileSync(configPath, config);
      const projection = join(root, "state", "projection");
      const result = spawnSync(
        "bash",
        [
          "-ceu",
          program,
          "openclaw-config-projection",
          configPath,
          projection,
          createHash("sha256").update(config).digest("hex"),
          root,
        ],
        { encoding: "utf8" },
      );
      if (kind === "symlink") {
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(
          "Telegram QA plugin fixture contains unsupported file types",
        );
        return;
      }
      expect(result.status, result.stderr).toBe(0);
      const projected = JSON.parse(readFileSync(join(projection, "openclaw.json"), "utf8"));
      const copied = projected.plugins.load.paths[0] as string;
      expect(copied).not.toBe(plugin);
      expect(readFileSync(join(copied, "index.js"), "utf8")).toBe(
        "export default { register() {} };\n",
      );
      expect(statSync(copied).uid).toBe(process.getuid!());
      expect(projected.plugins.load.paths[1]).toBe(external);
      expect(readFileSync(configPath, "utf8")).toBe(config);
    },
  );

  it("admits only one source-generation directory beneath the writable config root", () => {
    const launcher = sutScript("LAUNCHER");
    const admission = launcher.match(/case "\$OPENCLAW_CONFIG_PATH" in\n[\s\S]*?\n\s*esac/u)?.[0];
    expect(admission).toBeTruthy();
    const stateRoot = "/isolated-telegram/state";
    const generation = "a".repeat(64);
    const paths = [
      [`${stateRoot}/qa-runtime-config/${generation}/openclaw.json`, true],
      [`${stateRoot}/qa-runtime-config/openclaw.json`, false],
      [`${stateRoot}/qa-runtime-config/not-a-generation/openclaw.json`, false],
      [`${stateRoot}/qa-runtime-config/nested/${generation}/openclaw.json`, false],
      [`${stateRoot}/qa-runtime-config/${generation.slice(1)}/openclaw.json`, false],
      [`${stateRoot}/qa-runtime-config/${generation.toUpperCase()}/openclaw.json`, false],
      [`${stateRoot}/other/${generation}/openclaw.json`, false],
    ] as const;
    for (const [configPath, allowed] of paths) {
      const result = spawnSync("bash", ["-ceu", admission!], {
        encoding: "utf8",
        env: {
          ...process.env,
          OPENCLAW_STATE_DIR: stateRoot,
          OPENCLAW_CONFIG_PATH: configPath,
        },
      });
      expect(result.status === 0, configPath).toBe(allowed);
    }
  });

  it("keeps launcher identity private while forwarding the Gateway stdin lifeline", () => {
    const launcher = sutScript("LAUNCHER");
    const declarations = launcher.slice(
      launcher.indexOf("transport_keys=("),
      launcher.indexOf("\nload_process_identity()"),
    );
    const filter = launcher.slice(
      launcher.indexOf("declare -A keep_env=()"),
      launcher.indexOf("\ntemp_root="),
    );
    const handoff = launcher.slice(
      launcher.indexOf("export SUT_UID "),
      launcher.indexOf("\nlauncher_stage=enter-mount-namespace"),
    );
    const cleanup = launcher.match(
      /\n(\s+unset \\\n[\s\S]*?)\n\s*\n\s*if \[\[ "\$runtime_boundary_mode"/u,
    )?.[1];
    expect(cleanup).toBeDefined();
    const result = spawnSync(
      "bash",
      [
        "--noprofile",
        "--norc",
        "-ceu",
        `${declarations}\n${filter}\nconfig_path=/synthetic/openclaw.json\n${handoff}
printf '%s\\n' "$BASHPID" "\${launcher_pid-}"
${cleanup}
printf '%s\\n' "\${OPENCLAW_GATEWAY_HOST_LIFELINE-}" "\${launcher_pid-unset}" "\${OPENCLAW_QA_PARENT_PID-unset}" "\${PRIVATE_RUNNER_VALUE-unset}"`,
      ],
      {
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          OPENCLAW_GATEWAY_HOST_LIFELINE: "stdin",
          OPENCLAW_QA_PARENT_PID: "999999",
          PRIVATE_RUNNER_VALUE: "runner-only",
        },
      },
    );
    expect(result.status, result.stderr).toBe(0);
    const [shellPid, launcherPid, ...runtimeValues] = result.stdout.trim().split("\n");
    expect(runtimeValues).toEqual(["stdin", "unset", "unset", "unset"]);
    expect(shellPid).toMatch(/^[1-9][0-9]*$/u);
    expect(launcherPid).toBe(shellPid);
  });

  it("does not read shell startup files from socket-backed QA stdin", () => {
    const launcher = sutScript("LAUNCHER");
    const shellCommands = [...launcher.matchAll(/\/bin\/bash ([^\n]*-ceu) '/gu)];
    expect(shellCommands.length).toBeGreaterThan(0);
    const workdir = tempDirs.make("openclaw-telegram-shell-startup-");
    writeFileSync(join(workdir, ".bashrc"), 'printf "UNEXPECTED_STARTUP\\n" >&2\n');
    for (const [, shellArgs] of shellCommands) {
      if (!shellArgs) {
        throw new Error("Expected generated Bash arguments");
      }
      const result = spawnSync(
        process.platform === "win32" ? "bash" : "/bin/bash",
        [...shellArgs.split(" "), 'read -r value; printf "%s\\n" "$value"'],
        {
          encoding: "utf8",
          env: { HOME: workdir, PATH: process.env.PATH },
          input: "synthetic-stdin\n",
        },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe("synthetic-stdin\n");
      expect(result.stderr).toBe("");
    }

    expect(launcher).not.toContain("export PS1=");
    expect(launcher).not.toContain("export -n BASHOPTS SHELLOPTS");
    expect(launcher).not.toContain("unset BASH_ENV ENV");
  });

  it("mounts an isolated SUT-owned tmp without exposing the host tmp tree", () => {
    const launcher = sutScript("LAUNCHER");
    containsAll(launcher, [
      'for masked_path in "$RUNNER_HOME" /var/tmp /dev/shm; do',
      "set_launcher_stage mount-private-tmp",
      '-o "mode=0700,uid=${SUT_UID},gid=${SUT_GID},nosuid,nodev,noexec"',
      "openclaw-telegram-sut-tmp",
      '"$(stat -c \'%F:%a:%u:%g\' /tmp)" == "directory:700:${SUT_UID}:${SUT_GID}"',
    ]);
    expect(launcher).not.toContain('for masked_path in "$RUNNER_HOME" /tmp');
  });
});
