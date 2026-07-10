import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { validateInstallSmokeJobResults } from "../../scripts/lib/install-smoke-result-policy.mjs";

const WORKFLOW_PATH = ".github/workflows/install-smoke.yml";
const RELEASE_CHECKS_PATH = ".github/workflows/openclaw-release-checks.yml";
const LOADER_PATH = "scripts/docker/load-install-smoke-image.sh";
const DOWNLOAD_ARTIFACT_V8 = "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c";
const UPLOAD_ARTIFACT_V7 = "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a";
const IMAGE_DIGEST = `sha256:${"a".repeat(64)}`;
const CONTAINER_DIGEST = `sha256:${"b".repeat(64)}`;
const TARGET_SHA = "c".repeat(40);
const WORKFLOW_SHA = "f".repeat(40);

type WorkflowStep = {
  id?: string;
  name?: string;
  if?: string;
  uses?: string;
  run?: string;
  env?: Record<string, unknown>;
  with?: Record<string, unknown>;
};

type WorkflowJob = {
  if?: string;
  needs?: string[];
  outputs?: Record<string, string>;
  permissions?: Record<string, string>;
  steps: WorkflowStep[];
};

type InstallSmokeWorkflow = {
  on: {
    workflow_call: { inputs: Record<string, unknown> };
    workflow_dispatch: { inputs: Record<string, unknown> };
  };
  permissions: Record<string, string>;
  jobs: Record<string, WorkflowJob>;
};

type LoaderFixture = {
  archivePath: string;
  artifactDir: string;
  binDir: string;
  imageRef: string;
};

function readWorkflow(): InstallSmokeWorkflow {
  return parse(readFileSync(WORKFLOW_PATH, "utf8")) as InstallSmokeWorkflow;
}

function findStep(job: WorkflowJob, name: string): WorkflowStep {
  const step = job.steps.find((candidate) => candidate.name === name);
  if (!step) {
    throw new Error(`missing ${name} step`);
  }
  return step;
}

function createLoaderFixture(): LoaderFixture {
  const root = mkdtempSync(join(tmpdir(), "install-smoke-loader-"));
  const artifactDir = join(root, "artifact");
  const binDir = join(root, "bin");
  const archiveName = `openclaw-dockerfile-smoke-${TARGET_SHA}.tar.zst`;
  const archivePath = join(artifactDir, archiveName);
  const imageRef = `openclaw-dockerfile-smoke:${TARGET_SHA}`;

  mkdirSync(artifactDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  writeFileSync(archivePath, "deterministic docker archive fixture\n");
  const archive = readFileSync(archivePath);
  const evidence = {
    schema: "openclaw.install-smoke-root-image-evidence/v1",
    schemaVersion: 1,
    workflowPath: ".github/workflows/install-smoke.yml",
    workflowSha: WORKFLOW_SHA,
    rootImageTransport: "artifact",
    targetSha: TARGET_SHA,
    buildContext: {
      path: ".",
      gitTreeSha: "1".repeat(40),
    },
    dockerfile: {
      path: "Dockerfile",
      gitBlobSha: "2".repeat(40),
      sha256: "3".repeat(64),
    },
    imageRef,
    imageTag: TARGET_SHA,
    containerImageDigest: CONTAINER_DIGEST,
    dockerImageId: IMAGE_DIGEST,
    imageConfigDigest: IMAGE_DIGEST,
    buildMetadataSha256: "d".repeat(64),
    archive: {
      filename: archiveName,
      format: "docker-tar+zstd",
      sha256: createHash("sha256").update(archive).digest("hex"),
      sizeBytes: archive.byteLength,
    },
    conclusion: "success",
    runId: 12345,
    runAttempt: 1,
  };
  writeFileSync(
    join(artifactDir, "install-smoke-root-image-evidence.json"),
    `${JSON.stringify(evidence)}\n`,
  );

  const zstdPath = join(binDir, "zstd");
  writeFileSync(
    zstdPath,
    `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "-t" ]; then
  exit 0
fi
if [ "\${1:-}" = "-d" ] && [ "\${2:-}" = "--stdout" ]; then
  cat "\${3:?archive required}"
  exit 0
fi
exit 2
`,
  );
  chmodSync(zstdPath, 0o755);

  const dockerPath = join(binDir, "docker");
  writeFileSync(
    dockerPath,
    `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "image" ] && [ "\${2:-}" = "load" ]; then
  cat >/dev/null
  exit 0
fi
if [ "\${1:-}" = "image" ] && [ "\${2:-}" = "inspect" ]; then
  printf '%s\\n' "\${FAKE_IMAGE_DIGEST:?digest required}"
  exit 0
fi
exit 2
`,
  );
  chmodSync(dockerPath, 0o755);

  return { archivePath, artifactDir, binDir, imageRef };
}

function runLoader(fixture: LoaderFixture, env: Record<string, string> = {}) {
  return spawnSync(
    "bash",
    [LOADER_PATH, fixture.artifactDir, TARGET_SHA, fixture.imageRef, basename(fixture.archivePath)],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        FAKE_IMAGE_DIGEST: IMAGE_DIGEST,
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_RUN_ID: "12345",
        PATH: `${fixture.binDir}:${process.env.PATH}`,
        WORKFLOW_SHA,
        ...env,
      },
    },
  );
}

