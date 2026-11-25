import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  validateDockerReleaseManifest,
  verifyDockerReleaseProducer,
} from "../scripts/docker-release-artifacts.mjs";
import {
  buildReleaseStateArtifact,
  classifyReleaseSnapshot,
  composeReleaseAttemptJobs,
  composeReleaseChildAttemptEvidence,
} from "../scripts/full-release-validation-policy.mjs";
import { buildReleaseValidationManifest } from "../scripts/lib/full-release-manifest.mjs";
import {
  fastTrackRequestDigest,
  type FastTrackRequest,
} from "../scripts/lib/release-fast-track-contract.mts";
import {
  authenticateFastTrackPolicy,
  bindFastTrackPacket,
  fastTrackValidationSnapshot,
  releaseFastTrackDigest,
  type FastTrackJob,
} from "../scripts/lib/release-fast-track-publication.mts";
import { evaluateReleasePublishGates } from "../scripts/lib/release-publish-gates.mts";
import {
  resolveFullReleaseNpmPreflight,
  verifyNpmPreflightPublicationLineage,
} from "../scripts/npm-preflight-tooling-identity.mjs";
import { authenticateFullReleaseValidationEvidence } from "../scripts/validate-full-release-validation-evidence.mjs";
import { useAutoCleanupTempDirTracker } from "./helpers/temp-dir.js";
import { candidatePublicationFixture } from "./scripts/candidate-publication.test-support.js";

const roots = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.unstubAllEnvs());

async function partialPublication(rerun?: "bound" | "later") {
  const f = candidatePublicationFixture();
  const parent = { ...f.parent, conclusion: "failure" };
  const client = {
    ...f.client,
    getRun: async (id: string) => (id === f.runId ? parent : f.client.getRun(id)),
    getRunView: async (id: string) => ({
      ...(await f.client.getRunView(id)),
      conclusion: "failure",
    }),
    getRunAttemptJobs: async (id: string, _attempt = 1) => {
      const jobs = await f.client.getRunAttemptJobs(id);
      return id === f.runId
        ? [
            ...jobs,
            { ...jobs[0]!, id: 9901, name: "Synthetic validation gap", conclusion: "failure" },
          ]
        : jobs.map((job) => Object.assign({}, job, { id: Number(id) * 1000 + job.id }));
    },
  };
  const selectedChild = f.plan.children[0]!;
  if (rerun) {
    const originalRun = await f.client.getRun(selectedChild.runId);
    const laterRun = {
      ...originalRun,
      run_attempt: 2,
      triggering_actor: { login: "synthetic-human" },
    };
    const originals = await client.getRunAttemptJobs(selectedChild.runId);
    const first = [
      ...originals,
      { ...originals[0]!, id: 999900, name: "Unrerun failure", conclusion: "failure" },
    ];
    const second = originals.map((job) =>
      Object.assign({}, job, {
        id: job.id + 10000,
        started_at: "2026-07-11T01:00:00Z",
        completed_at: "2026-07-11T01:10:00Z",
      }),
    );
    const readRun = client.getRun;
    const readAttempt = client.getRunAttempt;
    const readJobs = client.getRunAttemptJobs;
    client.getRun = async (id: string) => (id === selectedChild.runId ? laterRun : readRun(id));
    client.getRunAttempt = (id: string, attempt: number) =>
      id === selectedChild.runId
        ? attempt === 1
          ? originalRun
          : laterRun
        : readAttempt(id, attempt);
    client.getRunAttemptJobs = async (id: string, attempt?: number) =>
      id === selectedChild.runId ? ((attempt ?? 1) === 1 ? first : second) : readJobs(id, attempt);
    if (rerun === "bound") {
      Object.assign(f.manifest.childEvidence, {
        [selectedChild.key]: composeReleaseChildAttemptEvidence({
          attempts: [
            { runAttempt: 1, jobs: first },
            { runAttempt: 2, jobs: second },
          ],
          expected: { ...selectedChild, plannedRunAttempt: 1, repository: f.repository },
          run: laterRun,
        }),
      });
    }
  }
  const jobs: FastTrackJob[] = [];
  for (const id of [
    f.runId,
    ...f.plan.children.filter((child) => child.selected && child.runId).map((child) => child.runId),
  ]) {
    const attempt = rerun === "bound" && id === selectedChild.runId ? 2 : 1;
    for (const job of await client.getRunAttemptJobs(id, attempt)) {
      jobs.push({
        name: job.name,
        jobId: String(job.id),
        runId: id,
        runAttempt: String(attempt),
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

it("admits a partial-FRV request without a chat approval URL through the publisher owner without turning its failure into success", async () => {
  const { f, client, packet, options } = await partialPublication();
  const original = JSON.stringify(f.manifest);
  await expect(authenticateFullReleaseValidationEvidence(options, client)).rejects.toThrow(
    "not completed/success",
  );
  const result = await authenticateFullReleaseValidationEvidence(
    { ...options, fastTrackRequest: packet },
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

it("carries a local exception request through npm lineage without relying on workflow environment", async () => {
  const { f, client, packet } = await partialPublication();
  vi.stubEnv("FAST_TRACK_REQUEST_JSON", "");
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
    fastTrackRequest: packet,
  });
  expect(qualified.producer.runId).toBe(f.npmQualified.producer.runId);
});

it("requires a fresh request when candidate, scope, artifact bytes, run attempt or expiry changes", async () => {
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
      bindFastTrackPacket(
        { ...packet, request, digest: fastTrackRequestDigest(request) },
        f.manifest,
      ),
    ).toThrow();
  }
  expect(() =>
    bindFastTrackPacket({ ...packet, digest: `sha256:${"0".repeat(64)}` }, f.manifest),
  ).toThrow("digest mismatch");
});

it("rejects a partial request that omits an observed validation failure", async () => {
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
        fastTrackRequest: { ...packet, request, digest: fastTrackRequestDigest(request) },
      },
      client,
    ),
  ).rejects.toThrow("all outstanding jobs");
});

it("does not make an unsealed publication artifact eligible, even with a matching exception packet", async () => {
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
    bindFastTrackPacket({ ...packet, request, digest: fastTrackRequestDigest(request) }, manifest),
  ).toThrow("npmPreflight");
});

