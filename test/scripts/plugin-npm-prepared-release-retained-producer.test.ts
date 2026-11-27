import { describe, expect, it, vi } from "vitest";

const c = "c".repeat(40);
const q = "a".repeat(40);
const p = "b".repeat(40);
const retained = "d".repeat(40);
const repository = "openclaw/openclaw";
const authenticated = vi.hoisted(() => ({ qualificationSha: "" }));

vi.mock("../../scripts/validate-full-release-validation-evidence.mjs", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../scripts/validate-full-release-validation-evidence.mjs")
  >()),
  authenticateFullReleaseValidationEvidence: async ({ manifest }: { manifest: unknown }) => ({
    evidence: { current: { manifest } },
    qualification: { candidateSha: c, qualificationSha: authenticated.qualificationSha },
    revalidateAuthority: () => {},
    publicationAuthority: {},
  }),
  revalidateCandidateArtifactAuthority: () => {},
}));

const { authenticatePreparedNpmArtifact, preparedNpmArtifactName } =
  await import("../../scripts/plugin-npm-prepared-release.mjs");

// Q reused plugin npm bytes produced by an earlier qualification run.
function retainedProducerAdoption() {
  const producer = {
    repository,
    runId: 4001,
    runAttempt: 1,
    workflowPath: ".github/workflows/plugin-npm-release.yml",
    workflowEvent: "workflow_dispatch",
    workflowHeadBranch: `release-ci/${retained.slice(0, 12)}-1`,
    workflowSha: retained,
  };
  const artifact = {
    ...producer,
    artifactId: 9001,
    artifactName: preparedNpmArtifactName(c, producer),
    artifactDigest: `sha256:${"e".repeat(64)}`,
    artifactSizeBytes: 1024,
  };
  const manifest = {
    runId: 5001,
    targetSha: c,
    workflowSha: q,
    sourceAdmission: {
      candidateSha: c,
      runId: 5001,
      workflow: { sha: q },
      qualificationAdmission: { runId: "5000" },
      coverage: {
        publication_artifact_source_json: JSON.stringify({ runId: "4000", runAttempt: 1 }),
      },
    },
    publicationArtifactSource: {
      runId: "4000",
      candidateSha: c,
      workflow: { sha: retained },
      qualificationAdmission: { runId: "3999" },
    },
    publicationArtifacts: { pluginNpm: artifact },
  };
  const evidenceClient = {
    loadManifest: async () => ({ manifest }),
    getRunAttempt: async () => ({}),
    getWorkflowSource: () => "name: retained plugin policy\n",
  };
  return {
    repository,
    sourceSha: c,
    workflowSha: p,
    workflowFullRef: "refs/tags/release-publish/bbbbbbbbbbbb-1",
    artifact: structuredClone(artifact),
    fullReleaseValidationRunId: "5001",
    fullReleaseValidationRunAttempt: 1,
    releaseTag: "v2026.11.8",
    selectionMode: "all-publishable",
    plugins: "",
    npmDistTag: "default",
    evidenceClient,
  };
}

describe("prepared npm adoption with a retained producer", () => {
  it("binds the authenticated qualification to Q, not the retained producer", async () => {
    authenticated.qualificationSha = q;
    const admitted = await authenticatePreparedNpmArtifact(retainedProducerAdoption());
    expect(admitted.workflowSha).toBe(retained);
  });

  it("rejects qualification that does not own the validation", async () => {
    authenticated.qualificationSha = retained;
    await expect(authenticatePreparedNpmArtifact(retainedProducerAdoption())).rejects.toThrow(
      "Prepared npm Q != P adoption requires live candidate-owned qualification.",
    );
  });
});
