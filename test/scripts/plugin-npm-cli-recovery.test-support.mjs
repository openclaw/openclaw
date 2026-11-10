// Raw GitHub response graph for a successfully sealed receipt-recovery aggregate.
// These are external producer records, not substituted authentication results.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  buildFullReleaseCandidateBinding,
} from "../../scripts/full-release-candidate-contract.mjs";
import {
  createPublicationAdmission,
  createPublicationSourceFact,
} from "../../scripts/full-release-publication-contract.mjs";
import {
  RECEIPT_RECOVERY_SCHEMA,
  RECEIPT_RECOVERY_WORKFLOW,
  receiptRecoveryChildInputs,
  receiptRecoverySourceRequest,
} from "../../scripts/full-release-receipt-recovery.mjs";
import {
  composeReleaseChildAttemptEvidence,
  releaseChildSpec,
  releaseCompositeJobsSha256,
} from "../../scripts/full-release-validation-policy.mjs";
import { canonicalizeJsonValue } from "../../scripts/lib/canonical-json.mjs";
import { fullReleaseCandidateManifestFixture } from "../helpers/full-release-candidate.js";
import { makeStoredZip } from "./actions-artifact-zip.test-support.js";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const canonicalHash = (value) => hash(JSON.stringify(canonicalizeJsonValue(value)));
const roles = [
  "normalCi",
  "pluginPrereleaseIndependent",
  "releaseChecksIndependent",
  "releaseChecksCandidate",
  "pluginPrereleaseCandidate",
];
const time = "2026-08-28T12:00:00.000Z";
const complete = { status: "completed", conclusion: "success" };

