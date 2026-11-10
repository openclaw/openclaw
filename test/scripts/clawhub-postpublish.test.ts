import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { crc32 } from "node:zlib";
import * as tar from "tar";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createClawHubParentAuthorization,
  readPackedClawHubTransaction,
} from "../../scripts/clawhub-parent-authorization.mjs";
import {
  recoverClawHubFromParent,
  verifyClawHubPostpublish,
} from "../../scripts/clawhub-postpublish.mjs";
import {
  checkOriginalPackedClawHubAbsent,
  createOriginalPackedClawHubDescriptor,
  createPreparedClawHubManifest,
  downloadPreparedClawHubRelease,
  resolvePreparedClawHubMatrix,
  restorePreparedClawHubPackage,
} from "../../scripts/clawhub-prepared-artifact.mjs";
import {
  createPublicationAdmission,
  createPublicationSourceFact,
} from "../../scripts/full-release-publication-contract.mjs";
import { releaseExecutionPlanSha256 } from "../../scripts/full-release-validation-policy.mjs";
import { waitForClawHubPublicVersion } from "../../scripts/lib/clawhub-publication-state.mjs";
import { createReleaseEvidenceClient } from "../../scripts/release-ci-summary.mjs";
import { verifyPublishedClawHubPackage } from "../../scripts/verify-clawhub-published-artifact.mjs";
import { candidatePublicationFixture } from "./candidate-publication.test-support.js";

function requestUrl(input: Parameters<typeof fetch>[0]) {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

vi.mock("node:timers/promises", () => ({ setTimeout: vi.fn(async () => {}) }));

const directories: string[] = [];
afterEach(() => vi.clearAllMocks());
afterEach(() =>
  directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })),
);
const sha = "a".repeat(40);
const ref = `release-publish/${sha.slice(0, 12)}-1`;
const repository = "openclaw/openclaw";
const parentWorkflow = ".github/workflows/openclaw-release-publish.yml";
const childWorkflow = ".github/workflows/plugin-clawhub-release.yml";
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const jobsPath = (run: number, attempt: number, page = 1) =>
  `actions/runs/${run}/attempts/${attempt}/jobs?per_page=100&page=${page}`;
const artifactsPath = (run: number) => `actions/runs/${run}/artifacts?per_page=100&page=1`;
const completed = { status: "completed", conclusion: "success" };
function job(name: string, run_id = 20, run_attempt = 1, steps: string[] = []) {
  return {
    name,
    run_id,
    run_attempt,
    head_sha: sha,
    ...completed,
    ...(steps.length ? { steps: steps.map((stepName) => ({ name: stepName, ...completed })) } : {}),
  };
}
function jobPage(jobs: unknown[]) {
  return { total_count: jobs.length, jobs };
}
function replaceJsonArtifact(
  f: ReturnType<typeof fixture>,
  artifact: typeof f.dispatchArtifact,
  fileName: string,
  value: unknown,
) {
  const archive = zip(fileName, Buffer.from(JSON.stringify(value)));
  f.archives.set(artifact.id, archive);
  Object.assign(artifact, { size_in_bytes: archive.length, digest: `sha256:${digest(archive)}` });
}
async function rejectsBeforeRegistry(
  f: ReturnType<typeof fixture>,
  error: RegExp | string,
  evidence = false,
) {
  await expect(verifyClawHubPostpublish(f.options)).rejects.toThrow(error);
  expect(f.registryReads).toEqual([]);
  if (evidence) {
    expect(existsSync(join(f.options.outputDir, "evidence.json"))).toBe(false);
  }
}
function sealParent(f: ReturnType<typeof fixture>, conclusion = "success") {
  replaceJsonArtifact(
    f,
    f.receiptArtifact,
    "authorization.json",
    createClawHubParentAuthorization(f.transactions, "automated-sealed"),
  );
  f.setJobs(10, 1, [
    {
      ...job("Publish plugins, then OpenClaw", 10, 1, [
        "Upload exact release child dispatch record",
        "Upload immutable ClawHub parent authorization",
      ]),
      head_sha: f.parent.head_sha,
      conclusion,
    },
  ]);
}

function zip(name: string, bytes: Buffer) {
  const fileName = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(crc32(bytes), 14);
  local.writeUInt32LE(bytes.length, 18);
  local.writeUInt32LE(bytes.length, 22);
  local.writeUInt16LE(fileName.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(crc32(bytes), 16);
  central.writeUInt32LE(bytes.length, 20);
  central.writeUInt32LE(bytes.length, 24);
  central.writeUInt16LE(fileName.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + fileName.length, 12);
  end.writeUInt32LE(local.length + fileName.length + bytes.length, 16);
  return Buffer.concat([local, fileName, bytes, central, fileName, end]);
}

function fixture(
  parentOnMain = false,
  verifierSha = sha,
  packageId = "example",
  parentRunAttempt = 1,
  { version = "2026.8.2", candidateSha = "b".repeat(40), toolingSha = sha, toolingRef = ref } = {},
) {
  const parentRef = parentOnMain ? "main" : toolingRef;
  const parentFullRef = parentOnMain ? "refs/heads/main" : `refs/tags/${toolingRef}`;
  const directory = mkdtempSync(join(tmpdir(), "clawhub-postpublish-"));
  directories.push(directory);
  const packageDir = join(directory, "package");
  const artifactDir = join(directory, "artifact");
  mkdirSync(packageDir);
  mkdirSync(artifactDir);
  writeFileSync(
    join(packageDir, "package.json"),
    JSON.stringify({ name: `@openclaw/${packageId}`, version }),
  );
  writeFileSync(join(packageDir, "openclaw.plugin.json"), JSON.stringify({ id: packageId }));
  const tarballPath = join(artifactDir, `${packageId}.tgz`);
  tar.create(
    {
      sync: true,
      cwd: directory,
      file: tarballPath,
      gzip: true,
      portable: true,
      mtime: new Date("1985-10-26T08:15:00.000Z"),
      noPax: true,
    },
    ["package/package.json", "package/openclaw.plugin.json"],
  );
  const tarball = readFileSync(tarballPath);
  const entry = readPackedClawHubTransaction({
    artifactDir,
    packageName: `@openclaw/${packageId}`,
    version,
    artifactName: `package-${packageId}`,
  });
  const identity = {
    version: 2,
    repository,
    workflow: childWorkflow,
    runId: "20",
    runAttempt: "1",
    ref: toolingRef,
    fullRef: `refs/tags/${toolingRef}`,
    sha: toolingSha,
    candidateRepository: repository,
    candidateSha,
    toolingRef: parentRef,
    toolingFullRef: parentFullRef,
    toolingSha,
    parentRepository: repository,
    parentWorkflow,
    parentRunId: "10",
    parentRunAttempt: String(parentRunAttempt),
  };
  const transactions = { schemaVersion: 1, identity, packages: [entry] };
  const receipt = createClawHubParentAuthorization(transactions, "automated-awaited");
  const run = (id: number, path: string) => ({
    id,
    run_attempt: id === 10 ? parentRunAttempt : 1,
    path: `${path}@${id === 10 ? parentFullRef : `refs/tags/${toolingRef}`}`,
    head_sha: toolingSha,
    head_branch: id === 10 ? parentRef : toolingRef,
    event: "workflow_dispatch",
    status: "completed",
    conclusion: "success",
    repository: { full_name: repository },
    head_repository: { full_name: repository },
  });
  const parent = run(10, parentWorkflow);
  const child = run(20, childWorkflow);
  const archives = new Map<number, Buffer>();
  const artifact = (id: number, name: string, runId: number, fileName: string, bytes: Buffer) => {
    const archive = zip(fileName, bytes);
    archives.set(id, archive);
    return {
      id,
      name,
      size_in_bytes: archive.length,
      digest: `sha256:${digest(archive)}`,
      expired: false,
      expires_at: "2099-01-01T00:00:00Z",
      workflow_run: { id: runId, head_sha: toolingSha },
    };
  };
  const receiptArtifact = artifact(
    1,
    `openclaw-clawhub-parent-authorization-v2-10-${parentRunAttempt}-20-1`,
    10,
    "authorization.json",
    Buffer.from(JSON.stringify(receipt)),
  );
  const transactionsArtifact = artifact(
    2,
    "openclaw-clawhub-transactions-20-1",
    20,
    "transactions.json",
    Buffer.from(JSON.stringify(transactions)),
  );
  const packageArtifact = artifact(3, `package-${packageId}`, 20, `${packageId}.tgz`, tarball);
  const recoveryManifest = {
    schemaVersion: 1,
    kind: "openclaw-clawhub-recovery-manifest",
    identity,
    packages: [{ ...entry, publicationStatus: "pending", attemptId: "attempt-1" }],
  };
  const recoveryArtifact = artifact(
    6,
    "openclaw-clawhub-recovery-manifest-20-1",
    20,
    "recovery-manifest.json",
    Buffer.from(JSON.stringify(recoveryManifest)),
  );
  const dispatch = {
    schemaVersion: 1,
    repository,
    parentRunId: "10",
    parentRunAttempt: String(parentRunAttempt),
    parentWorkflow,
    toolingRef: parentRef,
    toolingFullRef: parentFullRef,
    toolingSha,
    candidateSha: identity.candidateSha,
    normalClawHubRunId: "20",
    normalClawHubRunAttempt: "1",
  };
  const dispatchArtifact = artifact(
    4,
    `openclaw-release-children-10-${parentRunAttempt}`,
    10,
    "dispatch.json",
    Buffer.from(JSON.stringify(dispatch)),
  );
  const metadata = new Map<string, unknown>([
    [`actions/runs/10/attempts/${parentRunAttempt}`, parent],
    ["actions/runs/20/attempts/1", child],
    ["actions/runs/20", child],
    [artifactsPath(10), { total_count: 2, artifacts: [receiptArtifact, dispatchArtifact] }],
    [
      artifactsPath(20),
      { total_count: 3, artifacts: [transactionsArtifact, packageArtifact, recoveryArtifact] },
    ],
    [
      "actions/runs/20/artifacts?name=openclaw-clawhub-transactions-20-1&per_page=100",
      { total_count: 1, artifacts: [transactionsArtifact] },
    ],
    [
      jobsPath(20, 1),
      jobPage(
        [
          job("Seal exact ClawHub recovery manifest", 20, 1, ["Upload sealed recovery manifest"]),
          job("Seal ClawHub package transactions"),
          job(`Pack ClawHub package (${entry.name})`, 20, 1, ["Upload ClawHub package artifact"]),
        ].map((producerJob) => Object.assign({}, producerJob, { head_sha: toolingSha })),
      ),
    ],
    [
      `git/ref/tags/${toolingRef}`,
      { ref: `refs/tags/${toolingRef}`, object: { type: "commit", sha: toolingSha } },
    ],
    [`git/matching-refs/heads/${toolingRef}`, []],
    [`compare/${toolingSha}...main`, { status: "identical" }],
    [`compare/${toolingSha}...${verifierSha}`, { status: "identical" }],
    [`compare/${toolingSha}...${verifierSha}?per_page=1&page=2`, { status: "identical" }],
    ...[
      receiptArtifact,
      transactionsArtifact,
      packageArtifact,
      dispatchArtifact,
      recoveryArtifact,
    ].map((item): [string, unknown] => [`actions/artifacts/${item.id}`, item]),
  ]);
  const setJobs = (id: number, attempt: number, jobs: unknown[], total = jobs.length, page = 1) =>
    metadata.set(jobsPath(id, attempt, page), { total_count: total, jobs });
  const setArtifacts = (id: number, artifacts: unknown[], total = artifacts.length) =>
    metadata.set(artifactsPath(id), { total_count: total, artifacts });
  const githubReads: string[] = [];
  const registryReads: string[] = [];
  const requests: string[] = [];
  const responses = new Map<string, () => Response | undefined>();
  const archiveIdentity = {
    sha256: digest(tarball),
    size: tarball.length,
    npmIntegrity: `sha512-${createHash("sha512").update(tarball).digest("base64")}`,
    npmShasum: createHash("sha1").update(tarball).digest("hex"),
  };
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(requestUrl(input));
    expect(init?.method ?? "GET").toBe("GET");
    requests.push(url.pathname);
    if (url.hostname !== "api.github.com") {
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
    }
    const override = [...responses].find(([suffix]) => url.pathname.endsWith(suffix))?.[1]();
    if (override) {
      return override;
    }
    if (url.hostname === "api.github.com") {
      const path = `${url.pathname.replace(`/repos/${repository}/`, "")}${url.search}`;
      githubReads.push(path);
      const download = /^actions\/artifacts\/(\d+)\/zip$/u.exec(path);
      if (download) {
        return new Response(new Uint8Array(archives.get(Number(download[1]))!));
      }
      if (!metadata.has(path)) {
        throw new Error(`Unexpected GitHub request: ${path}`);
      }
      const value = metadata.get(path);
      return value instanceof Response ? value : Response.json(value);
    }
    registryReads.push(url.pathname);
    if (url.pathname.endsWith("/publication")) {
      return Response.json({ name: entry.name, version: entry.version, state: "published" });
    }
    if (url.pathname.endsWith("/trusted-publisher")) {
      return Response.json({
        trustedPublisher: {
          provider: "github-actions",
          repository,
          workflowFilename: "plugin-clawhub-release.yml",
        },
      });
    }
    if (url.pathname.endsWith("/artifact/download")) {
      return new Response(new Uint8Array(tarball), {
        headers: {
          "x-clawhub-artifact-sha256": archiveIdentity.sha256,
          "x-clawhub-npm-integrity": archiveIdentity.npmIntegrity,
          "x-clawhub-npm-shasum": archiveIdentity.npmShasum,
        },
      });
    }
    if (url.pathname.endsWith("/artifact")) {
      return Response.json({
        package: { name: entry.name },
        version: entry.version,
        artifact: { kind: "npm-pack", ...archiveIdentity },
      });
    }
    const publishTag = entry.version.includes("-beta.") ? "beta" : "latest";
    return Response.json({ package: { tags: { [publishTag]: entry.version } } });
  };
  const options = {
    event: { workflow_run: parent },
    verifierSha,
    token: "fixture-token",
    outputDir: join(directory, "result"),
    fetchImpl,
    runGh: (args: string[]) => {
      const apiPath = args[1];
      if (apiPath === undefined) {
        throw new Error("Missing GitHub API path.");
      }
      const key = apiPath.replace(`repos/${repository}/`, "");
      if (!metadata.has(key)) {
        throw new Error(`Unexpected gh request: ${key}`);
      }
      return JSON.stringify(metadata.get(key));
    },
  };
  return {
    setJobs,
    setArtifacts,
    directory,
    tarball,
    packageArtifact,
    options,
    parent,
    child,
    metadata,
    archives,
    githubReads,
    registryReads,
    requests,
    respond: (suffix: string, response: () => Response | undefined) =>
      responses.set(suffix, response),
    transactions,
    entry,
    receiptArtifact,
    transactionsArtifact,
    recoveryArtifact,
    dispatch,
    dispatchArtifact,
    receipt,
  };
}

