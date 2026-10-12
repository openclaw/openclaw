import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { buildFullReleaseCandidateRequest } from "../../scripts/full-release-candidate-contract.mjs";
import {
  createPublicationAdmission,
  createPublicationObservations,
  createPublicationSourceFact,
  publicationDispatchEnvelope,
  publicationSourceRequest,
  type PublicationSourceRequest,
} from "../../scripts/full-release-publication-contract.mjs";
import {
  buildReleaseExecutionPlan,
  buildReleaseExecutionPlanArtifact,
} from "../../scripts/full-release-validation-policy.mjs";
import { fullReleaseCandidateBindingFixture } from "../helpers/full-release-candidate.js";

export const SCRIPT = resolve("scripts/full-release-validation-state.mjs");
export const SHA = "a".repeat(40);
export const TARGET_SHA = "b".repeat(40);
export const TRUSTED_MAIN = { fullRef: "refs/heads/main", ref: "main", sha: SHA };

export function collectorEnv(overrides: NodeJS.ProcessEnv) {
  return {
    ...process.env,
    GITHUB_REF_NAME: "release-ci/tooling",
    GITHUB_REPOSITORY: "openclaw/openclaw",
    GITHUB_RUN_ATTEMPT: "2",
    GITHUB_RUN_ID: "77",
    GITHUB_SHA: SHA,
    RELEASE_PROFILE: "stable",
    RERUN_GROUP: "ci",
    TARGET_SHA,
    ...overrides,
  };
}

export function runCollector(mode: string, overrides: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [SCRIPT, mode], {
    encoding: "utf8",
    env: collectorEnv(overrides),
    timeout: 10_000,
  });
}

export function candidateRequestInput(overrides: Record<string, unknown> = {}) {
  return {
    repository: "openclaw/openclaw",
    targetSha: TARGET_SHA,
    toolingSha: SHA,
    releaseProfile: "stable",
    releaseSoak: true,
    upgradeSurvivorBaseline: "openclaw@latest",
    upgradeSurvivorBaselines: "",
    upgradeSurvivorScenarios: "reported-issues",
    allowFrozenTargetScenarioOmissions: false,
    allowUnreleasedChangelog: false,
    packagePublished: false,
    sharedImagePolicy: "no-push-artifact",
    ...overrides,
  };
}

export function canonicalCandidateRequest(overrides: Record<string, unknown> = {}) {
  return buildFullReleaseCandidateRequest(candidateRequestInput(overrides));
}

export function candidateBinding(requestOverrides: Record<string, unknown> = {}) {
  return fullReleaseCandidateBindingFixture({
    ...candidateRequestInput(requestOverrides),
    ...requestOverrides,
  });
}

export function evidenceManifest() {
  return { runAttempt: 1, runId: "99", targetSha: TARGET_SHA };
}

export function generatedManifest(planArtifact: Record<string, any>): Record<string, any> {
  return {
    candidateBinding: planArtifact.candidate ?? null,
    childRuns: {
      normalCi: "101",
      npmTelegram: "",
      pluginPrerelease: "",
      productPerformance: { blocking: true, conclusion: "", runId: "" },
      releaseChecks: "",
    },
    controls: {
      performanceBlocking: true,
      performanceReportPublication: "artifact-only",
      stableSoakRequired: false,
    },
    executionPlanSha256: planArtifact.sha256,
    releaseProfile: "stable",
    rerunGroup: "ci",
    runAttempt: 2,
    runId: "77",
    runReleaseSoak: "false",
    sourceParentRunAttempt: 1,
    targetRef: "main",
    targetSha: TARGET_SHA,
    version: 3,
    workflowFullRef: "refs/heads/release-ci/tooling",
    workflowName: "Full Release Validation",
    workflowRef: "release-ci/tooling",
    workflowRefType: "branch",
    workflowSha: SHA,
  };
}

export function child(key: string, overrides: Record<string, unknown> = {}) {
  return {
    conclusion: "",
    dispatchName: `Dispatch ${key}`,
    displayTitle: key,
    errors: [],
    jobs: [],
    key,
    required: true,
    result: "success",
    runAttempt: 1,
    runId: "101",
    selected: true,
    source: "fresh",
    status: "in_progress",
    url: "https://example.invalid/runs/101",
    workflow: "ci.yml",
    workflowRef: "release-ci/tooling",
    workflowSha: SHA,
    ...overrides,
  };
}

export function githubRun(
  planned: ReturnType<typeof child>,
  overrides: Record<string, unknown> = {},
) {
  return {
    actor: { login: "github-actions[bot]" },
    display_title: planned.displayTitle,
    event: "workflow_dispatch",
    head_branch: planned.workflowRef,
    head_sha: planned.workflowSha,
    id: 101,
    path: ".github/workflows/ci.yml",
    repository: { full_name: "openclaw/openclaw" },
    run_attempt: 1,
    status: "completed",
    triggering_actor: { login: "github-actions[bot]" },
    ...overrides,
  };
}

