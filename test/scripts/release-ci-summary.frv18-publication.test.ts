import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { projectFrv18Publication } from "../../scripts/lib/frv18-publication-exception.mjs";
import { createReleasePublishInputs } from "../../scripts/lib/release-publish-inputs.mjs";
import { createPluginSdkApiReleaseEvidence } from "../../scripts/plugin-sdk-api-release-evidence.mjs";
import { validateReleaseRunEvidence } from "../../scripts/release-ci-summary.mjs";
import { authenticateFullReleaseValidationEvidence } from "../../scripts/validate-full-release-validation-evidence.mjs";
import { candidatePublicationFixture } from "./candidate-publication.test-support.js";

afterEach(() => vi.unstubAllGlobals());

it.each([
  "failure",
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
  const originalGetRun = f.client.getRun;
  const client = {
    ...f.client,
    getRun: async (id: string) => {
      if (id === f.runId) {
        return parent;
      }
      if (["44507905054", "44507904089"].includes(id)) {
        const stage = id === "44507905054" ? "npm" : "docker";
        return {
          id,
          run_attempt: 1,
          status: "completed",
          conclusion: "success",
          head_sha: sha,
          head_branch: f.branch,
          path: ".github/workflows/full-release-artifacts.yml",
          display_title:
            "Full Release Artifacts full-release-validation-44507108002-1-artifacts-" + stage,
        };
      }
      return originalGetRun(id);
    },
    getRunView: async () => ({
      status: parent.status,
      conclusion: parent.conclusion,
      attempt: 1,
      headSha: sha,
      headBranch: f.branch,
      url: parent.html_url,
    }),
    getRunAttemptJobs: vi.fn((id: string) => {
      if (id !== f.runId) {
        throw new Error("Qualification children must not be read");
      }
      return f.client.getRunAttemptJobs(id);
    }),
    getParentJobs: vi.fn(() => {
      throw new Error("Qualification jobs must not be read");
    }),
    loadExecutionPlanEvidence: () => ({
      plan: f.plan,
      artifact: {
        id: 14524452145,
        name: "full-release-execution-plan-44507108002",
        digest: "sha256:e6cd16c92abefdc5f4a4aa949c1c8b369ec89a708652e45181d8a49cd8eea5ae",
        size_in_bytes: 10569,
        workflow_run: { head_sha: sha, head_branch: f.branch },
      },
    }),
    loadPinnedJsonArtifact: async ({ runId }: { runId: string }) => {
      if (runId === "44507913588") {
        return {
          producer: {
            repository: f.repository,
            runId: 44507913588,
            runAttempt: 1,
            workflowPath: ".github/workflows/plugin-npm-release.yml",
            workflowEvent: "workflow_dispatch",
            workflowHeadBranch: f.branch,
            workflowSha: sha,
          },
        };
      }
      const stage = runId === "44507905054" ? "npm" : "docker";
      return {
        schema: "openclaw.full-release-artifact-receipt/v1",
        stage,
        dispatchId: "full-release-validation-44507108002-1-artifacts-" + stage,
        repository: f.repository,
        sourceSha: scenario === "tampered-artifact" ? "a".repeat(40) : sha,
        toolingSha: sha,
        workflowRef: f.branch,
        releaseTag: "v2026.11.10-beta.1",
        runAttempt: "1",
        runId,
        outputs:
          stage === "npm"
            ? { qualified_preflight_bundle_json: JSON.stringify(f.npmQualified) }
            : {
                prepared_run_id: f.runId,
                prepared_run_attempt: "1",
                prepared_artifact_name: f.manifest.publicationArtifacts.docker.preparedArtifactName,
                prepared_manifest_sha256:
                  f.manifest.publicationArtifacts.docker.preparedManifestSha256,
              },
      };
    },
    loadPlanPublicationContext: async (plan: typeof f.plan) => {
      const projected = await projectFrv18Publication(plan, client);
      expect(projected.manifest.runId).toBe(f.runId);
      expect(projected.manifest.releaseProfile).toBe("beta");
      return projected;
    },
    loadPlanPublishInputs: async (manifest: typeof f.manifest) => {
      const diff = { entrypointsAdded: [], entrypointsRemoved: [], exports: [] };
      const digest = createHash("sha256").update(JSON.stringify(diff)).digest("hex");
      return createReleasePublishInputs({
        manifest,
        npmManifest: {
          ...f.npmManifest,
          pluginSdkApi: createPluginSdkApiReleaseEvidence({
            baseRef: "v2026.11.5",
            baseSha: "b".repeat(40),
            headSha: sha,
            workflowSha: sha,
            diff: { ...diff, digest },
          }),
        },
      });
    },
  };
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
