import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  validateDockerReleaseManifest,
  verifyDockerReleaseProducer,
} from "../scripts/docker-release-artifacts.mjs";
import {
  fastTrackRequestDigest,
  type FastTrackRequest,
} from "../scripts/lib/release-fast-track-contract.mts";
import {
  authenticateFastTrackPolicy,
  bindFastTrackApproval,
  fastTrackValidationSnapshot,
  releaseFastTrackDigest,
  type FastTrackJob,
} from "../scripts/lib/release-fast-track-publication.mts";
import { evaluateReleasePublishGates } from "../scripts/lib/release-publish-gates.mts";
import { verifyNpmPreflightPublicationLineage } from "../scripts/npm-preflight-tooling-identity.mjs";
import { authenticateFullReleaseValidationEvidence } from "../scripts/validate-full-release-validation-evidence.mjs";
import { useAutoCleanupTempDirTracker } from "./helpers/temp-dir.js";
import { candidatePublicationFixture } from "./scripts/candidate-publication.test-support.js";

const roots = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.unstubAllEnvs());

async function partialPublication() {
  const f = candidatePublicationFixture();
  const parent = { ...f.parent, conclusion: "failure" };
  const client = {
    ...f.client,
    getRun: async (id: string) => (id === f.runId ? parent : f.client.getRun(id)),
    getRunView: async (id: string) => ({
      ...(await f.client.getRunView(id)),
      conclusion: "failure",
    }),
    getRunAttemptJobs: async (id: string) => {
      const jobs = await f.client.getRunAttemptJobs(id);
      return id === f.runId
        ? [
            ...jobs,
            { ...jobs[0]!, id: 9901, name: "Synthetic validation gap", conclusion: "failure" },
          ]
        : jobs.map((job) => Object.assign({}, job, { id: Number(id) * 1000 + job.id }));
    },
  };
  const jobs: FastTrackJob[] = [];
  for (const id of [
    f.runId,
    ...f.plan.children.filter((child) => child.selected && child.runId).map((child) => child.runId),
  ]) {
    for (const job of await client.getRunAttemptJobs(id)) {
      jobs.push({
        name: job.name,
        jobId: String(job.id),
        runId: id,
        runAttempt: "1",
        status: job.conclusion === "failure" ? "failed" : "passed",
      });
    }
  }
  const snapshot = fastTrackValidationSnapshot(f.manifest, jobs);
  const request: FastTrackRequest = {
    schemaVersion: 1,
    policy: "approved-partial-frv-v1",
    action: "Approve publication with incomplete validation",
    reason: "Accept the explicitly enumerated synthetic validation gap.",
    repository: f.repository,
    releaseTag: "v2026.8.28-beta.1",
    channel: "beta",
    candidateSha: f.c,
    reference: {
      releaseTag: "v2026.8.27",
      targetSha: "a".repeat(40),
      validationEvidenceDigest: `sha256:${"a".repeat(64)}`,
    },
    delta: { commits: 30, added: 16000, deleted: 2 },
    artifacts: [
      {
        name: "publication-artifacts",
        digest: releaseFastTrackDigest(f.manifest.publicationArtifacts),
      },
    ],
    publicationScope: [`publication:${releaseFastTrackDigest(f.source.publicationSelection)}`],
    run: { id: f.runId, attempt: "1" },
    requestId: "00000000-0000-4000-8000-000000000001",
    expiresAt: "2099-01-01T00:00:00.000Z",
    validationSnapshot: {
      ...snapshot,
      runId: f.runId,
      runAttempt: "1",
      candidateSha: f.c,
      capturedAt: "2026-08-28T12:05:00.000Z",
      evidenceUrl: `https://github.com/openclaw/openclaw/actions/runs/${f.runId}`,
      outstandingChecks: snapshot.outstandingChecks.map((job) =>
        Object.assign({}, job, { status: "failed" as const }),
      ),
    },
  };
  const packet = {
    request,
    digest: fastTrackRequestDigest(request),
    approval: {
      approver: "synthetic-human-release-manager",
      decidedAt: "2026-08-28T12:10:00.000Z",
      url: "https://chat.google.com/room/synthetic/approval",
    },
  };
  const options = {
    run: parent,
    manifest: f.manifest,
    expectedRepository: f.repository,
    expectedRunId: f.runId,
    expectedRunAttempt: 1,
    expectedTargetSha: f.c,
    expectedReleaseTag: request.releaseTag,
    expectedTrustedWorkflowFullRef: f.publisherFullRef,
    expectedTrustedWorkflowSha: f.p,
    expectedCoreNpmPublication: { npmDistTag: "beta" },
    verifierSourceSha: f.p,
    verifierSourceContent: readFileSync("scripts/release-ci-summary.mjs"),
  };
  return { f, client, packet, options };
}

