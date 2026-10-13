import { expectDefined } from "@openclaw/normalization-core";
import { expect, vi } from "vitest";
import { buildFullReleaseCandidateRequest } from "../../scripts/full-release-candidate-contract.mjs";
import {
  buildReleaseExecutionPlanArtifact,
  composeReleaseAttemptJobs,
  type ReleaseExecutionPlan,
} from "../../scripts/full-release-validation-policy.mjs";
import { expectedChildDispatches } from "../../scripts/release-ci-summary.mjs";

export function rawManifest({
  candidateBinding,
  evidenceReuse,
  rerunGroup = "all",
  runId = "29090000000",
  targetSha = "a".repeat(40),
  version = 2,
  workflowFullRef,
  workflowRefType,
  workflowSha,
}: {
  candidateBinding?: unknown;
  evidenceReuse?: unknown;
  rerunGroup?: string;
  runId?: string;
  targetSha?: string;
  version?: 2 | 3;
  workflowFullRef?: string;
  workflowRefType?: "branch" | "tag";
  workflowSha?: string;
}): {
  candidateBinding?: unknown;
  childRuns: Record<string, string | { blocking: boolean; conclusion: string; runId: string }>;
  controls: Record<string, unknown>;
  evidenceReuse?: unknown;
  releaseProfile: string;
  rerunGroup: string;
  runAttempt: string;
  runId: string;
  runReleaseSoak: string;
  targetRef?: string;
  targetSha: string;
  validationInputs: Record<string, string>;
  version: 2 | 3;
  workflowFullRef?: string;
  workflowName: string;
  workflowRef: string;
  workflowRefType?: "branch" | "tag";
  workflowSha?: string;
} {
  return {
    ...(candidateBinding === undefined ? {} : { candidateBinding }),
    childRuns: {
      normalCi: "101",
      npmTelegram: "",
      pluginPrerelease: "202",
      productPerformance: { blocking: true, conclusion: "success", runId: "303" },
      releaseChecks: "404",
    },
    controls: {
      performanceBlocking: true,
      performanceReportPublication: "artifact-only",
      stableSoakRequired: false,
    },
    evidenceReuse,
    releaseProfile: "beta",
    rerunGroup,
    runAttempt: "2",
    runId,
    runReleaseSoak: "false",
    targetSha,
    validationInputs: {
      allowUnreleasedChangelog: "false",
      codexPluginSpec: "",
      crossOsSuiteFilter: "",
      liveSuiteFilter: "",
      mode: "direct",
      npmTelegramPackageSpec: "",
      npmTelegramProviderMode: "mock-openai",
      npmTelegramScenario: "",
      packageAcceptancePackageSpec: "",
      provider: "openai",
      releasePackageSpec: "",
      skipPackageTelegramE2e: "false",
      targetContextRef: "",
    },
    version,
    workflowName: "Full Release Validation",
    workflowRef: "main",
    ...(workflowSha ? { workflowSha } : {}),
    ...(version === 3
      ? {
          workflowFullRef: workflowFullRef ?? "refs/heads/main",
          workflowRefType: workflowRefType ?? "branch",
        }
      : {}),
  };
}