it("reuses successfully sealed Docker bytes from an approved failed FRV but never a failed Docker seal", async () => {
  const { f, client, packet, options } = await partialPublication();
  vi.stubEnv("FAST_TRACK_REQUEST_JSON", JSON.stringify(packet));
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
        fastTrack: bindFastTrackPacket(packet, f.manifest),
        ...changedInput,
      }),
    ).toThrow("Fast-track request does not cover");
  }
});

it("digests full-size validation manifests beyond the source-admission byte cap", () => {
  // Real stable FRV manifests exceed 128 KiB (v2026.11.8: 337 KB).
  const childEvidence = { log: "x".repeat(300 * 1024) };
  const digest = releaseFastTrackDigest({ version: 4, childEvidence, runId: "1" });
  expect(digest).toMatch(/^sha256:[a-f0-9]{64}$/u);
  expect(releaseFastTrackDigest({ runId: "1", childEvidence, version: 4 })).toBe(digest);
});

it("recomputes the bounded delta against a shipped baseline release, not a previous fast-track", async () => {
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
  const f = candidatePublicationFixture({ candidateSha, releaseProfile: "stable" });
  assert(f.source.projection);
  const request: FastTrackRequest = {
    schemaVersion: 1,
    policy: "approved-fast-track-v1",
    action: "Approve skipping release validation",
    repository: f.repository,
    releaseTag: "v2026.8.28",
    channel: "latest",
    candidateSha,
    reference: {
      releaseTag: "v2026.8.27",
      targetSha: baselineSha,
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
    ).rejects.toThrow("published release that was not itself fast-tracked");
  }
  const wrongDelta = { ...request, delta: { commits: 1, added: 0, deleted: 0 } };
  await expect(
    authenticateFastTrackPolicy({
      ...operation,
      packet: { ...packet, request: wrongDelta, digest: fastTrackRequestDigest(wrongDelta) },
    }),
  ).rejects.toThrow("Publisher-computed delta");
});

