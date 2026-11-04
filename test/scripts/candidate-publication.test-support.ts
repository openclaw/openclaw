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
const version = "2026.8.28-beta.1";
const workflowPath = (name: string) => `.github/workflows/${name}.yml`;

export function candidatePublicationFixture(
  options: {
    candidateSha?: string;
    transportRef?: string;
    runId?: string;
    purpose?: "publish" | "main-qualification" | "diagnostic";
    protectedTag?: boolean;
  } = {},
) {
  const fixture = trustedMainNpmFixture();
  const q = options.candidateSha ?? defaultQ;
  const branch =
    options.transportRef ??
    (options.candidateSha ? "release-ci/" + q.slice(0, 12) + "-123" : defaultBranch);
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
  const intent = {
    validationPurpose: purpose,
    publicationSelection: publishing ? selection : null,
  };
  Object.assign(inputs, {
    ref: q,
    expected_sha: q,
    target_context_ref: "release/2026.8.28",
    release_profile: "beta",
    rerun_group: "all",
    mode: "both",
    run_release_soak: "false",
    trusted_workflow_json: publicationDispatchEnvelope(tooling, intent, laneInputs),
  });
  const admission = admissionFixture(options.protectedTag ?? true, {
    inputs,
    candidateSha: q,
    transportRef: branch,
    candidateVersion: version,
    policy: JSON.parse(readFileSync("scripts/lib/release-qualification-coverage.json", "utf8")),
    workflowSource,
  });
  inputs.trusted_workflow_json = publicationDispatchEnvelope(
    tooling,
    intent,
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
          version,
          packages: [{ name: "openclaw", version, targets: ["npm"] }],
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
          version,
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
  const admissionFields = {
    sourceAdmissionContract: "1",
    sourceAdmission: source,
    publicationAdmissionContract: "1",
    publicationAdmission,
    qualificationCoverage: coverage,
    qualificationInputs: inputs,
    trustedWorkflow: tooling,
  };
  const plan = Object.assign(mapped(fixture.executionPlan), admissionFields);
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
    ...admissionFields,
    qualificationCoverage: structuredClone(coverage),
    targetRef: q,
    targetSha: q,
    workflowFullRef: tooling.fullRef,
    workflowRef: branch,
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
    referenced_workflows: ["docker-release-prepare", "openclaw-npm-preflight"].map((name) => ({
      path: `${repository}/${workflowPath(name)}@${q}`,
      sha: q,
      ref: tooling.fullRef,
    })),
  });
  const completedJob = (id: number, name: string) => ({
    id,
    name,
    run_id: Number(runId),
    run_attempt: 1,
    head_sha: q,
    status: "completed",
    conclusion: "success",
  });
  const sealer = {
    ...completedJob(options.runId ? 10902 : 902, "Seal release execution plan"),
    steps: (
      [
        ["Seal immutable release execution plan", "00", "01"],
        ["Upload immutable release execution plan", "01", "03"],
        ["Record immutable release execution plan digest", "03", "03"],
      ] as const
    ).map(([name, start, end], index) => ({
      name,
      number: index + 5,
      status: "completed",
      conclusion: "success",
      started_at: `2026-08-28T12:01:${start}.000Z`,
      completed_at: `2026-08-28T12:01:${end}.000Z`,
    })),
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
  const producer = {
    repository,
    runId,
    runAttempt: "1",
    workflowSha: q,
    workflowRef: `${repository}/${workflowPath("full-release-validation")}@${tooling.fullRef}`,
  };
  const npmProducer = {
    ...producer,
    producerWorkflowPath: workflowPath("openclaw-npm-preflight"),
    jobId: "780",
    jobName: "Qualify prepared npm package",
  };
  const npmManifest = {
    version: 3,
    releaseSha: q,
    releaseTag: `v${version}`,
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
  const artifact = (id: number, name: string, bytes: string | Uint8Array) => ({
    id,
    name,
    digest: "sha256:" + hash(bytes),
    size_in_bytes: bytes.length,
    expired: false,
    workflow_run: { id: Number(runId), head_sha: q },
  });
  const npmArtifact = {
    ...artifact(781, `openclaw-npm-preflight-v${version}`, npmArchive),
    expires_at: "2099-01-01T00:00:00Z",
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
  const npmJob = completedJob(780, npmProducer.jobName);
  const artifactName = dockerReleaseArtifactName(q, "1");
  const payloadBytes = ["immutable amd64 OCI payload", "immutable arm64 OCI payload"];
  const architectures = ["amd64", "arm64"];
  const dockerArtifacts = architectures.map((arch, i) =>
    artifact(810 + i, artifactName + "-" + arch, payloadBytes[i]!),
  );
  const docker = {
    schemaVersion: 1,
    repository,
    sourceSha: q,
    toolingSha: q,
    tag: `v${version}`,
    version,
    imageTagSuffix: "",
    builtAt: time,
    includeBrowser: false,
    artifactName,
    producer: {
      ...producer,
      preparationWorkflowRef: `${repository}/${workflowPath("docker-release-prepare")}@${tooling.fullRef}`,
      jobId: "800",
      jobName: "Prepare Docker / Seal prepared Docker images",
    },
    architectures: architectures.map((architecture, i) => ({
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
  const publicationArtifacts = {
    npmPreflight: npmQualified,
    docker: {
      preparedRunId: runId,
      preparedRunAttempt: "1",
      preparedArtifactName: artifactName,
      preparedManifestSha256: hash(dockerBytes),
    },
  };
  const dockerJob = completedJob(800, docker.producer.jobName);
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
  const runGh = (args: string[]) => {
    const endpoint = expectDefined(
      args.find((arg) => arg.startsWith("repos/")),
      "API endpoint",
    );
    return JSON.stringify(readApi(endpoint));
  };
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
    manifest: Object.assign(manifest, { publicationArtifacts }),
    parent,
    client,
    tooling,
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
