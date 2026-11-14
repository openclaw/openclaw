import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { vi } from "vitest";
import { verifyRetainedPublicationArtifacts } from "../../scripts/full-release-artifacts.mjs";
import { buildFullReleaseCandidateBinding } from "../../scripts/full-release-candidate-contract.mjs";
import {
  createPublicationAdmission,
  createPublicationSourceFact,
} from "../../scripts/full-release-publication-contract.mjs";
import {
  RECEIPT_RECOVERY_SCHEMA,
  receiptRecoveryChildInputs,
  receiptRecoverySourceRequest,
} from "../../scripts/full-release-receipt-recovery.mjs";
import {
  composeReleaseChildAttemptEvidence,
  releaseChildSpec,
  releaseCompositeJobsSha256,
} from "../../scripts/full-release-validation-policy.mjs";
import { canonicalizeJsonValue } from "../../scripts/lib/canonical-json.mjs";
import { validateReusableReleaseChild } from "../../scripts/lib/full-release-child-reuse.mjs";
import { isRecord } from "../../scripts/lib/record-shared.mjs";
import {
  verifyReceiptRecoveryAuthority,
  RECEIPT_RECOVERY_WORKFLOW,
} from "../../scripts/lib/release-evidence-identity.mjs";
import * as transport from "../../scripts/release-tooling-identity.mjs";
import {
  fullReleaseCandidateManifestFixture,
  canonicalTestJson,
} from "../helpers/full-release-candidate.js";
import { makeStoredZip } from "./actions-artifact-zip.test-support.js";
import { candidatePublicationFixture } from "./candidate-publication.test-support.js";

const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const time = "2026-08-28T12:00:00.000Z";
const expires = "2099-01-01T00:00:00Z";
const artifactWorkflow = ".github/workflows/full-release-artifacts.yml";
const childPublisher = "Seal full release child evidence / Seal child receipt";

