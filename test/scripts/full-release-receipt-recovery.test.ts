import { readFileSync } from "node:fs";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import * as publicationArtifacts from "../../scripts/full-release-artifacts.mjs";
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
import * as candidateReuse from "../../scripts/lib/full-release-candidate-reuse.mjs";
import * as childReuse from "../../scripts/lib/full-release-child-reuse.mjs";
import { retainedPublicationArtifactSource } from "../../scripts/lib/release-evidence-identity.mjs";
import { validateFullReleaseNpmPreflight } from "../../scripts/npm-preflight-tooling-identity.mjs";
import { fullReleaseCandidateBindingFixture } from "../helpers/full-release-candidate.js";
import { candidatePublicationFixture } from "./candidate-publication.test-support.js";

const roles = [
  "normalCi",
  "pluginPrereleaseIndependent",
  "releaseChecksIndependent",
  "releaseChecksCandidate",
  "pluginPrereleaseCandidate",
];
function fixture() {
  const old = candidatePublicationFixture();
  const producer = { runId: "900", runAttempt: 1, fullRef: "refs/heads/main", sha: "c".repeat(40) };
  const source = createPublicationSourceFact(
    receiptRecoverySourceRequest(old.admission.receipt, producer),
    { packages: [], platforms: [] },
    old.source.projection,
  );
  const baselines = JSON.parse(
    JSON.parse(old.admission.receipt.request.inputs.trusted_workflow_json).laneInputs
      .qualification_baselines_json,
  );
  const recovery = {
    schema: RECEIPT_RECOVERY_SCHEMA,
    requestId: "12345678-1234-4123-8123-123456789abc",
    repository: old.repository,
    qualificationAdmission: old.admission.descriptor,
    originalParent: { runId: old.runId, runAttempt: 1 },
    candidateBinding: fullReleaseCandidateBindingFixture({
      targetSha: old.q,
      toolingSha: old.q,
      releaseProfile: "beta",
      releaseSoak: false,
      upgradeSurvivorBaseline: baselines.upgradeBaseline,
      upgradeSurvivorBaselines: baselines.upgradeSurvivorBaselines.join(" "),
    }),
    children: Object.fromEntries(
      roles.map((role, index) => [
        role,
        {
          runId: String(910 + index),
          runAttempt: 1,
          workflowRef: old.branch,
          sourceParentRunId: old.runId,
          sourceParentAttempt: 1,
        },
      ]),
    ),
    publicationArtifacts: {
      ...old.manifest.publicationArtifacts,
      pluginNpm: { runId: "902", runAttempt: 1 },
    },
  };
  const manifest = {
    ...old.manifest,
    runId: producer.runId,
    workflowSha: producer.sha,
    workflowFullRef: producer.fullRef,
    workflowRef: "main",
    sourceAdmission: source,
    receiptRecovery: recovery,
  };
  return { old, producer, source, recovery, manifest };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("receipt-backed aggregate recovery", () => {
  it("passes a ten-minute budget to recovery child verification", async () => {
    const { old, recovery } = fixture();
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    // Candidate payload validation is separate from the child deadline handoff.
    vi.spyOn(candidateReuse, "verifySealedFullReleaseCandidate").mockImplementation(vi.fn());
    const verifyChild = vi
      .spyOn(childReuse, "validateReusableReleaseChild")
      .mockRejectedValue(new Error("child verification reached"));
    await expect(
      verifyOriginalReceiptQualification(recovery, {
        client: {
          ...old.client,
          getWorkflowSource: (_sha: string, path: string) => readFileSync(path, "utf8"),
        },
      }),
    ).rejects.toThrow("child verification reached");
    expect(verifyChild).toHaveBeenCalledOnce();
    expect(verifyChild.mock.calls[0]?.[2]?.deadlineMs).toBe(now + 600_000);
  });

  it("gives only recovery Docker payloads the four-minute archive budget", async () => {
    const { old, recovery } = fixture();
    vi.spyOn(candidateReuse, "verifySealedFullReleaseCandidate").mockImplementation(vi.fn());
    vi.spyOn(childReuse, "validateReusableReleaseChild").mockImplementation(async (_, request) => {
      const coverage = expectDefined(
        old.admission.receipt.coverage.children.find((child) => child.key === request.role),
        "child coverage",
      );
      const selection = {
        ...request,
        runId: expectDefined(recovery.children[request.role], "recovery child").runId,
        runAttempt: 1,
        workflowRef: old.branch,
        displayTitle: "fixture",
        sourceParentRunId: old.runId,
        sourceParentAttempt: 1,
        url: "https://github.com/openclaw/openclaw/actions/runs/910",
        artifact: {
          id: "1",
          name: "fixture",
          digest: "a".repeat(64),
          expiresAt: "2030-01-01",
          sizeInBytes: 1,
        },
        receiptSha256: "a".repeat(64),
        inputs: {},
      };
      return {
        selection,
        run: {},
        jobs: [],
        receipt: {
          jobs: coverage.requiredJobs.map((name) => ({
            name,
            status: "completed",
            conclusion: "success",
          })),
        },
      };
    });
    const verifyPayloads = vi
      .spyOn(publicationArtifacts, "verifyRetainedPublicationArtifacts")
      .mockRejectedValue(new Error("publication verification reached"));
    const dispatches = old.admission.receipt.coverage.children.map((child, index) => ({
      id: 10_000 + index,
      name: child.parentJobName,
      status: "completed",
      conclusion: "success",
      runId: expectDefined(recovery.children[child.key], "recovery child").runId,
    }));
    const parentJobs = [...(await old.client.getRunAttemptJobs(old.runId)), ...dispatches];
    await expect(
      verifyOriginalReceiptQualification(recovery, {
        client: {
          ...old.client,
          getWorkflowSource: (_sha: string, path: string) => readFileSync(path, "utf8"),
          getRunAttemptJobs: async () => parentJobs,
          getJobLog: async (id: number) => {
            const child = expectDefined(
              dispatches.find((entry) => entry.id === id),
              "dispatch job",
            );
            return `TARGET_SHA: ${old.q}\nCI_RELEASE_SCOPE: npm-beta\nhttps://github.com/${old.repository}/actions/runs/${child.runId} (attempt 1)`;
          },
        },
      }),
    ).rejects.toThrow("publication verification reached");
    expect(verifyPayloads).toHaveBeenCalledOnce();
    expect(verifyPayloads.mock.calls[0]?.[2]).toMatchObject({
      verifyPayloads: true,
      dockerArchiveTimeoutMs: 240_000,
    });
  });

  it("retains original selection, baselines and Q artifacts under a distinct P admission", () => {
    const { old, source, recovery, manifest, producer } = fixture();
    expect(validateReceiptRecoveryRequest(recovery)).toBe(recovery);
    expect(source.candidateSha).toBe(old.q);
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
      sourceSha: old.q,
      toolingSha: producer.sha,
    };
    expect(validateFullReleaseNpmPreflight(expected).producer).toEqual(old.npmQualified.producer);
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
    let attempt = 1;
    const client = {
      getRun: async (id: string) => {
        calls.push(id);
        return {
          id: Number(id),
          run_attempt: attempt,
          head_sha: old.q,
          status: "completed",
          conclusion: "success",
        };
      },
    };
    await revalidateReceiptRecoveryRuns(recovery, client);
    expect(new Set(calls).size).toBe(8);
    attempt = 2;
    await expect(revalidateReceiptRecoveryRuns(recovery, client)).rejects.toThrow(
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
      "node scripts/full-release-receipt-recovery.mjs admit",
      "node scripts/full-release-receipt-recovery.mjs seal",
    ]);
    expect(
      steps.some((step: { uses?: string }) => step.uses?.includes("full-release-validation")),
    ).toBe(false);
  });
});
