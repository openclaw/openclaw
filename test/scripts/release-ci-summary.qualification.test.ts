import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  validateDockerReleaseManifest,
  verifyDockerReleaseProducer,
} from "../../scripts/docker-release-artifacts.mjs";
import {
  buildReleaseExecutionPlanArtifact,
  validateReleaseExecutionPlanArtifact,
} from "../../scripts/full-release-validation-policy.mjs";
import {
  downloadFullReleaseNpmPreflight,
  verifyNpmPreflightProducer,
  verifyNpmPreflightPublicationLineage,
} from "../../scripts/npm-preflight-tooling-identity.mjs";
import { validateReleaseRunEvidence } from "../../scripts/release-ci-summary.mjs";
import { verifyQualificationAdmission } from "../../scripts/release-qualification-admission.mjs";
import { authenticateFullReleaseValidationEvidence } from "../../scripts/validate-full-release-validation-evidence.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { candidatePublicationFixture } from "./candidate-publication.test-support.js";
import { fixture as admissionFixture } from "./release-qualification-admission.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const sha256 = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function consumers(
  f: ReturnType<typeof candidatePublicationFixture>,
  evidenceClient: Parameters<typeof validateReleaseRunEvidence>[1] = f.client,
) {
  return {
    npm: () =>
      verifyNpmPreflightPublicationLineage({
        manifest: f.manifest,
        repository: f.repository,
        sourceSha: f.q,
        toolingSha: f.q,
        publisherSha: f.p,
        publisherFullRef: f.publisherFullRef,
        producerRunId: f.runId,
        producerRunAttempt: "1",
        runGh: f.runGh,
        evidenceClient,
      }),
    docker: () =>
      verifyDockerReleaseProducer(f.docker, {
        publisherSha: f.p,
        publisherFullRef: f.publisherFullRef,
        fullReleaseManifest: f.manifest,
        readApi: f.readApi,
        evidenceClient,
      }),
  };
}