function parentRecoveryFixture(f = fixture()) {
  const parentSha = f.parent.head_sha;
  const parentRef = f.parent.head_branch;
  sealParent(f);
  f.child.conclusion = "failure";
  const current = { ...f.parent, id: 30, status: "in_progress", conclusion: null };
  const inputs: Record<string, string> = {
    original_child_run_id: "20",
    original_child_run_attempt: "1",
    reason: "Resume original attempts",
    plugins: "",
    release_publish_run_id: "30",
    release_publish_run_attempt: "1",
    full_release_validation_run_id: "40",
    full_release_validation_run_attempt: "1",
  };
  const request = { ref: parentRef, inputs: { ...inputs } };
  const addArtifact = (id: number, name: string, fileName: string, value: unknown) => {
    const archive = zip(fileName, Buffer.from(JSON.stringify(value)));
    f.archives.set(id, archive);
    const artifact = {
      ...f.dispatchArtifact,
      id,
      name,
      size_in_bytes: archive.length,
      digest: `sha256:${digest(archive)}`,
      workflow_run: { id: 30, head_sha: parentSha, repository_id: 1, head_repository_id: 1 },
    };
    f.metadata.set(`actions/artifacts/${id}`, artifact);
    return artifact;
  };
  const approvalArtifact = addArtifact(7, "openclaw-release-approval-v1-30-1", "approval.json", {
    version: 1,
    kind: "openclaw-release-approval",
    repository,
    parentWorkflow,
    parentRunId: "30",
    parentRunAttempt: "1",
    toolingRef: parentRef,
    toolingFullRef: `refs/tags/${parentRef}`,
    toolingSha: parentSha,
    releaseTag: `v${f.entry.version}`,
    targetSha: f.transactions.identity.candidateSha,
    npmDistTag: f.entry.version.includes("-beta.") ? "beta" : "latest",
    environment: "npm-release",
    approvalJob: "Publish plugins, then OpenClaw",
    approver: "release-maintainer",
  });
  const requestArtifact = addArtifact(
    8,
    "openclaw-clawhub-recovery-request-30-1",
    "dispatch.json",
    request,
  );
  f.setArtifacts(30, [approvalArtifact, requestArtifact]);
  f.metadata.set("actions/runs/30", current);
  f.metadata.set("actions/runs/30/attempts/1", current);
  const producer = {
    ...job("Publish plugins, then OpenClaw", 30, 1, [
      "Write release approval receipt",
      "Upload ClawHub recovery request",
    ]),
    head_sha: parentSha,
    status: "in_progress",
    conclusion: null,
  };
  f.setJobs(30, 1, [producer]);
  f.metadata.set("actions/runs/30/attempts/1/jobs?per_page=100", jobPage([producer]));
  f.metadata.set("actions/runs/30/approvals", [
    {
      state: "approved",
      environments: [{ name: "npm-release" }],
      user: { login: "release-maintainer" },
    },
  ]);
  f.metadata.set("actions/runs/30/artifacts?name=openclaw-release-approval-v1-30-1&per_page=100", {
    total_count: 1,
    artifacts: [approvalArtifact],
  });
  const options = {
    event: { inputs },
    env: {
      GITHUB_REPOSITORY: repository,
      GITHUB_EVENT_NAME: "workflow_dispatch",
      GITHUB_WORKFLOW_REF: `${repository}/.github/workflows/plugin-clawhub-recovery.yml@refs/tags/${parentRef}`,
      GITHUB_WORKFLOW_SHA: parentSha,
      GITHUB_REF: `refs/tags/${parentRef}`,
      GITHUB_REF_NAME: parentRef,
      GH_TOKEN: "fixture-token",
      CLAWHUB_TOKEN: "publisher-token",
      RUNNER_TEMP: f.directory,
    },
    runGh: f.options.runGh,
    fetchImpl: async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (
        requestUrl(input).startsWith("https://clawhub.ai/") &&
        requestUrl(input).endsWith("/publication")
      ) {
        expect(init?.method ?? "GET").toBe("GET");
        return Response.json({ name: f.entry.name, version: f.entry.version, state: "published" });
      }
      return f.options.fetchImpl(input, init);
    },
  };
  return { ...f, original: f, options, current, producer, request, requestArtifact };
}

function addSealedSibling(f: ReturnType<typeof fixture>) {
  const sibling = fixture(false, f.parent.head_sha, "sibling", 1, {
    version: f.entry.version,
    candidateSha: f.transactions.identity.candidateSha,
    toolingSha: f.parent.head_sha,
    toolingRef: f.parent.head_branch,
  });
  f.transactions.packages.push(sibling.entry);
  replaceJsonArtifact(f, f.transactionsArtifact, "transactions.json", f.transactions);
  sealParent(f);
  const manifest = {
    schemaVersion: 1,
    kind: "openclaw-clawhub-recovery-manifest",
    identity: f.transactions.identity,
    packages: f.transactions.packages.map((entry, index) => ({
      ...entry,
      publicationStatus: "failed",
      attemptId: `attempt-${index + 1}`,
    })),
  };
  replaceJsonArtifact(f, f.recoveryArtifact, "recovery-manifest.json", manifest);
  return { manifest, artifact: f.recoveryArtifact, sibling };
}