export function trustedMainPackageFixture({
  manifestVersion = 2,
  parentPath = ".github/workflows/full-release-validation.yml",
  targetSha = "8".repeat(40),
  workflowFullRef,
  workflowRef = "main",
  workflowRefType,
  workflowSha = "0".repeat(40),
}: {
  manifestVersion?: 2 | 3;
  parentPath?: string;
  targetSha?: string;
  workflowFullRef?: string;
  workflowRef?: string;
  workflowRefType?: "branch" | "tag";
  workflowSha?: string;
} = {}) {
  const runId = "29071366025";
  const childRunId = "29071382629";
  const manifest = rawManifest({
    rerunGroup: "package",
    runId,
    targetSha,
    version: manifestVersion,
    workflowFullRef,
    workflowRefType,
    workflowSha,
  });
  manifest.childRuns = {
    normalCi: "",
    npmTelegram: "",
    pluginPrerelease: "",
    productPerformance: { blocking: true, conclusion: "", runId: "" },
    releaseChecks: childRunId,
  };
  manifest.releaseProfile = "full";
  manifest.runAttempt = "1";
  manifest.runReleaseSoak = "true";
  manifest.workflowRef = workflowRef;

  const parentRun = {
    conclusion: "success",
    event: "workflow_dispatch",
    head_branch: workflowRef,
    head_sha: workflowSha,
    html_url: `https://github.com/openclaw/openclaw/actions/runs/${runId}`,
    id: Number(runId),
    path: parentPath,
    repository: { full_name: "openclaw/openclaw" },
    run_attempt: 1,
    status: "completed",
  };
  const parentView = {
    attempt: 1,
    conclusion: "success",
    headBranch: workflowRef,
    headSha: workflowSha,
    jobs: [],
    status: "completed",
    url: parentRun.html_url,
  };
  const child = expectedChildDispatches(runId, 1, workflowRef).find(
    (entry) => entry.manifestKey === "releaseChecks",
  );
  if (!child) {
    throw new Error("missing release checks child fixture");
  }
  const parentJob = {
    completed_at: "2026-07-10T01:10:00Z",
    conclusion: "success",
    id: 86293408710,
    name: child.parentJobName,
    run_attempt: 1,
    started_at: "2026-07-10T01:00:00Z",
    status: "completed",
    steps: [],
  };
  const childRun = {
    actor: { login: "github-actions[bot]" },
    conclusion: "success",
    display_title: child.displayTitle,
    event: "workflow_dispatch",
    head_branch: workflowRef,
    head_sha: workflowSha,
    html_url: `https://github.com/openclaw/openclaw/actions/runs/${childRunId}`,
    id: Number(childRunId),
    path: ".github/workflows/openclaw-release-checks.yml",
    repository: { full_name: "openclaw/openclaw" },
    run_attempt: 1,
    status: "completed",
    triggering_actor: { login: "github-actions[bot]" },
  };
  const artifact = {
    digest: `sha256:${"9".repeat(64)}`,
    expired: false,
    id: 8220114429,
    name: `full-release-validation-${runId}-1`,
    size_in_bytes: 507,
    workflow_run: {
      head_branch: workflowRef,
      head_sha: workflowSha,
      id: Number(runId),
    },
  };
  const compareCommits = (base: string, head: string) => {
    expect(base).toBe(workflowSha);
    return {
      merge_base_commit: { sha: workflowSha },
      status: base === head ? "identical" : "ahead",
    };
  };
  const client = {
    verifyQualificationAdmission: () => {
      throw new Error("historical fixture must not request candidate qualification admission");
    },
    revalidateQualificationAdmissionAuthority: () => {
      throw new Error("historical fixture must not request candidate admission authority");
    },
    getWorkflowSource: (_sha: string) => "name: Full Release Validation\n",
    compareCommitLineage: compareCommits,
    compareCommits,
    getJobLog(jobId: number) {
      expect(jobId).toBe(parentJob.id);
      return [
        `TARGET_SHA: ${targetSha}`,
        `Dispatched openclaw-release-checks.yml: ${childRun.html_url} (attempt ${childRun.run_attempt})`,
      ].join("\n");
    },
    getParentJobs(requestedRunId: string) {
      expect(requestedRunId).toBe(runId);
      return [parentJob];
    },
    getRef(fullRef: string) {
      return { object: { sha: workflowSha }, ref: fullRef };
    },
    getRun(requestedRunId: string) {
      if (requestedRunId === runId) {
        return parentRun;
      }
      if (requestedRunId === childRunId) {
        return childRun;
      }
      throw new Error(`unexpected run: ${requestedRunId}`);
    },
    getRunView(requestedRunId: string) {
      expect(requestedRunId).toBe(runId);
      return parentView;
    },
    loadManifest(requestedRunId: string, requestedRunAttempt: number) {
      expect(requestedRunId).toBe(runId);
      expect(requestedRunAttempt).toBe(1);
      return { artifact, manifest };
    },
  };

  return {
    artifact,
    childRun,
    client,
    manifest,
    parentJob,
    parentRun,
    parentView,
    runId,
    targetSha,
    workflowSha,
  };
}

export function trustedMainFullFixture() {
  const fixture = trustedMainPackageFixture({ manifestVersion: 3 });
  const children = expectedChildDispatches(fixture.runId, 1, "main", 3).filter(
    (child) => child.manifestKey !== "npmTelegram",
  );
  const runs = children.map((child, index) => ({
    ...fixture.childRun,
    display_title: child.displayTitle,
    id: 101 + index,
    path: `.github/workflows/${child.workflow}`,
  }));
  const jobs = children.map((child, index) => ({
    ...fixture.parentJob,
    id: 201 + index,
    name: child.parentJobName,
  }));
  const manifest = {
    ...fixture.manifest,
    childRuns: {
      ...fixture.manifest.childRuns,
      ...Object.fromEntries(
        children.map((child, index) => {
          const runId = String(expectDefined(runs[index], "child run").id);
          return [
            child.manifestKey,
            child.manifestKey === "productPerformance"
              ? { blocking: true, conclusion: "success", runId }
              : runId,
          ];
        }),
      ),
    },
    rerunGroup: "all",
    version: 4,
  };
  const client = {
    ...fixture.client,
    getJobLog: vi.fn((jobId: number) => {
      const index = jobs.findIndex((job) => job.id === jobId);
      const child = expectDefined(children[index], "dispatch child");
      const run = expectDefined(runs[index], "child run");
      return `TARGET_SHA: ${fixture.targetSha}\n-f publish_reports=false\nDispatched ${child.workflow}: https://github.com/openclaw/openclaw/actions/runs/${run.id} (attempt 1)`;
    }),
    getParentJobs: vi.fn((runId: string) =>
      runId === fixture.runId
        ? jobs
        : [{ ...fixture.parentJob, name: "Verify artifact-only report mode" }],
    ),
    getRun: vi.fn((runId: string) =>
      runId === fixture.runId
        ? fixture.parentRun
        : expectDefined(
            runs.find((run) => String(run.id) === runId),
            "child run",
          ),
    ),
    loadExecutionPlan: vi.fn(() => undefined),
    loadManifest: () => ({ artifact: fixture.artifact, manifest }),
  };
  return { ...fixture, client, manifest, runs };
}

