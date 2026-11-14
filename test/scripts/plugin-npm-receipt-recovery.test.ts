import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { authenticatePreparedNpmArtifact } from "../../scripts/plugin-npm-prepared-release.mjs";

const authenticated = vi.hoisted(() => vi.fn());
vi.mock("../../scripts/validate-full-release-validation-evidence.mjs", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../scripts/validate-full-release-validation-evidence.mjs")
  >()),
  authenticateFullReleaseValidationEvidence: authenticated,
}));

it("uses original Q plugin bytes and policy after the aggregate owner authenticates new P", async () => {
  const q = "a".repeat(40),
    p = "b".repeat(40);
  const descriptor = {
    repository: "openclaw/openclaw",
    runId: 123,
    runAttempt: 1,
    workflowPath: ".github/workflows/plugin-npm-release.yml",
    workflowEvent: "workflow_dispatch",
    workflowHeadBranch: "release-ci/" + q.slice(0, 12) + "-1",
    workflowSha: q,
    artifactId: 124,
    artifactName: "plugin-npm-prepared-" + q + "-123-1",
    artifactDigest: "sha256:" + "c".repeat(64),
    artifactSizeBytes: 1024,
  };
  const manifest = {
    runId: "900",
    workflowSha: p,
    targetSha: q,
    sourceAdmission: { runId: "900", candidateSha: q },
    receiptRecovery: {
      schema: "openclaw.full-release-receipt-recovery/v1",
      originalParent: { runId: "100" },
      candidateBinding: { request: { targetSha: q, toolingSha: q } },
      children: { normalCi: { workflowRef: descriptor.workflowHeadBranch } },
    },
    publicationArtifacts: { pluginNpm: descriptor },
  };
  const revalidateAuthority = vi.fn();
  authenticated.mockResolvedValue({
    evidence: { current: { manifest, workflowRefProof: "receipt-backed-recovery-v1" } },
    revalidateAuthority,
  });
  const policy = "original immutable Q policy";
  const policyReads: string[] = [];
  const result = await authenticatePreparedNpmArtifact({
    repository: descriptor.repository,
    sourceSha: q,
    workflowSha: p,
    workflowFullRef: "refs/heads/main",
    artifact: descriptor,
    fullReleaseValidationRunId: "900",
    fullReleaseValidationRunAttempt: 1,
    evidenceClient: {
      loadManifest: async () => ({ manifest }),
      getRunAttempt: async () => ({}),
      getWorkflowSource: (sha: string) => {
        policyReads.push(sha);
        return policy;
      },
    },
  });
  expect(result.artifact).toEqual(descriptor);
  expect(result.workflowSha).toBe(q);
  expect(result.publisherPolicySha256).toBe(createHash("sha256").update(policy).digest("hex"));
  expect(policyReads).toEqual([q]);
  expect(revalidateAuthority).toHaveBeenCalledOnce();
});