function authenticatedParentRecoveryFixture(mode: "full" | "selected" | "omitted sibling") {
  const qualification = candidatePublicationFixture();
  const version = qualification.source.projection!.version;
  const f = parentRecoveryFixture(
    fixture(false, qualification.p, "example", 1, {
      version,
      candidateSha: qualification.q,
      toolingSha: qualification.p,
      toolingRef: qualification.publisherFullRef.slice("refs/tags/".length),
    }),
  );
  if (mode !== "omitted sibling") {
    const { sibling } = addSealedSibling(f.original);
    const artifact = { ...sibling.packageArtifact, id: 9 };
    f.archives.set(artifact.id, sibling.archives.get(sibling.packageArtifact.id)!);
    f.metadata.set(`actions/artifacts/${artifact.id}`, artifact);
    f.setArtifacts(20, [f.transactionsArtifact, f.packageArtifact, f.recoveryArtifact, artifact]);
    f.setJobs(
      20,
      1,
      [
        job("Seal exact ClawHub recovery manifest", 20, 1, ["Upload sealed recovery manifest"]),
        job("Seal ClawHub package transactions"),
        ...f.transactions.packages.map((entry) =>
          job(`Pack ClawHub package (${entry.name})`, 20, 1, ["Upload ClawHub package artifact"]),
        ),
      ].map((producerJob) => Object.assign({}, producerJob, { head_sha: qualification.p })),
    );
    const fetchImpl = f.options.fetchImpl;
    f.options.fetchImpl = async (input, init) => {
      if (requestUrl(input).includes(encodeURIComponent(sibling.entry.name))) {
        f.registryReads.push(new URL(requestUrl(input)).pathname);
        return sibling.options.fetchImpl(input, init);
      }
      return fetchImpl(input, init);
    };
  }
  f.options.event.inputs.full_release_validation_run_id = qualification.runId;
  f.options.event.inputs.plugins = mode === "selected" ? f.entry.name : "";
  Object.assign(f.request.inputs, f.options.event.inputs);
  replaceJsonArtifact(f.original, f.requestArtifact, "dispatch.json", f.request);

  // Seal the same two-package admission in the real FRV source, observations,
  // and execution plan. The omission case changes only the original child roster.
  const packages = [f.entry.name, "@openclaw/sibling"].map((name) => ({
    name,
    version,
    targets: ["clawhub"],
  }));
  const { digest: _sourceDigest, ...sourceRequest } = qualification.source;
  Object.assign(
    qualification.source,
    createPublicationSourceFact(
      sourceRequest,
      { packages: [], platforms: [] },
      {
        ...qualification.source.projection!,
        packages: [...packages, ...qualification.source.projection!.packages],
      },
    ),
  );
  const originalAdmission = qualification.manifest.publicationAdmission!;
  const observations = {
    ...originalAdmission.observations,
    sourceDigest: qualification.source.digest,
    clawhub: packages.map(({ name, version: packageVersion }) => ({
      name,
      version: packageVersion,
      observedAt: originalAdmission.observations.collectionCompletedAt,
      state: {
        packageExists: true,
        alreadyPublished: false,
        hasTrustedPublisher: true,
        trustedPublisher: {
          provider: "github-actions",
          repository,
          workflowFilename: "plugin-clawhub-release.yml",
          environment: null,
        },
      },
    })),
    plans: {
      ...originalAdmission.observations.plans,
      clawhub: {
        all: packages.map(({ name, version: packageVersion }) => ({
          name,
          version: packageVersion,
          alreadyPublished: false,
        })),
        candidates: packages.map(({ name }) => name),
        skippedPublished: [],
        bootstrapCandidates: [],
        missingTrustedPublisher: [],
        warnings: [],
      },
    },
  };
  const publicationAdmission = createPublicationAdmission(
    qualification.source,
    observations,
    originalAdmission.binding.artifact,
    originalAdmission.binding.admittedAt,
  );
  Object.assign(qualification.plan, {
    sourceAdmission: qualification.source,
    publicationAdmission,
  });
  qualification.plan.sha256 = releaseExecutionPlanSha256(qualification.plan);
  Object.assign(qualification.manifest, {
    sourceAdmission: qualification.source,
    publicationAdmission,
    executionPlanSha256: qualification.plan.sha256,
  });
  const recoveryWrites: string[] = [];
  const fetchImpl = f.options.fetchImpl;
  f.options.fetchImpl = async (input, init) => {
    const url = new URL(requestUrl(input));
    const entryIndex = f.transactions.packages.findIndex(
      (entry, index) =>
        url.pathname ===
          `/api/v1/packages/${encodeURIComponent(entry.name)}/versions/${entry.version}/publication` ||
        url.pathname === `/api/v1/publish/attempts/attempt-${index + 1}/recover`,
    );
    if (url.origin === "https://clawhub.ai" && entryIndex >= 0) {
      const entry = f.transactions.packages[entryIndex]!;
      const authorization = new Headers(init?.headers).get("authorization");
      if (url.pathname.endsWith("/recover")) {
        expect(init?.method).toBe("POST");
        expect(authorization).toBe("Bearer publisher-token");
        expect(qualification.admission.calls).toContain(`repos/${repository}/actions/artifacts/70`);
        recoveryWrites.push(entry.name);
        return Response.json({
          name: entry.name,
          version: entry.version,
          recoveredFromAttemptId: `attempt-${entryIndex + 1}`,
          attemptId: `successor-${entryIndex + 1}`,
          publicationStatus: "published",
        });
      }
      expect(init?.method ?? "GET").toBe("GET");
      // Recovery polling uses its ClawHub credential; public byte readback does not.
      expect(authorization === null || authorization === "Bearer publisher-token").toBe(true);
      f.registryReads.push(url.pathname);
      return Response.json(
        recoveryWrites.includes(entry.name)
          ? { name: entry.name, version: entry.version, state: "published" }
          : {
              name: entry.name,
              version: entry.version,
              state: "failed",
              recoverable: true,
              attemptId: `attempt-${entryIndex + 1}`,
            },
      );
    }
    return fetchImpl(input, init);
  };
  const evidenceClient = {
    ...qualification.client,
    verifyRetainedPublicationArtifacts() {
      throw new Error("Unexpected retained publication verification");
    },
    downloadArtifactArchive() {
      throw new Error("Unexpected publication artifact download");
    },
    getRunArtifacts() {
      throw new Error("Unexpected publication artifact listing");
    },
  };
  return { ...f, qualification, recoveryWrites, evidenceClient };
}

function originalPackedFixture(mode: "full" | "selected" | "omitted sibling" = "selected") {
  const f = authenticatedParentRecoveryFixture(mode);
  const seal = {
    schemaVersion: 1,
    kind: "openclaw-clawhub-recovery-manifest",
    identity: f.transactions.identity,
    packages: f.transactions.packages.map((entry) => ({
      ...entry,
      publicationStatus: "unavailable",
    })),
  };
  replaceJsonArtifact(f.original, f.recoveryArtifact, "recovery-manifest.json", seal);
  const inventory = f.metadata.get(jobsPath(20, 1)) as { jobs: ReturnType<typeof job>[] };
  const publisher = {
    ...job("publish_plugins_clawhub"),
    head_sha: f.child.head_sha,
    conclusion: "skipped",
  };
  f.setJobs(20, 1, [...inventory.jobs, publisher]);
  // Original parent authorization never existed. No prepared-success artifact is invented.
  f.setArtifacts(10, [f.dispatchArtifact]);
  const env = {
    ...f.options.env,
    GITHUB_WORKFLOW_REF: `${repository}/${parentWorkflow}@${f.options.env.GITHUB_REF}`,
    GITHUB_RUN_ID: "30",
    GITHUB_RUN_ATTEMPT: "1",
  };
  const source = (name: string) => {
    const content = JSON.stringify({ name });
    return {
      type: "file",
      encoding: "base64",
      size: Buffer.byteLength(content),
      content: Buffer.from(content).toString("base64"),
    };
  };
  const candidate = f.transactions.identity.candidateSha;
  f.metadata.set(`git/trees/${candidate}`, {
    tree: [{ path: "extensions", type: "tree", sha: "extension-tree" }],
  });
  f.metadata.set("git/trees/extension-tree", {
    tree: [
      { path: "actual-directory", type: "tree", sha: "example-tree" },
      { path: "sibling", type: "tree", sha: "sibling-tree" },
      { path: "test-support", type: "tree", sha: "support-tree" },
    ],
  });
  for (const name of ["example", "sibling"]) {
    f.metadata.set(`git/trees/${name}-tree`, {
      tree: [
        { path: "package.json", type: "blob", mode: "100644", sha: `${name}-blob` },
        { path: "src", type: "tree", sha: `${name}-source-tree` },
      ],
    });
  }
  f.metadata.set("git/trees/support-tree", {
    tree: [{ path: "fixtures", type: "tree", sha: "huge-unrelated-tree" }],
  });
  f.metadata.set(
    `contents/extensions/sibling/package.json?ref=${candidate}`,
    source("@openclaw/sibling"),
  );
  f.metadata.set(
    `contents/extensions/actual-directory/package.json?ref=${candidate}`,
    source(f.entry.name),
  );
  let state: "absent" | "pending" = "absent";
  const options = {
    ...f.options,
    env,
    evidenceClient: f.evidenceClient,
    request: f.request,
    runGhJson: (path: string) =>
      JSON.parse(f.options.runGh(["api", `repos/${repository}/${path}`])),
    fetchImpl: async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (
        requestUrl(input).startsWith("https://clawhub.ai/") &&
        requestUrl(input).endsWith("/publication")
      ) {
        expect(init?.method ?? "GET").toBe("GET");
        const name = decodeURIComponent(new URL(requestUrl(input)).pathname.split("/")[4]!);
        return Response.json({
          name,
          version: f.entry.version,
          state,
          ...(state === "pending" ? { stage: "staging" } : {}),
        });
      }
      return f.original.options.fetchImpl(input, init);
    },
  };
  return {
    ...f,
    options,
    seal,
    publisher,
    setPending: () => {
      state = "pending";
    },
  };
}

