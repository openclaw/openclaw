import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { authenticatePreparedNpmArtifact } from "../../scripts/plugin-npm-prepared-release.mjs";
import { validateReleaseRunEvidence } from "../../scripts/release-ci-summary.mjs";
import { authenticateFullReleaseValidationEvidence } from "../../scripts/validate-full-release-validation-evidence.mjs";
import { candidatePublicationFixture } from "./candidate-publication.test-support.js";
import { createFrv18PublicationClient } from "./frv18-publication.test-support.js";

afterEach(() => vi.unstubAllGlobals());

it.each([
  "failure",
  "prepared-npm",
  "cancelled",
  "in_progress",
  "other-run",
  "other-version",
  "other-candidate",
  "tampered-artifact",
] as const)("waives qualification without reading children: %s", async (scenario) => {
  const sha = "995f9059b6e6fe3ba0865a3354924fd2bcbfceea";
  const f = candidatePublicationFixture({
    candidateSha: scenario === "other-candidate" ? "a".repeat(40) : sha,
    candidateVersion: scenario === "other-version" ? "2026.11.10-beta.2" : "2026.11.10-beta.1",
    runId: scenario === "other-run" ? "777777" : "44507108002",
  });
  const parent = {
    ...f.parent,
    status: scenario === "in_progress" ? "in_progress" : "completed",
    conclusion: scenario === "in_progress" ? null : "failure",
  };
  if (scenario === "cancelled") {
    parent.conclusion = "cancelled";
  }
  const client = createFrv18PublicationClient(f, parent, {
    missingManifest: scenario === "prepared-npm",
    tamperedArtifact: scenario === "tampered-artifact",
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      url.endsWith("/2026.11.10-beta.1")
        ? new Response("{}", { status: 404 })
        : Response.json({
            versions: { "2026.11.5": {} },
            "dist-tags": { latest: "2026.11.5", beta: "2026.11.5" },
          }),
    ),
  );
  const options = {
    run: parent,
    expectedRepository: f.repository,
    expectedRunId: f.runId,
    expectedRunAttempt: 1,
    expectedTargetSha: sha,
    expectedReleaseTag: "v2026.11.10-beta.1",
    expectedTrustedWorkflowFullRef: f.publisherFullRef,
    expectedTrustedWorkflowSha: f.p,
    verifierSourceSha: f.p,
    verifierSourceContent: readFileSync("scripts/release-ci-summary.mjs"),
    expectedCoreNpmPublication: { npmDistTag: "beta" },
  };
  if (scenario === "prepared-npm") {
    const authenticated = await authenticatePreparedNpmArtifact({
      repository: f.repository,
      sourceSha: sha,
      workflowSha: f.p,
      workflowFullRef: f.publisherFullRef,
      fullReleaseValidationRunId: f.runId,
      fullReleaseValidationRunAttempt: 1,
      releaseTag: "v2026.11.10-beta.1",
      selectionMode: "all-publishable",
      plugins: "",
      npmDistTag: "default",
      evidenceClient: client,
    });
    expect(authenticated.artifact).toMatchObject({
      artifactId: 14519599717,
      artifactName: `plugin-npm-prepared-${sha}-44507913588-1`,
      workflowSha: sha,
      runId: 44507913588,
      runAttempt: 1,
    });
    expect(authenticated.publicationSelection).toEqual(f.source.publicationSelection);
    return;
  }
  const verification = authenticateFullReleaseValidationEvidence(options, client);
  if (["tampered-artifact", "other-version", "other-candidate"].includes(scenario)) {
    await expect(verification).rejects.toThrow();
    return;
  }
  const authenticated = await verification;
  expect(authenticated.evidence.current.conclusion).toBe(parent.conclusion);
  expect(authenticated.evidence.current.status).toBe(parent.status);
  expect(authenticated.evidence.qualification).toEqual(
    expect.objectContaining({ disposition: "waived" }),
  );
  expect(authenticated.evidence.children).toEqual([]);
  expect(client.getRunAttemptJobs.mock.calls.every(([id]) => id === f.runId)).toBe(true);
  expect(client.getParentJobs).not.toHaveBeenCalled();
  expect(authenticated.evidence.current.manifest.advisoryJobs ?? []).toEqual([]);
  if (scenario !== "other-run") {
    expect(authenticated.evidence.current.manifest.publishInputs.npmDistTag).toBe("beta");
  }
  expect(authenticated.forPublication(options).source).toBe("candidate-owned-admission-v1");
  await expect(
    validateReleaseRunEvidence(
      {
        repository: f.repository,
        runId: f.runId,
        verifierSourceSha: f.p,
        verifierSourceContent: options.verifierSourceContent,
        reuseRequest: {
          targetSha: sha,
          releaseProfile: "beta",
          runReleaseSoak: "false",
          validationInputs: {},
        },
      },
      client,
    ),
  ).rejects.toThrow("cannot qualify reuse");
});