// Only external transport is replaced; validation runs through production owners.
export function recoveryConsumptionFixture() {
  const direct = candidatePublicationFixture();
  const { q, p, repository, branch } = direct;
  const metadata = new Map<string, ReturnType<typeof addArtifact>>();
  const archives = new Map<string, Buffer>();
  const runs = new Map<string, ReturnType<typeof run>>();
  const jobs = new Map<string, ReturnType<typeof job>[]>();
  const logs = new Map<number, string>();
  const recoveryAuthority = { permission: "write" };
  function run(id: string, path = artifactWorkflow, sha = q, ref = branch) {
    return {
      ...direct.parent,
      id: Number(id),
      run_attempt: 1,
      head_sha: sha,
      head_branch: ref,
      path,
      repository: { full_name: repository, id: 1 },
      head_repository: { full_name: repository, id: 1 },
      status: "completed",
      conclusion: "success",
      actor: { id: 1, login: "operator", type: "User" },
      triggering_actor: { id: 1, login: "operator", type: "User" },
      html_url: "https://github.com/" + repository + "/actions/runs/" + id,
    };
  }
  function job(id: number, name: string, runId: string) {
    return {
      id,
      name,
      run_id: Number(runId),
      run_attempt: 1,
      head_sha: q,
      status: "completed",
      conclusion: "success",
      steps: [] as {
        name: string;
        number: number;
        status: string;
        conclusion: string;
        started_at: string;
        completed_at: string;
      }[],
    };
  }
  function addArtifact(id: string, name: string, runId: string, bytes: Buffer, sha = q) {
    const value = {
      id: Number(id),
      name,
      digest: "sha256:" + hash(bytes),
      size_in_bytes: bytes.length,
      expired: false,
      expires_at: expires,
      created_at: time,
      workflow_run: {
        id: Number(runId),
        head_sha: sha,
        head_branch: sha === p ? "main" : branch,
        repository_id: 1,
        head_repository_id: 1,
      },
    };
    metadata.set(id, value);
    archives.set(id, bytes);
    return value;
  }
  function archive(
    id: string,
    name: string,
    runId: string,
    files: Record<string, string | Buffer>,
    sha = q,
  ) {
    return addArtifact(id, name, runId, makeStoredZip(files), sha);
  }
  const sourceFile = (_sha: string, path = ".github/workflows/full-release-validation.yml") =>
    readFileSync(path, "utf8");
  const producer = { runId: "900", runAttempt: 1, fullRef: "refs/heads/main", sha: p };
  const source = createPublicationSourceFact(
    receiptRecoverySourceRequest(direct.admission.receipt, producer),
    { packages: [], platforms: [] },
    direct.source.projection,
  );
  const baselines = JSON.parse(
    JSON.parse(direct.admission.receipt.request.inputs.trusted_workflow_json).laneInputs
      .qualification_baselines_json,
  );
  const candidate = fullReleaseCandidateManifestFixture({
    targetSha: q,
    toolingSha: q,
    releaseProfile: "beta",
    releaseSoak: false,
    upgradeSurvivorBaseline: baselines.upgradeBaseline,
    upgradeSurvivorBaselines: baselines.upgradeSurvivorBaselines.join(" "),
  });
  candidate.package.packageSha256 = hash(direct.npmBytes);
  candidate.sharedImage.packageSha256 = candidate.package.packageSha256;
  for (const part of [
    candidate.package,
    candidate.sharedImage,
    candidate.prepublishPluginRegistry,
  ]) {
    const bytes =
      part === candidate.package
        ? makeStoredZip({
            [candidate.package.fileName]: direct.npmBytes,
            "package-candidate.json": "{}",
          })
        : Buffer.from("retained " + part.artifact.name);
    part.artifact.expiresAt = expires;
    part.artifact.digest = hash(bytes);
    addArtifact(part.artifact.id, part.artifact.name, "77", bytes);
  }
  const candidateMeta = archive(
    "104",
    "full-release-candidate-v2-" + candidate.requestSha256,
    "77",
    { "full-release-candidate.json": canonicalTestJson(candidate) },
  );
  const binding = buildFullReleaseCandidateBinding({
    manifest: candidate,
    artifact: {
      id: "104",
      name: candidateMeta.name,
      digest: candidateMeta.digest.slice(7),
      expiresAt: expires,
      runId: "77",
      runAttempt: "1",
    },
  });
  runs.set("77", run("77", ".github/workflows/full-release-validation.yml"));
  jobs.set(
    "77",
    [candidate.producer, candidate.publisher].map((entry) =>
      job(Number(entry.jobId), entry.jobName, "77"),
    ),
  );
  const children: Record<string, ReturnType<typeof child>> = {};
  function child(role: string, index: number) {
    const id = String(910 + index);
    const spec = releaseChildSpec(role);
    const dispatchId = "full-release-validation-" + direct.runId + "-1" + spec.suffix;
    const displayTitle = spec.displayName + " " + dispatchId;
    const inputs = receiptRecoveryChildInputs(
      role,
      direct.admission.receipt,
      binding,
      sourceFile(q, ".github/workflows/" + spec.workflow),
    );
    const current = {
      ...run(id, ".github/workflows/" + spec.workflow),
      display_title: displayTitle,
      actor: { id: 2, login: "github-actions[bot]", type: "Bot" },
      triggering_actor: { id: 2, login: "github-actions[bot]", type: "Bot" },
    };
    runs.set(id, current);
    const coverage = direct.admission.receipt.coverage.children.find(
      (entry) => entry.key === role,
    )!;
    const workload = coverage.requiredJobs.map((name, offset) =>
      job(10000 + index * 100 + offset, name, id),
    );
    const publisher = job(10099 + index * 100, childPublisher, id);
    publisher.steps = [
      "Checkout trusted child evidence tooling",
      "Seal exact child attempt evidence",
      "Upload sealed child evidence",
    ].map((name, step) => ({
      name,
      number: step + 1,
      status: "completed",
      conclusion: "success",
      started_at: time,
      completed_at: time,
    }));
    jobs.set(id, [...workload, publisher]);
    const composite = composeReleaseChildAttemptEvidence({
      attempts: [{ runAttempt: 1, jobs: workload }],
      expected: {
        key: role,
        repository,
        runId: id,
        plannedRunAttempt: 1,
        displayTitle,
        workflow: spec.workflow,
        workflowRef: branch,
        workflowSha: q,
      },
      run: current,
    });
    composite.compositeJobsSha256 = releaseCompositeJobsSha256(composite);
    const payload = canonicalizeJsonValue({
      schema: "openclaw.full-release-child-evidence/v1",
      repository,
      role,
      targetSha: q,
      workflowSha: q,
      workflowRef: branch,
      workflowPath: ".github/workflows/" + spec.workflow,
      displayTitle,
      dispatchId,
      sourceParentRunId: direct.runId,
      sourceParentAttempt: 1,
      workloadConclusion: "success",
      inputs,
      publisher: { jobId: String(publisher.id), jobName: childPublisher },
      ...composite,
    });
    if (!isRecord(payload)) {
      throw new Error("Expected child receipt record");
    }
    const receipt = { ...payload, sha256: hash(JSON.stringify(payload)) };
    const meta = archive(
      id,
      "full-release-child-evidence-" + q + "-" + role + "-" + id + "-1",
      id,
      { "full-release-child-evidence.json": JSON.stringify(receipt) },
    );
    return {
      repository,
      role,
      targetSha: q,
      workflowSha: q,
      workflowRef: branch,
      runId: id,
      runAttempt: 1,
      sourceParentRunId: direct.runId,
      sourceParentAttempt: 1,
      displayTitle,
      url: current.html_url,
      inputs,
      receiptSha256: receipt.sha256,
      artifact: {
        id,
        name: meta.name,
        digest: meta.digest,
        expiresAt: expires,
        sizeInBytes: meta.size_in_bytes,
      },
    };
  }
  direct.admission.receipt.coverage.children.forEach((entry, index) => {
    children[entry.key] = child(entry.key, index);
  });
  runs.set(direct.runId, run(direct.runId, ".github/workflows/full-release-validation.yml"));
  const parentJobs = direct.admission.receipt.coverage.requiredParentJobs.map((name, index) =>
    job(20000 + index, name, direct.runId),
  );
  for (const coverage of direct.admission.receipt.coverage.children) {
    const dispatch = job(21000 + parentJobs.length, coverage.parentJobName, direct.runId);
    parentJobs.push(dispatch);
    logs.set(
      dispatch.id,
      "TARGET_SHA: " +
        q +
        "\nCI_RELEASE_SCOPE: npm-beta\nhttps://github.com/" +
        repository +
        "/actions/runs/" +
        children[coverage.key]!.runId +
        " (attempt 1)",
    );
  }
  jobs.set(direct.runId, parentJobs);
  const npmRun = {
    ...run("81"),
    display_title:
      "Full Release Artifacts full-release-validation-" + direct.runId + "-1-artifacts-npm",
  };
  runs.set("81", npmRun);
  const npmProducer = {
    repository,
    workflowRef: repository + "/" + artifactWorkflow + "@refs/heads/" + branch,
    workflowSha: q,
    runId: "81",
    runAttempt: "1",
    jobId: "801",
    jobName: "Prepare npm artifacts / Prepare publishable npm package",
    producerWorkflowPath: ".github/workflows/openclaw-npm-preflight.yml",
  };
  const raw = {
    schema: "openclaw.prepared-npm-bundle/v1",
    source: { sha: q },
    producer: npmProducer,
    artifact: {
      id: "401",
      name: "openclaw-npm-package-81-1",
      digest: "a".repeat(64),
      runId: "81",
      runAttempt: "1",
    },
    package: {
      name: "openclaw",
      version: "2026.8.28-beta.1",
      fileName: binding.package.fileName,
      sha256: binding.package.packageSha256,
      sourceSha: q,
    },
    corePackages: [],
    manifestSha256: "a".repeat(64),
  };
  const packageManifest = JSON.stringify({
    schema: "openclaw.npm-package-bundle/v1",
    packageName: raw.package.name,
    packageVersion: raw.package.version,
    releaseSha: q,
    tarballName: raw.package.fileName,
    tarballSha256: raw.package.sha256,
    producer: raw.producer,
    corePackageTarballs: [],
    dependencyTarballs: [],
  });
  raw.manifestSha256 = hash(packageManifest);
  const qualified = {
    schema: "openclaw.qualified-npm-preflight/v1",
    source: raw.source,
    producer: {
      ...npmProducer,
      jobId: "802",
      jobName: "Prepare npm artifacts / Qualify prepared npm package",
    },
    artifact: { ...raw.artifact, id: "402", name: "openclaw-npm-preflight-" + q },
    preparedBundle: raw,
    manifestSha256: hash(direct.npmManifestBytes),
  };
  raw.artifact.digest = archive("401", raw.artifact.name, "81", {
    "package-bundle.json": packageManifest,
    [raw.package.fileName]: direct.npmBytes,
  }).digest.slice(7);
  qualified.artifact.digest = archive("402", qualified.artifact.name, "81", {
    "preflight-manifest.json": direct.npmManifestBytes,
    [raw.package.fileName]: direct.npmBytes,
  }).digest.slice(7);
  archive("403", "plugin-sdk-api-release-diff-81-1", "81", {
    "plugin-sdk-api-release-evidence.json": "{}",
  });
  jobs.set("81", [job(801, npmProducer.jobName, "81"), job(802, qualified.producer.jobName, "81")]);
  const docker = structuredClone(direct.docker);
  Object.assign(docker.producer, {
    runId: "91",
    jobId: "803",
    workflowRef: npmProducer.workflowRef,
  });
  const dockerRun = {
    ...run("91"),
    display_title:
      "Full Release Artifacts full-release-validation-" + direct.runId + "-1-artifacts-docker",
  };
  runs.set("91", dockerRun);
  jobs.set("91", [job(803, docker.producer.jobName, "91")]);
  docker.architectures.forEach((entry, index) => {
    entry.artifact.digest = addArtifact(
      entry.artifact.id,
      entry.artifact.name,
      "91",
      Buffer.from("image " + index),
    ).digest;
  });
  const dockerBytes = JSON.stringify(docker);
  archive("404", docker.artifactName, "91", { "manifest.json": dockerBytes });
  const dockerDescriptor = {
    preparedRunId: "91",
    preparedRunAttempt: "1",
    preparedArtifactName: docker.artifactName,
    preparedManifestSha256: hash(dockerBytes),
  };
  const artifactReceipt = (stage: string, id: string, outputs: Record<string, string>) => ({
    schema: "openclaw.full-release-artifact-receipt/v1",
    stage,
    dispatchId: "full-release-validation-" + direct.runId + "-1-artifacts-" + stage,
    repository,
    sourceSha: q,
    toolingSha: q,
    workflowRef: branch,
    releaseTag: "v2026.8.28-beta.1",
    preflightPhase: "all",
    runId: id,
    runAttempt: "1",
    outputs,
  });
  archive("405", "full-release-artifact-receipt-81-1", "81", {
    "artifact-receipt.json": JSON.stringify(
      artifactReceipt("npm", "81", {
        prepared_bundle_json: JSON.stringify(raw),
        qualified_preflight_bundle_json: JSON.stringify(qualified),
      }),
    ),
  });
  archive("406", "full-release-artifact-receipt-91-1", "91", {
    "artifact-receipt.json": JSON.stringify(
      artifactReceipt("docker", "91", {
        prepared_run_id: "91",
        prepared_run_attempt: "1",
        prepared_artifact_name: docker.artifactName,
        prepared_manifest_sha256: hash(dockerBytes),
      }),
    ),
  });
  const pluginRun = run("92", ".github/workflows/plugin-npm-release.yml");
  runs.set("92", pluginRun);
  const pluginProducer = {
    repository,
    runId: 92,
    runAttempt: 1,
    workflowPath: pluginRun.path,
    workflowEvent: "workflow_dispatch",
    workflowHeadBranch: branch,
    workflowSha: q,
  };
  const pluginPackage = archive(
    "408",
    "plugin-npm-package-codex-2026.8.28-beta.1-npm-oidc-92-1",
    "92",
    { "plugin.tgz": "retained plugin" },
  );
  const pluginManifest = {
    schema: "openclaw.plugin-npm-prepared/v1",
    runtimeQualification: "packed-runtime-v1",
    sourceSha: q,
    npmDistTag: "default",
    selectionMode: "all-publishable",
    publisherPolicySha256: hash(sourceFile(q, pluginRun.path)),
    producer: pluginProducer,
    packages: [
      {
        extensionId: "codex",
        packageDir: "extensions/codex",
        packageName: "@openclaw/codex",
        version: "2026.8.28-beta.1",
        channel: "beta",
        publishTag: "beta",
        installNpmSpec: "@openclaw/codex@2026.8.28-beta.1",
        route: "npm-oidc",
        artifact: {
          ...pluginProducer,
          artifactId: 408,
          artifactName: pluginPackage.name,
          artifactDigest: pluginPackage.digest,
          artifactSizeBytes: pluginPackage.size_in_bytes,
        },
      },
    ],
  };
  const pluginMeta = archive("407", "plugin-npm-prepared-" + q + "-92-1", "92", {
    "plugin-npm-prepared.json": JSON.stringify(pluginManifest),
  });
  const plugin = {
    ...pluginProducer,
    artifactId: 407,
    artifactName: pluginMeta.name,
    artifactDigest: pluginMeta.digest,
    artifactSizeBytes: pluginMeta.size_in_bytes,
  };
  const recovery = {
    schema: RECEIPT_RECOVERY_SCHEMA,
    requestId: "12345678-1234-4123-8123-123456789abc",
    repository,
    qualificationAdmission: direct.admission.descriptor,
    originalParent: { runId: direct.runId, runAttempt: 1 },
    candidateBinding: binding,
    children,
    publicationArtifacts: { npmPreflight: qualified, docker: dockerDescriptor, pluginNpm: plugin },
  };
  const observations = {
    ...direct.manifest.publicationAdmission!.observations,
    sourceDigest: source.digest,
  };
  const observationArtifact = archive(
    "444",
    "full-release-publication-observations-900-1",
    "900",
    { "publication-observations.json": JSON.stringify(observations) },
    p,
  );
  const publicationAdmission = createPublicationAdmission(
    source,
    observations,
    {
      id: "444",
      name: observationArtifact.name,
      digest: observationArtifact.digest,
      sizeInBytes: observationArtifact.size_in_bytes,
    },
    time,
    { workflowPath: RECEIPT_RECOVERY_WORKFLOW },
  );
  const {
    executionPlanSha256: _plan,
    qualificationCoverage: _coverage,
    ...original
  } = direct.manifest;
  const manifest = {
    ...original,
    runId: "900",
    runAttempt: 1,
    sourceParentRunAttempt: 1,
    workflowSha: p,
    workflowRef: "main",
    workflowFullRef: "refs/heads/main",
    sourceAdmission: source,
    publicationAdmission,
    trustedWorkflow: { ref: "main", fullRef: producer.fullRef, sha: p },
    receiptRecovery: recovery,
    childRuns: Object.fromEntries(
      Object.entries(children).map(([key, value]) => [key, value.runId]),
    ),
    publicationArtifacts: recovery.publicationArtifacts,
    retainedPublicationPayloads: [] as unknown[],
    waivers: [],
    advisoryJobs: [],
  };
  const recoveryRun = {
    ...run("900", RECEIPT_RECOVERY_WORKFLOW, p, "main"),
    name: "Full Release Receipt Recovery",
  };
  runs.set("900", recoveryRun);
  const sealer = job(9000, "Recover original qualification receipts", "900");
  sealer.head_sha = p;
  sealer.steps = [
    "Authenticate retained qualification and collect fresh admission",
    "Upload fresh publication observations",
    "Seal receipt-backed aggregate",
    "Upload receipt-backed aggregate",
  ].map((name, index) => ({
    name,
    number: index + 1,
    status: "completed",
    conclusion: "success",
    started_at: time,
    completed_at: time,
  }));
  jobs.set("900", [sealer]);
  const aggregateArtifact = {
    ...observationArtifact,
    id: 445,
    name: "full-release-validation-900-1",
    workflow_run: { ...observationArtifact.workflow_run, head_branch: "main" },
  };
  const required = <T>(value: T | undefined, label: string): T => {
    if (!value) {
      throw new Error("Unexpected fixture read: " + label);
    }
    return value;
  };
  const github = (path: string): unknown => {
    const artifactMatch = /^actions\/artifacts\/(\d+)$/.exec(path);
    if (artifactMatch) {
      return required(metadata.get(artifactMatch[1]!), path);
    }
    const jobMatch = /^actions\/jobs\/(\d+)$/.exec(path);
    if (jobMatch) {
      return required(
        [...jobs.values()].flat().find((entry) => String(entry.id) === jobMatch[1]),
        path,
      );
    }
    const runMatch = /^actions\/runs\/(\d+)(?:\/attempts\/\d+)?(?:\/(jobs|artifacts)\?.*)?$/.exec(
      path,
    );
    if (runMatch) {
      if (runMatch[2] === "jobs") {
        const entries = required(jobs.get(runMatch[1]!), path);
        return { total_count: entries.length, jobs: entries };
      }
      if (runMatch[2] === "artifacts") {
        const name = new URL("https://fixture/" + path).searchParams.get("name");
        const artifacts = [...metadata.values()].filter(
          (entry) =>
            entry.workflow_run.id === Number(runMatch[1]) && (!name || entry.name === name),
        );
        return { total_count: artifacts.length, artifacts };
      }
      return required(runs.get(runMatch[1]!), path);
    }
    if (path.startsWith("compare/")) {
      return { status: "identical", merge_base_commit: { sha: p } };
    }
    if (path === "collaborators/operator/permission") {
      return { permission: recoveryAuthority.permission, user: { id: 1, login: "operator" } };
    }
    throw new Error("Unexpected fixture API: " + path);
  };
  const runGh = (args: string[]) =>
    JSON.stringify(github(args[1]!.replace("repos/" + repository + "/", "")));
  vi.spyOn(transport, "runReleaseToolingGh").mockImplementation(runGh);
  vi.stubEnv("GH_TOKEN", "synthetic-fixture-token");
  vi.stubGlobal("fetch", async (input: string | URL | Request) => {
    const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
    const match = /\/actions\/artifacts\/(\d+)(\/zip)?$/.exec(path);
    if (!match) {
      throw new Error("Unexpected fixture fetch: " + path);
    }
    return match[2]
      ? new Response(new Uint8Array(required(archives.get(match[1]!), path)))
      : Response.json(required(metadata.get(match[1]!), path));
  });
  const download = async (input: Record<string, unknown>) => {
    if (!isRecord(input.expected)) {
      throw new Error("Expected artifact request");
    }
    const id = String(input.expected.artifactId);
    return {
      archiveBytes: required(archives.get(id), "archive"),
      artifactMetadata: required(metadata.get(id), "metadata"),
    };
  };
  const client = {
    ...direct.client,
    getWorkflowSource: sourceFile,
    getRun: async (id: string) => required(runs.get(id), id),
    getRunAttempt: async (id: string, attempt: number | string) => {
      if (Number(attempt) !== 1) {
        throw new Error("Unexpected attempt");
      }
      return required(runs.get(id), id);
    },
    getRunAttemptJobs: async (id: string) => required(jobs.get(id), id),
    getJobLog: async (id: number) => required(logs.get(id), String(id)),
    getArtifact: async (id: string | number) => required(metadata.get(String(id)), String(id)),
    getRunArtifacts: (id: string) =>
      [...metadata.values()].filter((entry) => entry.workflow_run.id === Number(id)),
    downloadArtifactArchive: download,
    validateChildReuse: (
      selection: Parameters<typeof validateReusableReleaseChild>[0],
      request: Parameters<typeof validateReusableReleaseChild>[1],
      options: { deadlineMs?: number } = {},
    ) =>
      validateReusableReleaseChild(selection, request, {
        ...options,
        github: async (path: string) => github(path),
        getJobLog: async (id: number) => required(logs.get(id), String(id)),
        downloadArchive: download,
      }),
    verifyRetainedPublicationArtifacts,
    verifyReceiptRecoveryAuthority: (value: Parameters<typeof verifyReceiptRecoveryAuthority>[1]) =>
      verifyReceiptRecoveryAuthority(repository, value, true, runGh),
    compareCommitLineage: () => ({ status: "identical", merge_base_commit: { sha: p } }),
    loadManifest: () => ({ artifact: aggregateArtifact, manifest }),
  };
  return {
    direct,
    manifest,
    recovery,
    run: recoveryRun,
    client,
    aggregateArtifact,
    metadata,
    archives,
    jobs,
    runs,
    source,
    producer,
    recoveryAuthority,
    runGh,
  };
}

export function consumptionOptions(f: ReturnType<typeof candidatePublicationFixture>) {
  return {
    run: f.parent,
    manifest: f.manifest,
    expectedRepository: f.repository,
    expectedRunId: f.runId,
    expectedRunAttempt: 1,
    expectedTargetSha: f.q,
    expectedReleaseTag: "v2026.8.28-beta.1",
    expectedTrustedWorkflowFullRef: f.publisherFullRef,
    expectedTrustedWorkflowSha: f.p,
    expectedCoreNpmPublication: { npmDistTag: "beta" },
    verifierSourceSha: f.p,
    verifierSourceContent: readFileSync("scripts/release-ci-summary.mjs"),
  };
}
