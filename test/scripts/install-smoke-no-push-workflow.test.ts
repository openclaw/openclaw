import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const INSTALL_SMOKE = ".github/workflows/install-smoke.yml";
const RELEASE_CHECKS = ".github/workflows/openclaw-release-checks.yml";

type WorkflowStep = {
  env?: Record<string, unknown>;
  id?: string;
  if?: string;
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
};

type WorkflowJob = {
  env?: Record<string, unknown>;
  if?: string;
  needs?: string | string[];
  outputs?: Record<string, unknown>;
  permissions?: Record<string, unknown>;
  steps?: WorkflowStep[];
  uses?: string;
  with?: Record<string, unknown>;
};

type Workflow = {
  jobs: Record<string, WorkflowJob>;
  on?: {
    workflow_call?: { inputs?: Record<string, Record<string, unknown>> };
    workflow_dispatch?: { inputs?: Record<string, Record<string, unknown>> };
  };
  permissions?: Record<string, unknown>;
};

function readWorkflow(path: string): Workflow {
  return parse(readFileSync(path, "utf8")) as Workflow;
}

function job(workflow: Workflow, name: string): WorkflowJob {
  const found = workflow.jobs[name];
  expect(found, name).toBeDefined();
  return found!;
}

function step(workflowJob: WorkflowJob, name: string): WorkflowStep {
  const found = workflowJob.steps?.find((candidate) => candidate.name === name);
  expect(found, name).toBeDefined();
  return found!;
}