export function plan(overrides: Record<string, unknown> = {}) {
  return buildReleaseExecutionPlan({
    children: {
      normalCi: { result: "success", runAttempt: 1, runId: "101" },
      npmTelegram: { result: "success", runAttempt: 1, runId: "404" },
      pluginPrerelease: { result: "success", runAttempt: 1, runId: "202" },
      productPerformance: { result: "success", runAttempt: 1, runId: "505" },
      releaseChecks: { result: "success", runAttempt: 1, runId: "303" },
    },
    dockerPreflightResult: "success",
    evidenceReuse: false,
    parentRunAttempt: 2,
    parentRunId: "77",
    candidateBindingResult: "success",
    rerunGroup: "all",
    resolveTargetResult: "success",
    workflowRef: "release-ci/tooling",
    workflowSha: SHA,
    ...overrides,
  });
}

export function executionPlan(
  overrides: Record<string, unknown> = {},
  artifactOverrides: Record<string, unknown> = {},
) {
  const {
    candidateRequest,
    expected: expectedOverrides,
    ...remainingArtifactOverrides
  } = artifactOverrides;
  const expected = {
    parentRunAttempt: 1,
    parentRunId: "77",
    repository: "openclaw/openclaw",
    targetSha: TARGET_SHA,
    workflowRef: "release-ci/tooling",
    workflowSha: SHA,
    ...(candidateRequest === undefined ? {} : { candidateRequest }),
    ...(expectedOverrides as Record<string, unknown> | undefined),
  };
  const built = plan({ ...overrides, parentRunAttempt: expected.parentRunAttempt });
  return buildReleaseExecutionPlanArtifact({
    children: built.children,
    expected,
    gates: built.gates,
    releaseProfile: "stable",
    rerunGroup: typeof overrides.rerunGroup === "string" ? overrides.rerunGroup : "all",
    trustedWorkflow: TRUSTED_MAIN,
    ...remainingArtifactOverrides,
  });
}

export function reusedEvidenceChildren() {
  return [
    ["normalCi", "101", "CI"],
    ["pluginPrerelease", "202", "Plugin Prerelease"],
    ["releaseChecks", "303", "OpenClaw Release Checks"],
    ["productPerformance", "505", "OpenClaw Performance"],
  ].map(([role, runId, name]) => ({
    displayTitle: `${name} full-release-validation-99-1`,
    headBranch: "release-ci/tooling",
    role,
    runAttempt: 1,
    runId,
    url: `https://example.invalid/runs/${runId}`,
    workflowSha: SHA,
  }));
}

export function sourceFact(overrides: Partial<PublicationSourceRequest> = {}) {
  const request = {
    ...publicationSourceRequest({
      PUBLICATION_INPUTS_JSON: JSON.stringify({
        ref: TARGET_SHA,
        release_profile: "stable",
        rerun_group: "all",
        trusted_workflow_json: publicationDispatchEnvelope(null, {
          validationPurpose: "publish",
          publicationSelection: {
            route: "normal",
            npmDistTag: "latest",
            publishOpenclawNpm: true,
            pluginPublishScope: "all-publishable",
            plugins: [],
          },
        }),
      }),
      PUBLICATION_TARGET_CONTEXT: "release/2026.9.9",
      PUBLICATION_TOOLING_JSON: JSON.stringify(TRUSTED_MAIN),
      PUBLICATION_TARGET_SHA: TARGET_SHA,
      GITHUB_REPOSITORY: "openclaw/openclaw",
      GITHUB_REF: "refs/heads/release-ci/tooling",
      GITHUB_SHA: SHA,
      GITHUB_RUN_ID: "77",
      GITHUB_RUN_ATTEMPT: "1",
    }),
    ...overrides,
  };
  return createPublicationSourceFact(
    request,
    request.validationPurpose === "publish" ? { packages: [], platforms: [] } : null,
    request.validationPurpose === "publish"
      ? {
          version: "2026.9.9",
          packages: [{ name: "openclaw", version: "2026.9.9", targets: ["npm"] }],
          platforms: [],
        }
      : null,
  );
}

export function registryRecord(source = sourceFact()) {
  const time = "2026-09-13T14:00:00.000Z";
  const observations = createPublicationObservations(source, {
    sourceDigest: source.digest,
    prerequisitesCompletedAt: time,
    collectionStartedAt: time,
    collectionCompletedAt: time,
    npm: [
      {
        name: "openclaw",
        version: "2026.9.9",
        required: true,
        observedAt: time,
        outcome: "observed",
        state: {
          packageExists: true,
          hasVersionHistory: true,
          selectedVersionExists: false,
          latestVersion: null,
        },
      },
    ],
    clawhub: [],
    pendingAuthority: [],
    plans: {
      npm: { all: [], candidates: [], skippedPublished: [], warnings: [] },
      clawhub: {
        all: [],
        candidates: [],
        skippedPublished: [],
        warnings: [],
        bootstrapCandidates: [],
        missingTrustedPublisher: [],
      },
    },
  });
  return {
    sourceAdmissionContract: "1",
    sourceAdmission: source,
    publicationAdmissionContract: "1",
    publicationAdmission: createPublicationAdmission(
      source,
      observations,
      {
        id: "456",
        name: `full-release-publication-observations-${source.runId}-1`,
        digest: `sha256:${"d".repeat(64)}`,
        sizeInBytes: 4096,
      },
      time,
    ),
  };
}