export function trustedMainNpmFixture(releaseProfile: "beta" | "stable" = "beta") {
  const fixture = trustedMainFullFixture();
  const beta = releaseProfile === "beta";
  const coveragePolicy = beta ? "npm-beta-v1" : "npm-stable-v1";
  const targetVersion = beta ? "2026.8.28-beta.1" : "2026.8.28";
  Object.assign(fixture.manifest, { releaseProfile, runReleaseSoak: String(!beta) });
  Object.assign(fixture.manifest.validationInputs, {
    coveragePolicy,
    skipPackageTelegramE2e: String(beta),
    targetContextRef: "release/2026.8.28",
    targetVersion,
  });
  fixture.manifest.controls.performanceBlocking = !beta;
  fixture.manifest.controls.stableSoakRequired = !beta;
  if (beta) {
    fixture.manifest.childRuns.productPerformance = { blocking: false, conclusion: "", runId: "" };
  }
  const plannedChildren = expectedChildDispatches(fixture.runId, 1, "main", 3).map((child) => {
    const run = fixture.runs.find((entry) => entry.display_title === child.displayTitle);
    const selected =
      child.manifestKey !== "npmTelegram" && !(beta && child.manifestKey === "productPerformance");
    return {
      displayTitle: child.displayTitle,
      key: child.manifestKey,
      required: selected,
      result: selected ? "success" : "skipped",
      runAttempt: selected ? 1 : null,
      runId: selected ? String(expectDefined(run, "selected child run").id) : "",
      selected,
      source: "fresh",
      url: selected ? expectDefined(run, "selected child run").html_url : "",
      workflow: child.workflow,
      workflowRef: "main",
      workflowSha: fixture.workflowSha,
    };
  });
  const executionPlan = buildReleaseExecutionPlanArtifact({
    attemptEvidenceVersion: 3,
    candidate: null,
    children: plannedChildren,
    coveragePolicy,
    evidenceReuse: { requested: false },
    expected: {
      candidateRequest: buildFullReleaseCandidateRequest({
        repository: "openclaw/openclaw",
        targetSha: fixture.targetSha,
        toolingSha: fixture.workflowSha,
        releaseProfile,
        releaseSoak: !beta,
        upgradeSurvivorBaseline: "openclaw@latest",
        upgradeSurvivorBaselines: "",
        upgradeSurvivorScenarios: "",
        allowFrozenTargetScenarioOmissions: false,
        allowUnreleasedChangelog: false,
        packagePublished: false,
        sharedImagePolicy: "no-push-artifact",
      }),
      parentRunAttempt: 1,
      parentRunId: fixture.runId,
      repository: "openclaw/openclaw",
      targetSha: fixture.targetSha,
      workflowRef: "main",
      workflowSha: fixture.workflowSha,
    },
    gates: [{ name: "Resolve target ref", required: true, result: "success" }],
    releaseProfile,
    rerunGroup: "all",
    targetVersion,
    trustedWorkflow: { fullRef: "refs/heads/main", ref: "main", sha: fixture.workflowSha },
  });
  const jobs = [{ ...fixture.parentJob, name: "test" }];
  const performanceJobs = [{ ...fixture.parentJob, name: "Verify artifact-only report mode" }];
  const jobsForChild = (key: string) => (key === "productPerformance" ? performanceJobs : jobs);
  const manifest = Object.assign(fixture.manifest, {
    childEvidence: Object.fromEntries(
      plannedChildren
        .filter((child) => child.selected)
        .map((child) => {
          const composite = composeReleaseAttemptJobs(
            [{ jobs: jobsForChild(child.key), runAttempt: 1 }],
            { effectiveRunAttempt: 1, plannedRunAttempt: 1 },
          );
          return [
            child.key,
            {
              compositeJobsSha256: composite.sha256,
              dispatchActor: "github-actions[bot]",
              effectiveRunAttempt: 1,
              jobs: composite.jobs,
              observedRunAttempts: [1],
              plannedRunAttempt: 1,
              repository: "openclaw/openclaw",
              runId: child.runId,
              triggeringActor: "github-actions[bot]",
            },
          ];
        }),
    ),
    executionPlanSha256: executionPlan.sha256,
    sourceParentRunAttempt: 1,
  });
  const originalLog = fixture.client.getJobLog;
  const client = {
    ...fixture.client,
    getJobLog: vi.fn(
      (jobId: number) => `${originalLog(jobId)}\nCI_RELEASE_SCOPE: npm-${releaseProfile}`,
    ),
    getRunAttemptJobs: vi.fn((runId: string) =>
      jobsForChild(
        expectDefined(
          plannedChildren.find((child) => child.runId === runId),
          "child",
        ).key,
      ),
    ),
    loadExecutionPlan: vi.fn<() => ReleaseExecutionPlan | undefined>(() => executionPlan),
  };
  return { ...fixture, client, executionPlan, manifest };
}