function retryFixture({
  parentOnMain = false,
  producerAttempt = 1,
  terminalAttempt = producerAttempt + 1,
  jobName = "Publish plugins, then OpenClaw",
}: {
  parentOnMain?: boolean;
  producerAttempt?: number;
  terminalAttempt?: number;
  jobName?: string;
} = {}) {
  const f = fixture(parentOnMain, sha, "example", producerAttempt);
  f.metadata.set(`actions/runs/10/attempts/${producerAttempt}`, {
    ...f.parent,
    conclusion: "failure",
  });
  f.parent.run_attempt = terminalAttempt;
  f.metadata.set(`actions/runs/10/attempts/${terminalAttempt}`, f.parent);
  const uploadStep = {
    name: "Upload exact release child dispatch record",
    ...completed,
    number: 23,
    started_at: "2026-10-05T18:48:31Z",
    completed_at: "2026-10-05T18:48:32Z",
  };
  const producer = {
    ...job(jobName, 10, producerAttempt),
    runner_id: 42,
    started_at: "2026-10-05T18:43:49Z",
    completed_at: "2026-10-05T19:10:19Z",
    steps: [uploadStep],
  };
  const originalProducer = { ...producer, steps: [{ ...uploadStep }] };
  const terminalUpload = { ...uploadStep };
  const terminalProducer = { ...producer, run_attempt: terminalAttempt, steps: [terminalUpload] };
  for (const producerJob of [originalProducer, terminalProducer]) {
    f.setJobs(10, producerJob.run_attempt, [producerJob]);
  }
  return { ...f, originalProducer, terminalProducer, terminalUpload };
}

function preparedFixture(selectionMode = "selected", packageId = "example", runAttempt = 1) {
  const f = fixture(false, sha, packageId);
  const candidateSha = f.transactions.identity.candidateSha;
  const producer = {
    repository,
    runId: 20,
    runAttempt,
    workflowPath: childWorkflow,
    workflowEvent: "workflow_dispatch",
    workflowHeadBranch: ref,
    workflowSha: sha,
  };
  f.child.run_attempt = runAttempt;
  f.metadata.set(`actions/runs/20/attempts/${runAttempt}`, f.child);
  const packageArtifact = {
    ...f.packageArtifact,
    name: `clawhub-package-openclaw-${packageId}-${f.entry.version}-20-${runAttempt}`,
  };
  f.metadata.set("actions/artifacts/3", packageArtifact);
  const matrix = [
    {
      packageName: f.entry.name,
      packageDir: `extensions/${packageId}`,
      version: f.entry.version,
      publishTag: "latest",
      artifactName: packageArtifact.name,
      alreadyPublished: false,
    },
  ] as const;
  const packedDirectory = join(f.directory, "prepared-packages");
  mkdirSync(join(packedDirectory, packageArtifact.name), { recursive: true });
  writeFileSync(join(packedDirectory, packageArtifact.name, `${packageId}.tgz`), f.tarball);
  const packJob = job(`Pack ClawHub package (${f.entry.name})`, 20, runAttempt);
  const sealOptions = {
    candidateSha,
    producer,
    selectionMode,
    matrix,
    directory: packedDirectory,
    artifacts: [packageArtifact] as const,
    workflowRun: { ...f.child, status: "in_progress", conclusion: null },
    workflowJobs: {
      total_count: 1,
      jobs: [packJob] as const,
    },
  };
  const manifest = createPreparedClawHubManifest(sealOptions);
  const manifestName = `clawhub-prepared-${candidateSha.slice(0, 12)}-20-${runAttempt}`;
  const archive = zip("prepared-clawhub.json", Buffer.from(JSON.stringify(manifest)));
  f.archives.set(5, archive);
  const descriptor = {
    ...producer,
    artifactId: 5,
    artifactName: manifestName,
    artifactDigest: `sha256:${digest(archive)}`,
    artifactSizeBytes: archive.length,
  };
  f.metadata.set("actions/artifacts/5", {
    id: 5,
    name: manifestName,
    digest: descriptor.artifactDigest,
    size_in_bytes: archive.length,
    expired: false,
    expires_at: "2099-01-01T00:00:00Z",
    workflow_run: { id: 20, head_sha: sha },
  });
  const runGhJson = (apiPath: string) => {
    if (!f.metadata.has(apiPath)) {
      throw new Error(`Unexpected GitHub request: ${apiPath}`);
    }
    return f.metadata.get(apiPath);
  };
  const resolveOptions = {
    descriptor,
    candidateSha,
    toolingSha: sha,
    selectionMode,
    plugins: selectionMode === "all-publishable" ? [] : [f.entry.name],
    token: f.options.token,
    fetchImpl: f.options.fetchImpl,
    runGhJson,
  };
  const restoreOptions = {
    descriptor,
    toolingSha: sha,
    entry: manifest.packages[0],
    outputDir: join(f.directory, "promoted-package"),
    token: f.options.token,
    fetchImpl: f.options.fetchImpl,
    runGhJson,
  };
  return { ...f, manifest, resolveOptions, restoreOptions, sealOptions };
}

function preparedSealingFixture(attempts: readonly [number, number] = [2, 2]) {
  const first = preparedFixture("all-publishable", "example", attempts[0]);
  const second = preparedFixture("all-publishable", "other", attempts[1]);
  const [secondEntry] = second.sealOptions.matrix;
  const secondDirectory = join(first.sealOptions.directory, secondEntry.artifactName);
  mkdirSync(secondDirectory);
  writeFileSync(join(secondDirectory, "other.tgz"), second.tarball);
  return {
    ...first.sealOptions,
    producer: { ...first.sealOptions.producer, runAttempt: 2 },
    workflowRun: { ...first.sealOptions.workflowRun, run_attempt: 2 },
    matrix: [...first.sealOptions.matrix, secondEntry] as const,
    artifacts: [
      ...first.sealOptions.artifacts,
      { ...second.sealOptions.artifacts[0], id: 6 },
    ] as const,
    workflowJobs: {
      total_count: 2,
      jobs: [
        ...first.sealOptions.workflowJobs.jobs,
        ...second.sealOptions.workflowJobs.jobs,
      ] as const,
    },
  };
}

it.each([{ version: "2026.8.2-alpha.1" }, { publishTag: "alpha" }])(
  "rejects retired alpha prepared selection %j",
  (override) => {
    const f = preparedFixture();
    expect(() =>
      createPreparedClawHubManifest({
        ...f.sealOptions,
        matrix: [{ ...f.sealOptions.matrix[0], ...override }],
      }),
    ).toThrow("Alpha releases are retired;");
  },
);

