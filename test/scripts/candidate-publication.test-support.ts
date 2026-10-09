import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expectDefined } from "@openclaw/normalization-core";
import { parse } from "yaml";
import { dockerReleaseArtifactName } from "../../scripts/docker-release-artifacts.mjs";
import {
  createPublicationAdmission,
  createPublicationObservations,
  createPublicationSourceFact,
  publicationDispatchEnvelope,
  publicationIntentInputs,
  publicationSourceRequest,
  type PublicationSelection,
} from "../../scripts/full-release-publication-contract.mjs";
import {
  composeReleaseAttemptJobs,
  releaseExecutionPlanSha256,
} from "../../scripts/full-release-validation-policy.mjs";
import {
  revalidateQualificationAdmissionAuthority,
  verifyQualificationAdmission,
} from "../../scripts/release-qualification-admission.mjs";
import { makeStoredZip } from "./actions-artifact-zip.test-support.js";
import { trustedMainNpmFixture } from "./release-ci-summary.test-support.js";
import {
  fixture as admissionFixture,
  qualificationBaselinesJson,
  repository,
  candidateSha as defaultQ,
  publisherSha as p,
  transportRef as defaultBranch,
} from "./release-qualification-admission.test-support.js";

const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const time = "2026-08-28T12:00:00.000Z";

