import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  createPublicationAdmission,
  createPublicationSourceFact,
  validatePublicationAdmissionBinding,
} from "../../scripts/full-release-publication-contract.mjs";
import {
  RECEIPT_RECOVERY_SCHEMA,
  RECEIPT_RECOVERY_WORKFLOW,
  receiptRecoverySourceRequest,
  revalidateReceiptRecoveryRuns,
  validateReceiptRecoveryRequest,
  verifyOriginalReceiptQualification,
} from "../../scripts/full-release-receipt-recovery.mjs";
import { retainedPublicationArtifactSource } from "../../scripts/lib/release-evidence-identity.mjs";
import { validateFullReleaseNpmPreflight } from "../../scripts/npm-preflight-tooling-identity.mjs";
import { candidatePublicationFixture } from "./candidate-publication.test-support.js";

const roles = ["normalCi", "pluginPrereleaseIndependent", "releaseChecksIndependent", "releaseChecksCandidate", "pluginPrereleaseCandidate"];
function fixture() {
  const old = candidatePublicationFixture();
  const producer = { runId: "900", runAttempt: 1, fullRef: "refs/heads/main", sha: "c".repeat(40) };
  const source = createPublicationSourceFact(
    receiptRecoverySourceRequest(old.admission.receipt, producer),
    { packages: [], platforms: [] }, old.source.projection,
  );
  const recovery = {
    schema: RECEIPT_RECOVERY_SCHEMA, requestId: "12345678-1234-4123-8123-123456789abc",
    repository: old.repository, qualificationAdmission: old.admission.descriptor,
    originalParent: { runId: old.runId, runAttempt: 1 },
    candidateBinding: { request: { targetSha: old.q, toolingSha: old.q }, producer: { runId: "901", runAttempt: 1 } },
    children: Object.fromEntries(roles.map((role, index) => [role, { runId: String(910 + index), runAttempt: 1, workflowRef: old.branch }])),
    publicationArtifacts: { ...old.manifest.publicationArtifacts, pluginNpm: { runId: "902", runAttempt: 1 } },
  };
  const manifest = { ...old.manifest, runId: producer.runId, workflowSha: producer.sha,
    workflowFullRef: producer.fullRef, workflowRef: "main", sourceAdmission: source,
    receiptRecovery: recovery };
  return { old, producer, source, recovery, manifest };
}