describe("install smoke workflow", () => {
  it("uses registry transport by default and exposes explicit artifact transport", () => {
    const workflow = readWorkflow();
    const preflightCheckout = findStep(workflow.jobs.preflight, "Checkout");

    expect(workflow.on.workflow_dispatch.inputs.root_image_transport).toEqual({
      description: "How full-smoke jobs share the exact-target root image",
      required: false,
      default: "registry",
      type: "choice",
      options: ["registry", "artifact"],
    });
    expect(workflow.on.workflow_call.inputs.root_image_transport).toEqual({
      description: "How full-smoke jobs share the exact-target root image",
      required: false,
      default: "registry",
      type: "string",
    });
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(preflightCheckout.with?.ref).toBe("${{ inputs.ref || github.sha }}");
    expect(JSON.stringify(workflow)).not.toContain("inputs.ref || github.ref");
  });

  it("routes release install-smoke reruns through read-only artifact transport", () => {
    const releaseChecks = parse(readFileSync(RELEASE_CHECKS_PATH, "utf8")) as {
      jobs: Record<
        string,
        {
          permissions: Record<string, string>;
          with: Record<string, unknown>;
        }
      >;
    };
    const installSmoke = releaseChecks.jobs.install_smoke_release_checks;

    expect(installSmoke.permissions).toEqual({ contents: "read", packages: "read" });
    expect(installSmoke.with).toMatchObject({
      ref: "${{ needs.resolve_target.outputs.revision }}",
      root_image_transport: "artifact",
      run_bun_global_install_smoke: true,
      update_baseline_version: "2026.6.11",
    });
  });

  it("isolates the registry writer from the read-only artifact producer", () => {
    const workflow = readWorkflow();
    const registryJob = workflow.jobs.root_dockerfile_image;
    const artifactJob = workflow.jobs.root_dockerfile_image_artifact;
    const artifactBuild = findStep(artifactJob, "Build exact-target root image artifact");
    const artifactUpload = findStep(artifactJob, "Upload root image artifact");

    expect(registryJob.if).toContain("root_image_transport == 'registry'");
    expect(registryJob.permissions).toEqual({ contents: "read", packages: "write" });
    expect(findStep(registryJob, "Build and push root Dockerfile smoke image").run).toContain(
      "--push",
    );

    expect(artifactJob.if).toContain("root_image_transport == 'artifact'");
    expect(artifactJob.permissions).toEqual({ contents: "read" });
    expect(JSON.stringify(artifactJob)).not.toContain("docker/login-action");
    expect(JSON.stringify(artifactJob)).not.toContain("docker pull");
    expect(artifactBuild.run).not.toContain("--push");
    expect(artifactBuild.run).toContain('--output "type=docker,dest=${image_tar}"');
    expect(artifactBuild.run).toContain('--metadata-file "$metadata_path"');
    expect(artifactBuild.run).toContain("containerimage.config.digest");
    expect(artifactBuild.run).toContain("git rev-parse 'HEAD^{tree}'");
    expect(artifactBuild.run).toContain("git rev-parse HEAD:Dockerfile");
    expect(artifactBuild.run).toContain("zstd -T0 -10");
    expect(artifactBuild.run).toContain("openclaw.install-smoke-root-image-evidence/v1");
    expect(artifactBuild.run).toContain('rootImageTransport: "artifact"');
    expect(artifactBuild.run).toContain('format: "docker-tar+zstd"');
    expect(artifactBuild.run).toContain('conclusion: "success"');
    expect(artifactUpload).toMatchObject({
      id: "upload_image",
      uses: UPLOAD_ARTIFACT_V7,
      with: {
        name: "${{ steps.artifact_image.outputs.artifact_name }}",
        path: "${{ steps.artifact_image.outputs.artifact_path }}",
        "if-no-files-found": "error",
        "compression-level": 0,
      },
    });
    expect(artifactJob.outputs).toMatchObject({
      image_artifact_id: "${{ steps.upload_image.outputs.artifact-id }}",
      image_artifact_digest:
        "${{ format('sha256:{0}', steps.upload_image.outputs.artifact-digest) }}",
      image_archive_sha256: "${{ steps.artifact_image.outputs.archive_sha256 }}",
      image_config_digest: "${{ steps.artifact_image.outputs.image_config_digest }}",
      container_image_digest: "${{ steps.artifact_image.outputs.container_image_digest }}",
      image_evidence_sha256: "${{ steps.artifact_image.outputs.evidence_sha256 }}",
    });
  });

  it("uses the trusted workflow revision to verify artifact transport", () => {
    const workflow = readWorkflow();

    for (const jobName of ["root_dockerfile_smokes", "bun_global_install_smoke"]) {
      const job = workflow.jobs[jobName];
      const harness = findStep(job, "Checkout trusted install-smoke harness");
      const load = findStep(job, "Verify and load root Dockerfile smoke image artifact");

      expect(job.needs).toEqual([
        "preflight",
        "root_dockerfile_image",
        "root_dockerfile_image_artifact",
      ]);
      expect(job.permissions).toEqual({ contents: "read", packages: "read" });
      expect(harness).toMatchObject({
        if: "needs.preflight.outputs.root_image_transport == 'artifact'",
        with: {
          repository: "${{ fromJSON(toJSON(job)).workflow_repository }}",
          ref: "${{ fromJSON(toJSON(job)).workflow_sha }}",
          path: ".release-harness",
          "persist-credentials": false,
        },
      });
      expect(load.run).toContain(
        "bash .release-harness/scripts/docker/load-install-smoke-image.sh",
      );
      expect(load.run).not.toContain("candidate/scripts/docker/load-install-smoke-image.sh");
    }

    const installer = workflow.jobs.installer_smoke;
    const trustedCheckout = findStep(installer, "Checkout trusted installer harness");
    const candidateCheckout = findStep(installer, "Checkout candidate CLI");
    const installerLoad = findStep(
      installer,
      "Verify and load root Dockerfile smoke image artifact",
    );
    const installerRun = findStep(installer, "Run installer docker tests");
    expect(installer.permissions).toEqual({ contents: "read", packages: "read" });
    expect(trustedCheckout.with).toMatchObject({
      repository: "${{ fromJSON(toJSON(job)).workflow_repository }}",
      ref: "${{ fromJSON(toJSON(job)).workflow_sha }}",
      "persist-credentials": false,
    });
    expect(candidateCheckout.with).toMatchObject({
      ref: "${{ needs.preflight.outputs.target_sha }}",
      path: "candidate",
      "persist-credentials": false,
    });
    expect(installerRun.env).toMatchObject({
      OPENCLAW_INSTALL_SMOKE_SOURCE_DIR: "${{ github.workspace }}/candidate",
      OPENCLAW_INSTALL_SMOKE_EXPECT_SOURCE_SHA: "${{ needs.preflight.outputs.target_sha }}",
    });
    expect(installerLoad.run).toContain("bash scripts/docker/load-install-smoke-image.sh");
    expect(installerLoad.run).not.toContain("candidate/scripts/docker/load-install-smoke-image.sh");
  });

  it("pins every post-preflight candidate checkout to the resolved target SHA", () => {
    const workflow = readWorkflow();
    const candidateCheckouts = Object.entries(workflow.jobs).flatMap(([jobName, job]) =>
      job.steps
        .filter(
          (step) =>
            jobName !== "preflight" &&
            step.uses === "actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10" &&
            !step.name?.includes("trusted"),
        )
        .map((step) => ({ jobName, step })),
    );

    expect(candidateCheckouts.map(({ jobName }) => jobName).sort()).toEqual(
      [
        "bun_global_install_smoke",
        "docker-e2e-fast",
        "install-smoke-fast",
        "installer_smoke",
        "qr_package_install_smoke",
        "root_dockerfile_image",
        "root_dockerfile_image_artifact",
        "root_dockerfile_smokes",
      ].sort(),
    );
    for (const { jobName, step } of candidateCheckouts) {
      expect(step.with?.ref, jobName).toBe("${{ needs.preflight.outputs.target_sha }}");
    }
    expect(JSON.stringify(candidateCheckouts)).not.toContain("inputs.ref || github.ref");
  });

  it("downloads and loads the exact artifact instead of using GHCR", () => {
    const workflow = readWorkflow();

    for (const jobName of [
      "root_dockerfile_smokes",
      "installer_smoke",
      "bun_global_install_smoke",
    ]) {
      const job = workflow.jobs[jobName];
      const registryLogin = findStep(job, "Log in to GHCR");
      const registryPull = findStep(job, "Pull root Dockerfile smoke image");
      const download = findStep(job, "Download root Dockerfile smoke image artifact");
      const load = findStep(job, "Verify and load root Dockerfile smoke image artifact");

      expect(registryLogin.if).toBe("needs.preflight.outputs.root_image_transport == 'registry'");
      expect(registryPull.if).toBe("needs.preflight.outputs.root_image_transport == 'registry'");
      expect(download).toMatchObject({
        if: "needs.preflight.outputs.root_image_transport == 'artifact'",
        uses: DOWNLOAD_ARTIFACT_V8,
        with: {
          name: "${{ needs.root_dockerfile_image_artifact.outputs.image_artifact_name }}",
          path: "install-smoke-root-image",
        },
      });
      expect(load.if).toBe("needs.preflight.outputs.root_image_transport == 'artifact'");
      expect(load.run).toContain('"$TARGET_SHA"');
      expect(load.run).toContain('"$IMAGE_REF"');
      expect(load.run).toContain('"$ARCHIVE_NAME"');
    }
  });

  it("leaves QR and generic Docker E2E jobs independent from image transport", () => {
    const workflow = readWorkflow();

    for (const jobName of ["qr_package_install_smoke", "docker-e2e-fast"]) {
      const serialized = JSON.stringify(workflow.jobs[jobName]);
      expect(serialized).not.toContain("root_dockerfile_image");
      expect(serialized).not.toContain("install-smoke-root-image");
      expect(serialized).not.toContain("root_image_transport");
    }
  });

  it("uploads one terminal manifest binding the root artifact and all leaf results", () => {
    const workflow = readWorkflow();
    const terminal = workflow.jobs.install_smoke_evidence;
    const checkout = findStep(terminal, "Checkout trusted install-smoke evidence harness");
    const write = findStep(terminal, "Write terminal install-smoke evidence");
    const upload = findStep(terminal, "Upload terminal install-smoke evidence");

    expect(terminal.if).toBe("always()");
    expect(terminal.permissions).toEqual({ contents: "read" });
    expect(terminal.needs).toEqual([
      "preflight",
      "install-smoke-fast",
      "root_dockerfile_image",
      "root_dockerfile_image_artifact",
      "qr_package_install_smoke",
      "root_dockerfile_smokes",
      "installer_smoke",
      "bun_global_install_smoke",
    ]);
    expect(checkout.with).toMatchObject({
      repository: "${{ fromJSON(toJSON(job)).workflow_repository }}",
      ref: "${{ fromJSON(toJSON(job)).workflow_sha }}",
      "persist-credentials": false,
    });
    expect(checkout.uses).toBe("actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10");
    expect(terminal.steps.indexOf(checkout)).toBeLessThan(terminal.steps.indexOf(write));
    expect(JSON.stringify(workflow)).not.toContain("github.workflow_sha");
    expect(JSON.stringify(workflow)).toContain("fromJSON(toJSON(job)).workflow_sha");
    expect(write.run).toContain("validateInstallSmokeJobResults");
    expect(write.run).toContain("openclaw.install-smoke-evidence/v1");
    expect(write.run).toContain("rootArtifact");
    expect(write.run).toContain("containerImageDigest");
    expect(write.run).toContain("imageConfigDigest");
    expect(write.run).toContain("fastInstallSmoke");
    expect(write.run).toContain("qrPackageInstallSmoke");
    expect(write.run).toContain("rootDockerfileSmokes");
    expect(write.run).toContain("installerSmoke");
    expect(write.run).toContain("bunGlobalInstallSmoke");
    expect(write.run).not.toContain("dockerE2eFast");
    expect(upload).toMatchObject({
      id: "upload_evidence",
      if: "always()",
      uses: UPLOAD_ARTIFACT_V7,
      with: {
        name: "install-smoke-evidence-${{ github.run_id }}-${{ github.run_attempt }}",
        path: "${{ runner.temp }}/install-smoke-evidence/install-smoke-evidence.json",
        "if-no-files-found": "error",
      },
    });
  });
});

