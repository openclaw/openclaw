import { createHash } from "node:crypto";
import { expect, vi } from "vitest";
import { projectFrv18Publication } from "../../scripts/lib/frv18-publication-exception.mjs";
import { createReleasePublishInputs } from "../../scripts/lib/release-publish-inputs.mjs";
import { createPluginSdkApiReleaseEvidence } from "../../scripts/plugin-sdk-api-release-evidence.mjs";
import { candidatePublicationFixture } from "./candidate-publication.test-support.js";

export function createFrv18PublicationClient(
  f: ReturnType<typeof candidatePublicationFixture>,
  parent = f.parent,
  { missingManifest = false, tamperedArtifact = false } = {},
) {
  const sha = "995f9059b6e6fe3ba0865a3354924fd2bcbfceea";
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
    getRunAttempt: (id: string, attempt: number) =>
      id === f.runId ? parent : f.client.getRunAttempt(id, attempt),
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
    loadManifest: () => (missingManifest ? undefined : f.client.loadManifest()),
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
        sourceSha: tamperedArtifact ? "a".repeat(40) : sha,
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
  return client;
}
