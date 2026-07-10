import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const PACKAGE_ACCEPTANCE_WORKFLOW = ".github/workflows/package-acceptance.yml";
const LIVE_E2E_WORKFLOW = ".github/workflows/openclaw-live-and-e2e-checks-reusable.yml";
const RELEASE_DELTA_WORKFLOW = ".github/workflows/release-delta-evidence.yml";
const EXACT_PACKAGE_VERIFIER = "scripts/verify-openwebui-exact-package-artifact.sh";
const OPENWEBUI_DOCKERFILE = "scripts/e2e/Dockerfile";
const OPENWEBUI_HARNESS = "scripts/e2e/openwebui-docker.sh";
const DOCKER_IMAGE_HELPER = "scripts/lib/docker-e2e-image.sh";
const DOCKER_SCENARIOS = "scripts/lib/docker-e2e-scenarios.mjs";
const EXACT_PACKAGE_VERIFIER_PATH = resolve(EXACT_PACKAGE_VERIFIER);

type WorkflowInput = {
  default?: boolean | number | string;
  description?: string;
  options?: string[];
  type?: string;
};

type WorkflowStep = {
  env?: Record<string, string>;
  id?: string;
  if?: string;
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, boolean | number | string>;
};

type WorkflowJob = {
  env?: Record<string, string>;
  if?: string;
  name?: string;
  outputs?: Record<string, string>;
  permissions?: Record<string, string>;
  secrets?: Record<string, string>;
  steps?: WorkflowStep[];
  uses?: string;
  with?: Record<string, boolean | number | string>;
};

type Workflow = {
  jobs?: Record<string, WorkflowJob>;
  on?: {
    workflow_call?: {
      inputs?: Record<string, WorkflowInput>;
    };
    workflow_dispatch?: {
      inputs?: Record<string, WorkflowInput>;
    };
  };
};

type ZipEntry = {
  data: Buffer;
  mode?: number;
  name: string;
};

type ExactPackageFixtureOptions = {
  aiHashMismatch?: boolean;
  aiPackageVersion?: string;
  apiMetadataMismatch?: boolean;
  candidateSourceSha?: string;
  duplicateEntry?: string;
  extraEntry?: boolean;
  markSymlinkEntry?: string;
  packageSetTargetSha?: string;
  rawDigestMismatch?: boolean;
  rootHashMismatch?: boolean;
  rootPackageVersion?: string;
  runAttempt?: string;
  trustedWorkflowShaOverride?: string;
};

type ExactPackageFixture = {
  aiRuntimeSha256: string;
  cleanup: () => void;
  env: NodeJS.ProcessEnv;
  outputDir: string;
  root: string;
  rootEntrySha256: string;
};

const CRC32_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function readWorkflow(path: string): Workflow {
  return parse(readFileSync(path, "utf8")) as Workflow;
}

function workflowJob(workflow: Workflow, name: string): WorkflowJob {
  const job = workflow.jobs?.[name];
  if (!job) {
    throw new Error(`Expected workflow job ${name}`);
  }
  return job;
}

function workflowStep(job: WorkflowJob, name: string): WorkflowStep {
  const step = job.steps?.find((candidate) => candidate.name === name);
  if (!step) {
    throw new Error(`Expected workflow step ${name}`);
  }
  return step;
}

function expectTextToIncludeAll(text: string | undefined, snippets: string[]): void {
  if (text === undefined) {
    throw new Error("Expected workflow script text");
  }
  for (const snippet of snippets) {
    expect(text).toContain(snippet);
  }
}