describe("ClawHub prepared publication", () => {
  it("seals a lone prepared package from a flat artifact download", () => {
    const f = preparedFixture();
    const { directory, matrix } = f.sealOptions;
    rmSync(join(directory, matrix[0].artifactName), { recursive: true });
    writeFileSync(join(directory, "example.tgz"), f.tarball);

    const manifest = createPreparedClawHubManifest(f.sealOptions);
    expect(manifest.packages).toMatchObject([
      {
        packageName: "@openclaw/example",
        version: "2026.8.2",
        tarballName: "example.tgz",
        tarballSha256: digest(f.tarball),
        tarballSizeBytes: f.tarball.length,
      },
    ]);
  });

  it("seals the complete same-attempt roster from successful pack producers", () => {
    const options = preparedSealingFixture();
    const manifest = createPreparedClawHubManifest(options);
    expect(manifest.packages.map((entry: { packageName: string }) => entry.packageName)).toEqual([
      "@openclaw/example",
      "@openclaw/other",
    ]);
    expect(manifest.producer.runAttempt).toBe(2);
  });

  it.each(["prior attempt", "failed producer", "reused producer"])(
    "refuses to relabel %s packages as the current preparation attempt",
    (change) => {
      const options = preparedSealingFixture(change === "prior attempt" ? [1, 1] : [2, 2]);
      if (change === "failed producer") {
        options.workflowJobs.jobs[0].conclusion = "failure";
      }
      if (change === "reused producer") {
        options.workflowJobs.jobs[0].run_attempt = 1;
      }
      expect(() => createPreparedClawHubManifest(options)).toThrow(
        /producer attempt|producer job did not complete successfully/u,
      );
    },
  );

  it("seals an empty roster without requiring a skipped pack job", () => {
    const f = preparedFixture("all-publishable");
    expect(
      createPreparedClawHubManifest({
        ...f.sealOptions,
        matrix: [],
        artifacts: [],
        workflowJobs: { total_count: 0, jobs: [] },
      }).packages,
    ).toEqual([]);
  });

  it.each(["selected", "all-publishable"])(
    "retains the native family and exact bytes on %s resume",
    async (selectionMode) => {
      const f = preparedFixture(selectionMode, "cloudflare");
      const [entry] = await resolvePreparedClawHubMatrix(f.resolveOptions);
      expect(entry.alreadyPublished).toBe(true);
      expect(entry.family).toBe("code-plugin");
      expect(entry.publication).toEqual({ state: "published" });
      await restorePreparedClawHubPackage({ ...f.restoreOptions, entry: entry.prepared });
      expect(readFileSync(join(f.restoreOptions.outputDir, "cloudflare.tgz"))).toEqual(f.tarball);
    },
  );

  it.each([
    { publication: { state: "absent" } },
    { publication: { state: "pending", stage: "staging" } },
    { publication: { state: "pending", stage: "checks", attemptId: "attempt_checks" } },
    { publication: { state: "failed", attemptId: "attempt_recover", recoverable: true } },
    { publication: { state: "failed", recoverable: false } },
    { publication: { state: "published" }, legacy: [404, 200] },
    { publication: { state: "absent" }, legacy: [200, 404] },
  ])("resolves prepared publication detail: %j", async ({ publication, legacy }) => {
    const f = preparedFixture();
    f.respond("/publication", () =>
      Response.json(
        { name: f.entry.name, version: f.entry.version, ...(legacy ? {} : publication) },
        { status: legacy?.[0] ?? 200 },
      ),
    );
    f.respond(`/versions/${f.entry.version}`, () => {
      if (!legacy) {
        throw new Error("Recognized publication state must not fall back to the version probe.");
      }
      return new Response(null, { status: legacy[1] });
    });
    if (["pending", "failed"].includes(publication.state)) {
      f.respond("/trusted-publisher", () => new Response(null, { status: 404 }));
    }
    const [entry] = await resolvePreparedClawHubMatrix(f.resolveOptions);
    expect(entry).toMatchObject({
      packageName: f.entry.name,
      alreadyPublished: publication.state === "published",
      prepared: { tarballSha256: f.entry.artifactSha256 },
    });
    expect(entry.publication).toEqual(publication);
    expect(
      f.requests
        .filter((url) => url.includes("/versions/"))
        .map((url) => url.slice(url.indexOf("/versions/"))),
    ).toEqual([
      `/versions/${f.entry.version}/publication`,
      ...(legacy ? [`/versions/${f.entry.version}`] : []),
    ]);
  });

  it.each([
    { label: "missing package", status: 404, patch: {} },
    { label: "missing configuration", status: 200, patch: null },
    { label: "wrong provider", status: 200, patch: { provider: "other" } },
    { label: "wrong repository", status: 200, patch: { repository: "other/repository" } },
    { label: "wrong workflow", status: 200, patch: { workflowFilename: "other-release.yml" } },
    { label: "unexpected environment", status: 200, patch: { environment: "production" } },
  ])(
    "requires existing owner repair for $label before normal preparation",
    async ({ status, patch }) => {
      const f = preparedFixture("all-publishable");
      f.respond("/trusted-publisher", () =>
        status === 404
          ? new Response(null, { status })
          : Response.json({
              trustedPublisher:
                patch === null
                  ? null
                  : {
                      provider: "github-actions",
                      repository,
                      workflowFilename: "plugin-clawhub-release.yml",
                      ...patch,
                    },
            }),
      );
      await expect(resolvePreparedClawHubMatrix(f.resolveOptions)).rejects.toThrow(
        /Plugin ClawHub New owner before preparing again/u,
      );
      expect(f.requests.filter((url) => url.startsWith("/api/v1/"))).toEqual([
        `/api/v1/packages/${encodeURIComponent(f.entry.name)}/versions/${f.entry.version}/publication`,
        `/api/v1/packages/${encodeURIComponent(f.entry.name)}/trusted-publisher`,
      ]);
    },
  );

  it("reuses a verified saved archive and output, but refuses to overwrite changed bytes", async () => {
    const f = preparedFixture();
    const options = { ...f.restoreOptions, archivePath: join(f.directory, "package.zip") };
    await restorePreparedClawHubPackage(options);
    f.respond("/zip", () => {
      throw new Error("Saved verified bytes must not be redownloaded.");
    });
    await restorePreparedClawHubPackage(options);
    const tarballPath = join(options.outputDir, "example.tgz");
    writeFileSync(tarballPath, "changed local bytes");
    await expect(restorePreparedClawHubPackage(options)).rejects.toThrow();
    expect(readFileSync(tarballPath, "utf8")).toBe("changed local bytes");
  });

  it.each(["extra", "all-publishable"])(
    "rejects %s drift instead of silently publishing a different roster",
    async (change) => {
      const f = preparedFixture();
      const plugins = change === "extra" ? [f.entry.name, "@openclaw/other"] : [];
      await expect(
        downloadPreparedClawHubRelease({
          ...f.resolveOptions,
          plugins,
          selectionMode: change === "all-publishable" ? "all-publishable" : "selected",
        }),
      ).rejects.toThrow(/selection.*mismatch/u);
      expect(f.registryReads).toEqual([]);
    },
  );

  it.each(["candidate", "tooling", "producer-attempt", "producer-ref"])(
    "rejects substituted %s before exposing publication bytes",
    async (change) => {
      const f = preparedFixture();
      if (change === "producer-attempt") {
        f.child.run_attempt = 2;
      }
      if (change === "producer-ref") {
        f.child.path = `${childWorkflow}@refs/heads/${ref}`;
      }
      await expect(
        downloadPreparedClawHubRelease({
          ...f.resolveOptions,
          ...(change === "candidate" ? { candidateSha: "c".repeat(40) } : {}),
          ...(change === "tooling" ? { toolingSha: "c".repeat(40) } : {}),
        }),
      ).rejects.toThrow(/(mismatch|immutable publication tuple)/u);
      expect(existsSync(f.restoreOptions.outputDir)).toBe(false);
    },
  );

  it("retries an interrupted body against the same artifact and restores its original bytes", async () => {
    const f = preparedFixture();
    let transfers = 0;
    f.respond("/actions/artifacts/3/zip", () => {
      if (++transfers === 1) {
        let firstChunk = true;
        return new Response(
          new ReadableStream({
            pull(controller) {
              if (firstChunk) {
                firstChunk = false;
                controller.enqueue(new Uint8Array(f.archives.get(3)!.subarray(0, 31)));
              } else {
                controller.error(
                  new TypeError("terminated", {
                    cause: Object.assign(new Error("other side closed"), {
                      code: "UND_ERR_SOCKET",
                    }),
                  }),
                );
              }
            },
          }),
        );
      }
      return undefined;
    });
    await restorePreparedClawHubPackage(f.restoreOptions);
    expect(transfers).toBe(2);
    expect(readFileSync(join(f.restoreOptions.outputDir, "example.tgz"))).toEqual(f.tarball);
  });

  it("leaves no publishable output when a retained tarball inventory conflicts", async () => {
    const f = preparedFixture();
    const entry = { ...f.restoreOptions.entry, inventoryDigest: "f".repeat(64) };
    await expect(
      restorePreparedClawHubPackage({
        ...f.restoreOptions,
        entry,
      }),
    ).rejects.toThrow(/bytes and inventory mismatch/u);
    expect(existsSync(f.restoreOptions.outputDir)).toBe(false);
    expect(f.registryReads).toEqual([]);
  });

  it("refuses a matching-version registry package with different bytes instead of adopting it", async () => {
    const f = preparedFixture();
    await restorePreparedClawHubPackage(f.restoreOptions);
    const fetchImpl: typeof fetch = async (input, init) => {
      if (requestUrl(input).endsWith("/artifact/download")) {
        return new Response("different published bytes");
      }
      return f.options.fetchImpl(input, init);
    };
    await expect(
      verifyPublishedClawHubPackage({
        expectedArtifactDir: f.restoreOptions.outputDir,
        packageName: f.entry.name,
        packageVersion: f.entry.version,
        publishTag: "latest",
        retryOptions: { fetchImpl, attempts: 1 },
      }),
    ).rejects.toThrow(/registry artifact sha256 mismatch/u);
  });
});

describe("original sealed ClawHub source", () => {
  it("resolves package directories without expanding a huge unrelated source subtree", async () => {
    const f = originalPackedFixture();
    const hugeTree = {
      tree: Array.from({ length: 12_891 }, (_, index) => ({
        path: `test-support/fixtures/unrelated/source-file-${index}.ts`,
        type: "blob",
        mode: "100644",
        sha: "d".repeat(40),
      })),
    };
    expect(Buffer.byteLength(JSON.stringify(hugeTree))).toBeGreaterThan(1024 * 1024);
    f.metadata.set("git/trees/extension-tree?recursive=1", hugeTree);
    f.metadata.set("git/trees/huge-unrelated-tree", hugeTree);
    const reads: string[] = [];
    const descriptor = await createOriginalPackedClawHubDescriptor(f.options);
    const matrix = await resolvePreparedClawHubMatrix({
      ...f.options,
      descriptor,
      runGhJson: (path: string) => {
        reads.push(path);
        const value = f.options.runGhJson(path);
        if (Buffer.byteLength(JSON.stringify(value)) > 1024 * 1024) {
          throw new Error("GitHub transport response exceeds 1 MiB");
        }
        return value;
      },
    });
    expect(matrix).toMatchObject([{ packageDir: "extensions/actual-directory" }]);
    expect(reads).toEqual([
      `git/trees/${f.transactions.identity.candidateSha}`,
      "git/trees/extension-tree",
      "git/trees/example-tree",
      `contents/extensions/actual-directory/package.json?ref=${f.transactions.identity.candidateSha}`,
      "git/trees/sibling-tree",
      `contents/extensions/sibling/package.json?ref=${f.transactions.identity.candidateSha}`,
      "git/trees/support-tree",
    ]);
  });

  it.each(["release_publish_run_id", "release_publish_run_attempt"] as const)(
    "rejects a descriptor whose %s differs from the actual child dispatch before authentication",
    async (field) => {
      const f = originalPackedFixture();
      const descriptor = await createOriginalPackedClawHubDescriptor(f.options);
      const githubReads = f.githubReads.length;
      await expect(
        resolvePreparedClawHubMatrix({
          ...f.options,
          descriptor,
          event: { inputs: { ...f.request.inputs, [field]: "99" } },
          env: {
            ...f.options.env,
            GITHUB_WORKFLOW_REF: `${repository}/${childWorkflow}@${f.options.env.GITHUB_REF}`,
            GITHUB_RUN_ID: "50",
          },
        }),
      ).rejects.toThrow("does not bind the actual child dispatch parent");
      expect(f.githubReads).toHaveLength(githubReads);
      expect(f.recoveryWrites).toEqual([]);
    },
  );

  it("hands selected original bytes to a fresh transaction without original parent authorization", async () => {
    const f = originalPackedFixture();
    const descriptor = await createOriginalPackedClawHubDescriptor(f.options);
    expect(descriptor).toEqual({ kind: "openclaw-clawhub-original-packed", request: f.request });
    const eventPath = join(f.directory, "child-event.json");
    writeFileSync(eventPath, JSON.stringify({ inputs: f.request.inputs }));
    const childOptions = {
      ...f.options,
      event: undefined,
      env: {
        ...f.options.env,
        GITHUB_WORKFLOW_REF: `${repository}/${childWorkflow}@${f.options.env.GITHUB_REF}`,
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_RUN_ID: "50",
      },
    };
    const matrix = await resolvePreparedClawHubMatrix({
      ...childOptions,
      descriptor,
      candidateSha: f.transactions.identity.candidateSha,
      selectionMode: "selected",
      plugins: f.entry.name,
    });
    expect(matrix).toMatchObject([
      {
        packageName: f.entry.name,
        packageDir: "extensions/actual-directory",
        alreadyPublished: false,
        publication: { state: "absent" },
        prepared: {
          tarballSha256: f.entry.artifactSha256,
          inventoryDigest: f.entry.inventoryDigest,
        },
      },
    ]);
    const outputDir = join(f.directory, "fresh-package");
    await restorePreparedClawHubPackage({
      ...childOptions,
      descriptor,
      entry: matrix[0]!.prepared,
      token: "fixture-token",
      outputDir,
      artifactName: "fresh-parent-package",
    });
    expect(readFileSync(join(outputDir, "example.tgz"))).toEqual(f.tarball);
    expect(f.recoveryWrites).toEqual([]);
    expect(f.qualification.admission.calls).toContain(`repos/${repository}/actions/artifacts/70`);
    f.setPending();
    await expect(checkOriginalPackedClawHubAbsent({ ...childOptions, descriptor })).rejects.toThrow(
      "not absent",
    );
    const blockedOutput = join(f.directory, "blocked-package");
    await expect(
      restorePreparedClawHubPackage({
        ...childOptions,
        descriptor,
        entry: matrix[0]!.prepared,
        token: "fixture-token",
        outputDir: blockedOutput,
      }),
    ).rejects.toThrow("not absent");
    expect(existsSync(blockedOutput)).toBe(false);
  });

  it.each([
    "executed publisher",
    "missing publisher",
    "incomplete pack",
    "outside admission",
    "tampered seal",
    "changed request",
  ] as const)("refuses original source for %s", async (change) => {
    const f = originalPackedFixture(
      change === "outside admission" ? "omitted sibling" : "selected",
    );
    const inventory = f.metadata.get(jobsPath(20, 1)) as { jobs: ReturnType<typeof job>[] };
    if (change === "executed publisher") {
      f.publisher.conclusion = "failure";
      expect(await createOriginalPackedClawHubDescriptor(f.options)).toBeNull();
    } else {
      if (change === "missing publisher") {
        f.setJobs(
          20,
          1,
          inventory.jobs.filter((entry) => entry !== f.publisher),
        );
      } else if (change === "incomplete pack") {
        f.setJobs(
          20,
          1,
          inventory.jobs.filter((entry) => !entry.name.includes("Pack ClawHub package")),
        );
      } else if (change === "tampered seal") {
        f.archives.set(f.recoveryArtifact.id, Buffer.from("tampered seal"));
      } else if (change === "changed request") {
        f.request.inputs.reason = "Not the uploaded request";
      }
      await expect(createOriginalPackedClawHubDescriptor(f.options)).rejects.toThrow(
        change === "missing publisher"
          ? /unproven/u
          : change === "incomplete pack"
            ? /pack job inventory/u
            : change === "outside admission"
              ? /outside the original admitted/u
              : change === "changed request"
                ? /authenticated parent request/u
                : /size|digest/u,
      );
    }
    expect(f.recoveryWrites).toEqual([]);
  });

  it.each(["legacy missing state", "unknown", "published", "HTTP 404"])(
    "does not treat %s as authoritative absence",
    async (state) => {
      const f = originalPackedFixture();
      const fetchImpl: typeof fetch = async (input, init) => {
        if (
          requestUrl(input).startsWith("https://clawhub.ai/") &&
          requestUrl(input).endsWith("/publication")
        ) {
          return state === "HTTP 404"
            ? new Response(null, { status: 404 })
            : Response.json({
                name: f.entry.name,
                version: f.entry.version,
                ...(state === "legacy missing state" ? {} : { state }),
              });
        }
        return f.options.fetchImpl(input, init);
      };
      await expect(
        createOriginalPackedClawHubDescriptor({ ...f.options, fetchImpl }),
      ).rejects.toThrow(/publication|HTTP 404/u);
      expect(f.recoveryWrites).toEqual([]);
    },
  );

  it("rejects changed tarball bytes even when their enclosing archive digest is current", async () => {
    const f = originalPackedFixture();
    const descriptor = await createOriginalPackedClawHubDescriptor(f.options);
    const matrix = await resolvePreparedClawHubMatrix({ ...f.options, descriptor });
    const sibling = fixture(false, f.child.head_sha, "sibling", 1, {
      version: f.entry.version,
      candidateSha: f.transactions.identity.candidateSha,
      toolingSha: f.child.head_sha,
      toolingRef: f.child.head_branch,
    });
    const archive = zip("example.tgz", sibling.tarball);
    f.archives.set(f.packageArtifact.id, archive);
    Object.assign(f.packageArtifact, {
      size_in_bytes: archive.length,
      digest: `sha256:${digest(archive)}`,
    });
    const entry = {
      ...matrix[0]!.prepared,
      artifactSizeBytes: archive.length,
      artifactDigest: f.packageArtifact.digest,
    };
    const outputDir = join(f.directory, "changed-package");
    await expect(
      restorePreparedClawHubPackage({
        ...f.options,
        descriptor,
        entry,
        token: "fixture-token",
        outputDir,
      }),
    ).rejects.toThrow("identity mismatch");
    expect(existsSync(outputDir)).toBe(false);
  });
});

