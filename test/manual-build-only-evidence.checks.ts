import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createClient } from "../scripts/frv.mjs";
import {
  buildReleaseExecutionPlan,
  buildReleaseStateArtifact,
  classifyReleaseSnapshot,
  releaseExecutionPlanSha256,
  validateReleaseExecutionPlanArtifact,
  verifyReleaseStateArtifacts,
} from "../scripts/full-release-validation-policy.mjs";
import {
  fastTrackRequestDigest,
  type FastTrackRequest,
} from "../scripts/lib/release-fast-track-contract.mts";
import {
  fastTrackValidationSnapshot,
  releaseFastTrackDigest,
  type FastTrackJob,
} from "../scripts/lib/release-fast-track-publication.mts";
import {
  downloadFullReleaseNpmPreflight,
  verifyNpmPreflightPublicationLineage,
} from "../scripts/npm-preflight-tooling-identity.mjs";
import {
  requiredChildKeysForRerunGroup,
  parseReleaseCiSummaryArgs,
  validateReleaseBuildOnlyEvidence,
  validateReleaseRunEvidence,
} from "../scripts/release-ci-summary.mjs";
import { candidatePublicationFixture } from "./scripts/candidate-publication.test-support.js";

function evidenceOptions(f: ReturnType<typeof candidatePublicationFixture>) {
  return {
    repository: f.repository,
    runId: f.runId,
    trustedWorkflowFullRef: f.publisherFullRef,
    trustedWorkflowRef: f.publisherFullRef.replace(/^refs\/(?:heads|tags)\//u, ""),
    trustedWorkflowSha: f.p,
    verifierSourceSha: f.p,
    verifierSourceContent: readFileSync("scripts/release-ci-summary.mjs"),
  };
}

async function approvedBuildOnly(f: ReturnType<typeof candidatePublicationFixture>) {
  const jobs: FastTrackJob[] = (await f.client.getRunAttemptJobs(f.runId)).map((job) => ({
    name: job.name,
    jobId: String(job.id),
    runId: f.runId,
    runAttempt: "1",
    status: job.conclusion === "skipped" ? "skipped" : "passed",
  }));
  const snapshot = fastTrackValidationSnapshot(f.manifest, jobs);
  const request: FastTrackRequest = {
    schemaVersion: 1,
    policy: "approved-partial-frv-v1",
    action: "Approve publication with incomplete validation",
    reason: "Accept all explicitly skipped validation for these exact sealed artifacts.",
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
      outstandingChecks: snapshot.outstandingChecks.flatMap((job) =>
        job.status === "passed"
          ? []
          : [
              {
                name: job.name,
                jobId: job.jobId,
                runId: job.runId,
                runAttempt: job.runAttempt,
                status: job.status,
              },
            ],
      ),
      runId: f.runId,
      runAttempt: "1",
      candidateSha: f.c,
      capturedAt: "2026-08-28T12:05:00.000Z",
      evidenceUrl: `https://github.com/openclaw/openclaw/actions/runs/${f.runId}`,
    },
  };
  return {
    request,
    digest: fastTrackRequestDigest(request),
  };
}