describe("install smoke terminal result policy", () => {
  it("accepts the full artifact-transport result graph", () => {
    expect(
      validateInstallSmokeJobResults({
        jobs: {
          preflight: "success",
          fastInstallSmoke: "skipped",
          registryImageProducer: "skipped",
          artifactImageProducer: "success",
          qrPackageInstallSmoke: "success",
          rootDockerfileSmokes: "success",
          installerSmoke: "success",
          bunGlobalInstallSmoke: "success",
        },
        rootImageTransport: "artifact",
        runBunGlobalInstallSmoke: true,
        runFastInstallSmoke: true,
        runFullInstallSmoke: true,
      }),
    ).toEqual([]);
  });

  it("accepts fast-only results only when producers and full leaves are skipped", () => {
    const jobs = {
      preflight: "success",
      fastInstallSmoke: "success",
      registryImageProducer: "skipped",
      artifactImageProducer: "skipped",
      qrPackageInstallSmoke: "skipped",
      rootDockerfileSmokes: "skipped",
      installerSmoke: "skipped",
      bunGlobalInstallSmoke: "skipped",
    };

    expect(
      validateInstallSmokeJobResults({
        jobs,
        rootImageTransport: "artifact",
        runBunGlobalInstallSmoke: true,
        runFastInstallSmoke: true,
        runFullInstallSmoke: false,
      }),
    ).toEqual([]);
    expect(
      validateInstallSmokeJobResults({
        jobs: {
          ...jobs,
          artifactImageProducer: "success",
          fastInstallSmoke: "skipped",
        },
        rootImageTransport: "artifact",
        runBunGlobalInstallSmoke: true,
        runFastInstallSmoke: true,
        runFullInstallSmoke: false,
      }),
    ).toEqual(
      expect.arrayContaining([
        "fastInstallSmoke: expected success, got skipped",
        "artifactImageProducer: expected skipped, got success",
      ]),
    );
  });
});

describe("install smoke artifact loader", () => {
  it("accepts a matching evidence manifest and loaded config digest", () => {
    const result = runLoader(createLoaderFixture());
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it("rejects an archive changed after the manifest was written", () => {
    const fixture = createLoaderFixture();
    writeFileSync(fixture.archivePath, "tampered archive\n");
    expect(runLoader(fixture).status).not.toBe(0);
  });

  it("rejects evidence from another workflow run", () => {
    const fixture = createLoaderFixture();
    expect(runLoader(fixture, { GITHUB_RUN_ID: "99999" }).status).not.toBe(0);
  });

  it("rejects rerun attempts", () => {
    const fixture = createLoaderFixture();
    expect(runLoader(fixture, { GITHUB_RUN_ATTEMPT: "2" }).status).not.toBe(0);
  });

  it("rejects a loaded image with a different config digest", () => {
    const fixture = createLoaderFixture();
    expect(runLoader(fixture, { FAKE_IMAGE_DIGEST: `sha256:${"e".repeat(64)}` }).status).not.toBe(
      0,
    );
  });
});