describe("ClawHub parent-requested recovery", () => {
  it.each(["full", "selected"] as const)(
    "authenticates original FRV admission before %s parent recovery",
    async (mode) => {
      const f = authenticatedParentRecoveryFixture(mode);
      const evidence = await recoverClawHubFromParent({
        ...f.options,
        evidenceClient: f.evidenceClient,
      });
      expect(
        evidence.packages
          .map((entry: { package: { packageName: string } }) => entry.package.packageName)
          .toSorted(),
      ).toEqual(mode === "full" ? [f.entry.name, "@openclaw/sibling"] : [f.entry.name]);
      expect(evidence.complete).toBe(mode === "full");
      expect(f.recoveryWrites).toEqual(
        mode === "full" ? [f.entry.name, "@openclaw/sibling"] : [f.entry.name],
      );
      expect(evidence).toMatchObject({
        publicationAttempts: [{ name: f.entry.name }, { name: "@openclaw/sibling" }],
      });
      expect(f.qualification.admission.calls).toContain(`repos/${repository}/actions/artifacts/70`);
      if (mode === "selected") {
        expect(f.registryReads.some((path) => path.includes("sibling"))).toBe(false);
      }
    },
  );

  it("rejects a full recovery seal that omits an originally admitted sibling", async () => {
    const f = authenticatedParentRecoveryFixture("omitted sibling");
    await expect(
      recoverClawHubFromParent({
        ...f.options,
        evidenceClient: f.evidenceClient,
      }),
    ).rejects.toThrow("outside the original admitted name/version roster");
    expect(f.qualification.admission.calls).toContain(`repos/${repository}/actions/artifacts/70`);
    // Read-only observations may precede admission, but no recovery write may.
    expect(f.recoveryWrites).toEqual([]);
  });

  it.each([
    { change: "partial inputs", error: /every internal dispatch input/u },
    { change: "other tooling", error: /headSha mismatch/u },
    { change: "cancelled parent", error: /parent state/u },
    { change: "unfinished upload", error: /request upload/u },
    { change: "changed request", error: /dispatch differs/u },
    { change: "changed archive", error: /digest/u },
    { change: "missing original seal", error: /original ClawHub seal/u },
  ])("rejects $change before registry access", async ({ change, error }) => {
    const f = parentRecoveryFixture();
    if (change === "partial inputs") {
      delete f.options.event.inputs.full_release_validation_run_attempt;
    } else if (change === "other tooling") {
      f.current.head_sha = "f".repeat(40);
    } else if (change === "cancelled parent") {
      Object.assign(f.current, { status: "completed", conclusion: "cancelled" });
    } else if (change === "unfinished upload") {
      f.producer.steps![1]!.status = "in_progress";
    } else if (change === "changed request") {
      f.request.inputs.plugins = "@openclaw/outside";
      replaceJsonArtifact(f.original, f.requestArtifact, "dispatch.json", f.request);
    } else if (change === "changed archive") {
      const bytes = Buffer.from(f.archives.get(8)!);
      bytes[0] = bytes[0]! ^ 1;
      f.archives.set(8, bytes);
    } else {
      f.setArtifacts(20, [f.transactionsArtifact, f.packageArtifact]);
    }
    await expect(recoverClawHubFromParent(f.options)).rejects.toThrow(error);
    expect(f.registryReads).toEqual([]);
  });

  it("does not let an approved request or public bytes replace original FRV authority", async () => {
    const f = parentRecoveryFixture();
    const loadManifest = vi.fn(() => {
      throw new Error("Original FRV provenance unavailable");
    });
    await expect(
      recoverClawHubFromParent({
        ...f.options,
        evidenceClient: { ...createReleaseEvidenceClient(repository), loadManifest },
      }),
    ).rejects.toThrow("Original FRV provenance unavailable");
    expect(loadManifest).toHaveBeenCalledWith("40", 1);
    expect(f.githubReads).toContain("actions/runs/10/attempts/1");
    expect(f.githubReads).toContain("actions/runs/20/attempts/1");
  });
});