it("admits the explicitly approved partial FRV through the publisher owner without turning its failure into success", async () => {
  const { f, client, packet, options } = await partialPublication();
  const original = JSON.stringify(f.manifest);
  await expect(authenticateFullReleaseValidationEvidence(options, client)).rejects.toThrow(
    "not completed/success",
  );
  const result = await authenticateFullReleaseValidationEvidence(
    { ...options, fastTrackApproval: packet },
    client,
  );
  expect(result.evidence.current.conclusion).toBe("failure");
  expect(result.evidence).toMatchObject({
    fastTrack: {
      disposition: "validation skipped by approved fast-track",
      digest: packet.digest,
      snapshot: { summary: { failed: 1 } },
    },
  });
  expect(result.forPublication(options).source).toBe("candidate-owned-admission-v1");
  expect(JSON.stringify(f.manifest)).toBe(original);
});

it("carries an explicit local approval through npm lineage without relying on workflow environment", async () => {
  const { f, client, packet } = await partialPublication();
  vi.stubEnv("FAST_TRACK_APPROVAL_JSON", "");
  const operation = {
    manifest: f.manifest,
    repository: f.repository,
    sourceSha: f.c,
    toolingSha: f.q,
    publisherSha: f.p,
    publisherFullRef: f.publisherFullRef,
    producerRunId: f.npmQualified.producer.runId,
    producerRunAttempt: f.npmQualified.producer.runAttempt,
    evidenceClient: client,
  };
  await expect(verifyNpmPreflightPublicationLineage(operation)).rejects.toThrow(
    "not completed/success",
  );
  const qualified = await verifyNpmPreflightPublicationLineage({
    ...operation,
    fastTrackApproval: packet,
  });
  expect(qualified.producer.runId).toBe(f.npmQualified.producer.runId);
});

it("requires fresh approval when candidate, scope, artifact bytes, run attempt or expiry changes", async () => {
  const { f, packet } = await partialPublication();
  for (const change of [
    { candidateSha: "b".repeat(40) },
    { publicationScope: ["npm:unapproved:latest"] },
    { artifacts: [{ name: "publication-artifacts", digest: `sha256:${"0".repeat(64)}` }] },
    { run: { id: f.runId, attempt: "2" } },
    { expiresAt: "2026-08-28T12:11:00.000Z" },
  ]) {
    const request = { ...packet.request, ...change };
    expect(() =>
      bindFastTrackApproval(
        { ...packet, request, digest: fastTrackRequestDigest(request) },
        f.manifest,
      ),
    ).toThrow();
  }
  expect(() =>
    bindFastTrackApproval({ ...packet, digest: `sha256:${"0".repeat(64)}` }, f.manifest),
  ).toThrow("digest mismatch");
});

it("rejects partial approval that omits an observed validation failure", async () => {
  const { client, packet, options } = await partialPublication();
  const request = {
    ...packet.request,
    validationSnapshot: {
      ...packet.request.validationSnapshot,
      summary: {
        ...packet.request.validationSnapshot.summary,
        passed: packet.request.validationSnapshot.summary.passed + 1,
      },
    },
  };
  await expect(
    authenticateFullReleaseValidationEvidence(
      {
        ...options,
        fastTrackApproval: { ...packet, request, digest: fastTrackRequestDigest(request) },
      },
      client,
    ),
  ).rejects.toThrow("all outstanding jobs");
});

it("does not make an unsealed publication artifact eligible, even with a matching human packet", async () => {
  const { f, packet } = await partialPublication();
  const manifest = { ...f.manifest, publicationArtifacts: {} };
  const request = {
    ...packet.request,
    artifacts: [
      {
        name: "publication-artifacts",
        digest: releaseFastTrackDigest(manifest.publicationArtifacts),
      },
    ],
  };
  expect(() =>
    bindFastTrackApproval(
      { ...packet, request, digest: fastTrackRequestDigest(request) },
      manifest,
    ),
  ).toThrow("npmPreflight");
});

it("reuses successfully sealed Docker bytes from an approved failed FRV but never a failed Docker seal", async () => {
  const { f, client, packet, options } = await partialPublication();
  vi.stubEnv("FAST_TRACK_APPROVAL_JSON", JSON.stringify(packet));
  const docker = validateDockerReleaseManifest(f.docker, {
    tag: f.docker.tag,
    sourceSha: f.c,
    repository: f.repository,
    artifactName: f.docker.artifactName,
    runId: f.runId,
    runAttempt: "1",
  });
  const readApi = (endpoint: string) =>
    endpoint.endsWith(`/actions/runs/${f.runId}`) ||
    endpoint.endsWith(`/actions/runs/${f.runId}/attempts/1`)
      ? options.run
      : f.readApi(endpoint);
  const operation = {
    publisherSha: f.p,
    publisherFullRef: f.publisherFullRef,
    fullReleaseManifest: f.manifest,
    evidenceClient: client,
    readApi,
  };
  const verified = await verifyDockerReleaseProducer(docker, operation);
  expect(verified.manifest.producer.runId).toBe(f.runId);
  await expect(
    verifyDockerReleaseProducer(docker, {
      ...operation,
      readApi: (endpoint: string) =>
        endpoint.endsWith("/actions/jobs/800")
          ? Object.assign({}, readApi(endpoint), { conclusion: "failure" })
          : readApi(endpoint),
    }),
  ).rejects.toThrow("Exact Docker preparation job has not completed successfully");
});