export function candidatePublicationFixture(
  options: {
    candidateSha?: string;
    runId?: string;
    purpose?: "publish" | "main-qualification" | "diagnostic";
  } = {},
) {
  const fixture = trustedMainNpmFixture();
  const q = options.candidateSha ?? defaultQ;
  const branch = options.candidateSha ? "release-ci/" + q.slice(0, 12) + "-123" : defaultBranch;
  const legacyRunId = fixture.runId;
  const runId = options.runId ?? legacyRunId;
  const workflowSource = readFileSync(".github/workflows/full-release-validation.yml", "utf8");
  const definitions = parse(workflowSource).on.workflow_dispatch.inputs;
  const inputs: Record<string, string> = Object.fromEntries(
    Object.entries<{ default?: string | boolean | number }>(definitions).map(
      ([key, definition]) => [key, String(definition.default ?? "")],
    ),
  );
  const purpose = options.purpose ?? "publish";
  const publishing = purpose === "publish";
  const tooling = { fullRef: "refs/heads/" + branch, ref: branch, sha: q };
  const laneInputs = { qualification_baselines_json: qualificationBaselinesJson };
  const selection: PublicationSelection = {
    route: "normal",
    npmDistTag: "beta",
    publishOpenclawNpm: true,
    pluginPublishScope: "all-publishable",
    plugins: [],
  };
  Object.assign(inputs, {
    ref: q,
    expected_sha: q,
    target_context_ref: "release/2026.8.28",
    release_profile: "beta",
    rerun_group: "all",
    mode: "both",
    run_release_soak: "false",
    trusted_workflow_json: publicationDispatchEnvelope(
      tooling,
      { validationPurpose: purpose, publicationSelection: publishing ? selection : null },
      laneInputs,
    ),
  });
  const admission = admissionFixture(true, {
    inputs,
    candidateSha: q,
    candidateVersion: "2026.8.28-beta.1",
    policy: JSON.parse(readFileSync("scripts/lib/release-qualification-coverage.json", "utf8")),
    workflowSource,
  });
  inputs.trusted_workflow_json = publicationDispatchEnvelope(
    tooling,
    { validationPurpose: purpose, publicationSelection: publishing ? selection : null },
    laneInputs,
    admission.descriptor,
  );
  const coverage = admission.receipt.coverage;
  const mapped = <T>(value: T): T =>
    JSON.parse(
      JSON.stringify(value)
        .replaceAll(legacyRunId, runId)
        .replaceAll(fixture.targetSha, q)
        .replaceAll(fixture.workflowSha, q)
        .replaceAll('"main"', JSON.stringify(branch))
        .replaceAll("refs/heads/main", tooling.fullRef),
    );
  const source = createPublicationSourceFact(
    publicationSourceRequest({
      PUBLICATION_INPUTS_JSON: JSON.stringify(inputs),
      PUBLICATION_TOOLING_JSON: JSON.stringify(tooling),
      PUBLICATION_TARGET_CONTEXT: inputs.target_context_ref,
      PUBLICATION_TARGET_SHA: q,
      PUBLICATION_COVERAGE_POLICY: "npm-beta-v1",
      PUBLICATION_SKIP_TELEGRAM: "true",
      GITHUB_REPOSITORY: repository,
      GITHUB_REF: tooling.fullRef,
      GITHUB_SHA: q,
      GITHUB_RUN_ID: runId,
      GITHUB_RUN_ATTEMPT: "1",
    }),
    publishing ? { packages: [], platforms: [] } : null,
    publishing
      ? {
          version: "2026.8.28-beta.1",
          packages: [{ name: "openclaw", version: "2026.8.28-beta.1", targets: ["npm"] }],
          platforms: [],
        }
      : null,
  );
  const publicationAdmission = (() => {
    if (!publishing) {
      return null;
    }
    const observations = createPublicationObservations(source, {
      sourceDigest: source.digest,
      prerequisitesCompletedAt: time,
      collectionStartedAt: time,
      collectionCompletedAt: time,
      npm: [
        {
          name: "openclaw",
          version: "2026.8.28-beta.1",
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
          bootstrapCandidates: [],
          missingTrustedPublisher: [],
          warnings: [],
        },
      },
    });
    return createPublicationAdmission(
      source,
      observations,
      {
        id: "444",
        name: "full-release-publication-observations-" + runId + "-1",
        digest: "sha256:" + "c".repeat(64),
        sizeInBytes: 4096,
      },
      time,
    );
  })();
  const plan = Object.assign(mapped(fixture.executionPlan), {
    sourceAdmissionContract: "1",
    sourceAdmission: source,
    publicationAdmissionContract: "1",
    publicationAdmission,
    qualificationCoverage: coverage,
    qualificationInputs: inputs,
    trustedWorkflow: tooling,
  });
  plan.children = plan.children.filter((child) => child.selected);
  const qualificationBaselines = JSON.parse(qualificationBaselinesJson);
  Object.assign(expectDefined(plan.candidateRequest, "candidate request"), {
    upgradeBaseline: qualificationBaselines.upgradeBaseline,
    upgradeSurvivorBaselines: qualificationBaselines.upgradeSurvivorBaselines,
  });
  const jobsFor = (requestedRunId: string) => {
    const child = plan.children.find((entry) => entry.runId === requestedRunId);
    const names =
      requestedRunId === runId
        ? coverage.requiredParentJobs
        : expectDefined(
            coverage.children.find((entry) => entry.key === child?.key),
            "covered child",
          ).requiredJobs;
    return names.map((name, index) =>
      Object.assign(mapped(fixture.parentJob), { id: 600 + index, name }),
    );
  };
  const manifest = Object.assign(mapped(fixture.manifest), {
    // Fresh qualification has no reused evidence or shared candidate artifact.
    candidateBinding: undefined,
    evidenceReuse: undefined,
    sourceAdmissionContract: "1",
    sourceAdmission: source,
    publicationAdmissionContract: "1",
    publicationAdmission,
    qualificationCoverage: structuredClone(coverage),
    qualificationInputs: inputs,
    trustedWorkflow: tooling,
    targetRef: q,
    targetSha: q,
    workflowFullRef: tooling.fullRef,
    workflowRef: branch,
    publicationArtifacts: { npmPreflight: {}, docker: {} },
  });
  delete manifest.candidateBinding;
  delete manifest.evidenceReuse;
  Object.assign(
    manifest.validationInputs,
    Object.fromEntries(
      Object.entries(source.coverage).map(([key, value]) => [
        key.replace(/_([a-z])/gu, (_, letter: string) => letter.toUpperCase()),
        value,
      ]),
    ),
    publicationIntentInputs(source),
  );
  manifest.validationInputs.targetContextRef = expectDefined(
    inputs.target_context_ref,
    "normalized target context ref",
  );
  for (const child of plan.children) {
    const composite = composeReleaseAttemptJobs([{ jobs: jobsFor(child.runId), runAttempt: 1 }], {
      effectiveRunAttempt: 1,
      plannedRunAttempt: 1,
    });
    Object.assign(manifest.childEvidence[child.key]!, {
      jobs: composite.jobs,
      compositeJobsSha256: composite.sha256,
    });
  }
  plan.sha256 = releaseExecutionPlanSha256(plan);
  manifest.executionPlanSha256 = plan.sha256;
  const parent = Object.assign(mapped(fixture.parentRun), {
    name: "Full Release Validation",
    head_repository: { full_name: repository },
    referenced_workflows: [
      {
        path: repository + "/.github/workflows/docker-release-prepare.yml@" + q,
        sha: q,
        ref: tooling.fullRef,
      },
      {
        path: repository + "/.github/workflows/openclaw-npm-preflight.yml@" + q,
        sha: q,
        ref: tooling.fullRef,
      },
    ],
  });
  const sealer = {
    id: options.runId ? 10902 : 902,
    name: "Seal release execution plan",
    run_id: Number(runId),
    run_attempt: 1,
    head_sha: q,
    status: "completed",
    conclusion: "success",
    steps: [
      {
        name: "Seal immutable release execution plan",
        number: 5,
        status: "completed",
        conclusion: "success",
        started_at: "2026-08-28T12:01:00.000Z",
        completed_at: "2026-08-28T12:01:01.000Z",
      },
      {
        name: "Upload immutable release execution plan",
        number: 6,
        status: "completed",
        conclusion: "success",
        started_at: "2026-08-28T12:01:01.000Z",
        completed_at: "2026-08-28T12:01:03.000Z",
      },
      {
        name: "Record immutable release execution plan digest",
        number: 7,
        status: "completed",
        conclusion: "success",
        started_at: "2026-08-28T12:01:03.000Z",
        completed_at: "2026-08-28T12:01:03.000Z",
      },
    ],
  };
  const originalJobs = jobsFor(runId).map((job) =>
    Object.assign(job, {
      steps:
        job.name === "Resolve target ref"
          ? [{ name: "Finalize publication admission", conclusion: "success" }]
          : [],
    }),
  );
  const denied = () => {
    throw new Error("Q is not an ancestor of main or P");
  };
  const client = {
    ...fixture.client,
    validateChildReuse() {
      throw new Error("Fresh candidate fixture does not contain reused children");
    },
    getArtifact() {
      throw new Error("Fresh candidate fixture does not reuse publication artifacts");
    },
    compareCommitLineage: denied,
    compareCommits: denied,
    verifyQualificationAdmission: (
      verification: Parameters<typeof verifyQualificationAdmission>[0],
    ) =>
      verifyQualificationAdmission({
        ...verification,
        runGh: admission.runGh,
        downloadArchive: admission.archive,
      }),
    revalidateQualificationAdmissionAuthority: (
      authority: Parameters<typeof revalidateQualificationAdmissionAuthority>[0],
    ) => revalidateQualificationAdmissionAuthority({ ...authority, runGh: admission.runGh }),
    getWorkflowSource: () => workflowSource,
    getRef: (ref: string) => ({ ref, object: { sha: admission.authority.tagSha } }),
    getRunView: (_id: string) => mapped(fixture.client.getRunView(legacyRunId)),
    getRun: async (id: string) => (id === runId ? parent : mapped(fixture.client.getRun(id))),
    getRunAttempt: (id: string, attempt: number) => {
      if (attempt !== 1) {
        throw new Error("Unexpected producer attempt");
      }
      return id === runId ? parent : mapped(fixture.client.getRun(id));
    },
    getParentJobs: async (id: string) =>
      mapped(fixture.client.getParentJobs(id === runId ? legacyRunId : id)),
    getJobLog: async (id: number) =>
      id === sealer.id
        ? "2026-08-28T12:01:03.750Z FRV_EXECUTION_PLAN_SHA256=" + plan.sha256 + "\n"
        : fixture.client
            .getJobLog(id)
            .replaceAll(legacyRunId, runId)
            .replaceAll(fixture.targetSha, q),
    getRunAttemptJobs: async (id: string) =>
      id === runId ? [...originalJobs, sealer] : jobsFor(id),
    loadExecutionPlan: () => plan,
    loadExecutionPlanEvidence: () => ({
      plan,
      artifact: {
        created_at: "2026-08-28T12:01:02.000Z",
        workflow_run: { head_sha: q, head_branch: branch },
      },
    }),
    loadManifest: () => ({ artifact: mapped(fixture.artifact), manifest }),
  };
  const npmBytes = "immutable qualified npm tarball bytes";
  const npmProducer = {
    repository,
    runId,
    runAttempt: "1",
    workflowSha: q,
    workflowRef: repository + "/.github/workflows/full-release-validation.yml@" + tooling.fullRef,
    producerWorkflowPath: ".github/workflows/openclaw-npm-preflight.yml",
    jobId: "780",
    jobName: "Qualify prepared npm package",
  };
  const npmManifest = {
    version: 3,
    releaseSha: q,
    releaseTag: "v2026.8.28-beta.1",
    tarballName: "openclaw.tgz",
    tarballSha256: hash(npmBytes),
    producer: npmProducer,
    preparedBundle: {
      schema: "openclaw.prepared-npm-bundle/v1",
      source: { sha: q },
      package: { sha256: hash(npmBytes) },
      producer: { repository, workflowSha: q },
    },
  };
  const npmManifestBytes = JSON.stringify(npmManifest);
  const npmArchive = makeStoredZip({
    "preflight-manifest.json": npmManifestBytes,
    "openclaw.tgz": npmBytes,
  });
  const npmArtifact = {
    id: 781,
    name: "openclaw-npm-preflight-v2026.8.28-beta.1",
    digest: "sha256:" + hash(npmArchive),
    size_in_bytes: npmArchive.length,
    expired: false,
    expires_at: "2099-01-01T00:00:00Z",
    workflow_run: { id: Number(runId), head_sha: q },
  };
  const npmQualified = {
    schema: "openclaw.qualified-npm-preflight/v1",
    source: { sha: q },
    producer: npmProducer,
    manifestSha256: hash(npmManifestBytes),
    artifact: {
      id: "781",
      name: npmArtifact.name,
      digest: hash(npmArchive),
      runId,
      runAttempt: "1",
    },
  };
  manifest.publicationArtifacts.npmPreflight = npmQualified;
  const npmJob = {
    id: 780,
    run_id: Number(runId),
    run_attempt: 1,
    head_sha: q,
    name: npmProducer.jobName,
    status: "completed",
    conclusion: "success",
  };
  const artifactName = dockerReleaseArtifactName(q, "1");
  const payloadBytes = ["immutable amd64 OCI payload", "immutable arm64 OCI payload"];
  const dockerArtifacts = ["amd64", "arm64"].map((arch, i) => ({
    id: 810 + i,
    name: artifactName + "-" + arch,
    digest: "sha256:" + hash(payloadBytes[i]!),
    size_in_bytes: payloadBytes[i]!.length,
    expired: false,
    workflow_run: { id: Number(runId), head_sha: q },
  }));
  const docker = {
    schemaVersion: 1,
    repository,
    sourceSha: q,
    toolingSha: q,
    tag: "v2026.8.28-beta.1",
    version: "2026.8.28-beta.1",
    imageTagSuffix: "",
    builtAt: time,
    includeBrowser: false,
    artifactName,
    producer: {
      repository,
      runId,
      runAttempt: "1",
      workflowSha: q,
      workflowRef: repository + "/.github/workflows/full-release-validation.yml@" + tooling.fullRef,
      preparationWorkflowRef:
        repository + "/.github/workflows/docker-release-prepare.yml@" + tooling.fullRef,
      jobId: "800",
      jobName: "Prepare Docker / Seal prepared Docker images",
    },
    architectures: ["amd64", "arm64"].map((architecture, i) => ({
      architecture,
      artifact: {
        id: String(dockerArtifacts[i]!.id),
        name: dockerArtifacts[i]!.name,
        digest: dockerArtifacts[i]!.digest,
      },
      images: [
        {
          variant: "default",
          smoke: "success",
          attestations: "success",
          indexDigest: "sha256:" + hash("index" + architecture),
          imageDigest: "sha256:" + hash("image" + architecture),
          configDigest: "sha256:" + hash("config" + architecture),
          manifests: [],
        },
      ],
    })),
  };
  const dockerBytes = JSON.stringify(docker, null, 2) + "\n";
  manifest.publicationArtifacts.docker = {
    preparedRunId: runId,
    preparedRunAttempt: "1",
    preparedArtifactName: artifactName,
    preparedManifestSha256: hash(dockerBytes),
  };
  const dockerJob = {
    id: 800,
    run_id: Number(runId),
    run_attempt: 1,
    head_sha: q,
    name: docker.producer.jobName,
    status: "completed",
    conclusion: "success",
  };
  const readApi = (endpoint: string) => {
    if (endpoint.includes("/compare/")) {
      return denied();
    }
    if (
      endpoint.endsWith("/actions/runs/" + runId) ||
      endpoint.endsWith("/actions/runs/" + runId + "/attempts/1")
    ) {
      return parent;
    }
    if (endpoint.includes("/jobs?")) {
      return { total_count: 2, jobs: [npmJob, dockerJob] };
    }
    if (endpoint.endsWith("/actions/jobs/800")) {
      return dockerJob;
    }
    if (endpoint.includes("/artifacts?")) {
      return { artifacts: dockerArtifacts.filter((item) => endpoint.includes(item.name)) };
    }
    if (endpoint.endsWith("/actions/artifacts/781")) {
      return npmArtifact;
    }
    throw new Error("Unexpected publication API: " + endpoint);
  };
  const runGh = (args: string[]) =>
    JSON.stringify(
      readApi(
        expectDefined(
          args.find((arg) => arg.startsWith("repos/")),
          "API endpoint",
        ),
      ),
    );
  return {
    q,
    p,
    branch,
    repository,
    runId,
    publisherFullRef: admission.producer.workflowFullRef,
    admission,
    source,
    plan,
    manifest,
    parent,
    client,
    fixture,
    inputs,
    tooling,
    coverage,
    npmBytes,
    npmManifest,
    npmManifestBytes,
    npmArchive,
    npmArtifact,
    npmQualified,
    docker,
    dockerBytes,
    dockerArtifacts,
    payloadBytes,
    readApi,
    runGh,
  };
}