it("admits a beta-prerelease fast-track without a baseline release or delta ceiling", async () => {
  const f = candidatePublicationFixture();
  const request: FastTrackRequest = {
    schemaVersion: 1,
    policy: "approved-fast-track-v1",
    action: "Approve skipping release validation",
    repository: f.repository,
    releaseTag: "v2026.8.28-beta.1",
    channel: "beta",
    candidateSha: f.c,
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
  const readPublishedRelease = vi.fn(() => {
    throw new Error("Beta fast-track must not require a baseline release");
  });
  // No Git history: the publisher must not measure a delta for beta prereleases.
  await expect(
    authenticateFastTrackPolicy({
      packet: { request, digest: fastTrackRequestDigest(request) },
      manifest: f.manifest,
      jobs: [],
      repositoryRoot: roots.make("fast-track-beta-no-history-"),
      readPublishedRelease,
    }),
  ).resolves.toMatchObject({ disposition: "validation skipped by approved fast-track" });
  expect(readPublishedRelease).not.toHaveBeenCalled();
});

it("generates truthful failed-decision evidence and validates it without passing the strict FRV verdict", async () => {
  const f = candidatePublicationFixture();
  const children = await Promise.all(
    f.plan.children
      .filter((planned) => planned.selected)
      .map(async (planned) => {
        const rawJobs = await f.client.getRunAttemptJobs(planned.runId);
        if (planned.key === "normalCi") {
          rawJobs.push(
            Object.assign({}, rawJobs[0], {
              id: 9901,
              name: "Synthetic validation failure",
              conclusion: "failure",
            }),
          );
        }
        const composite = composeReleaseAttemptJobs([{ jobs: rawJobs, runAttempt: 1 }], {
          plannedRunAttempt: 1,
          effectiveRunAttempt: 1,
        });
        return Object.assign({}, planned, {
          status: "completed",
          conclusion: planned.key === "normalCi" ? "failure" : "success",
          errors: [],
          jobs: composite.jobs,
          observedRunAttempts: [1],
          plannedRunAttempt: 1,
          compositeJobsSha256: composite.sha256,
          repository: f.repository,
          dispatchActor: "github-actions[bot]",
          triggeringActor: "github-actions[bot]",
        });
      }),
  );
  const decision = classifyReleaseSnapshot({
    children,
    releaseProfile: "beta",
    targetSha: f.c,
    targetVersion: "2026.8.28-beta.1",
  });
  expect(decision.state).toBe("blocked_complete");
  const expected = {
    parentRunId: f.runId,
    parentRunAttempt: 1,
    targetSha: f.c,
    workflowRef: f.branch,
    workflowSha: f.q,
  };
  const state = (mode: "decision" | "drain") =>
    buildReleaseStateArtifact({
      children,
      decision,
      executionPlan: f.plan,
      expected,
      mode,
      releaseProfile: "beta",
      rerunGroup: "all",
    });
  const drain = state("drain");
  const manifest = buildReleaseValidationManifest({
    plan: f.plan,
    drain,
    reusedManifest: undefined,
    context: {
      runId: f.runId,
      runAttempt: "1",
      workflowRef: f.branch,
      workflowSha: f.q,
      workflowFullRef: f.tooling.fullRef,
      workflowRefType: "branch",
      targetRef: f.c,
      releaseProfile: "beta",
      rerunGroup: "all",
      runReleaseSoak: "false",
      validationInputs: f.manifest.validationInputs,
      publicationArtifacts: f.manifest.publicationArtifacts,
    },
  });
  expect(manifest.childEvidence.normalCi?.jobs).toContainEqual(
    expect.objectContaining({
      name: "Synthetic validation failure",
      status: "completed",
      conclusion: "failure",
    }),
  );
  const root = roots.make("failed-frv-manifest-");
  const files = Object.fromEntries(
    Object.entries({ plan: f.plan, decision: state("decision"), drain, manifest }).map(
      ([name, payload]) => {
        const path = join(root, `${name}.json`);
        writeFileSync(path, JSON.stringify(payload));
        return [name, path];
      },
    ),
  );
  const env = {
    ...process.env,
    GITHUB_RUN_ID: f.runId,
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_REPOSITORY: f.repository,
    GITHUB_REF_NAME: f.branch,
    GITHUB_SHA: f.q,
    RELEASE_PROFILE: "beta",
    RERUN_GROUP: "all",
    TARGET_SHA: f.c,
    RELEASE_EXECUTION_PLAN_PATH: files.plan,
    RELEASE_DECISION_PATH: files.decision,
    DIAGNOSTIC_DRAIN_PATH: files.drain,
    RELEASE_VALIDATION_MANIFEST_PATH: files.manifest,
  };
  const validate = (mode: string) =>
    spawnSync(process.execPath, ["scripts/full-release-validation-state.mjs", mode], {
      env,
      encoding: "utf8",
      timeout: 10_000,
    });
  const evidence = validate("validate-manifest-evidence");
  expect(evidence.status, evidence.stderr).toBe(0);
  const strict = validate("validate-manifest");
  expect(strict.status).not.toBe(0);
  expect(strict.stderr).toContain("blocked_complete");
  expect(
    JSON.parse(readFileSync(files.manifest!, "utf8")).childEvidence.normalCi.jobs,
  ).toContainEqual(
    expect.objectContaining({ name: "Synthetic validation failure", conclusion: "failure" }),
  );
});

it("requires and accepts the complete partial-rerun snapshot with original attempt identity", async () => {
  const { f, client, packet, options } = await partialPublication("bound");
  await expect(
    authenticateFullReleaseValidationEvidence({ ...options, fastTrackRequest: packet }, client),
  ).rejects.toThrow("all outstanding jobs");
  assert(packet.request.policy === "approved-partial-frv-v1");
  const snapshot = packet.request.validationSnapshot;
  const request = {
    ...packet.request,
    validationSnapshot: {
      ...snapshot,
      summary: { ...snapshot.summary, failed: snapshot.summary.failed + 1 },
      outstandingChecks: [
        ...snapshot.outstandingChecks,
        {
          name: "Unrerun failure",
          jobId: "999900",
          runId: f.plan.children[0]!.runId,
          runAttempt: "1",
          status: "failed" as const,
        },
      ],
    },
  };
  const complete = { ...packet, request, digest: fastTrackRequestDigest(request) };
  await expect(
    authenticateFullReleaseValidationEvidence({ ...options, fastTrackRequest: complete }, client),
  ).resolves.toMatchObject({ evidence: { fastTrack: { digest: complete.digest } } });
});

it("authenticates the frozen child attempt after a later rerun", async () => {
  const { client, packet, options } = await partialPublication("later");
  await expect(
    authenticateFullReleaseValidationEvidence({ ...options, fastTrackRequest: packet }, client),
  ).resolves.toMatchObject({ evidence: { fastTrack: { digest: packet.digest } } });
});

it("resolves sealed inline npm bytes from failed FRV only for downstream fast-track authentication", () => {
  const f = candidatePublicationFixture();
  const read = (args: string[]) => {
    const endpoint = args.find((arg) => arg.startsWith("repos/"))!;
    const value = f.readApi(endpoint);
    return JSON.stringify(
      endpoint.endsWith(`/actions/runs/${f.runId}`) ||
        endpoint.endsWith(`/actions/runs/${f.runId}/attempts/1`)
        ? { ...value, conclusion: "failure" }
        : value,
    );
  };
  const operation = {
    manifest: f.manifest,
    repository: f.repository,
    runId: f.runId,
    runAttempt: "1",
    sourceSha: f.c,
    toolingSha: f.q,
    runGh: read,
  };
  expect(() => resolveFullReleaseNpmPreflight(operation)).toThrow("successful producer parent");
  expect(
    resolveFullReleaseNpmPreflight({
      ...operation,
      fastTrackRequest: "transport only; owner authenticates separately",
    }).producer.runId,
  ).toBe(f.runId);
  const failedSeal = (args: string[]) => {
    const value = JSON.parse(read(args));
    if (Array.isArray(value.jobs)) {
      value.jobs = value.jobs.map((job: { id: number }) =>
        job.id === 780 ? { ...job, conclusion: "failure" } : job,
      );
    }
    return JSON.stringify(value);
  };
  expect(() =>
    resolveFullReleaseNpmPreflight({
      ...operation,
      fastTrackRequest: "transport only",
      runGh: failedSeal,
    }),
  ).toThrow("completed producer job");
});