it("build-only retains frozen coverage but executes no validation children, with mandatory artifact gates and a verifiable empty drain", () => {
  const f = candidatePublicationFixture({ rerunGroup: "build-only" });
  const built = buildReleaseExecutionPlan({
    parentRunId: f.runId,
    parentRunAttempt: 1,
    rerunGroup: "build-only",
    releaseProfile: "beta",
    qualificationCoverage: f.admission.receipt.coverage,
    workflowRef: f.branch,
    workflowSha: f.q,
    childPhaseVersion: 3,
    candidateRequired: true,
    pluginNpmPreflightRequired: true,
    resolveTargetResult: "success",
    npmPreparationResult: "success",
    npmQualificationResult: "success",
    pluginNpmPreparationResult: "success",
    dockerPreparationResult: "success",
    candidateAcquisitionResult: "success",
  });
  expect(built.children.length).toBeGreaterThan(0);
  expect(
    built.children.every(
      (child) => !child.selected && !child.required && !child.runId && child.result === "skipped",
    ),
  ).toBe(true);
  expect(built.gates.filter((gate) => gate.required).map((gate) => gate.name)).toEqual([
    "Resolve target ref",
    "Prepare release npm artifacts",
    "Qualify release npm artifacts",
    "Prepare exact plugin npm artifacts",
    "Prepare release Docker artifacts",
    "Acquire full release candidate",
  ]);
  expect(requiredChildKeysForRerunGroup("build-only")).toEqual(new Set());
  expect(() => requiredChildKeysForRerunGroup("not-a-group")).toThrow("rerun group is invalid");
  const expected = {
    parentRunId: f.runId,
    parentRunAttempt: 1,
    targetSha: f.c,
    workflowRef: f.branch,
    workflowSha: f.q,
  };
  const decision = classifyReleaseSnapshot({
    children: f.plan.children,
    targetSha: f.c,
    targetVersion: f.plan.targetVersion,
  });
  const state = (mode: "decision" | "drain") =>
    buildReleaseStateArtifact({
      children: f.plan.children,
      decision,
      executionPlan: f.plan,
      expected,
      mode,
      releaseProfile: "beta",
      rerunGroup: "build-only",
    });
  const verified = verifyReleaseStateArtifacts(f.plan, state("decision"), state("drain"), expected);
  expect(verified.drain.children).toEqual({});
  const changed = structuredClone(f.plan);
  Object.assign(changed.children[0]!, { selected: true, required: true });
  changed.sha256 = releaseExecutionPlanSha256(changed);
  expect(() => validateReleaseExecutionPlanArtifact(changed, expected)).toThrow(
    "required coverage changed",
  );
});

it("preparation authenticates direct C/Q/P without claiming qualification, publication authority, or a reusable baseline", async () => {
  const f = candidatePublicationFixture({ rerunGroup: "build-only" });
  const options = evidenceOptions(f);
  const prepared = await validateReleaseBuildOnlyEvidence(options, f.client);
  expect(prepared).toMatchObject({
    prepared: true,
    valid: false,
    publicationAuthorized: false,
    validation: { mode: "build-only" },
    current: { targetSha: f.c },
  });
  expect(prepared).not.toHaveProperty("fastTrack");
  await expect(validateReleaseRunEvidence(options, f.client)).rejects.toThrow(
    "not validated release evidence",
  );
  await expect(
    validateReleaseBuildOnlyEvidence({ ...options, expectedTargetSha: "e".repeat(40) }, f.client),
  ).rejects.toThrow("direct admitted artifact plan");
  const ordinary = candidatePublicationFixture();
  await expect(
    validateReleaseBuildOnlyEvidence(evidenceOptions(ordinary), ordinary.client),
  ).rejects.toThrow("direct admitted artifact plan");
});

it.each(["failed-seal", "missing-seal", "failed-parent", "missing-descriptor"])(
  "does not report build-only preparation ready for %s",
  async (failure) => {
    const f = candidatePublicationFixture({ rerunGroup: "build-only" });
    const client = {
      ...f.client,
      loadManifest: () => {
        const loaded = f.client.loadManifest();
        return {
          artifact: loaded.artifact,
          manifest:
            failure === "missing-descriptor"
              ? {
                  ...loaded.manifest,
                  publicationArtifacts: {
                    npmPreflight: f.manifest.publicationArtifacts.npmPreflight,
                  },
                }
              : loaded.manifest,
        };
      },
    };
    if (failure === "failed-parent") {
      client.getRun = async () => ({ ...f.parent, conclusion: "failure" });
      client.getRunView = async (id: string) => ({
        ...(await f.client.getRunView(id)),
        conclusion: "failure",
      });
    } else if (failure !== "missing-descriptor") {
      client.getRunAttemptJobs = async (id: string) => {
        const jobs = await f.client.getRunAttemptJobs(id);
        return failure === "missing-seal"
          ? jobs.filter((job) => job.name !== "Qualify release npm artifacts")
          : jobs.map((job) =>
              job.name === "Qualify release npm artifacts"
                ? Object.assign({}, job, { conclusion: "failure" })
                : job,
            );
      };
    }
    await expect(validateReleaseBuildOnlyEvidence(evidenceOptions(f), client)).rejects.toThrow(
      failure === "failed-parent"
        ? "not completed/success"
        : failure === "missing-descriptor"
          ? "sealed descriptors"
          : "required job did not succeed",
    );
  },
);