describe("install smoke no-push root image transport", () => {
  it("keeps registry transport as the default and validates the selected mode", () => {
    const workflow = readWorkflow(INSTALL_SMOKE);
    const dispatchInput = workflow.on?.workflow_dispatch?.inputs?.root_image_transport;
    const callInput = workflow.on?.workflow_call?.inputs?.root_image_transport;
    expect(dispatchInput).toMatchObject({
      default: "registry",
      options: ["registry", "no-push-artifact"],
      type: "choice",
    });
    expect(callInput).toMatchObject({
      default: "registry",
      type: "string",
    });
    expect(workflow.permissions).toMatchObject({
      actions: "read",
      contents: "read",
      packages: "read",
    });

    const preflight = job(workflow, "preflight");
    expect(preflight.outputs?.root_image_transport).toBe(
      "${{ steps.manifest.outputs.root_image_transport }}",
    );
    expect(preflight.outputs?.workflow_repository).toBe(
      "${{ steps.workflow.outputs.workflow_repository }}",
    );
    expect(preflight.outputs?.workflow_sha).toBe("${{ steps.workflow.outputs.workflow_sha }}");
    const workflowIdentity = step(preflight, "Resolve job workflow identity");
    expect(workflowIdentity.env?.JOB_CONTEXT).toBe("${{ toJSON(job) }}");
    expect(workflowIdentity.run).toContain(
      "job.workflow_repository must be an owner/repository slug",
    );
    expect(workflowIdentity.run).toContain("job.workflow_sha must be a full lowercase commit SHA");
    const manifest = step(preflight, "Build install-smoke CI manifest");
    expect(manifest.env?.OPENCLAW_CI_ROOT_IMAGE_TRANSPORT).toBe(
      "${{ inputs.root_image_transport || 'registry' }}",
    );
    expect(manifest.run).toContain("registry)");
    expect(manifest.run).toContain("no-push-artifact)");
    expect(manifest.run).toContain(
      'dockerfile_image="ghcr.io/${owner}/openclaw-dockerfile-smoke:${target_sha}"',
    );
    expect(manifest.run).toContain(
      'dockerfile_image="openclaw-dockerfile-smoke-local:${target_sha}"',
    );
    expect(manifest.run).toContain("root_image_transport must be registry or no-push-artifact");

    const trustedCheckouts = Object.entries(workflow.jobs).flatMap(([jobName, workflowJob]) =>
      (workflowJob.steps ?? [])
        .filter((candidate) => candidate.name?.startsWith("Checkout trusted "))
        .map((candidate) => ({ candidate, jobName })),
    );
    expect(trustedCheckouts).toHaveLength(5);
    for (const { candidate, jobName } of trustedCheckouts) {
      expect(candidate.with, jobName).toMatchObject({
        repository: "${{ needs.preflight.outputs.workflow_repository }}",
        ref: "${{ needs.preflight.outputs.workflow_sha }}",
        "persist-credentials": false,
      });
    }
  });

  it("builds one local target image and uploads provenance-bound bytes", () => {
    const workflow = readWorkflow(INSTALL_SMOKE);
    const producer = job(workflow, "root_dockerfile_image");
    expect(producer.permissions).toEqual({
      contents: "read",
      packages: "read",
    });
    expect(producer.outputs?.archive_sha256).toBe(
      "${{ steps.image_artifact.outputs.archive_sha256 }}",
    );
    expect(producer.outputs?.artifact_digest).toBe(
      "${{ steps.image_artifact_upload.outputs.artifact-digest }}",
    );
    expect(producer.outputs?.artifact_id).toBe(
      "${{ steps.image_artifact_upload.outputs.artifact-id }}",
    );
    expect(producer.outputs?.artifact_name).toBe(
      "${{ steps.image_artifact.outputs.artifact_name }}",
    );
    expect(producer.outputs?.artifact_run_attempt).toBe(
      "${{ steps.image_artifact.outputs.run_attempt }}",
    );
    expect(producer.outputs?.artifact_run_id).toBe("${{ steps.image_artifact.outputs.run_id }}");
    expect(producer.outputs?.image_exists).toBe("${{ steps.existing.outputs.exists }}");
    expect(step(producer, "Checkout CLI").with).toMatchObject({
      ref: "${{ needs.preflight.outputs.target_sha }}",
      "persist-credentials": false,
    });

    const trustedCheckout = step(producer, "Checkout trusted image artifact helper");
    expect(trustedCheckout.if).toBe(
      "needs.preflight.outputs.root_image_transport == 'no-push-artifact'",
    );
    expect(trustedCheckout.with).toMatchObject({
      repository: "${{ needs.preflight.outputs.workflow_repository }}",
      ref: "${{ needs.preflight.outputs.workflow_sha }}",
      path: ".release-harness",
      "persist-credentials": false,
    });

    expect(step(producer, "Log in to GHCR").if).toBe(
      "needs.preflight.outputs.root_image_transport == 'registry'",
    );
    expect(step(producer, "Check for existing root Dockerfile smoke image").if).toBe(
      "needs.preflight.outputs.root_image_transport == 'registry'",
    );
    expect(
      producer.steps?.some(
        (candidate) => candidate.name === "Build and push root Dockerfile smoke image",
      ),
    ).toBe(false);

    const localBuild = step(producer, "Build local root Dockerfile smoke image");
    expect(localBuild.if).toBe(
      "needs.preflight.outputs.root_image_transport == 'no-push-artifact'",
    );
    expect(localBuild.run).toContain("--load");
    expect(localBuild.run).not.toContain("--push");
    expect(localBuild.run).toContain('-t "$IMAGE_REF"');

    const pack = step(producer, "Pack root Dockerfile image artifact");
    expect(pack.if).toBe("needs.preflight.outputs.root_image_transport == 'no-push-artifact'");
    expect(pack.env).toMatchObject({
      IMAGE_REF: "${{ needs.preflight.outputs.dockerfile_image }}",
      TARGET_SHA: "${{ needs.preflight.outputs.target_sha }}",
      WORKFLOW_SHA: "${{ needs.preflight.outputs.workflow_sha }}",
    });
    expect(pack.run).toContain(
      'artifact_name="install-smoke-root-image-${TARGET_SHA:0:12}-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"',
    );
    expect(pack.run).toContain(
      'pack "$artifact_dir" install-smoke-root "$TARGET_SHA" "$WORKFLOW_SHA" "$IMAGE_REF"',
    );
    expect(pack.run).toContain(
      'jq -er \'.archive.sha256 | select(type == "string" and test("^[a-f0-9]{64}$"))\'',
    );
    expect(pack.run).toContain('echo "archive_sha256=$archive_sha256"');
    expect(pack.run).toContain('echo "run_attempt=$GITHUB_RUN_ATTEMPT"');
    expect(pack.run).toContain('echo "run_id=$GITHUB_RUN_ID"');

    const upload = step(producer, "Upload root Dockerfile image artifact");
    expect(upload.id).toBe("image_artifact_upload");
    expect(upload.if).toBe("needs.preflight.outputs.root_image_transport == 'no-push-artifact'");
    expect(upload.uses).toBe("actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a");
    expect(upload.with).toMatchObject({
      "compression-level": 0,
      "if-no-files-found": "error",
      name: "${{ steps.image_artifact.outputs.artifact_name }}",
      path: "${{ steps.image_artifact.outputs.artifact_path }}",
    });

    const registryPublisher = job(workflow, "push_root_dockerfile_image");
    expect(registryPublisher.permissions).toEqual({
      contents: "read",
      packages: "write",
    });
    expect(registryPublisher.if).toBe(
      "needs.preflight.outputs.root_image_transport == 'registry' && needs.root_dockerfile_image.outputs.image_exists != 'true'",
    );
    expect(step(registryPublisher, "Checkout CLI").with).toMatchObject({
      ref: "${{ needs.preflight.outputs.target_sha }}",
      "persist-credentials": false,
    });
    expect(step(registryPublisher, "Log in to GHCR").if).toBeUndefined();
    const registryBuild = step(registryPublisher, "Build and push root Dockerfile smoke image");
    expect(registryBuild.run).toContain("--push");
    expect(registryBuild.run).not.toContain("--load");

    const writeScopedJobs = Object.entries(workflow.jobs)
      .filter(([, candidate]) => candidate.permissions?.packages === "write")
      .map(([name]) => name);
    expect(writeScopedJobs).toEqual(["push_root_dockerfile_image"]);

    const ready = job(workflow, "root_dockerfile_image_ready");
    expect(ready.needs).toEqual([
      "preflight",
      "root_dockerfile_image",
      "push_root_dockerfile_image",
    ]);
    expect(ready.if).toContain("always()");
    const verify = step(ready, "Verify root Dockerfile image preparation");
    expect(verify.run).toContain('if [[ "$PREPARE_RESULT" != "success" ]]');
    expect(verify.run).toContain(
      'if [[ "$ROOT_IMAGE_TRANSPORT" == "registry" && "$IMAGE_EXISTS" != "true" ]]',
    );
    expect(verify.run).toContain('elif [[ "$PUSH_RESULT" != "skipped" ]]');
  });

  it("verifies and loads the artifact in every consumer without registry fallback", () => {
    const workflow = readWorkflow(INSTALL_SMOKE);
    for (const [jobName, checkoutName] of [
      ["install-smoke-fast", "Checkout CLI"],
      ["qr_package_install_smoke", "Checkout CLI"],
      ["root_dockerfile_smokes", "Checkout CLI"],
      ["installer_smoke", "Checkout candidate CLI"],
      ["bun_global_install_smoke", "Checkout CLI"],
      ["docker-e2e-fast", "Checkout CLI"],
    ]) {
      const checkout = step(job(workflow, jobName), checkoutName);
      expect(checkout.with?.ref, jobName).toBe("${{ needs.preflight.outputs.target_sha }}");
      expect(checkout.with?.["persist-credentials"], jobName).toBe(false);
    }

    for (const jobName of [
      "root_dockerfile_smokes",
      "installer_smoke",
      "bun_global_install_smoke",
    ]) {
      const consumer = job(workflow, jobName);
      expect(consumer.needs, jobName).toContain("root_dockerfile_image_ready");
      expect(consumer.env?.OPENCLAW_DOCKER_E2E_REQUIRE_LOCAL_IMAGE, jobName).toBe(
        "${{ needs.preflight.outputs.root_image_transport == 'no-push-artifact' && '1' || '0' }}",
      );
      const trustedCheckout = step(consumer, "Checkout trusted image artifact helper");
      expect(trustedCheckout.if, jobName).toBe(
        "needs.preflight.outputs.root_image_transport == 'no-push-artifact'",
      );
      expect(trustedCheckout.with, jobName).toMatchObject({
        repository: "${{ needs.preflight.outputs.workflow_repository }}",
        ref: "${{ needs.preflight.outputs.workflow_sha }}",
        path: ".release-harness",
        "persist-credentials": false,
      });

      expect(step(consumer, "Log in to GHCR").if, jobName).toBe(
        "needs.preflight.outputs.root_image_transport == 'registry'",
      );
      expect(step(consumer, "Pull root Dockerfile smoke image").if, jobName).toBe(
        "needs.preflight.outputs.root_image_transport == 'registry'",
      );

      const binding = step(consumer, "Validate root Dockerfile image artifact binding");
      expect(binding.if, jobName).toBe(
        "needs.preflight.outputs.root_image_transport == 'no-push-artifact'",
      );
      expect(binding.env, jobName).toMatchObject({
        ARCHIVE_SHA256: "${{ needs.root_dockerfile_image.outputs.archive_sha256 }}",
        ARTIFACT_DIGEST: "${{ needs.root_dockerfile_image.outputs.artifact_digest }}",
        ARTIFACT_ID: "${{ needs.root_dockerfile_image.outputs.artifact_id }}",
        ARTIFACT_NAME: "${{ needs.root_dockerfile_image.outputs.artifact_name }}",
        ARTIFACT_RUN_ATTEMPT: "${{ needs.root_dockerfile_image.outputs.artifact_run_attempt }}",
        ARTIFACT_RUN_ID: "${{ needs.root_dockerfile_image.outputs.artifact_run_id }}",
        GH_TOKEN: "${{ github.token }}",
        TARGET_SHA: "${{ needs.preflight.outputs.target_sha }}",
      });
      expect(binding.run, jobName).toContain('[[ "$ARTIFACT_ID" =~ ^[1-9][0-9]*$ ]]');
      expect(binding.run, jobName).toContain('[[ "$ARTIFACT_DIGEST" =~ ^[a-f0-9]{64}$ ]]');
      expect(binding.run, jobName).toContain('[[ "$ARCHIVE_SHA256" =~ ^[a-f0-9]{64}$ ]]');
      expect(binding.run, jobName).toContain('[[ "$ARTIFACT_RUN_ID" =~ ^[1-9][0-9]*$ ]]');
      expect(binding.run, jobName).toContain('[[ "$ARTIFACT_RUN_ATTEMPT" =~ ^[1-9][0-9]*$ ]]');
      expect(binding.run, jobName).not.toContain(
        '"$ARTIFACT_RUN_ATTEMPT" == "$GITHUB_RUN_ATTEMPT"',
      );
      expect(binding.run, jobName).toContain(
        'expected_artifact_name="install-smoke-root-image-${TARGET_SHA:0:12}-${ARTIFACT_RUN_ID}-${ARTIFACT_RUN_ATTEMPT}"',
      );
      expect(binding.run, jobName).toContain(
        "repos/${GITHUB_REPOSITORY}/actions/artifacts/${ARTIFACT_ID}",
      );
      expect(binding.run, jobName).toContain('--arg digest "sha256:${ARTIFACT_DIGEST}"');
      expect(binding.run, jobName).toContain('--arg id "$ARTIFACT_ID"');
      expect(binding.run, jobName).toContain('--arg name "$ARTIFACT_NAME"');
      expect(binding.run, jobName).toContain("(.id | tostring) == $id");
      expect(binding.run, jobName).toContain(".name == $name");
      expect(binding.run, jobName).toContain(".expired == false");
      expect(binding.run, jobName).toContain(".digest == $digest");
      expect(binding.run, jobName).toContain("(.workflow_run.id | tostring) == $run_id");
      expect(binding.run, jobName).toContain(
        "repos/${GITHUB_REPOSITORY}/actions/runs/${ARTIFACT_RUN_ID}/attempts/${ARTIFACT_RUN_ATTEMPT}",
      );
      expect(binding.run, jobName).toContain("(.run_attempt | tostring) == $attempt");

      const download = step(consumer, "Download root Dockerfile image artifact");
      expect(download.if, jobName).toBe(
        "needs.preflight.outputs.root_image_transport == 'no-push-artifact'",
      );
      expect(download.uses, jobName).toBe(
        "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c",
      );
      expect(download.with, jobName).toMatchObject({
        "artifact-ids": "${{ needs.root_dockerfile_image.outputs.artifact_id }}",
        "github-token": "${{ github.token }}",
        path: "${{ runner.temp }}/install-smoke-root-image",
        "run-id": "${{ needs.root_dockerfile_image.outputs.artifact_run_id }}",
      });
      expect(download.with?.name, jobName).toBeUndefined();
      expect(
        consumer.steps?.findIndex(
          (candidate) => candidate.name === "Validate root Dockerfile image artifact binding",
        ),
        jobName,
      ).toBeLessThan(
        consumer.steps?.findIndex(
          (candidate) => candidate.name === "Download root Dockerfile image artifact",
        ) ?? -1,
      );

      const load = step(consumer, "Verify and load root Dockerfile image artifact");
      expect(load.if, jobName).toBe(
        "needs.preflight.outputs.root_image_transport == 'no-push-artifact'",
      );
      expect(load.env, jobName).toMatchObject({
        IMAGE_REF: "${{ needs.root_dockerfile_image.outputs.image_ref }}",
        OPENCLAW_SHARED_IMAGE_ARCHIVE_SHA256:
          "${{ needs.root_dockerfile_image.outputs.archive_sha256 }}",
        OPENCLAW_SHARED_IMAGE_RUN_ATTEMPT:
          "${{ needs.root_dockerfile_image.outputs.artifact_run_attempt }}",
        OPENCLAW_SHARED_IMAGE_RUN_ID: "${{ needs.root_dockerfile_image.outputs.artifact_run_id }}",
        TARGET_SHA: "${{ needs.preflight.outputs.target_sha }}",
        WORKFLOW_SHA: "${{ needs.preflight.outputs.workflow_sha }}",
      });
      expect(load.run, jobName).toContain(
        'load "${RUNNER_TEMP}/install-smoke-root-image" install-smoke-root',
      );
      expect(load.run, jobName).toContain("set -euo pipefail");
      expect(load.run, jobName).toContain('"$TARGET_SHA" "$WORKFLOW_SHA" "$IMAGE_REF"');

      const requireLocal = step(consumer, "Require local root Dockerfile image");
      expect(requireLocal.if, jobName).toBe(
        "needs.preflight.outputs.root_image_transport == 'no-push-artifact'",
      );
      expect(requireLocal.run, jobName).toBe('docker image inspect "$IMAGE_REF" >/dev/null');
    }

    expect(job(workflow, "install-smoke-fast").env?.OPENCLAW_DOCKER_E2E_REQUIRE_LOCAL_IMAGE).toBe(
      "1",
    );
  });

  it("selects no-push transport with read-only package access from release checks", () => {
    const release = readWorkflow(RELEASE_CHECKS);
    const caller = job(release, "install_smoke_release_checks");
    expect(caller.uses).toBe("./.github/workflows/install-smoke.yml");
    expect(caller.permissions).toEqual({
      actions: "read",
      contents: "read",
      packages: "read",
    });
    expect(caller.with).toMatchObject({
      ref: "${{ needs.resolve_target.outputs.revision }}",
      root_image_transport: "no-push-artifact",
      run_bun_global_install_smoke: true,
    });
  });
});