export function addRecoveryGraph({
  f,
  producer,
  packages,
  artifacts,
  json,
  bytes,
  source,
  metadata,
}) {
  const workflow = ".github/workflows/full-release-artifacts.yml";
  const fullRef = "refs/heads/" + f.branch;
  const repository = { full_name: f.repository, id: 1 };
  const job = (id, name, runId) => ({
    id,
    name,
    run_id: Number(runId),
    run_attempt: 1,
    head_sha: f.q,
    ...complete,
    started_at: time,
    completed_at: time,
    html_url: "https://github.com/" + f.repository + "/actions/runs/" + runId + "/job/" + id,
    steps: [],
  });
  const run = (id, path, overrides = {}) => ({
    id: Number(id),
    run_attempt: 1,
    head_sha: f.q,
    head_branch: f.branch,
    event: "workflow_dispatch",
    path,
    repository,
    head_repository: repository,
    actor: { login: "github-actions[bot]" },
    triggering_actor: { login: "github-actions[bot]" },
    html_url: "https://github.com/" + f.repository + "/actions/runs/" + id,
    ...complete,
    ...overrides,
  });
  const recordRun = (value, jobs) => {
    json("actions/runs/" + value.id, value);
    json("actions/runs/" + value.id + "/attempts/1", value);
    for (const suffix of ["?per_page=100", "?per_page=100&page=1"]) {
      json("actions/runs/" + value.id + "/attempts/1/jobs" + suffix, {
        total_count: jobs.length,
        jobs,
      });
    }
  };
  const put = (id, name, files, runId, sha = f.q, branch = f.branch) => {
    const archive = makeStoredZip(files);
    const meta = {
      ...metadata(id, name, archive, Number(runId), sha, branch),
      created_at: time,
      workflow_run: {
        id: Number(runId),
        head_sha: sha,
        head_branch: branch,
        repository_id: 1,
        head_repository_id: 1,
      },
    };
    artifacts.set(id, meta);
    bytes("actions/artifacts/" + id + "/zip", archive);
    json("actions/artifacts/" + id, meta);
    return meta;
  };
  const list = (runId) => {
    const all = [...artifacts.values()].filter((entry) => entry.workflow_run.id === Number(runId));
    json("actions/runs/" + runId + "/artifacts?per_page=100&page=1", {
      total_count: all.length,
      artifacts: all,
    });
    for (const entry of all) {
      json(
        "actions/runs/" +
          runId +
          "/artifacts?name=" +
          encodeURIComponent(entry.name) +
          "&per_page=100",
        { total_count: 1, artifacts: [entry] },
      );
    }
  };
  const artifactIdentity = (meta) => ({
    id: String(meta.id),
    name: meta.name,
    digest: meta.digest.slice(7),
    expiresAt: meta.expires_at,
    runId: String(meta.workflow_run.id),
    runAttempt: "1",
  });

  // The original npm and Docker producers are independent artifact workflow runs.
  // Sealed payload records attest their bytes; readers still check live metadata.
  const npmProducer = {
    repository: f.repository,
    workflowRef: f.repository + "/" + workflow + "@" + fullRef,
    workflowSha: f.q,
    runId: "6001",
    runAttempt: "1",
    jobId: "6101",
    jobName: "Prepare npm artifacts / Prepare publishable npm package",
    producerWorkflowPath: ".github/workflows/openclaw-npm-preflight.yml",
  };
  const packageFile = "openclaw-current.tgz";
  const packageBytes = Buffer.from(f.npmBytes);
  const packageManifest = JSON.stringify({
    schema: "openclaw.npm-package-bundle/v1",
    packageName: "openclaw",
    packageVersion: f.npmManifest.releaseTag.slice(1),
    releaseSha: f.q,
    tarballName: packageFile,
    tarballSha256: hash(packageBytes),
    producer: npmProducer,
    corePackageTarballs: [],
    dependencyTarballs: [],
  });
  const rawMeta = put(
    6201,
    "openclaw-npm-package-6001-1",
    { "package-bundle.json": packageManifest, [packageFile]: packageBytes },
    6001,
  );
  const raw = {
    schema: "openclaw.prepared-npm-bundle/v1",
    source: { sha: f.q },
    producer: npmProducer,
    artifact: {
      id: "6201",
      name: rawMeta.name,
      digest: rawMeta.digest.slice(7),
      runId: "6001",
      runAttempt: "1",
    },
    package: {
      name: "openclaw",
      version: f.npmManifest.releaseTag.slice(1),
      fileName: packageFile,
      sha256: hash(packageBytes),
      sourceSha: f.q,
    },
    corePackages: [],
    manifestSha256: hash(packageManifest),
  };
  const qualifiedProducer = {
    ...npmProducer,
    jobId: "6102",
    jobName: "Prepare npm artifacts / Qualify prepared npm package",
  };
  const qualifiedManifest = JSON.stringify({
    version: 3,
    releaseSha: f.q,
    releaseTag: f.npmManifest.releaseTag,
    tarballName: packageFile,
    tarballSha256: hash(packageBytes),
    producer: qualifiedProducer,
    preparedBundle: raw,
  });
  const qualifiedMeta = put(
    6202,
    "openclaw-npm-preflight-" + f.q,
    { "preflight-manifest.json": qualifiedManifest, [packageFile]: packageBytes },
    6001,
  );
  const qualified = {
    schema: "openclaw.qualified-npm-preflight/v1",
    source: { sha: f.q },
    producer: qualifiedProducer,
    artifact: {
      id: "6202",
      name: qualifiedMeta.name,
      digest: qualifiedMeta.digest.slice(7),
      runId: "6001",
      runAttempt: "1",
    },
    preparedBundle: raw,
    manifestSha256: hash(qualifiedManifest),
  };
  recordRun(
    run(6001, workflow, {
      display_title:
        "Full Release Artifacts full-release-validation-" + f.runId + "-1-artifacts-npm",
    }),
    [job(6101, npmProducer.jobName, 6001), job(6102, qualifiedProducer.jobName, 6001)],
  );
  const sdk = put(
    6203,
    "plugin-sdk-api-release-diff-6001-1",
    { "plugin-sdk-api-release-evidence.json": "{}" },
    6001,
  );
  const receipt = (stage, runId, outputs) => ({
    schema: "openclaw.full-release-artifact-receipt/v1",
    stage,
    dispatchId: "full-release-validation-" + f.runId + "-1-artifacts-" + stage,
    repository: f.repository,
    sourceSha: f.q,
    toolingSha: f.q,
    workflowRef: f.branch,
    releaseTag: f.npmManifest.releaseTag,
    preflightPhase: "all",
    runId: String(runId),
    runAttempt: "1",
    outputs,
  });
  put(
    6204,
    "full-release-artifact-receipt-6001-1",
    {
      "artifact-receipt.json": JSON.stringify(
        receipt("npm", 6001, {
          prepared_bundle_json: JSON.stringify(raw),
          qualified_preflight_bundle_json: JSON.stringify(qualified),
        }),
      ),
    },
    6001,
  );

  const dockerManifest = structuredClone(f.docker);
  Object.assign(dockerManifest.producer, {
    runId: "6002",
    jobId: "6103",
    jobName: "Prepare Docker artifacts / Seal prepared Docker images",
    workflowRef: f.repository + "/" + workflow + "@" + fullRef,
  });
  const dockerPayloads = dockerManifest.architectures.map((entry, index) => {
    const meta = put(
      6301 + index,
      entry.artifact.name,
      { "image.tar": "immutable image " + entry.architecture },
      6002,
    );
    entry.artifact = { id: String(meta.id), name: meta.name, digest: meta.digest };
    return meta;
  });
  const dockerJson = JSON.stringify(dockerManifest);
  const dockerMeta = put(6303, dockerManifest.artifactName, { "manifest.json": dockerJson }, 6002);
  const docker = {
    preparedRunId: "6002",
    preparedRunAttempt: "1",
    preparedArtifactName: dockerMeta.name,
    preparedManifestSha256: hash(dockerJson),
  };
  put(
    6304,
    "full-release-artifact-receipt-6002-1",
    {
      "artifact-receipt.json": JSON.stringify(
        receipt("docker", 6002, {
          prepared_run_id: "6002",
          prepared_run_attempt: "1",
          prepared_artifact_name: dockerMeta.name,
          prepared_manifest_sha256: hash(dockerJson),
        }),
      ),
    },
    6002,
  );
  const dockerJob = job(6103, dockerManifest.producer.jobName, 6002);
  json("actions/jobs/6103", dockerJob);
  recordRun(
    run(6002, workflow, {
      display_title:
        "Full Release Artifacts full-release-validation-" + f.runId + "-1-artifacts-docker",
      referenced_workflows: [
        {
          path: f.repository + "/.github/workflows/docker-release-prepare.yml@" + f.q,
          sha: f.q,
          ref: fullRef,
        },
      ],
    }),
    [dockerJob],
  );

  const baselines = JSON.parse(
    JSON.parse(f.admission.receipt.request.inputs.trusted_workflow_json).laneInputs
      .qualification_baselines_json,
  );
  const candidate = fullReleaseCandidateManifestFixture({
    targetSha: f.q,
    toolingSha: f.q,
    releaseProfile: "beta",
    releaseSoak: false,
    upgradeSurvivorBaseline: baselines.upgradeBaseline,
    upgradeSurvivorBaselines: baselines.upgradeSurvivorBaselines.join(" "),
  });
  for (const key of ["producer", "publisher"]) candidate[key].runId = f.runId;
  const constituents = [
    [
      candidate.package,
      put(
        101,
        candidate.package.artifact.name,
        { [packageFile]: packageBytes, "package-candidate.json": "{}" },
        f.runId,
      ),
    ],
    [
      candidate.prepublishPluginRegistry,
      put(
        102,
        candidate.prepublishPluginRegistry.artifact.name,
        { "registry.json": "{}" },
        f.runId,
      ),
    ],
    [
      candidate.sharedImage,
      put(103, candidate.sharedImage.artifact.name, { "image.tar": "shared image" }, f.runId),
    ],
  ];
  for (const [part, meta] of constituents) part.artifact = artifactIdentity(meta);
  candidate.package.fileName = packageFile;
  candidate.package.packageSha256 = hash(packageBytes);
  candidate.sharedImage.packageSha256 = hash(packageBytes);
  const candidateMeta = put(
    104,
    "full-release-candidate-v2-" + candidate.requestSha256,
    { "full-release-candidate.json": JSON.stringify(candidate) },
    f.runId,
  );
  const candidateBinding = buildFullReleaseCandidateBinding({
    manifest: candidate,
    artifact: artifactIdentity(candidateMeta),
  });

  // Build complete child receipts from external jobs and dispatch inputs, as a
  // real seal would. No verify/authorize function is called to manufacture success.
  const children = {};
  const dispatchJobs = [];
  for (const [index, role] of roles.entries()) {
    const id = 910 + index;
    const spec = releaseChildSpec(role);
    const workflowSource = readFileSync(".github/workflows/" + spec.workflow, "utf8");
    source(".github/workflows/" + spec.workflow, f.q, workflowSource);
    const inputs = receiptRecoveryChildInputs(
      role,
      f.admission.receipt,
      candidateBinding,
      workflowSource,
    );
    const normalizedInputs = Object.fromEntries(
      Object.entries(inputs)
        .filter(([key, value]) => key !== "dispatch_id" && value !== "")
        .map(([key, value]) => [key, String(value)]),
    );
    const dispatchId = "full-release-validation-" + f.runId + "-1" + spec.suffix;
    const childRun = run(id, ".github/workflows/" + spec.workflow, {
      display_title: spec.displayName + " " + dispatchId,
    });
    const coverage = f.admission.receipt.coverage.children.find((entry) => entry.key === role);
    const childJobs = coverage.requiredJobs.map((name, offset) => job(id * 100 + offset, name, id));
    const publisher = job(
      id * 100 + 90,
      "Seal full release child evidence / Seal child receipt",
      id,
    );
    publisher.steps = [
      "Checkout trusted child evidence tooling",
      "Seal exact child attempt evidence",
      "Upload sealed child evidence",
    ].map((name, number) => ({ name, number: number + 1, ...complete }));
    childJobs.push(publisher);
    const composite = composeReleaseChildAttemptEvidence({
      attempts: [{ runAttempt: 1, jobs: childJobs }],
      expected: {
        key: role,
        repository: f.repository,
        runId: String(id),
        plannedRunAttempt: 1,
        displayTitle: childRun.display_title,
        workflow: spec.workflow,
        workflowRef: f.branch,
        workflowSha: f.q,
      },
      run: childRun,
    });
    composite.jobs = composite.jobs.filter((entry) => entry.name !== publisher.name);
    composite.compositeJobsSha256 = releaseCompositeJobsSha256(composite);
    const childReceipt = {
      schema: "openclaw.full-release-child-evidence/v1",
      repository: f.repository,
      role,
      targetSha: f.q,
      workflowSha: f.q,
      workflowRef: f.branch,
      workflowPath: ".github/workflows/" + spec.workflow,
      displayTitle: childRun.display_title,
      dispatchId,
      sourceParentRunId: f.runId,
      sourceParentAttempt: 1,
      workloadConclusion: "success",
      inputs: normalizedInputs,
      publisher: { jobId: String(publisher.id), jobName: publisher.name },
      ...composite,
      dispatchActor: "github-actions[bot]",
      triggeringActor: "github-actions[bot]",
      observedRunAttempts: [1],
      runId: String(id),
    };
    const sealedReceipt = { ...childReceipt, sha256: canonicalHash(childReceipt) };
    const childMeta = put(
      6400 + index,
      "full-release-child-evidence-" + f.q + "-" + role + "-" + id + "-1",
      { "full-release-child-evidence.json": JSON.stringify(sealedReceipt) },
      id,
    );
    children[role] = {
      repository: f.repository,
      targetSha: f.q,
      role,
      runId: String(id),
      runAttempt: 1,
      workflowSha: f.q,
      workflowRef: f.branch,
      displayTitle: childRun.display_title,
      sourceParentRunId: f.runId,
      sourceParentAttempt: 1,
      url: childRun.html_url,
      inputs: normalizedInputs,
      artifact: {
        id: String(childMeta.id),
        name: childMeta.name,
        digest: childMeta.digest,
        expiresAt: childMeta.expires_at,
        sizeInBytes: childMeta.size_in_bytes,
      },
      receiptSha256: sealedReceipt.sha256,
    };
    recordRun(childRun, childJobs);
    const dispatch = job(6500 + index, coverage.parentJobName, f.runId);
    dispatchJobs.push(dispatch);
    bytes(
      "actions/jobs/" + dispatch.id + "/logs",
      Buffer.from(
        "TARGET_SHA: " +
          f.q +
          "\nCI_RELEASE_SCOPE: npm-beta\n" +
          childRun.html_url +
          " (attempt 1)",
      ),
    );
  }
  const parentJobs = f.admission.receipt.coverage.requiredParentJobs
    .filter((name) => !dispatchJobs.some((entry) => entry.name === name))
    .map((name, index) => job(6600 + index, name, f.runId));
  parentJobs.push(
    ...dispatchJobs,
    job(Number(candidate.producer.jobId), candidate.producer.jobName, f.runId),
    job(Number(candidate.publisher.jobId), candidate.publisher.jobName, f.runId),
  );
  recordRun({ ...f.parent, repository, head_repository: repository }, parentJobs);

  const publicationArtifacts = { npmPreflight: qualified, docker, pluginNpm: producer };
  const recovery = {
    schema: RECEIPT_RECOVERY_SCHEMA,
    requestId: "12345678-1234-4123-8123-123456789abc",
    repository: f.repository,
    qualificationAdmission: f.admission.descriptor,
    originalParent: { runId: f.runId, runAttempt: 1 },
    candidateBinding,
    children,
    publicationArtifacts,
  };
  const aggregate = { runId: "9900", runAttempt: 1, fullRef: "refs/heads/main", sha: f.p };
  const publicationSource = createPublicationSourceFact(
    receiptRecoverySourceRequest(f.admission.receipt, aggregate),
    { packages: [], platforms: [] },
    f.source.projection,
  );
  const observations = {
    ...f.manifest.publicationAdmission.observations,
    sourceDigest: publicationSource.digest,
  };
  const observationMeta = put(
    444,
    "full-release-publication-observations-9900-1",
    { "publication-observations.json": JSON.stringify(observations) },
    9900,
    f.p,
    "main",
  );
  const payload = (kind, meta, runId, extra = {}) => ({
    kind,
    artifact: {
      id: String(meta.id),
      name: meta.name,
      digest: meta.digest,
      sizeBytes: meta.size_in_bytes,
      expiresAt: meta.expires_at,
    },
    producer: { runId: String(runId), runAttempt: "1", workflowSha: f.q },
    sha256: meta.digest.slice(7),
    ...extra,
  });
  const packageIdentity = { fileName: packageFile, sha256: hash(packageBytes) };
  const payloads = [
    payload("raw-npm", rawMeta, 6001, { package: packageIdentity }),
    payload("qualified-npm", qualifiedMeta, 6001, { package: packageIdentity }),
    payload("sdk", sdk, 6001),
    payload("docker-manifest", dockerMeta, 6002, { manifestSha256: hash(dockerJson) }),
    ...dockerPayloads.map((meta, index) =>
      payload("docker-" + dockerManifest.architectures[index].architecture, meta, 6002),
    ),
    payload("plugin-npm", artifacts.get(producer.artifactId), producer.runId),
    ...packages.map((entry) => ({
      kind: "plugin-npm-package",
      artifact: entry.artifact,
      sha256: entry.artifact.artifactDigest.slice(7),
    })),
    {
      kind: "candidate-shared-image",
      artifact: candidateBinding.sharedImage.artifact,
      sha256: artifacts.get(103).digest.slice(7),
    },
    {
      kind: "candidate-plugin-registry",
      artifact: candidateBinding.prepublishPluginRegistry.artifact,
      sha256: artifacts.get(102).digest.slice(7),
    },
  ];
  const manifest = {
    ...f.manifest,
    runId: aggregate.runId,
    runAttempt: 1,
    sourceParentRunAttempt: 1,
    workflowRef: "main",
    workflowFullRef: aggregate.fullRef,
    workflowRefType: "branch",
    workflowSha: f.p,
    trustedWorkflow: { ref: "main", fullRef: aggregate.fullRef, sha: f.p },
    sourceAdmission: publicationSource,
    publicationAdmission: createPublicationAdmission(
      publicationSource,
      observations,
      {
        id: "444",
        name: observationMeta.name,
        digest: observationMeta.digest,
        sizeInBytes: observationMeta.size_in_bytes,
      },
      time,
      { workflowPath: RECEIPT_RECOVERY_WORKFLOW },
    ),
    publicationArtifacts,
    receiptRecovery: recovery,
    retainedPublicationPayloads: payloads,
    childRuns: Object.fromEntries(roles.map((role) => [role, children[role].runId])),
    waivers: [],
    advisoryJobs: [],
    controls: {
      stableSoakRequired: false,
      performanceBlocking: false,
      performanceReportPublication: "artifact-only",
    },
  };
  delete manifest.executionPlanSha256;
  delete manifest.qualificationCoverage;
  delete manifest.qualificationInputs;
  const aggregateJob = {
    ...job(9901, "Recover original qualification receipts", 9900),
    head_sha: f.p,
    steps: [
      "Authenticate retained qualification and collect fresh admission",
      "Upload fresh publication observations",
      "Seal receipt-backed aggregate",
      "Upload receipt-backed aggregate",
    ].map((name, index) => ({
      name,
      number: index + 1,
      ...complete,
      started_at: time,
      completed_at: time,
    })),
  };
  const aggregateRun = run(9900, RECEIPT_RECOVERY_WORKFLOW, {
    name: "Full Release Receipt Recovery",
    head_sha: f.p,
    head_branch: "main",
    actor: f.admission.actor,
    triggering_actor: f.admission.actor,
  });
  recordRun(aggregateRun, [aggregateJob]);
  json("run view 9900", {
    status: "completed",
    conclusion: "success",
    attempt: 1,
    headBranch: "main",
    headSha: f.p,
    url: aggregateRun.html_url,
  });
  source(RECEIPT_RECOVERY_WORKFLOW, f.p, readFileSync(RECEIPT_RECOVERY_WORKFLOW, "utf8"));
  json("compare/" + f.p + "...main", { status: "identical", merge_base_commit: { sha: f.p } });
  json("compare/" + f.p + "..." + f.p + "?per_page=1&page=2", {
    status: "identical",
    merge_base_commit: { sha: f.p },
  });
  put(
    91,
    "full-release-validation-9900-1",
    { "full-release-validation-manifest.json": JSON.stringify(manifest) },
    9900,
    f.p,
    "main",
  );
  // The plugin producer current endpoint is distinct from the live publisher.
  recordRun(run(producer.runId, producer.workflowPath), []);
  for (const id of [6001, 6002, producer.runId, 9900]) list(id);
  return {
    runId: aggregate.runId,
    manifest,
    recovery,
    retainedArchiveIds: [6204, 6304, 6303, 444, 9001],
    metadataOnlyPayloadIds: [6201, 6202, 6203, 6301, 6302, 101, 102, 103],
    immutableArchiveIds: [
      91,
      104,
      70,
      6204,
      6304,
      6303,
      444,
      9001,
      ...roles.map((_, index) => 6400 + index),
    ],
  };
}