it("admits build-only publication only with an exact exception request while retaining all skipped validation", async () => {
  const f = candidatePublicationFixture({ rerunGroup: "build-only" });
  const packet = await approvedBuildOnly(f);
  const evidence = await validateReleaseRunEvidence(
    { ...evidenceOptions(f), fastTrackRequest: packet },
    f.client,
  );
  expect(evidence).toMatchObject({
    valid: true,
    fastTrack: {
      disposition: "validation skipped by approved fast-track",
      snapshot: { summary: { skipped: f.plan.children.length } },
    },
  });
  expect(evidence.current.manifest.rerunGroup).toBe("build-only");
  expect(evidence.current.manifest.childEvidence).toEqual({});
  const operation = {
    manifest: f.manifest,
    repository: f.repository,
    sourceSha: f.c,
    toolingSha: f.q,
    publisherSha: f.p,
    publisherFullRef: f.publisherFullRef,
    producerRunId: f.npmQualified.producer.runId,
    producerRunAttempt: f.npmQualified.producer.runAttempt,
    evidenceClient: f.client,
    fastTrackRequest: packet,
  };
  expect(await verifyNpmPreflightPublicationLineage(operation)).toEqual(f.npmQualified);
  const directory = mkdtempSync(join(tmpdir(), "build-only-download-"));
  try {
    const archivePath = join(directory, "archive.zip");
    writeFileSync(archivePath, f.npmArchive);
    const outputDir = join(directory, "sealed");
    await downloadFullReleaseNpmPreflight({
      manifest: f.manifest,
      repository: f.repository,
      sourceSha: f.c,
      toolingSha: f.q,
      runId: f.runId,
      runAttempt: 1,
      fastTrackRequest: packet,
      runGh: f.runGh,
      token: "fixture-token",
      fetchImpl: async (input) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const route = `https://api.github.com/repos/${f.repository}/actions/artifacts/${f.npmArtifact.id}`;
        if (url === route) {
          return Response.json(f.npmArtifact);
        }
        if (url === `${route}/zip`) {
          return new Response(Uint8Array.from(f.npmArchive));
        }
        throw new Error(`Unexpected artifact request: ${url}`);
      },
      archivePath,
      outputDir,
    });
    expect(readFileSync(join(outputDir, f.npmManifest.tarballName), "utf8")).toBe(f.npmBytes);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  const before = JSON.stringify(f.manifest);
  await expect(validateReleaseRunEvidence(evidenceOptions(f), f.client)).rejects.toThrow(
    "not validated release evidence",
  );
  expect(JSON.stringify(f.manifest)).toBe(before);
});

it("FRV verification returns real preparation evidence and refuses a failed seal without claiming validation", async () => {
  const f = candidatePublicationFixture({ rerunGroup: "build-only" });
  const client = createClient(f.repository, {
    execCommand: async (_command: string, args: string[]) => {
      const options = parseReleaseCiSummaryArgs(args.slice(1));
      const verify = options.buildOnlyPreparation
        ? validateReleaseBuildOnlyEvidence
        : validateReleaseRunEvidence;
      return JSON.stringify(await verify({ ...options, ...evidenceOptions(f) }, f.client));
    },
  });
  const result = await client.verify(f.runId, f.plan);
  expect(JSON.parse(String(result))).toMatchObject({
    prepared: true,
    valid: false,
    publicationAuthorized: false,
    validation: { mode: "build-only" },
  });
  Reflect.deleteProperty(f.manifest.publicationArtifacts, "npmPreflight");
  await expect(client.verify(f.runId, f.plan)).rejects.toThrow();
});