describe("candidate-owned publish consumer chain", () => {
  it.each(["same qualification", "changed candidate", "changed input", "changed P", "revoked P"])(
    "selects a direct admitted root across transport refs only for %s",
    async (scenario) => {
      const root = candidatePublicationFixture();
      const candidateSha = scenario === "changed candidate" ? "d".repeat(40) : root.q;
      const workflowRef = "release-ci/" + candidateSha.slice(0, 12) + "-456";
      const inputs = structuredClone(root.plan.qualificationInputs);
      inputs.ref = candidateSha;
      inputs.expected_sha = candidateSha;
      if (scenario === "changed input") {
        inputs.fail_fast = inputs.fail_fast === "true" ? "false" : "true";
      }
      assert(inputs.trusted_workflow_json);
      const envelope = JSON.parse(inputs.trusted_workflow_json);
      envelope.trustedWorkflow = {
        ref: workflowRef,
        fullRef: "refs/heads/" + workflowRef,
        sha: candidateSha,
      };
      inputs.trusted_workflow_json = JSON.stringify(envelope);
      const current = admissionFixture(true, {
        inputs,
        candidateSha,
        transportRef: workflowRef,
        candidateVersion: "2026.8.28-beta.1",
        policy: JSON.parse(readFileSync("scripts/lib/release-qualification-coverage.json", "utf8")),
        workflowSource: readFileSync(".github/workflows/full-release-validation.yml", "utf8"),
      });
      envelope.qualificationAdmission = current.descriptor;
      inputs.trusted_workflow_json = JSON.stringify(envelope);
      if (scenario === "revoked P") {
        current.authority.permission = "read";
      }
      const client = {
        ...root.client,
        verifyQualificationAdmission: (
          request: Parameters<typeof root.client.verifyQualificationAdmission>[0],
        ) =>
          request.workflowRef === workflowRef
            ? verifyQualificationAdmission({
                ...request,
                runGh: current.runGh,
                downloadArchive: current.archive,
              })
            : root.client.verifyQualificationAdmission(request),
      };
      const result = validateReleaseRunEvidence(
        {
          repository: root.repository,
          runId: root.runId,
          trustedWorkflowRef: root.publisherFullRef.slice("refs/tags/".length),
          trustedWorkflowFullRef: root.publisherFullRef,
          trustedWorkflowSha: root.p,
          verifierSourceSha: scenario === "changed P" ? "e".repeat(40) : root.p,
          verifierSourceContent: readFileSync("scripts/release-ci-summary.mjs"),
          reuseRequest: {
            targetSha: root.q,
            releaseProfile: root.manifest.releaseProfile,
            runReleaseSoak: root.manifest.runReleaseSoak,
            validationInputs: root.manifest.validationInputs,
          },
          qualificationReuse: {
            candidateSha,
            qualificationSha: candidateSha,
            workflowRef,
            descriptor: current.descriptor,
            inputs,
          },
        },
        client,
      );
      if (scenario === "same qualification") {
        const evidence = await result;
        expect(evidence).toMatchObject({
          valid: true,
          directRoot: true,
          root: { runId: root.runId, workflowRefProof: "candidate-owned-admission-v1" },
          conclusions: { allRequiredSucceeded: true },
        });
        expect(evidence.manifest.publicationArtifacts).toEqual(root.manifest.publicationArtifacts);
        expect(evidence.children.map((child) => child.runId)).toEqual(
          root.plan.children.map((child) => child.runId),
        );
      } else {
        await expect(result).rejects.toThrow(
          scenario === "revoked P" ? "qualification authority" : "exact admitted C/Q/P",
        );
      }
    },
  );

  it.each(["main-qualification", "diagnostic"] as const)(
    "never promotes authenticated %s evidence to publication",
    async (purpose) => {
      const f = candidatePublicationFixture({ purpose });
      await expect(
        validateReleaseRunEvidence(
          {
            repository: f.repository,
            runId: f.runId,
            verifierSourceSha: f.p,
            verifierSourceContent: readFileSync("scripts/release-ci-summary.mjs"),
          },
          f.client,
        ),
      ).resolves.toMatchObject({ valid: true });
      await expect(consumers(f).npm()).rejects.toThrow("publish-purpose");
      await expect(consumers(f).docker()).rejects.toThrow("publish-purpose");
    },
  );
  it.each(["exact", "changelog", "retained artifacts", "changed retained IDs"])(
    "retains the original admitted Q and child attempts through %s reuse",
    async (mode) => {
      const root = candidatePublicationFixture();
      const retainArtifacts = mode === "retained artifacts" || mode === "changed retained IDs";
      const current = candidatePublicationFixture({
        candidateSha: mode === "changelog" ? "d".repeat(40) : root.q,
        ...(retainArtifacts ? { transportRef: `release-ci/${root.q.slice(0, 12)}-456` } : {}),
        runId: "29071366026",
      });
      const policy =
        mode === "changelog" ? "changelog-only-release-v1" : "exact-target-full-validation-v1";
      const changedPaths = mode === "changelog" ? ["CHANGELOG.md"] : [];
      Object.assign(current.manifest, {
        childRuns: structuredClone(root.manifest.childRuns),
        childEvidence: structuredClone(root.manifest.childEvidence),
        evidenceReuse: {
          policy,
          runId: root.runId,
          selectedRunId: root.runId,
          evidenceSha: root.q,
          changedPaths,
          publication: {
            sourceAdmissionContract: "1",
            sourceAdmission: root.source,
            publicationAdmissionContract: "1",
            publicationAdmission: root.manifest.publicationAdmission,
          },
        },
      });
      if (retainArtifacts) {
        current.manifest.publicationArtifacts = structuredClone(root.manifest.publicationArtifacts);
        if (mode === "changed retained IDs") {
          current.manifest.publicationArtifacts.npmPreflight.producer.runId = "99991";
          current.manifest.publicationArtifacts.npmPreflight.artifact.runId = "99991";
          current.manifest.publicationArtifacts.docker.preparedRunId = "99992";
        }
      }
      current.plan.children = root.plan.children.map((child) =>
        Object.assign({}, child, { source: "reused" }),
      );
      current.plan.evidenceReuse = {
        requested: true,
        policy,
        rootRunId: root.runId,
        selectedRunId: root.runId,
        evidenceSha: root.q,
        changedPaths,
        runUrl: root.parent.html_url,
        sourceManifest: root.manifest,
      };
      // Use the producer boundary: its normalized reuse payload owns digest order.
      Object.assign(
        current.plan,
        buildReleaseExecutionPlanArtifact({ ...current.plan, expected: current.plan }),
      );
      const restored = validateReleaseExecutionPlanArtifact(current.plan);
      expect(validateReleaseExecutionPlanArtifact(restored).sha256).toBe(current.plan.sha256);
      current.manifest.executionPlanSha256 = current.plan.sha256;
      const selected = (id: string) => (id === current.runId ? current.client : root.client);
      const client = {
        ...current.client,
        getRun: (id: string) => selected(id).getRun(id),
        getRunView: (id: string) => selected(id).getRunView(id),
        getRunAttempt: (id: string, attempt: number) => selected(id).getRunAttempt(id, attempt),
        getParentJobs: (id: string) => selected(id).getParentJobs(id),
        getRunAttemptJobs: (id: string) => selected(id).getRunAttemptJobs(id),
        getJobLog: (id: number) => (id === 10902 ? current.client : root.client).getJobLog(id),
        loadManifest: (id: string) => selected(id).loadManifest(),
        loadExecutionPlan: (id: string) => selected(id).loadExecutionPlan(),
        loadExecutionPlanEvidence: (id: string) => selected(id).loadExecutionPlanEvidence(),
        verifyQualificationAdmission: (
          request: Parameters<typeof current.client.verifyQualificationAdmission>[0],
        ) =>
          (request.workflowRef === root.manifest.workflowRef
            ? root.client
            : current.client
          ).verifyQualificationAdmission(request),
        compareCommits: (base: string, head: string) => {
          expect([base, head]).toEqual([root.q, current.q]);
          return {
            status: "ahead",
            merge_base_commit: { sha: root.q },
            files: [{ filename: "CHANGELOG.md", status: "modified" }],
          };
        },
      };
      const validation = validateReleaseRunEvidence(
        {
          runId: current.runId,
          repository: root.repository,
          trustedWorkflowRef: current.publisherFullRef.slice("refs/tags/".length),
          trustedWorkflowFullRef: current.publisherFullRef,
          trustedWorkflowSha: current.p,
          verifierSourceSha: current.p,
          verifierSourceContent: readFileSync("scripts/release-ci-summary.mjs"),
        },
        client,
      );
      if (mode === "changed retained IDs") {
        await expect(validation).rejects.toThrow("Reused publication artifacts differ");
        return;
      }
      const result = await validation;
      expect(result.current.targetSha).toBe(current.q);
      expect(result.root.targetSha).toBe(root.q);
      expect(
        result.children.every((child) => child.workflowSha === root.q && child.runAttempt === 1),
      ).toBe(true);
      expect(result.conclusions.allRequiredSucceeded).toBe(true);
      const publication = consumers(
        retainArtifacts ? { ...root, manifest: current.manifest } : current,
        client,
      );
      await expect(publication.npm()).resolves.toEqual(
        retainArtifacts ? root.npmQualified : current.npmQualified,
      );
      await expect(publication.docker()).resolves.toBeDefined();
      if (mode === "changelog") {
        const staleArtifacts = consumers({ ...root, manifest: current.manifest }, client);
        await expect(staleArtifacts.npm()).rejects.toThrow(
          "Candidate-owned artifact source and qualification SHA differ",
        );
        await expect(staleArtifacts.docker()).rejects.toThrow(
          "Candidate-owned artifact source and qualification SHA differ",
        );
      }
    },
  );

  it("authenticates P admission, strict FRV, and both original artifact producers without Q ancestry", async () => {
    const f = candidatePublicationFixture();
    const before = JSON.stringify(f.manifest);
    const qualified = await authenticateFullReleaseValidationEvidence(
      {
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
        isTrustedMainAncestor: () => {
          throw new Error("Q must not require main ancestry");
        },
      },
      f.client,
    );
    expect(qualified.source).toBe("candidate-owned-admission-v1");
    await expect(consumers(f).npm()).resolves.toEqual(f.npmQualified);
    expect(
      verifyNpmPreflightProducer({
        manifest: f.npmManifest,
        manifestSha256: sha256(f.npmManifestBytes),
        repository: f.repository,
        workflowFullRef: f.tooling.fullRef,
        workflowSha: f.q,
        workflowPath: ".github/workflows/full-release-validation.yml",
        runId: f.runId,
        runAttempt: "1",
        fullReleaseManifest: f.manifest,
        fullReleaseRunId: f.runId,
        fullReleaseRunAttempt: "1",
        runGh: f.runGh,
      }).provenance,
    ).toBe("immutable-manifest");
    const outputDir = join(tempDirs.make("candidate-npm-consumption-"), "qualified");
    await downloadFullReleaseNpmPreflight({
      manifest: f.manifest,
      repository: f.repository,
      runId: f.runId,
      runAttempt: "1",
      sourceSha: f.q,
      toolingSha: f.q,
      outputDir,
      token: "test-artifact-token",
      runGh: f.runGh,
      fetchImpl: async (url) =>
        (typeof url === "string" ? url : url instanceof URL ? url.href : url.url).endsWith("/zip")
          ? new Response(new Uint8Array(f.npmArchive))
          : Response.json(f.npmArtifact),
    });
    expect(readFileSync(join(outputDir, "preflight-manifest.json"), "utf8")).toBe(
      f.npmManifestBytes,
    );
    expect(readFileSync(join(outputDir, "openclaw.tgz"), "utf8")).toBe(f.npmBytes);
    validateDockerReleaseManifest(f.docker, {
      repository: f.repository,
      sourceSha: f.q,
      tag: f.docker.tag,
      artifactName: f.docker.artifactName,
      runId: f.runId,
      runAttempt: "1",
    });
    expect((await consumers(f).docker()).manifest).toBe(f.docker);
    expect(JSON.stringify(f.docker, null, 2) + "\n").toBe(f.dockerBytes);
    expect(f.docker.architectures.map((entry) => entry.artifact.digest)).toEqual(
      f.payloadBytes.map((bytes) => "sha256:" + sha256(bytes)),
    );
    expect(JSON.stringify(f.manifest)).toBe(before);
    expect(f.admission.calls.some((call) => call.includes("compare/" + f.q))).toBe(false);
  });

  it.each([
    "P attempt",
    "P archive digest",
    "P archive bytes",
    "P revoked",
    "missing required gate",
  ])("rejects %s in both consumers before consuming publication artifacts", async (failure) => {
    const f = candidatePublicationFixture();
    if (failure === "P attempt") {
      f.admission.run.run_attempt = 2;
    }
    if (failure === "P archive digest") {
      f.admission.metadata.digest = "sha256:" + "f".repeat(64);
    }
    if (failure === "P archive bytes") {
      f.admission.archive().writeUInt8(f.admission.archive().readUInt8(0) ^ 1, 0);
    }
    if (failure === "P revoked") {
      f.admission.authority.permission = "read";
    }
    if (failure === "missing required gate") {
      const original = f.client.getRunAttemptJobs;
      f.client.getRunAttemptJobs = async (id: string) => (id === f.runId ? original(id) : []);
    }
    await expect(consumers(f).npm()).rejects.toThrow();
    await expect(consumers(f).docker()).rejects.toThrow();
  });

  it("rejects changed npm artifact digest and Docker payload or manifest bytes after real admission", async () => {
    const f = candidatePublicationFixture();
    await consumers(f).npm();
    f.npmArtifact.digest = "sha256:" + "f".repeat(64);
    expect(() =>
      verifyNpmPreflightProducer({
        manifest: f.npmManifest,
        manifestSha256: sha256(f.npmManifestBytes),
        repository: f.repository,
        workflowFullRef: f.tooling.fullRef,
        workflowSha: f.q,
        workflowPath: ".github/workflows/full-release-validation.yml",
        runId: f.runId,
        runAttempt: "1",
        fullReleaseManifest: f.manifest,
        fullReleaseRunId: f.runId,
        fullReleaseRunAttempt: "1",
        runGh: f.runGh,
      }),
    ).toThrow("artifact identity changed");
    f.dockerArtifacts[0]!.digest = "sha256:" + "f".repeat(64);
    await expect(consumers(f).docker()).rejects.toThrow("payload artifact changed");
    f.dockerArtifacts[0]!.digest = f.docker.architectures[0]!.artifact.digest;
    f.docker.architectures[0]!.images[0]!.imageDigest = "sha256:" + "e".repeat(64);
    await expect(consumers(f).docker()).rejects.toThrow("bytes differ");
  });
});