describe("receipt-backed aggregate recovery", () => {
  it("retains original selection, baselines and Q artifacts under a distinct P admission", () => {
    const { old, source, recovery, manifest, producer } = fixture();
    expect(validateReceiptRecoveryRequest(recovery)).toBe(recovery);
    expect(source.candidateSha).toBe(old.q);
    expect(source.workflow).toEqual({ ref: producer.fullRef, sha: producer.sha });
    expect(source.publicationSelection).toEqual(old.source.publicationSelection);
    expect(source.coverage).toEqual(old.source.coverage);
    expect(source.qualificationAdmission).toBeUndefined();
    expect(retainedPublicationArtifactSource(manifest)?.workflow.sha).toBe(old.q);
    const qualified = validateFullReleaseNpmPreflight({ manifest, repository: old.repository,
      runId: producer.runId, runAttempt: 1, sourceSha: old.q, toolingSha: producer.sha });
    expect(qualified.producer).toEqual(old.npmQualified.producer);
    expect(() => validateFullReleaseNpmPreflight({ manifest, repository: old.repository,
      runId: producer.runId, runAttempt: 1, sourceSha: "d".repeat(40), toolingSha: producer.sha })).toThrow();
  });

  it("requires a new explicit admission path and never loosens the historical default", () => {
    const { old, source } = fixture();
    const observations = { ...old.manifest.publicationAdmission.observations, sourceDigest: source.digest };
    const admission = createPublicationAdmission(source, observations, {
      id: "940", name: "full-release-publication-observations-900-1",
      digest: "sha256:" + "e".repeat(64), sizeInBytes: 1024,
    }, observations.collectionCompletedAt, { workflowPath: RECEIPT_RECOVERY_WORKFLOW });
    const record = { sourceAdmissionContract: "1", sourceAdmission: source,
      publicationAdmissionContract: "1", publicationAdmission: admission };
    expect(() => validatePublicationAdmissionBinding(record)).toThrow();
    expect(validatePublicationAdmissionBinding(record, { workflowPath: RECEIPT_RECOVERY_WORKFLOW })).toEqual(admission);
    expect(() => createPublicationAdmission(source, observations, admission.binding.artifact,
      observations.collectionCompletedAt, { workflowPath: ".github/workflows/ci.yml" })).toThrow();
  });

  it.each(["parent identity", "required jobs"])("rejects changed original %s through the receipt owner", async (fault) => {
    const { old, recovery } = fixture();
    const baselines = JSON.parse(JSON.parse(old.admission.receipt.request.inputs.trusted_workflow_json).laneInputs.qualification_baselines_json);
    const request = { ...recovery, candidateBinding: { ...recovery.candidateBinding,
      request: { ...recovery.candidateBinding.request, ...baselines, releaseProfile: "beta", releaseSoak: false },
      package: { version: old.admission.receipt.baselinePolicy.candidateVersion },
    } };
    const callsBefore = old.admission.calls.length;
    const client = { ...old.client,
      getRunAttempt: (id: string, attempt: number) => {
        expect([id, attempt]).toEqual([old.runId, 1]);
        return { ...old.parent, head_sha: fault === "parent identity" ? "f".repeat(40) : old.q };
      },
      getRunAttemptJobs: async () => [],
    };
    await expect(verifyOriginalReceiptQualification(request, { client })).rejects.toThrow(
      fault === "parent identity" ? "original parent differs" : "required job did not succeed exactly once",
    );
    // This is the real admission verifier and immutable archive, not a supplied
    // successful strict-verifier result. Failure occurs before candidate download.
    expect(old.admission.calls.slice(callsBefore)).toContain(`repos/${old.repository}/actions/artifacts/70`);
  });

  it("rejects historical-plan substitution and incomplete role selection", () => {
    const { recovery } = fixture();
    expect(() => validateReceiptRecoveryRequest({ ...recovery, executionPlan: {} })).toThrow();
    const missing = structuredClone(recovery);
    delete missing.children.normalCi;
    expect(() => validateReceiptRecoveryRequest(missing)).toThrow();
  });

  it("rechecks every current producer tuple and rejects a superseding attempt", async () => {
    const { recovery, old } = fixture();
    const calls: string[] = [];
    const client = { getRun: async (id: string) => {
      calls.push(id);
      return { id: Number(id), run_attempt: 1, head_sha: old.q, status: "completed", conclusion: "success" };
    } };
    await revalidateReceiptRecoveryRuns(recovery, client);
    expect(new Set(calls).size).toBe(8);
    await expect(revalidateReceiptRecoveryRuns(recovery, { getRun: async (id: string) => ({
      ...await client.getRun(id), run_attempt: id === recovery.children.normalCi.runId ? 2 : 1,
    }) })).rejects.toThrow("current attempt changed");
  });

  it("exposes only a read-authorized aggregate workflow with no qualification fallback", () => {
    const workflow = parse(readFileSync(RECEIPT_RECOVERY_WORKFLOW, "utf8"));
    expect(workflow.permissions).toEqual({ actions: "read", contents: "read" });
    expect(Object.keys(workflow.jobs)).toEqual(["aggregate"]);
    const steps = workflow.jobs.aggregate.steps;
    expect(steps.filter((step: { run?: string }) => step.run?.includes("full-release-receipt-recovery.mjs")).map((step: { run: string }) => step.run))
      .toEqual(["node scripts/full-release-receipt-recovery.mjs admit", "node scripts/full-release-receipt-recovery.mjs seal"]);
    expect(steps.some((step: { uses?: string }) => step.uses?.includes("full-release-validation"))).toBe(false);
  });
});