function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function crc32(data: Buffer): number {
  let value = 0xffffffff;
  for (const byte of data) {
    value = CRC32_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function writeStoredZip(path: string, entries: ZipEntry[]): void {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const checksum = crc32(entry.data);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(entry.data.length, 18);
    localHeader.writeUInt32LE(entry.data.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localHeader.writeUInt16LE(0, 28);
    localParts.push(localHeader, name, entry.data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(0x0314, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(entry.data.length, 20);
    centralHeader.writeUInt32LE(entry.data.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(((entry.mode ?? 0o100644) << 16) >>> 0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(centralHeader, name);

    offset += localHeader.length + name.length + entry.data.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  writeFileSync(path, Buffer.concat([...localParts, centralDirectory, end]));
}

function runRequired(command: string, args: string[], cwd: string): string {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed:\n${String(result.stdout)}\n${String(result.stderr)}`,
    );
  }
  return String(result.stdout).trim();
}

function createPackageTarball(params: {
  entry: string;
  entryContents: string;
  fixtureRoot: string;
  name: string;
  slug: string;
  version: string;
}): { entrySha256: string; path: string; sha256: string } {
  const sourceRoot = join(params.fixtureRoot, `${params.slug}-source`);
  const packageRoot = join(sourceRoot, "package");
  const entryPath = join(packageRoot, params.entry);
  mkdirSync(dirname(entryPath), { recursive: true });
  writeFileSync(
    join(packageRoot, "package.json"),
    `${JSON.stringify({ name: params.name, version: params.version }, null, 2)}\n`,
  );
  writeFileSync(entryPath, params.entryContents);
  const tarball = join(params.fixtureRoot, `${params.slug}.tgz`);
  runRequired("tar", ["-czf", tarball, "-C", sourceRoot, "package"], params.fixtureRoot);
  return {
    entrySha256: sha256(params.entryContents),
    path: tarball,
    sha256: sha256(readFileSync(tarball)),
  };
}

function createExactPackageFixture(options: ExactPackageFixtureOptions = {}): ExactPackageFixture {
  const root = mkdtempSync(join(tmpdir(), "openclaw-openwebui-exact-"));
  const targetSha = "a".repeat(40);
  const packageVersion = "2026.7.1-beta.3";
  const runId = "456";
  const packageArtifactId = "123";
  const npmPreflightRunId = "789";
  const npmPreflightArtifactId = "987";
  const npmPreflightArtifactDigest = `sha256:${"b".repeat(64)}`;
  const npmPreflightManifestSha256 = "c".repeat(64);

  const harness = join(root, ".release-harness");
  mkdirSync(harness);
  runRequired("git", ["init", "-q"], harness);
  writeFileSync(join(harness, "fixture.txt"), "trusted release harness\n");
  runRequired("git", ["add", "fixture.txt"], harness);
  runRequired(
    "git",
    [
      "-c",
      "user.name=OpenClaw Test",
      "-c",
      "user.email=openclaw-test@example.com",
      "commit",
      "-qm",
      "test: trusted release harness",
    ],
    harness,
  );
  const actualHarnessSha = runRequired("git", ["rev-parse", "HEAD"], harness);
  const trustedWorkflowSha = options.trustedWorkflowShaOverride ?? actualHarnessSha;

  const rootTarball = createPackageTarball({
    entry: "dist/index.js",
    entryContents: "export const openclawExactFixture = true;\n",
    fixtureRoot: root,
    name: "openclaw",
    slug: "openclaw-current",
    version: options.rootPackageVersion ?? packageVersion,
  });
  const aiTarball = createPackageTarball({
    entry: "dist/internal/runtime.mjs",
    entryContents: "export const aiExactFixture = true;\n",
    fixtureRoot: root,
    name: "@openclaw/ai",
    slug: "openclaw-ai-current",
    version: options.aiPackageVersion ?? packageVersion,
  });
  const declaredRootSha256 = options.rootHashMismatch ? "d".repeat(64) : rootTarball.sha256;
  const declaredAiSha256 = options.aiHashMismatch ? "e".repeat(64) : aiTarball.sha256;
  const npmPreflightArtifactName = `openclaw-npm-preflight-${targetSha}`;

  const packageCandidate = Buffer.from(
    `${JSON.stringify(
      {
        name: "openclaw",
        packageSourceSha: options.candidateSourceSha ?? targetSha,
        sha256: declaredRootSha256,
        version: packageVersion,
      },
      null,
      2,
    )}\n`,
  );
  const packageSet = Buffer.from(
    `${JSON.stringify(
      {
        schema: "openclaw.openwebui-package-set/v1",
        targetSha: options.packageSetTargetSha ?? targetSha,
        trustedWorkflow: {
          path: ".github/workflows/package-acceptance.yml",
          sha: trustedWorkflowSha,
          runId: Number(runId),
          runAttempt: Number(options.runAttempt ?? "1"),
        },
        npmPreflightArtifact: {
          runId: Number(npmPreflightRunId),
          id: Number(npmPreflightArtifactId),
          name: npmPreflightArtifactName,
          digest: npmPreflightArtifactDigest,
          manifestSha256: npmPreflightManifestSha256,
        },
        root: {
          file: "openclaw-current.tgz",
          name: "openclaw",
          version: packageVersion,
          sha256: declaredRootSha256,
        },
        ai: {
          file: "openclaw-ai-current.tgz",
          name: "@openclaw/ai",
          version: packageVersion,
          sha256: declaredAiSha256,
        },
      },
      null,
      2,
    )}\n`,
  );

  const entries: ZipEntry[] = [
    {
      name: "openclaw-current.tgz",
      data: readFileSync(rootTarball.path),
    },
    {
      name: "openclaw-ai-current.tgz",
      data: readFileSync(aiTarball.path),
    },
    {
      name: "package-candidate.json",
      data: packageCandidate,
    },
    {
      name: "exact-package-set.json",
      data: packageSet,
    },
  ].map((entry) =>
    entry.name === options.markSymlinkEntry ? { ...entry, mode: 0o120777 } : entry,
  );
  if (options.duplicateEntry) {
    const duplicate = entries.find((entry) => entry.name === options.duplicateEntry);
    if (!duplicate) {
      throw new Error(`Unknown duplicate entry ${options.duplicateEntry}`);
    }
    entries.push({ ...duplicate });
  }
  if (options.extraEntry) {
    entries.push({ data: Buffer.from("unexpected\n"), name: "unexpected.txt" });
  }

  const archive = join(root, "package-artifact.zip");
  writeStoredZip(archive, entries);
  const actualArtifactDigest = `sha256:${sha256(readFileSync(archive))}`;
  const declaredArtifactDigest = options.rawDigestMismatch
    ? `sha256:${"f".repeat(64)}`
    : actualArtifactDigest;
  const apiArtifactDigest = options.apiMetadataMismatch
    ? `sha256:${"0".repeat(64)}`
    : declaredArtifactDigest;
  const artifactJson = join(root, "artifact.json");
  writeFileSync(
    artifactJson,
    `${JSON.stringify({
      id: Number(packageArtifactId),
      name: "package-under-test",
      expired: false,
      digest: apiArtifactDigest,
      workflow_run: {
        id: Number(runId),
        head_sha: trustedWorkflowSha,
      },
    })}\n`,
  );

  const fakeBin = join(root, "bin");
  mkdirSync(fakeBin);
  const fakeGh = join(fakeBin, "gh");
  writeFileSync(
    fakeGh,
    `#!/usr/bin/env bash
set -euo pipefail
request="\${!#}"
if [[ "$request" == */zip ]]; then
  cat "$FIXTURE_ARCHIVE"
else
  cat "$FIXTURE_ARTIFACT_JSON"
fi
`,
  );
  chmodSync(fakeGh, 0o755);

  const outputDir = join(root, "verified-package");
  const githubOutput = join(root, "github-output.txt");
  return {
    aiRuntimeSha256: aiTarball.entrySha256,
    cleanup: () => rmSync(root, { force: true, recursive: true }),
    env: {
      ...process.env,
      FIXTURE_ARCHIVE: archive,
      FIXTURE_ARTIFACT_JSON: artifactJson,
      GH_TOKEN: "fixture-token",
      GITHUB_OUTPUT: githubOutput,
      GITHUB_REPOSITORY: "openclaw/openclaw",
      GITHUB_RUN_ATTEMPT: options.runAttempt ?? "1",
      GITHUB_RUN_ID: runId,
      NPM_PREFLIGHT_ARTIFACT_DIGEST: npmPreflightArtifactDigest,
      NPM_PREFLIGHT_ARTIFACT_ID: npmPreflightArtifactId,
      NPM_PREFLIGHT_ARTIFACT_NAME: npmPreflightArtifactName,
      NPM_PREFLIGHT_MANIFEST_SHA256: npmPreflightManifestSha256,
      NPM_PREFLIGHT_RUN_ID: npmPreflightRunId,
      OPENCLAW_EXACT_PACKAGE_OUTPUT_DIR: outputDir,
      PACKAGE_AI_SHA256: declaredAiSha256,
      PACKAGE_AI_VERSION: packageVersion,
      PACKAGE_ARTIFACT_DIGEST: declaredArtifactDigest,
      PACKAGE_ARTIFACT_ID: packageArtifactId,
      PACKAGE_ARTIFACT_NAME: "package-under-test",
      PACKAGE_SET_MANIFEST_SHA256: sha256(packageSet),
      PACKAGE_SHA256: declaredRootSha256,
      PACKAGE_VERSION: packageVersion,
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      RUNNER_TEMP: root,
      TARGET_SHA: targetSha,
      TRUSTED_WORKFLOW_SHA: trustedWorkflowSha,
    },
    outputDir,
    root,
    rootEntrySha256: rootTarball.entrySha256,
  };
}

function runExactPackageVerifier(fixture: ExactPackageFixture) {
  return spawnSync("bash", [EXACT_PACKAGE_VERIFIER_PATH], {
    cwd: fixture.root,
    encoding: "utf8",
    env: fixture.env,
  });
}

describe("exact-target OpenWebUI package acceptance", () => {
  it("resolves one immutable beta npm preflight artifact and preserves standard defaults", () => {
    const workflow = readWorkflow(PACKAGE_ACCEPTANCE_WORKFLOW);
    const dispatchInputs = workflow.on?.workflow_dispatch?.inputs;
    const callInputs = workflow.on?.workflow_call?.inputs;
    expect(dispatchInputs?.openwebui_mode).toMatchObject({
      default: "standard",
      options: ["standard", "exact-target-local"],
      type: "choice",
    });
    expect(callInputs?.openwebui_mode).toMatchObject({
      default: "standard",
      type: "string",
    });
    expect(dispatchInputs?.preflight_artifact_id?.description).toContain(
      "required for exact-target OpenWebUI",
    );
    expect(dispatchInputs?.preflight_artifact_digest?.description).toContain(
      "required for exact-target OpenWebUI",
    );

    const resolvePackage = workflowJob(workflow, "resolve_package");
    expect(resolvePackage.outputs).toMatchObject({
      exact_openwebui: "${{ steps.profile.outputs.exact_openwebui }}",
      package_artifact_digest:
        "${{ format('sha256:{0}', steps.upload_package.outputs.artifact-digest) }}",
      package_artifact_id: "${{ steps.upload_package.outputs.artifact-id }}",
      preflight_artifact_digest: "${{ steps.exact_preflight.outputs.artifact_digest }}",
      preflight_artifact_id: "${{ steps.exact_preflight.outputs.artifact_id }}",
      preflight_run_id: "${{ steps.exact_preflight.outputs.run_id }}",
    });

    expectTextToIncludeAll(
      workflowStep(resolvePackage, "Validate exact-target OpenWebUI inputs").run,
      [
        '[[ "$WORKFLOW_RUN_ATTEMPT" == "1" ]]',
        '[[ "$ADVISORY" == "false" ]]',
        '[[ "$SOURCE" == "artifact" ]]',
        '[[ "$PREFLIGHT_RUN_ID" =~ ^[1-9][0-9]*$ ]]',
        '[[ "$TARGET_SHA" =~ ^[0-9a-f]{40}$ ]]',
        '[[ "$TELEGRAM_MODE" == "none" ]]',
        "preflight_artifact_digest must be an explicit lowercase sha256 digest.",
      ],
    );
    const preflight = workflowStep(resolvePackage, "Download exact npm preflight artifact");
    expect(preflight.if).toBe("inputs.openwebui_mode == 'exact-target-local'");
    expectTextToIncludeAll(preflight.run, [
      '.name == "OpenClaw NPM Release"',
      '.path == ".github/workflows/openclaw-npm-release.yml"',
      ".run_attempt == 1",
      ".head_sha == $target_sha",
      "Raw npm preflight artifact ZIP digest mismatch.",
      "manifest.releaseSha !== targetSha",
      "manifest.releaseTag !== `v${manifest.packageVersion}`",
      'manifest.npmDistTag !== "beta"',
      'manifest.packageName !== "openclaw"',
      'entry?.packageName === "@openclaw/ai"',
      "npm preflight root tarball digest mismatch.",
      '"@openclaw/ai" || ai.version !== expectedVersion',
      "package/dist/internal/runtime.mjs",
      'packageTrustedReason: "npm-preflight-artifact"',
    ]);
    expectTextToIncludeAll(workflowStep(resolvePackage, "Stage exact OpenWebUI package set").run, [
      "runId: $trustedWorkflowRunId",
      "runAttempt: $trustedWorkflowRunAttempt",
    ]);
  });

  it("calls the focused local-image lane without package registry permission", () => {
    const workflow = readWorkflow(PACKAGE_ACCEPTANCE_WORKFLOW);
    const exactJob = workflowJob(workflow, "openwebui_exact_target");
    expect(exactJob).toMatchObject({
      name: "Focused exact-target OpenWebUI package acceptance",
      if: "needs.resolve_package.outputs.exact_openwebui == 'true'",
      uses: "./.github/workflows/openclaw-live-and-e2e-checks-reusable.yml",
      permissions: {
        actions: "read",
        contents: "read",
        "pull-requests": "read",
      },
    });
    expect(exactJob.permissions).not.toHaveProperty("packages");
    expect(exactJob.with).toMatchObject({
      advisory: false,
      ref: "${{ inputs.target_sha }}",
      include_repo_e2e: false,
      include_release_path_suites: false,
      include_openwebui: true,
      docker_lanes: "",
      package_artifact_id: "${{ needs.resolve_package.outputs.package_artifact_id }}",
      package_artifact_digest: "${{ needs.resolve_package.outputs.package_artifact_digest }}",
      package_ai_sha256: "${{ needs.resolve_package.outputs.package_ai_sha256 }}",
      package_ai_version: "${{ needs.resolve_package.outputs.package_ai_version }}",
      package_set_manifest_sha256:
        "${{ needs.resolve_package.outputs.package_set_manifest_sha256 }}",
      package_sha256: "${{ needs.resolve_package.outputs.package_sha256 }}",
      package_version: "${{ needs.resolve_package.outputs.package_version }}",
      npm_preflight_run_id: "${{ needs.resolve_package.outputs.preflight_run_id }}",
      npm_preflight_artifact_id: "${{ needs.resolve_package.outputs.preflight_artifact_id }}",
      npm_preflight_artifact_digest:
        "${{ needs.resolve_package.outputs.preflight_artifact_digest }}",
      npm_preflight_artifact_name: "${{ needs.resolve_package.outputs.preflight_artifact_name }}",
      npm_preflight_manifest_sha256:
        "${{ needs.resolve_package.outputs.preflight_manifest_sha256 }}",
      trusted_workflow_sha: "${{ needs.resolve_package.outputs.trusted_workflow_sha }}",
      shared_image_policy: "artifact",
      include_live_suites: false,
      live_models_only: false,
    });
    expect(exactJob.with).not.toHaveProperty("docker_e2e_bare_image");
    expect(exactJob.with).not.toHaveProperty("docker_e2e_functional_image");
    expect(exactJob.secrets).toEqual({
      OPENAI_API_KEY: "${{ secrets.OPENAI_API_KEY }}",
      OPENAI_BASE_URL: "${{ secrets.OPENAI_BASE_URL }}",
    });
    expect(workflowJob(workflow, "docker_acceptance").if).toBe(
      "needs.resolve_package.outputs.exact_openwebui != 'true'",
    );
  });

  it("keeps the delta producer focused caller off the package registry", () => {
    const workflow = readWorkflow(RELEASE_DELTA_WORKFLOW);
    const exactJob = workflowJob(workflow, "focused_openwebui");
    expect(exactJob.permissions).toEqual({
      actions: "read",
      contents: "read",
      "pull-requests": "read",
    });
  });

  it("keeps exact artifact mode callable-only and forbids shared image mutation", () => {
    const workflow = readWorkflow(LIVE_E2E_WORKFLOW);
    const dispatchInputs = workflow.on?.workflow_dispatch?.inputs;
    const callInputs = workflow.on?.workflow_call?.inputs;
    expect(dispatchInputs?.shared_image_policy).toMatchObject({
      default: "allow-push",
      options: ["allow-push", "existing-only"],
      type: "choice",
    });
    for (const name of [
      "package_artifact_id",
      "package_artifact_digest",
      "package_ai_sha256",
      "package_ai_version",
      "package_set_manifest_sha256",
      "package_sha256",
      "package_version",
      "npm_preflight_run_id",
      "npm_preflight_artifact_id",
      "npm_preflight_artifact_digest",
      "npm_preflight_artifact_name",
      "npm_preflight_manifest_sha256",
      "trusted_workflow_sha",
    ]) {
      expect(dispatchInputs).not.toHaveProperty(name);
      expect(callInputs).toHaveProperty(name);
    }
    expect(callInputs?.shared_image_policy).toMatchObject({
      default: "allow-push",
      type: "string",
    });

    const validateJob = workflowJob(workflow, "validate_selected_ref");
    expect(workflowStep(validateJob, "Checkout workflow repository").with).toMatchObject({
      repository:
        "${{ inputs.shared_image_policy == 'artifact' && fromJSON(toJSON(job)).workflow_repository || github.repository }}",
      ref: "${{ inputs.shared_image_policy == 'artifact' && fromJSON(toJSON(job)).workflow_sha || github.sha }}",
      "persist-credentials": false,
    });
    const validate = workflowStep(validateJob, "Validate selected ref");
    expectTextToIncludeAll(validate.run, [
      'case "$SHARED_IMAGE_POLICY" in',
      "allow-push)",
      "existing-only)",
      "artifact)",
      '[[ "$WORKFLOW_RUN_ATTEMPT" == "1" ]]',
      "shared_image_policy=artifact requires ref to be the exact lowercase target SHA.",
      "shared_image_policy=artifact is a focused OpenWebUI-only mode.",
      "shared_image_policy=artifact builds the exact package locally and rejects provided images.",
      "npm_preflight_artifact_digest must be a lowercase sha256 digest.",
      "trusted_workflow_sha must equal the called reusable workflow SHA.",
    ]);

    const prepare = workflowJob(workflow, "prepare_docker_e2e_image");
    expect(prepare.if).toContain("inputs.shared_image_policy != 'artifact'");
    expect(workflowStep(prepare, "Log in to GHCR").if).toContain(
      "inputs.shared_image_policy != 'artifact'",
    );
    expect(workflowStep(prepare, "Check existing shared Docker E2E images").if).toContain(
      "inputs.shared_image_policy != 'artifact'",
    );
    expectTextToIncludeAll(workflowStep(prepare, "Check existing shared Docker E2E images").run, [
      "shared_image_policy=existing-only forbids building or pushing missing shared images.",
    ]);
    expect(workflowStep(prepare, "Setup Docker builder").if).toContain(
      "inputs.shared_image_policy == 'allow-push'",
    );
    for (const name of [
      "Build and push bare Docker E2E image",
      "Build and push functional Docker E2E image",
    ]) {
      const step = workflowStep(prepare, name);
      expect(step.if).toContain("inputs.shared_image_policy == 'allow-push'");
      expect(step.run).toContain("--push");
    }
  });

  it("builds the exact functional image locally and emits byte-bound evidence", () => {
    const workflow = readWorkflow(LIVE_E2E_WORKFLOW);
    const job = workflowJob(workflow, "validate_docker_openwebui");
    expect(job.name).toBe("Docker E2E (openwebui)");
    expect(job.permissions).not.toHaveProperty("packages");
    expect(job.env).toMatchObject({
      OPENCLAW_DOCKER_E2E_REQUIRE_LOCAL_IMAGE:
        "${{ inputs.shared_image_policy == 'artifact' && '1' || '0' }}",
      OPENCLAW_OPENWEBUI_MODEL: "openai/gpt-5.5",
      OPENCLAW_SKIP_DOCKER_BUILD: "1",
    });
    expect(workflowStep(job, "Checkout selected ref").with).toMatchObject({
      "persist-credentials": false,
    });
    expect(workflowStep(job, "Checkout trusted release harness").with).toMatchObject({
      repository:
        "${{ inputs.shared_image_policy == 'artifact' && fromJSON(toJSON(job)).workflow_repository || github.repository }}",
      ref: "${{ inputs.shared_image_policy == 'artifact' && fromJSON(toJSON(job)).workflow_sha || github.sha }}",
      "persist-credentials": false,
    });
    expect(workflowStep(job, "Log in to GHCR for shared Docker E2E image").if).toBe(
      "inputs.shared_image_policy != 'artifact'",
    );
    expect(workflowStep(job, "Pull shared bare Docker E2E image").if).toContain(
      "inputs.shared_image_policy != 'artifact'",
    );
    expect(workflowStep(job, "Pull shared functional Docker E2E image").if).toContain(
      "inputs.shared_image_policy != 'artifact'",
    );

    const exactPackage = workflowStep(job, "Download and verify exact OpenWebUI package artifact");
    expect(exactPackage.run).toBe(
      "bash .release-harness/scripts/verify-openwebui-exact-package-artifact.sh",
    );
    const build = workflowStep(job, "Build exact-target local functional image");
    expectTextToIncludeAll(build.run, [
      "docker buildx build",
      "--load",
      "--target functional-local-ai",
      "--build-context openclaw_package=.artifacts/docker-e2e-package",
      "docker image inspect --format '{{.Id}}' \"$FUNCTIONAL_IMAGE\"",
      'echo "image_id=$image_id" >> "$GITHUB_OUTPUT"',
    ]);
    expect(build.run).not.toContain("--push");

    const run = workflowStep(job, "Run Open WebUI Docker E2E chunk");
    expectTextToIncludeAll(run.run, [
      'if [[ "$SHARED_IMAGE_POLICY" == "artifact" ]]',
      "cd .release-harness",
      "bash scripts/e2e/openwebui-docker.sh",
      "export OPENCLAW_DOCKER_ALL_BUILD=0",
      "export OPENCLAW_DOCKER_E2E_REQUIRE_LOCAL_IMAGE=1",
      "export OPENCLAW_SKIP_DOCKER_BUILD=1",
      '[[ "$before_image_id" == "$EXACT_FUNCTIONAL_IMAGE_ID" ]]',
      '[[ "$after_image_id" != "$before_image_id" ]]',
      'echo "before_image_id=$before_image_id"',
      'echo "after_image_id=$after_image_id"',
    ]);
    expect(run.run).not.toContain("OPENCLAW_DOCKER_ALL_BUILD=1");
    expect(run.run).not.toContain("OPENCLAW_SKIP_DOCKER_BUILD=0");

    const evidence = workflowStep(job, "Write exact-target OpenWebUI evidence");
    expect(evidence.if).toBe("inputs.shared_image_policy == 'artifact'");
    expect(evidence.env).toMatchObject({
      PACKAGE_AI_RUNTIME_SHA256: "${{ steps.exact_package.outputs.ai_runtime_sha256 }}",
      PACKAGE_ROOT_ENTRY_SHA256: "${{ steps.exact_package.outputs.root_entry_sha256 }}",
    });
    expectTextToIncludeAll(evidence.run, [
      '[[ "$GITHUB_RUN_ATTEMPT" == "1" ]]',
      "release-openwebui/openwebui-exact-target-evidence.json",
      '.status == "passed"',
      '.lanes[0].name == "openwebui"',
      "docker image inspect --format '{{.Id}}' \"$FUNCTIONAL_IMAGE\"",
      '[[ "$RUN_BEFORE_IMAGE_ID" == "$BUILT_IMAGE_ID"',
      '"$RUN_AFTER_IMAGE_ID" == "$BUILT_IMAGE_ID"',
      'require("/app/package.json")',
      "entrySha256:hash(rootEntry)",
      "runtimeSha256:hash(aiRuntime)",
      "entrySha256: $packageRootEntrySha256",
      "runtimeSha256: $packageAiRuntimeSha256",
      "providerModel: $providerModel",
      'provider: "openai"',
      'docker save --output "$image_archive" "$FUNCTIONAL_IMAGE"',
      'distribution: "local-buildx-load"',
      "localImageRequired: true",
      "beforeRunId: $imageBeforeRunId",
      "afterRunId: $imageAfterRunId",
      'format: "docker-archive"',
      'id: "openwebui-chat"',
      "sharedGhcrLogin: false",
      "sharedImagePull: false",
      "candidateImagePull: false",
      "imagePush: false",
      'conclusion: "success"',
    ]);
    expect(workflowStep(job, "Upload Open WebUI Docker E2E artifacts").with).toMatchObject({
      name: "docker-e2e-openwebui",
      path: ".artifacts/docker-tests/",
      "if-no-files-found": "error",
    });
    expect(workflowStep(job, "Upload exact-target OpenWebUI evidence").with).toEqual({
      name: "openwebui-exact-target-evidence",
      path: ".artifacts/docker-tests/release-openwebui/openwebui-exact-target-evidence.json",
      "if-no-files-found": "error",
    });
  });

  it("fails exact local-image reuse before any candidate pull", () => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-openwebui-local-image-"));
    const calls = join(root, "docker-calls.log");
    try {
      const script = `
set -euo pipefail
source "$1"
calls="$2"
docker_e2e_docker_cmd() {
  printf '%s\\n' "$*" >> "$calls"
  if [[ "$1" == "image" && "$2" == "inspect" ]]; then
    return 1
  fi
  if [[ "$1" == "pull" ]]; then
    return 0
  fi
  return 0
}
export OPENCLAW_SKIP_DOCKER_BUILD=1
export OPENCLAW_DOCKER_E2E_REQUIRE_LOCAL_IMAGE=1
if docker_e2e_build_or_reuse "openclaw-exact-target:missing" "exact-target"; then
  echo "missing local image unexpectedly succeeded" >&2
  exit 91
fi
if grep -q '^pull ' "$calls"; then
  echo "candidate pull was attempted" >&2
  exit 92
fi
`;
      const result = spawnSync(
        "bash",
        ["-c", script, "bash", resolve(DOCKER_IMAGE_HELPER), calls],
        {
          cwd: process.cwd(),
          encoding: "utf8",
        },
      );
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.stderr).toContain(
        "Required local Docker image not found: openclaw-exact-target:missing",
      );
      expect(readFileSync(calls, "utf8")).toBe("image inspect openclaw-exact-target:missing\n");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("uses a trusted regular-file verifier and one OpenAI model source", () => {
    const verifier = readFileSync(EXACT_PACKAGE_VERIFIER, "utf8");
    expectTextToIncludeAll(verifier, [
      '[[ "$GITHUB_RUN_ATTEMPT" == "1" ]]',
      ".workflow_run.head_sha == $trusted_workflow_sha",
      '[[ "${#entries[@]}" == "4" ]]',
      'unzip -p "$archive" "$entry" >"$output_dir/$entry"',
      "root_entry_sha256=",
      "ai_runtime_sha256=",
      "Trusted release harness checkout differs from the package-set workflow SHA.",
    ]);
    expect(verifier).not.toContain('unzip -q "$archive" -d');

    const dockerfile = readFileSync(OPENWEBUI_DOCKERFILE, "utf8");
    expectTextToIncludeAll(dockerfile, [
      "FROM bare AS functional-local-ai",
      "openclaw-ai-current.tgz",
      "openclaw-current.tgz",
      "npm install --prefix /tmp/openclaw-prefix",
    ]);
    const harness = readFileSync(OPENWEBUI_HARNESS, "utf8");
    expectTextToIncludeAll(harness, [
      "OPENCLAW_OPENWEBUI_EVIDENCE_FILE",
      'schema: "openclaw.openwebui-probe-evidence/v1"',
      "nonceSha256",
      "replySha256",
      "replyContainsNonce: true",
    ]);
    const scenarios = readFileSync(DOCKER_SCENARIOS, "utf8");
    expect(scenarios).not.toContain("OPENCLAW_OPENWEBUI_MODEL=openai/gpt-5.4-mini");
  });

  it("materializes one exact package set as regular files and emits content hashes", () => {
    const fixture = createExactPackageFixture({
      markSymlinkEntry: "package-candidate.json",
    });
    try {
      const result = runExactPackageVerifier(fixture);
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      for (const name of [
        "openclaw-current.tgz",
        "openclaw-ai-current.tgz",
        "package-candidate.json",
        "exact-package-set.json",
      ]) {
        const stat = lstatSync(join(fixture.outputDir, name));
        expect(stat.isFile()).toBe(true);
        expect(stat.isSymbolicLink()).toBe(false);
      }
      const outputs = readFileSync(fixture.env.GITHUB_OUTPUT as string, "utf8");
      expect(outputs).toContain(`root_entry_sha256=${fixture.rootEntrySha256}`);
      expect(outputs).toContain(`ai_runtime_sha256=${fixture.aiRuntimeSha256}`);
    } finally {
      fixture.cleanup();
    }
  });

  const tamperCases: Array<[string, ExactPackageFixtureOptions, string]> = [
    [
      "artifact API metadata",
      { apiMetadataMismatch: true },
      "Exact package artifact identity, digest, name, or run differs.",
    ],
    ["raw ZIP digest", { rawDigestMismatch: true }, "Exact package artifact ZIP digest mismatch."],
    [
      "duplicate normalized member",
      { duplicateEntry: "openclaw-current.tgz" },
      "Exact package artifact must contain one openclaw-current.tgz; found 2.",
    ],
    [
      "extra normalized member",
      { extraEntry: true },
      "Exact package artifact must contain only the four normalized package-set files.",
    ],
    [
      "root package hash",
      { rootHashMismatch: true },
      "Exact package root tarball digest mismatch.",
    ],
    [
      "AI package hash",
      { aiHashMismatch: true },
      "Exact package @openclaw/ai tarball digest mismatch.",
    ],
    [
      "root package version",
      { rootPackageVersion: "2026.7.1-beta.4" },
      "root package identity differs",
    ],
    [
      "AI package version",
      { aiPackageVersion: "2026.7.1-beta.4" },
      "@openclaw/ai package identity differs",
    ],
    [
      "package-set target",
      { packageSetTargetSha: "1".repeat(40) },
      "Exact package-set manifest does not bind the requested source and package identities.",
    ],
    [
      "package candidate source",
      { candidateSourceSha: "2".repeat(40) },
      "Package candidate metadata does not bind the exact root tarball.",
    ],
    [
      "trusted harness SHA",
      { trustedWorkflowShaOverride: "3".repeat(40) },
      "Trusted release harness checkout differs from the package-set workflow SHA.",
    ],
    [
      "workflow rerun",
      { runAttempt: "2" },
      "Exact package verification requires workflow run attempt 1.",
    ],
  ];

  it.each(tamperCases)("rejects tampered %s", (_name, options, expectedError) => {
    const fixture = createExactPackageFixture(options);
    try {
      const result = runExactPackageVerifier(fixture);
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain(expectedError);
    } finally {
      fixture.cleanup();
    }
  });
});
