import { buildFullReleaseCandidateRequest } from "../../scripts/full-release-candidate-contract.mjs";
import {
  buildReleaseExecutionPlan,
  buildReleaseExecutionPlanArtifact,
  releaseChildSpec,
  releaseExecutionPlanSha256,
} from "../../scripts/full-release-validation-policy.mjs";

export const SHA = "a".repeat(40);
export const TARGET_SHA = "b".repeat(40);
export const SOURCE_REF = `release-ci/${SHA.slice(0, 12)}-77`;
export const REPOSITORY = "openclaw/openclaw";

export function job(name: string, conclusion = "success") {
  return {
    completed_at: "2026-08-22T00:01:00Z",
    conclusion,
    html_url: `https://example.invalid/jobs/${name}`,
    name,
    started_at: "2026-08-22T00:00:00Z",
    status: "completed",
  };
}

export function child(key: string, runId: string) {
  const spec = releaseChildSpec(key);
  return {
    displayTitle: `${spec.displayName} full-release-validation-77-1${spec.suffix}`,
    key,
    required: true,
    runAttempt: 1,
    runId,
    selected: true,
    sourceParentAttempt: 1,
    url: `https://github.com/${REPOSITORY}/actions/runs/${runId}`,
    workflow: spec.workflow,
    workflowRef: SOURCE_REF,
    workflowSha: SHA,
  };
}

export function withoutChildRunIdentity(entry: ReturnType<typeof child>) {
  const missing = structuredClone(entry);
  Reflect.set(missing, "runAttempt", null);
  Reflect.set(missing, "runId", "");
  Reflect.set(missing, "url", "");
  return missing;
}

export function requiredChildren() {
  return [
    child("normalCi", "101"),
    child("pluginPrerelease", "202"),
    child("releaseChecks", "303"),
    child("productPerformance", "404"),
  ];
}

export function plan(children = requiredChildren()) {
  return {
    attemptEvidenceVersion: 2,
    children,
    parentRunAttempt: 1,
    parentRunId: "77",
    releaseProfile: "beta",
    rerunGroup: "all",
    targetSha: TARGET_SHA,
    trustedWorkflow: { fullRef: "refs/heads/main", ref: "main", sha: SHA },
    workflowRef: SOURCE_REF,
    workflowSha: SHA,
  };
}

export function executionPlanArtifact({
  children = requiredChildren(),
  evidenceReuse = { requested: false },
}: {
  children?: ReturnType<typeof requiredChildren>;
  evidenceReuse?: Record<string, unknown>;
} = {}) {
  const built = buildReleaseExecutionPlan({
    children: Object.fromEntries(
      children.map((entry) => [
        entry.key,
        {
          result: "success",
          runAttempt: entry.runAttempt,
          runId: entry.runId,
          url: entry.url,
        },
      ]),
    ),
    dockerPreflightResult: "success",
    evidenceReuse: evidenceReuse.requested === true,
    parentRunAttempt: 1,
    parentRunId: "77",
    candidateBindingResult: "success",
    rerunGroup: "all",
    resolveTargetResult: "success",
    workflowRef: SOURCE_REF,
    workflowSha: SHA,
  });
  const candidateRequest = buildFullReleaseCandidateRequest({
    repository: REPOSITORY,
    targetSha: TARGET_SHA,
    toolingSha: SHA,
    releaseProfile: "beta",
    releaseSoak: false,
    upgradeSurvivorBaseline: "openclaw@latest",
    upgradeSurvivorBaselines: "",
    upgradeSurvivorScenarios: "",
    allowFrozenTargetScenarioOmissions: false,
    allowUnreleasedChangelog: false,
    packagePublished: false,
    sharedImagePolicy: "no-push-artifact",
  });
  const selectedKeys = new Set(children.map((entry) => entry.key));
  return buildReleaseExecutionPlanArtifact({
    attemptEvidenceVersion: 2,
    candidate: null,
    children: built.children.map((entry) =>
      selectedKeys.has(entry.key)
        ? entry
        : {
            ...entry,
            required: false,
            result: "skipped",
            runAttempt: null,
            runId: "",
            selected: false,
            url: "",
          },
    ),
    evidenceReuse,
    expected: {
      candidateRequest,
      parentRunAttempt: 1,
      parentRunId: "77",
      repository: REPOSITORY,
      targetSha: TARGET_SHA,
      workflowRef: SOURCE_REF,
      workflowSha: SHA,
    },
    gates: built.gates,
    releaseProfile: "beta",
    rerunGroup: "all",
    trustedWorkflow: { fullRef: "refs/heads/main", ref: "main", sha: SHA },
  });
}

export function historicalExecutionPlanArtifact() {
  const artifact = structuredClone(executionPlanArtifact());
  delete artifact.attemptEvidenceVersion;
  delete artifact.candidate;
  delete artifact.candidateRequest;
  delete artifact.repository;
  for (const entry of artifact.children) {
    delete entry.sourceParentAttempt;
  }
  artifact.sha256 = releaseExecutionPlanSha256(artifact);
  return artifact;
}

export function runFor(
  entry: ReturnType<typeof child>,
  attempt: number,
  conclusion: string | null,
  status = conclusion === null ? "in_progress" : "completed",
) {
  return {
    actor: { login: "github-actions[bot]" },
    conclusion,
    display_title: entry.displayTitle,
    event: "workflow_dispatch",
    head_branch: entry.workflowRef,
    head_sha: entry.workflowSha,
    html_url: entry.url,
    id: Number(entry.runId),
    path: `.github/workflows/${entry.workflow}`,
    repository: { full_name: REPOSITORY },
    run_attempt: attempt,
    status,
    triggering_actor: {
      login: attempt === entry.runAttempt ? "github-actions[bot]" : "release-operator",
    },
  };
}

export function rootRun(
  attempt = 1,
  conclusion: string | null = "failure",
  status = conclusion === null ? "in_progress" : "completed",
) {
  return {
    actor: { login: "github-actions[bot]" },
    conclusion,
    display_title: "Full Release Validation",
    event: "workflow_dispatch",
    head_branch: SOURCE_REF,
    head_sha: SHA,
    id: 77,
    path: ".github/workflows/full-release-validation.yml",
    repository: { full_name: REPOSITORY },
    run_attempt: attempt,
    status,
    triggering_actor: { login: attempt === 1 ? "github-actions[bot]" : "release-operator" },
  };
}
