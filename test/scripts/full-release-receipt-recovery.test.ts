import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import {
  createPublicationAdmission,
  validatePublicationAdmissionBinding,
} from "../../scripts/full-release-publication-contract.mjs";
import {
  authenticateReceiptRecovery,
  revalidateReceiptRecoveryRuns,
  validateReceiptRecoveryRequest,
  verifyOriginalReceiptQualification,
} from "../../scripts/full-release-receipt-recovery.mjs";
import {
  RECEIPT_RECOVERY_WORKFLOW,
  retainedPublicationArtifactSource,
} from "../../scripts/lib/release-evidence-identity.mjs";
import { validateFullReleaseNpmPreflight } from "../../scripts/npm-preflight-tooling-identity.mjs";
import { makeStoredZip } from "./actions-artifact-zip.test-support.js";
import { recoveryConsumptionFixture } from "./release-evidence-consumption.test-support.js";

function fixture(independentQ = false) {
  const test = recoveryConsumptionFixture(independentQ);
  return { ...test, old: { ...test.direct, client: test.client } };
}

const digest = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function aggregateFixture() {
  const test = fixture();
  const originalRead = vi.fn().mockRejectedValue(new Error("original qualification reached"));
  const downloads = vi.spyOn(test.client, "downloadArtifactArchive");
  const authenticate = () =>
    authenticateReceiptRecovery({
      manifest: test.manifest,
      run: test.run,
      client: { ...test.client, getRunAttempt: originalRead },
      artifact: test.aggregateArtifact,
      verifier: undefined,
      expectedRunAttempts: undefined,
    });
  return {
    ...test,
    steps: expectDefined(test.jobs.get("900"), "aggregate jobs")[0]!.steps,
    observations: test.manifest.publicationAdmission.observations,
    observationArtifact: expectDefined(test.metadata.get("444"), "observations"),
    originalRead,
    downloads,
    authenticate,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("receipt-backed aggregate recovery", () => {
  it("rejects a recovery title for a different request", async () => {
    const test = aggregateFixture();
    test.run.name = "Receipt Recovery 87654321-1234-4123-8123-123456789abc";
    await expect(test.authenticate()).rejects.toThrow("aggregate run identity differs");
    expect(test.originalRead).not.toHaveBeenCalled();
  });

  it.each(["failed seal", "reordered seal", "changed observations", "valid"] as const)(
    "authenticates aggregate seal and observation bytes before original qualification: %s",
    async (fault) => {
      const test = aggregateFixture();
      if (fault === "failed seal") {
        test.steps[2]!.conclusion = "failure";
      }
      if (fault === "reordered seal") {
        test.steps[2]!.number = 1;
      }
      if (fault === "changed observations") {
        // Rebind a real, internally consistent ZIP to different observation content.
        // The byte comparison, not a transport digest failure, must reject it.
        const changed = makeStoredZip({
          "publication-observations.json": JSON.stringify({
            ...test.observations,
            pendingAuthority: ["changed"],
          }),
        });
        test.observationArtifact.digest = "sha256:" + digest(changed);
        test.observationArtifact.size_in_bytes = changed.length;
        Object.assign(test.manifest.publicationAdmission!.binding.artifact, {
          digest: test.observationArtifact.digest,
          sizeInBytes: changed.length,
        });
        test.archives.set("444", changed);
      }
      await expect(test.authenticate()).rejects.toThrow(
        {
          "failed seal": "missing successful Seal receipt-backed aggregate",
          "reordered seal": "aggregate admission ordering changed",
          "changed observations": "fresh observation artifact bytes differ",
          valid: "original qualification reached",
        }[fault],
      );
      expect(test.originalRead).toHaveBeenCalledTimes(fault === "valid" ? 1 : 0);
      if (fault === "valid") {
        expect(test.downloads).toHaveBeenCalledWith(
          expect.objectContaining({
            expected: expect.objectContaining({ artifactId: 444 }),
          }),
        );
      }
    },
  );

  it("retains original selection, baselines and Q artifacts under a distinct P admission", () => {
    const { old, source, recovery, manifest, producer } = fixture(true);
    expectDefined(recovery.children.normalCi, "normal CI selection").workflowRef =
      "release-ci/earlier-normal-ci";
    expect(validateReceiptRecoveryRequest(recovery)).toBe(recovery);
    expect(source.candidateSha).toBe(old.c);
    expect(source.workflow).toEqual({ ref: producer.fullRef, sha: producer.sha });
    expect(source.publicationSelection).toEqual(old.source.publicationSelection);
    expect(source.coverage).toEqual(old.source.coverage);
    expect(source.qualificationAdmission).toBeUndefined();
    expect(retainedPublicationArtifactSource(manifest)?.workflow.sha).toBe(old.q);
    const expected = {
      manifest,
      repository: old.repository,
      runId: producer.runId,
      runAttempt: 1,
      sourceSha: old.c,
      toolingSha: producer.sha,
    };
    expect(validateFullReleaseNpmPreflight(expected).producer).toEqual(
      recovery.publicationArtifacts.npmPreflight.producer,
    );
    expect(() =>
      validateFullReleaseNpmPreflight({ ...expected, sourceSha: "d".repeat(40) }),
    ).toThrow();
  });

  it("requires a new explicit admission path and never loosens the historical default", () => {
    const { old, source } = fixture();
    const original = expectDefined(old.manifest.publicationAdmission, "admission");
    const observations = { ...original.observations, sourceDigest: source.digest };
    const admission = createPublicationAdmission(
      source,
      observations,
      { ...original.binding.artifact, name: "full-release-publication-observations-900-1" },
      observations.collectionCompletedAt,
      { workflowPath: RECEIPT_RECOVERY_WORKFLOW },
    );
    const record = {
      sourceAdmissionContract: "1",
      sourceAdmission: source,
      publicationAdmissionContract: "1",
      publicationAdmission: admission,
    };
    expect(() => validatePublicationAdmissionBinding(record)).toThrow();
    expect(
      validatePublicationAdmissionBinding(record, { workflowPath: RECEIPT_RECOVERY_WORKFLOW }),
    ).toEqual(admission);
    expect(() =>
      createPublicationAdmission(
        source,
        observations,
        admission.binding.artifact,
        observations.collectionCompletedAt,
        { workflowPath: ".github/workflows/ci.yml" },
      ),
    ).toThrow();
  });

  it.each(["parent identity", "required jobs"])(
    "rejects changed original %s through the receipt owner",
    async (fault) => {
      const { old, recovery } = fixture();
      const callsBefore = old.admission.calls.length;
      const client = {
        ...old.client,
        getRunAttempt: (id: string, attempt: number) => {
          expect([id, attempt]).toEqual([old.runId, 1]);
          return { ...old.parent, head_sha: fault === "parent identity" ? "f".repeat(40) : old.q };
        },
        getRunAttemptJobs: async () => [],
      };
      await expect(verifyOriginalReceiptQualification(recovery, { client })).rejects.toThrow(
        fault === "parent identity"
          ? "original parent differs"
          : "required job did not succeed exactly once",
      );
      // This is the real admission verifier and immutable archive, not a supplied
      // successful strict-verifier result. Failure occurs before candidate download.
      expect(old.admission.calls.slice(callsBefore)).toContain(
        `repos/${old.repository}/actions/artifacts/70`,
      );
    },
  );

  it("rejects historical-plan substitution and incomplete role selection", async () => {
    const { recovery, client } = fixture();
    expect(() => validateReceiptRecoveryRequest({ ...recovery, executionPlan: {} })).toThrow();
    const invalid = structuredClone(recovery);
    invalid.candidateBinding.request.targetSha = "invalid";
    await expect(verifyOriginalReceiptQualification(invalid, { client })).rejects.toThrow(
      "original candidate and qualification must identify commits",
    );
    const missing = structuredClone(recovery);
    delete missing.children.normalCi;
    await expect(verifyOriginalReceiptQualification(missing, { client })).rejects.toThrow(
      "exactly the admitted child roles",
    );
  });

  it("rechecks every current producer tuple and rejects a superseding attempt", async () => {
    const { recovery, old } = fixture(true);
    const calls: string[] = [];
    let attempt = 1;
    let childSha = old.q;
    const client = {
      getRun: async (id: string) => {
        calls.push(id);
        return {
          id: Number(id),
          run_attempt: attempt,
          head_sha: id === recovery.children.normalCi?.runId ? childSha : old.q,
          status: "completed",
          conclusion: "success",
        };
      },
    };
    await revalidateReceiptRecoveryRuns(recovery, client);
    expect(new Set(calls).size).toBe(10);
    const normalCi = recovery.children.normalCi;
    if (!normalCi) {
      throw new Error("fixture is missing the normal CI child");
    }
    const waivedRun = normalCi.runId;
    const failedClient = {
      getRun: async (id: string) => ({
        ...(await client.getRun(id)),
        conclusion: id === waivedRun ? "failure" : "success",
      }),
    };
    await expect(revalidateReceiptRecoveryRuns(recovery, failedClient)).rejects.toThrow(
      "current attempt changed",
    );
    childSha = "d".repeat(40);
    const verifiedChildren = [{ runId: waivedRun, conclusion: "failure", workflowSha: childSha }];
    await revalidateReceiptRecoveryRuns(recovery, failedClient, verifiedChildren);
    await expect(
      revalidateReceiptRecoveryRuns(recovery, failedClient, [
        { ...verifiedChildren[0], workflowSha: old.q },
      ]),
    ).rejects.toThrow("current attempt changed");
    attempt = 2;
    await expect(revalidateReceiptRecoveryRuns(recovery, client)).rejects.toThrow(
      "current attempt changed",
    );
  });

  it("keeps qualification attempt 1 while pinning a later terminal parent attempt", async () => {
    const { recovery, old } = fixture();
    const request = {
      ...recovery,
      originalParent: { ...recovery.originalParent, currentRunAttempt: 2 },
    };
    validateReceiptRecoveryRequest(request);
    let currentAttempt = 2;
    let status = "completed";
    const client = {
      getRun: async (id: string) => ({
        id: Number(id),
        run_attempt: id === request.originalParent.runId ? currentAttempt : 1,
        head_sha: old.q,
        status: id === request.originalParent.runId ? status : "completed",
        conclusion: id === request.originalParent.runId ? "failure" : "success",
      }),
    };
    await expect(revalidateReceiptRecoveryRuns(request, client)).resolves.toBeUndefined();
    expect(request.originalParent.runAttempt).toBe(1);
    currentAttempt = 3;
    await expect(revalidateReceiptRecoveryRuns(request, client)).rejects.toThrow(
      "current attempt changed",
    );
    currentAttempt = 2;
    status = "in_progress";
    await expect(revalidateReceiptRecoveryRuns(request, client)).rejects.toThrow(
      "current attempt changed",
    );
  });

  it("exposes only a read-authorized aggregate workflow with no qualification fallback", () => {
    const workflow = parse(readFileSync(RECEIPT_RECOVERY_WORKFLOW, "utf8"));
    expect(workflow.permissions).toEqual({ actions: "read", contents: "read" });
    expect(Object.keys(workflow.jobs)).toEqual(["aggregate"]);
    const steps = workflow.jobs.aggregate.steps;
    expect(
      steps
        .filter((step: { run?: string }) => step.run?.includes("full-release-receipt-recovery.mjs"))
        .map((step: { run: string }) => step.run),
    ).toEqual([
      "node scripts/full-release-receipt-recovery.mjs request",
      "node scripts/full-release-receipt-recovery.mjs admit",
      "node scripts/full-release-receipt-recovery.mjs seal",
    ]);
    expect(
      steps.some((step: { uses?: string }) => step.uses?.includes("full-release-validation")),
    ).toBe(false);
  });
});