describe("ClawHub detached postpublish verification", () => {
  it.each([false, true])(
    "recovers only the sealed subset with fresh authority (revoked=%s)",
    async (revoked) => {
      const f = fixture();
      addSealedSibling(f);
      f.child.conclusion = "failure";
      const effects: string[] = [];
      const revalidateAuthority = vi.fn(async () => {
        if (revoked) {
          throw new Error("Current parent authority revoked");
        }
        effects.push("authority");
      });
      const result = verifyClawHubPostpublish({
        ...f.options,
        parentStatePolicy: "recovery-producer",
        plugins: f.entry.name,
        recover: {
          reason: "Resume the sealed publication",
          token: "publisher-token",
          revalidateAuthority,
          report: () => {},
          fetchImpl: async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
            const path = new URL(requestUrl(input)).pathname;
            if (init?.method === "POST") {
              expect(effects.at(-1)).toBe("authority");
              expect(path).toBe("/api/v1/publish/attempts/attempt-1/recover");
              effects.push("recover");
              return Response.json({
                name: f.entry.name,
                version: f.entry.version,
                recoveredFromAttemptId: "attempt-1",
                attemptId: "successor-1",
                publicationStatus: "published",
              });
            }
            expect(path).toBe(
              `/api/v1/packages/${encodeURIComponent(f.entry.name)}/versions/${f.entry.version}/publication`,
            );
            return Response.json({
              name: f.entry.name,
              version: f.entry.version,
              state: "failed",
              recoverable: true,
              attemptId: "attempt-1",
            });
          },
        },
      });
      if (revoked) {
        await expect(result).rejects.toThrow("Current parent authority revoked");
        expect(effects).toEqual([]);
        expect(f.registryReads).toEqual([]);
      } else {
        const evidence = await result;
        expect(
          evidence.packages.map(
            (entry: { package: { packageName: string } }) => entry.package.packageName,
          ),
        ).toEqual([f.entry.name]);
        expect(effects).toEqual(["authority", "recover", "authority"]);
        expect(f.registryReads.some((path) => path.includes("sibling"))).toBe(false);
        expect(evidence).toMatchObject({
          publicationAttempts: [{ name: f.entry.name }, { name: "@openclaw/sibling" }],
        });
        expect(evidence.complete).toBe(false);
      }
    },
  );

  it.each(["missing seal", "failed seal", "changed sibling", "local replacement"])(
    "authenticates the complete original roster before selection: %s",
    async (change) => {
      const f = fixture();
      const { manifest, artifact } = addSealedSibling(f);
      if (change === "missing seal") {
        f.setArtifacts(20, [f.metadata.get("actions/artifacts/2"), f.packageArtifact]);
      } else if (change === "failed seal") {
        f.setJobs(20, 1, [
          {
            ...job("Seal exact ClawHub recovery manifest", 20, 1),
            conclusion: "failure",
            steps: [
              {
                name: "Upload sealed recovery manifest",
                status: "completed",
                conclusion: "failure",
              },
            ],
          },
          job("Seal ClawHub package transactions"),
        ]);
      } else {
        manifest.packages[1]!.artifactSha256 = "f".repeat(64);
        if (change === "changed sibling") {
          replaceJsonArtifact(f, artifact, "recovery-manifest.json", manifest);
        }
      }
      await expect(
        verifyClawHubPostpublish({
          ...f.options,
          parentStatePolicy: "recovery-producer",
          plugins: f.entry.name,
          recoveryManifest: manifest,
          verifyPublication: false,
        }),
      ).rejects.toThrow(
        /sealed ClawHub|producer (?:job|step)|transaction roster|authenticated seal/u,
      );
      expect(f.registryReads).toEqual([]);
    },
  );

  it.each(["", "@openclaw/outside", "@openclaw/example,@openclaw/example"])(
    "rejects invalid sealed selection %j before registry access",
    async (plugins) => {
      const f = fixture();
      addSealedSibling(f);
      await expect(
        verifyClawHubPostpublish({
          ...f.options,
          parentStatePolicy: "recovery-producer",
          plugins,
        }),
      ).rejects.toThrow(/nonempty subset/u);
      expect(f.registryReads).toEqual([]);
    },
  );
  it.each([
    { label: "protected-tag publication", noChild: false },
    { label: "main publication", noChild: false, parentOnMain: true },
    { label: "no normal ClawHub child", noChild: true },
    { label: "Docker-only recovery", noChild: true, jobName: "record_docker_only_scope" },
  ])(
    "reuses the retained dispatch producer after a terminal retry: $label",
    async ({ noChild, ...options }) => {
      const f = retryFixture(options);
      if (noChild) {
        replaceJsonArtifact(f, f.dispatchArtifact, "dispatch.json", {
          ...f.dispatch,
          normalClawHubRunId: null,
          normalClawHubRunAttempt: null,
        });
      }
      const result = await verifyClawHubPostpublish(f.options);
      expect(result).toMatchObject({ complete: true, parentRunAttempt: 2, dispatchRunAttempt: 1 });
      expect(result.packages).toHaveLength(noChild ? 0 : 1);
      expect(f.registryReads.length > 0).toBe(!noChild);
      if (noChild) {
        expect(result).toMatchObject({ outcome: "no-normal-clawhub-publication" });
      }
    },
  );

  it.each([false, true])(
    "preserves deferred publication as incomplete (conflicting child=%s)",
    async (conflict) => {
      const f = retryFixture();
      replaceJsonArtifact(f, f.dispatchArtifact, "dispatch.json", {
        ...f.dispatch,
        clawHubDeferred: true,
        normalClawHubRunId: conflict ? f.dispatch.normalClawHubRunId : null,
        normalClawHubRunAttempt: conflict ? f.dispatch.normalClawHubRunAttempt : null,
      });
      if (conflict) {
        await expect(verifyClawHubPostpublish(f.options)).rejects.toThrow(
          /dispatch record identity/u,
        );
      } else {
        expect(await verifyClawHubPostpublish(f.options)).toMatchObject({
          complete: false,
          outcome: "clawhub-deferred",
          packages: [],
        });
      }
      expect(f.registryReads).toEqual([]);
    },
  );

  it("selects the retained producer among distinct historical dispatches", async () => {
    const f = retryFixture({ producerAttempt: 2 });
    const oldRun = { ...f.parent, run_attempt: 1, conclusion: "failure" };
    const oldJob = { ...structuredClone(f.originalProducer), run_attempt: 1, runner_id: 7 };
    f.metadata.set("actions/runs/10/attempts/1", oldRun);
    f.setJobs(10, 1, [oldJob]);
    const oldArtifact = {
      ...f.dispatchArtifact,
      id: 5,
      name: "openclaw-release-children-10-1",
    };
    replaceJsonArtifact(f, oldArtifact, "dispatch.json", {
      ...f.dispatch,
      parentRunAttempt: "1",
      normalClawHubRunId: "19",
    });
    f.metadata.set("actions/artifacts/5", oldArtifact);
    f.setArtifacts(10, [oldArtifact, f.receiptArtifact, f.dispatchArtifact]);
    expect(await verifyClawHubPostpublish(f.options)).toMatchObject({
      complete: true,
      parentRunAttempt: 3,
      dispatchRunAttempt: 2,
      dispatchArtifactId: 4,
    });
    expect(f.registryReads.length).toBeGreaterThan(0);
  });

  it.each([
    { change: "rerun producer", error: /retained ClawHub dispatch record/u },
    { change: "different runner", error: /retained ClawHub dispatch record/u },
    { change: "failed producer", error: /successful ClawHub dispatch producer/u },
    { change: "future record", error: /retained ClawHub dispatch record/u },
    { change: "ambiguous records", error: /ambiguous retained/u },
    { change: "changed digest", error: /digest/u },
    { change: "changed source", error: /headSha mismatch/u },
    { change: "changed ref", error: /producer workflow ref mismatch/u },
    { change: "parallel producer", error: /ambiguous successful ClawHub dispatch producer/u },
    { change: "excessive history", error: /historical record limit/u },
  ])(
    "rejects $change during retained dispatch recovery before registry reads",
    async ({ change, error }) => {
      const f = retryFixture();
      if (change === "rerun producer") {
        f.terminalProducer.started_at = "2026-10-05T20:00:00Z";
        f.terminalProducer.completed_at = "2026-10-05T20:10:00Z";
        f.terminalUpload.started_at = "2026-10-05T20:05:00Z";
        f.terminalUpload.completed_at = "2026-10-05T20:05:01Z";
      } else if (change === "different runner") {
        f.originalProducer.runner_id = 43;
      } else if (change === "failed producer") {
        f.originalProducer.conclusion = "failure";
      } else if (change === "future record") {
        f.dispatchArtifact.name = "openclaw-release-children-10-3";
      } else if (change === "ambiguous records") {
        f.setArtifacts(10, [
          f.receiptArtifact,
          f.dispatchArtifact,
          { ...f.dispatchArtifact, id: 5 },
        ]);
      } else if (change === "changed digest") {
        const changed = Buffer.from(f.archives.get(4)!);
        changed.writeUInt32LE(0, 0);
        f.archives.set(4, changed);
      } else if (change === "changed ref") {
        f.metadata.set("actions/runs/10/attempts/1", {
          ...f.parent,
          run_attempt: 1,
          path: `${parentWorkflow}@refs/heads/main`,
        });
      } else if (change === "parallel producer") {
        f.setJobs(10, 2, [f.terminalProducer, { ...f.terminalProducer, runner_id: 7 }]);
      } else if (change === "excessive history") {
        f.setArtifacts(
          10,
          Array.from({ length: 33 }, (_, index) => ({
            ...f.dispatchArtifact,
            id: index + 4,
          })),
        );
      } else {
        f.metadata.set("actions/runs/10/attempts/1", {
          ...f.parent,
          run_attempt: 1,
          head_sha: "c".repeat(40),
        });
      }
      await rejectsBeforeRegistry(f, error, true);
    },
  );

  it.each([
    ["active parent", "in_progress", null, "sealed-producer", "success", "success"],
    ["failed parent and child", "completed", "failure", "sealed-producer", "failure", "success"],
    ["successful parent", "completed", "success", "sealed-producer", "success", "success"],
    ["cancelled parent", "completed", "cancelled", "recovery-producer", "success", "cancelled"],
  ] as const)(
    "reconciles the complete roster from %s",
    async (_label, status, conclusion, parentStatePolicy, childConclusion, parentJobConclusion) => {
      const f = fixture();
      const parent = {
        ...f.parent,
        status,
        conclusion,
      };
      f.metadata.set("actions/runs/10/attempts/1", parent);
      f.child.conclusion = childConclusion;
      sealParent(f, parentJobConclusion);
      if (status === "in_progress") {
        f.setJobs(10, 1, [
          {
            ...job("Publish plugins, then OpenClaw", 10, 1, [
              "Upload exact release child dispatch record",
              "Upload original-byte ClawHub parent authorization",
            ]),
            status: "in_progress",
            conclusion: null,
          },
        ]);
      }

      const recoveryManifest = {
        schemaVersion: 1,
        kind: "openclaw-clawhub-recovery-manifest",
        identity: f.transactions.identity,
        packages: f.transactions.packages.map((entry) => ({
          ...entry,
          publicationStatus: "pending",
          attemptId: "attempt-1",
        })),
      };
      if (parentStatePolicy === "recovery-producer") {
        const authorized = await verifyClawHubPostpublish({
          ...f.options,
          parent,
          parentStatePolicy,
          recoveryManifest,
          verifyPublication: false,
        });
        expect(authorized).toMatchObject({
          complete: true,
          outcome: "authorized-recovery-roster",
        });
        expect(f.registryReads).toEqual([]);
      }

      const result = await verifyClawHubPostpublish({
        ...f.options,
        parent,
        parentStatePolicy,
        recoveryManifest: parentStatePolicy === "recovery-producer" ? recoveryManifest : undefined,
      });
      expect(result.complete).toBe(true);
      expect(result.packages).toHaveLength(1);
      f.setArtifacts(20, [f.metadata.get("actions/artifacts/2"), f.packageArtifact]);
      await expect(
        verifyClawHubPostpublish({
          ...f.options,
          parent,
          parentStatePolicy,
        }),
      ).rejects.toThrow(/sealed ClawHub original attempt roster/u);
    },
  );

  it.each(["dispatch upload", "authorization upload", "wrong attempt"])(
    "rejects an active parent with %s failure before public readback",
    async (change) => {
      const f = fixture();
      const parent = { ...f.parent, status: "in_progress", conclusion: null };
      f.metadata.set("actions/runs/10/attempts/1", parent);
      sealParent(f);
      const producer = {
        ...job("Publish plugins, then OpenClaw", 10, 1, [
          "Upload exact release child dispatch record",
          "Upload original-byte ClawHub parent authorization",
        ]),
        status: "in_progress",
        conclusion: null,
      };
      if (change === "wrong attempt") {
        producer.run_attempt = 2;
      } else {
        producer.steps![change === "dispatch upload" ? 0 : 1]!.conclusion = "failure";
      }
      f.setJobs(10, 1, [producer]);
      await expect(
        verifyClawHubPostpublish({
          ...f.options,
          parent,
          parentStatePolicy: "sealed-producer",
        }),
      ).rejects.toThrow(/producer (job|step)/u);
      expect(f.registryReads).toEqual([]);
    },
  );

  it("verifies historical successful publishers without recovery manifests", async () => {
    const f = fixture();
    f.setArtifacts(20, [f.metadata.get("actions/artifacts/2"), f.packageArtifact]);
    expect(await verifyClawHubPostpublish(f.options)).toMatchObject({
      complete: true,
      packages: [expect.objectContaining({ inventoryDigest: f.entry.inventoryDigest })],
    });
    expect(f.registryReads.length).toBeGreaterThan(0);
    expect(f.registryReads.some((url) => url.endsWith("/publication"))).toBe(false);
    await expect(
      verifyClawHubPostpublish({ ...f.options, verifyPublication: false }),
    ).rejects.toThrow(/sealed ClawHub original attempt roster/u);
  });

  it.each(["published", "failed", "replacement"])(
    "waits on the sealed original attempt before public readback: %s",
    async (outcome) => {
      const f = fixture();
      let publicationReads = 0;
      f.respond("/publication", () => {
        publicationReads += 1;
        const state =
          publicationReads === 1
            ? { state: "pending", stage: "finalization", attemptId: "attempt-1" }
            : outcome === "published"
              ? { state: "published" }
              : outcome === "failed"
                ? { state: "failed", recoverable: false, attemptId: "attempt-1" }
                : { state: "pending", stage: "checks", attemptId: "replacement" };
        return Response.json({ name: f.entry.name, version: f.entry.version, ...state });
      });
      f.respond(encodeURIComponent(f.entry.name), () =>
        publicationReads === 2 && outcome === "published"
          ? undefined
          : Response.json({ package: { tags: { latest: "2026.8.1" } } }),
      );
      const options = f.options;
      if (outcome === "published") {
        expect((await verifyClawHubPostpublish(options)).complete).toBe(true);
        expect(f.registryReads.length).toBeGreaterThan(0);
      } else {
        await expect(verifyClawHubPostpublish(options)).rejects.toThrow(
          outcome === "failed" ? /publication failed/u : /sealed attempt/u,
        );
        expect(f.registryReads).toEqual([]);
        expect(
          JSON.parse(readFileSync(join(options.outputDir, "evidence.json"), "utf8")),
        ).toMatchObject({
          complete: false,
        });
      }
      expect(publicationReads).toBe(2);
      expect(sleep).toHaveBeenCalledExactlyOnceWith(10_000);
    },
  );

  it.each(["published", "pending"])(
    "reads authoritative completion after an earlier batch exhausts the wait budget: %s",
    async (state) => {
      const entry = { name: "@openclaw/example", version: "2026.8.2", attemptId: "attempt-1" };
      const publication =
        state === "published"
          ? { state }
          : { state, stage: "finalization", attemptId: entry.attemptId };
      const fetchImpl = vi.fn(async () =>
        Response.json({
          name: entry.name,
          version: entry.version,
          ...publication,
        }),
      );
      const onState = vi.fn();
      const observation = waitForClawHubPublicVersion(entry, {
        deadline: Date.now() - 1,
        fetchImpl,
        onState,
      });
      if (state === "published") {
        await expect(observation).resolves.toBeUndefined();
      } else {
        await expect(observation).rejects.toThrow(
          /attempt attempt-1.*Retry postpublish verification/u,
        );
      }
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(onState).toHaveBeenCalledWith(publication);
      expect(sleep).not.toHaveBeenCalled();
    },
  );

  it("finds exact package producers beyond the first job page", async () => {
    const f = fixture();
    const parent = { ...f.parent, status: "completed", conclusion: "failure" };
    f.metadata.set("actions/runs/10/attempts/1", parent);
    sealParent(f);
    const firstPage = Array.from({ length: 100 }, (_, index) => job(`Unrelated job ${index}`));
    const original = f.metadata.get(jobsPath(20, 1)) as {
      jobs: unknown[];
    };
    f.setJobs(20, 1, firstPage, 103);
    f.setJobs(20, 1, original.jobs, 103, 2);
    const result = await verifyClawHubPostpublish({
      ...f.options,
      parent,
      parentStatePolicy: "sealed-producer",
    });
    expect(result.complete).toBe(true);
    expect(
      f.githubReads.filter((path) => path.includes("actions/runs/20/attempts/1/jobs")),
    ).toEqual([
      "actions/runs/20/attempts/1/jobs?per_page=100&page=1",
      "actions/runs/20/attempts/1/jobs?per_page=100&page=2",
    ]);
  });

  it.each([
    { label: "protected-tag parent", parentOnMain: false, status: "identical" },
    { label: "main parent and protected-tag child", parentOnMain: true, status: "ahead" },
  ])(
    "reads authorized bytes using bounded ancestry without commits for $label",
    async ({ parentOnMain, status }) => {
      const verifierSha = status === "identical" ? sha : "c".repeat(40);
      const f = fixture(parentOnMain, verifierSha);
      const comparison = `compare/${sha}...${verifierSha}`;
      f.metadata.set(`${comparison}?per_page=1&page=2`, { status, commits: [] });
      const result = await verifyClawHubPostpublish(f.options);
      expect(result.complete).toBe(true);
      expect(result.packages).toHaveLength(1);
      expect(result.packages[0]).toMatchObject({
        inventoryDigest: f.entry.inventoryDigest,
        publicationAuthentication: "not-verified",
      });
      expect(f.registryReads.length).toBeGreaterThan(0);
      expect(f.githubReads.filter((path) => path.startsWith("compare/"))).toEqual([
        `${comparison}?per_page=1&page=2`,
      ]);
    },
  );

  it.each(["success", "revoked child", "changed output"])(
    "resumes a failed public readback with retained downloads: %s",
    async (outcome) => {
      const f = fixture();
      let publicReadbackAvailable = false;
      f.respond("/artifact/download", () =>
        publicReadbackAvailable ? undefined : new Response(null, { status: 403 }),
      );
      const options = f.options;
      await expect(verifyClawHubPostpublish(options)).rejects.toThrow(/HTTP 403/u);
      const tarballPath = join(options.outputDir, "3", "example.tgz");
      expect(readFileSync(tarballPath)).toEqual(f.tarball);
      expect(f.requests.filter((url) => url.endsWith("/zip"))).toHaveLength(5);
      f.requests.length = 0;
      f.registryReads.length = 0;
      publicReadbackAvailable = true;
      if (outcome === "revoked child") {
        f.child.conclusion = "cancelled";
        await expect(verifyClawHubPostpublish(options)).rejects.toThrow(/authorized state/u);
        expect(f.registryReads).toEqual([]);
      } else if (outcome === "changed output") {
        writeFileSync(tarballPath, "changed local bytes");
        await expect(verifyClawHubPostpublish(options)).rejects.toThrow(
          /Retained ClawHub package bytes mismatch/u,
        );
        expect(readFileSync(tarballPath, "utf8")).toBe("changed local bytes");
        expect(f.registryReads).toEqual([]);
      } else {
        expect((await verifyClawHubPostpublish(options)).complete).toBe(true);
      }
      expect(f.requests.filter((url) => url.endsWith("/zip"))).toEqual([]);
      expect(
        f.requests.filter((url) => /\/actions\/runs\/(10|20)\/attempts\/1$/u.test(url)),
      ).toEqual([
        `/repos/${repository}/actions/runs/10/attempts/1`,
        `/repos/${repository}/actions/runs/20/attempts/1`,
      ]);
    },
  );

  it.each([
    {
      label: "non-ancestor status",
      response: () => Response.json({ status: "behind", commits: [] }),
      error: "Parent tooling is not an ancestor of trusted verification tooling.",
    },
    {
      label: "oversized response",
      response: () => Response.json({ status: "ahead", message: "x".repeat(2 * 1024 * 1024) }),
      error: "GitHub postpublish response body exceeded 2097152 bytes",
    },
    {
      label: "HTTP failure",
      response: () => new Response(null, { status: 404 }),
      error: "GitHub postpublish read returned HTTP 404.",
    },
  ])(
    "rejects a comparison $label before registry reads or evidence",
    async ({ response, error }) => {
      const f = fixture();
      const comparison = `compare/${sha}...${sha}`;
      for (const path of [comparison, `${comparison}?per_page=1&page=2`]) {
        f.metadata.set(path, response());
      }
      await rejectsBeforeRegistry(f, error, true);
    },
  );

  it.each([
    { runId: 20, patch: { conclusion: "failure" }, error: /authorized state/u },
    { runId: 10, patch: { run_attempt: 2 }, error: /runAttempt mismatch/u },
  ])("rejects changed run authority before registry reads: %j", async ({ runId, patch, error }) => {
    const f = fixture();
    f.metadata.set(`actions/runs/${runId}/attempts/1`, {
      ...(runId === 10 ? f.parent : f.child),
      ...patch,
    });
    await rejectsBeforeRegistry(f, error);
  });

  it("does not mistake a missing dispatch record for an empty release", async () => {
    const f = fixture();
    f.setArtifacts(10, []);
    await rejectsBeforeRegistry(f, /dispatch record/u);
  });

  it("rejects a different parent-approved inventory even when all archive digests verify", async () => {
    const f = fixture();
    const receipt = {
      ...f.receipt,
      packages: [{ ...f.receipt.packages[0], inventoryDigest: "f".repeat(64) }],
    };
    replaceJsonArtifact(f, f.receiptArtifact, "authorization.json", receipt);
    await rejectsBeforeRegistry(f, /Parent authorization packages mismatch/u);
  });

  it("rejects package archive substitution before contacting the registry", async () => {
    const f = fixture();
    const corrupted = Buffer.from(f.archives.get(3)!);
    corrupted.writeUInt32LE(0, 0);
    f.archives.set(3, corrupted);
    await expect(verifyClawHubPostpublish(f.options)).rejects.toThrow(/digest/u);
    expect(f.requests.filter((url) => url.endsWith("/actions/artifacts/3/zip"))).toHaveLength(1);
    expect(f.registryReads).toEqual([]);
  });
});