it("does not allow a valid packet to bypass a different actual publisher tag or source", async () => {
  const { f, packet } = await partialPublication();
  for (const changedInput of [
    { releaseTag: "v2026.8.28-beta.2" },
    { expectedSha: "c".repeat(40) },
  ]) {
    expect(() =>
      evaluateReleasePublishGates({
        manifest: f.manifest,
        releaseTag: packet.request.releaseTag,
        npmDistTag: "beta",
        consumer: "publisher",
        expectedSha: f.c,
        fastTrack: bindFastTrackApproval(packet, f.manifest),
        ...changedInput,
      }),
    ).toThrow("Fast-track approval does not cover");
  }
});

it("recomputes the bounded delta against a matching published fully validated baseline, not a previous fast-track", async () => {
  const root = roots.make("fast-track-publisher-baseline-");
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
    }).trim();
  git("init", "-b", "main");
  git("config", "user.name", "Synthetic proof");
  git("config", "user.email", "proof@example.invalid");
  git("config", "commit.gpgsign", "false");
  writeFileSync(join(root, "source.txt"), "baseline\n");
  git("add", "source.txt");
  git("commit", "-m", "baseline");
  const baselineSha = git("rev-parse", "HEAD");
  writeFileSync(join(root, "source.txt"), "baseline\nchange\n");
  git("add", "source.txt");
  git("commit", "-m", "candidate");
  const candidateSha = git("rev-parse", "HEAD");
  const f = candidatePublicationFixture({ candidateSha });
  assert(f.source.projection);
  const baselineManifest = {
    ...f.manifest,
    targetSha: baselineSha,
    sourceAdmission: { ...f.source, projection: { ...f.source.projection, version: "2026.8.27" } },
  };
  const reference = { current: { targetSha: baselineSha, manifest: baselineManifest } };
  const request: FastTrackRequest = {
    schemaVersion: 1,
    policy: "approved-fast-track-v1",
    action: "Approve skipping release validation",
    repository: f.repository,
    releaseTag: "v2026.8.28-beta.1",
    channel: "beta",
    candidateSha,
    reference: {
      releaseTag: "v2026.8.27",
      targetSha: baselineSha,
      validationEvidenceDigest: releaseFastTrackDigest(baselineManifest),
    },
    delta: { commits: 1, added: 1, deleted: 0 },
    artifacts: [
      {
        name: "publication-artifacts",
        digest: releaseFastTrackDigest(f.manifest.publicationArtifacts),
      },
    ],
    publicationScope: [`publication:${releaseFastTrackDigest(f.source.publicationSelection)}`],
    run: { id: f.runId, attempt: "1" },
    requestId: "00000000-0000-4000-8000-000000000001",
    expiresAt: "2099-01-01T00:00:00.000Z",
  };
  const packet = {
    request,
    digest: fastTrackRequestDigest(request),
    approval: {
      approver: "synthetic-human-release-manager",
      decidedAt: "2026-08-28T12:10:00.000Z",
      url: "https://chat.google.com/room/synthetic/approval",
    },
    referenceRunId: "99",
    referenceRunAttempt: "1",
  };
  const release = {
    draft: false,
    published_at: "2026-08-27T12:00:00.000Z",
    targetSha: baselineSha,
    fastTracked: false,
  };
  const operation = {
    packet,
    manifest: f.manifest,
    jobs: [],
    repositoryRoot: root,
    loadReference: async () => reference,
    readPublishedRelease: () => release,
  };
  await expect(authenticateFastTrackPolicy(operation)).resolves.toMatchObject({
    disposition: "validation skipped by approved fast-track",
  });
  for (const changedRelease of [
    { ...release, fastTracked: true },
    { ...release, targetSha: candidateSha },
    { ...release, draft: true },
  ]) {
    await expect(
      authenticateFastTrackPolicy({ ...operation, readPublishedRelease: () => changedRelease }),
    ).rejects.toThrow("published fully validated release");
  }
  const wrongDelta = { ...request, delta: { commits: 1, added: 0, deleted: 0 } };
  await expect(
    authenticateFastTrackPolicy({
      ...operation,
      packet: { ...packet, request: wrongDelta, digest: fastTrackRequestDigest(wrongDelta) },
    }),
  ).rejects.toThrow("Publisher-computed delta");
});
