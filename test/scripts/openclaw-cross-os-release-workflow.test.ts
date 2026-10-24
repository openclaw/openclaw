import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  resolvePackagedUpgradeTimeouts,
  resolveRunnerMatrix,
} from "../../scripts/lib/cross-os-release-checks/config.ts";
import { createReleaseCheckSelection } from "../../scripts/plan-release-workflow-matrix.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.ts";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
function expectContains(text: string | undefined, fragments: string[]) {
  for (const fragment of fragments) {
    expect(text).toContain(fragment);
  }
}

const WORKFLOW_PATH = ".github/workflows/openclaw-cross-os-release-checks-reusable.yml";
const RELEASE_CHECKS_PATH = ".github/workflows/openclaw-release-checks.yml";
const WRAPPER_PATH = "scripts/github/run-openclaw-cross-os-release-checks.sh";
const SCRIPT_PATH = "scripts/openclaw-cross-os-release-checks.ts";
const BASH_BIN = process.platform === "win32" ? "bash" : "/bin/bash";

type WorkflowStep = {
  "continue-on-error"?: boolean | string;
  env?: Record<string, unknown>;
  id?: string;
  if?: string;
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
  "working-directory"?: string;
};

type WorkflowJob = {
  "timeout-minutes"?: number | string;
  "continue-on-error"?: boolean | string;
  if?: string;
  needs?: string | string[];
  outputs?: Record<string, unknown>;
  steps?: WorkflowStep[];
  with?: Record<string, unknown>;
};

type Workflow = {
  jobs: Record<string, WorkflowJob>;
  on?: {
    workflow_call?: { inputs?: Record<string, Record<string, unknown>> };
    workflow_dispatch?: { inputs?: Record<string, Record<string, unknown>> };
  };
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

function expressionBinding(expression: string) {
  return `\${{ ${expression} }}`;
}

function expectBindings(actual: unknown, prefix: string, fields: Record<string, string>) {
  expect(actual).toMatchObject(
    Object.fromEntries(
      Object.entries(fields).map(([key, value]) => [key, expressionBinding(prefix + value)]),
    ),
  );
}

function expectRun(workflowJob: WorkflowJob, name: string, fragments: string[]) {
  expectContains(step(workflowJob, name).run, fragments);
}

function expectBefore(workflowJob: WorkflowJob, ...names: string[]) {
  const indices = names.map((name) => workflowJob.steps!.indexOf(step(workflowJob, name)));
  for (let index = 1; index < indices.length; index++) {
    expect(indices[index - 1]!, names.join(" → ")).toBeLessThan(indices[index]!);
  }
}

function runWrapper(args: string[], cwd = process.cwd(), env: NodeJS.ProcessEnv = {}) {
  return spawnSync(BASH_BIN, [WRAPPER_PATH, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, OPENCLAW_RELEASE_CHECKS_SCRIPT: SCRIPT_PATH, ...env },
  });
}

function matrixEntry(osId: "ubuntu" | "windows" | "macos", suite: string, node26 = false) {
  const [artifact, display, runner] = {
    ubuntu: ["linux", "Linux", "blacksmith-8vcpu-ubuntu-2404"],
    windows: ["windows", "Windows", "blacksmith-32vcpu-windows-2025"],
    macos: ["macos", "macOS", "xcode-27"],
  }[osId];
  return {
    artifact_name: artifact + (node26 ? "-node26.12.1" : ""),
    display_name: display,
    node_version: node26 ? "26.12.1" : "24.22.1",
    lane: suite.endsWith("fresh") ? "fresh" : "upgrade",
    os_id: osId,
    runner,
    suite,
    suite_label: suite.replace("-", " ") + (node26 ? " (Node 26.12.1)" : ""),
  };
}

describe("cross-OS release checks workflow", () => {
  const workflow = readWorkflow(WORKFLOW_PATH);
  const release = readWorkflow(RELEASE_CHECKS_PATH);
  const prepare = job(workflow, "prepare");
  const consumer = job(workflow, "cross_os_release_checks");
  it("lets Windows packaged-upgrade finish its bounded timeout recovery within the job", () => {
    const expression = String(consumer["timeout-minutes"]).replace(/^\$\{\{(.*)\}\}$/u, "$1");
    for (const osId of ["ubuntu", "windows", "macos"]) {
      for (const suite of ["packaged-fresh", "packaged-upgrade", "dev-update", "installer-fresh"]) {
        const minutes = runInNewContext(expression, { matrix: { os_id: osId, suite } });
        if (osId === "windows" && suite === "packaged-upgrade") {
          const installCeilingMs = 45 * 60_000;
          const { wrapperTimeoutMs } = resolvePackagedUpgradeTimeouts(installCeilingMs, "win32");
          expect(minutes * 60_000).toBeGreaterThanOrEqual(
            2 * installCeilingMs + wrapperTimeoutMs + 20 * 60_000,
          );
          expect(minutes).toBeLessThanOrEqual(180);
        } else {
          expect(minutes).toBe(60);
        }
      }
    }
  });

  it("covers both packaged Node lines while preserving platform exceptions and proof identities", () => {
    const matrix = resolveRunnerMatrix({
      mode: "both",
      ref: "main",
      ubuntuRunner: "",
      windowsRunner: "",
      macosRunner: "",
      varUbuntuRunner: "",
      varWindowsRunner: "",
      varMacosRunner: "",
    });

    expect(matrix.include).toHaveLength(18);
    expect(
      new Set(matrix.include.map((entry) => `${entry.display_name}/${entry.suite_label}`)).size,
    ).toBe(18);
    expect(
      new Set(matrix.include.map((entry) => `${entry.artifact_name}/${entry.suite}`)).size,
    ).toBe(18);
    for (const osId of ["ubuntu", "windows", "macos"]) {
      for (const suite of ["packaged-fresh", "packaged-upgrade"]) {
        expect(
          matrix.include
            .filter((entry) => entry.os_id === osId && entry.suite === suite)
            .map((entry) => entry.node_version),
        ).toEqual(["24.22.1", "26.12.1"]);
      }
    }
    for (const [osId, suite] of [
      ["windows", "dev-update"],
      ["ubuntu", "installer-fresh"],
      ["macos", "packaged-fresh"],
    ] as const) {
      expect(matrix.include.find((entry) => entry.os_id === osId && entry.suite === suite)).toEqual(
        matrixEntry(osId, suite),
      );
    }
  });

  it.each(["windows/packaged-upgrade", "packaged-fresh"])(
    "filters the cross-OS runner matrix by %s",
    (suiteFilter) => {
      const matrix = resolveRunnerMatrix({ mode: "both", ref: "main", suiteFilter });
      const source = readFileSync(WORKFLOW_PATH, "utf8");
      expect(source).toContain("suite_filter:");
      expect(source).toContain('--suite-filter "${INPUT_SUITE_FILTER}"');
      if (suiteFilter === "windows/packaged-upgrade") {
        expect(matrix.include).toEqual([
          matrixEntry("windows", "packaged-upgrade"),
          matrixEntry("windows", "packaged-upgrade", true),
        ]);
      } else {
        expect(matrix.include).toHaveLength(6);
        expect([...new Set(matrix.include.map((entry) => entry.os_id))].toSorted()).toEqual([
          "macos",
          "ubuntu",
          "windows",
        ]);
        expect(matrix.include.every((entry) => entry.suite === "packaged-fresh")).toBe(true);
      }
    },
  );

  it("preserves failed preparation and cross-OS test job conclusions", () => {
    for (const target of [prepare, consumer, step(consumer, "Run cross-OS release checks")]) {
      expect(target["continue-on-error"]).toBeUndefined();
    }
  });

  it.each([
    ["candidate", "download_candidate"],
    ["baseline", "download_baseline"],
    ["prerelease plugin registry", "download_prepublish_plugin_registry"],
  ])("retries only failed %s artifact acquisition once before tests", (artifact, downloadId) => {
    const first = step(consumer, `Download ${artifact} artifact`);
    const warning = step(consumer, `Warn about ${artifact} artifact acquisition retry`);
    const retry = step(consumer, `Retry ${artifact} artifact download`);

    expect(first.id).toBe(downloadId);
    expect(first["continue-on-error"]).toBe(true);
    expect(first.uses).toMatch(/^actions\/download-artifact@/u);
    expect(retry.uses).toBe(first.uses);
    expect(retry.with).toEqual(first.with);
    expect(retry["continue-on-error"]).toBeUndefined();
    expect(warning.if).toBe(retry.if);
    expect(warning.run).toContain("::warning::");
    expect(warning.run).toContain("retrying infrastructure acquisition once before tests");
    for (const outcome of ["success", "failure", "skipped", "cancelled"]) {
      const retryEnabled = runInNewContext(retry.if!.replace(/^\$\{\{(.*)\}\}$/u, "$1"), {
        steps: { [downloadId]: { outcome } },
      });
      expect(retryEnabled, outcome).toBe(outcome === "failure");
    }
    expectBefore(consumer, first.name!, warning.name!, retry.name!, "Verify release-check inputs");
  });

  it("uses the matrix runtime consistently for both consumer setup steps", () => {
    for (const setupName of ["Setup Node.js", "Setup pnpm"]) {
      expect(step(prepare, setupName).with?.["node-version"]).toBe("${{ env.NODE_VERSION }}");
      const expression = String(step(consumer, setupName).with?.["node-version"]);
      for (const [osId, suite, nodeVersion, expected] of [
        ["windows", "packaged-fresh", "26.12.1", "26.12.1"],
        ["windows", "packaged-fresh", "24.22.1", "24.22.1"],
        ["ubuntu", "packaged-upgrade", "26.12.1", "26.12.1"],
        // The public workflow_ref input can select a pre-field tooling revision.
        ["windows", "packaged-fresh", undefined, "24.22.1"],
        ["windows", "packaged-upgrade", undefined, "24.22.1"],
        ["macos", "packaged-fresh", undefined, "24.22.1"],
      ]) {
        expect(
          runInNewContext(expression.replace(/^\$\{\{(.*)\}\}$/u, "$1"), {
            matrix: { os_id: osId, suite, node_version: nodeVersion },
            env: { NODE_VERSION: "24.22.1" },
          }),
          `${setupName}: ${osId}/${suite}/${nodeVersion ?? "legacy"}`,
        ).toBe(expected);
      }
    }
  });

  it("reuses npm downloads across isolated lane homes without caching installed state", () => {
    const run = step(consumer, "Run cross-OS release checks");
    const restore = step(consumer, "Restore npm downloads");
    const save = step(consumer, "Save npm downloads");
    const cacheRoot = run.env?.NPM_CONFIG_CACHE;

    expect(cacheRoot).toBe("${{ github.workspace }}/.cache/openclaw-cross-os-npm-cache");
    expect(restore.with?.path).toBe(".cache/openclaw-cross-os-npm-cache/_cacache");
    expect(save.with?.path).toBe(restore.with?.path);
    expect(restore.with?.enableCrossOsArchive).toBe(true);
    expect(save.with?.enableCrossOsArchive).toBe(true);
    expect(restore.with?.["restore-keys"]).toContain("openclaw-cross-os-npm-v1-seed-\n");
    expect(save.with?.key).toBe("${{ steps.npm_downloads.outputs.cache-primary-key }}");
    expect(save.if).toBe(
      "github.repository == 'openclaw/openclaw' && github.event_name == 'workflow_dispatch' && steps.npm_downloads.outputs.cache-hit != 'true'",
    );
    expect(step(consumer, "Setup Node.js").id).toBe("node");
    expect(restore.with?.key).toBe(
      "openclaw-cross-os-npm-v1-${{ runner.os }}-${{ runner.arch }}-${{ steps.node.outputs.node-version }}-${{ matrix.suite }}-${{ needs.prepare.outputs.candidate_sha256 }}-${{ needs.prepare.outputs.baseline_sha256 }}",
    );
    expectBefore(consumer, restore.name!, run.name!, save.name!);
  });

  it("fails the Windows lane on its first interrupted dashboard probe", () => {
    const run = step(consumer, "Run cross-OS release checks");
    const root = tempDirs.make("cross-os-first-failure-");
    const harness = join(root, "workflow/scripts/github");
    const outputDir = join(root, "output");
    mkdirSync(harness, { recursive: true });
    mkdirSync(join(outputDir, "logs"), { recursive: true });
    writeFileSync(
      join(outputDir, "logs/fresh-dashboard.log"),
      "attempt=1 url=http://127.0.0.1:1/\n",
    );
    writeFileSync(
      join(harness, "run-openclaw-cross-os-release-checks.sh"),
      [
        'if [[ -f "$OUTPUT_DIR/attempt" ]]; then exit 0; fi',
        'printf "first\\n" > "$OUTPUT_DIR/attempt"',
        "exit 127",
      ].join("\n"),
    );
    const result = spawnSync(BASH_BIN, ["-e", "-o", "pipefail", "-c", run.run!], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        ...Object.fromEntries(Object.keys(run.env ?? {}).map((key) => [key, ""])),
        MODE: "fresh",
        OPENCLAW_RELEASE_CHECK_OS: "windows",
        OUTPUT_DIR: outputDir,
      },
    });

    expect(result.status, result.stdout + result.stderr).toBe(127);
    expect(readFileSync(join(outputDir, "attempt"), "utf8")).toBe("first\n");
  });

  it("bounds npm baseline packing during prepare", () => {
    const baseline = step(prepare, "Resolve baseline package spec");
    const baselineMetadata = step(prepare, "Capture baseline metadata");

    for (const trigger of ["workflow_dispatch", "workflow_call"] as const) {
      expect(workflow.on?.[trigger]?.inputs?.target_context_ref).toMatchObject({
        default: "",
        required: false,
      });
    }
    expect(baseline.env).toMatchObject({
      CANDIDATE_JSON: "${{ runner.temp }}/openclaw-cross-os-release-checks/prepare/candidate.json",
      INPUT_PREVIOUS_VERSION: "${{ inputs.previous_version }}",
      INPUT_TARGET_CONTEXT_REF: "${{ inputs.target_context_ref }}",
    });
    expect(baseline.run).toContain("scripts/lib/release-upgrade-baseline.mjs");
    expect(baseline.run).toContain('--target-context-ref "$INPUT_TARGET_CONTEXT_REF"');
    expect(baseline.run).toContain('--previous-version "$INPUT_PREVIOUS_VERSION"');
    expect(baseline.run).not.toContain("npm view openclaw@latest");
    expect(readFileSync(WORKFLOW_PATH, "utf8")).toContain(
      "timeout --preserve-status 300s npm pack --ignore-scripts",
    );
    expect(baselineMetadata["working-directory"]).toBe("workflow");
    expect(baselineMetadata.run).toContain(
      'import { resolveNpmJsonEntries } from "./scripts/lib/npm-json-output.mts";',
    );
    expect(baselineMetadata.run).toContain("const entry = resolveNpmJsonEntries(payload).at(-1);");
  });

  it("derives baselines from the candidate owner and passes them to every consumer", () => {
    const target = job(release, "resolve_target");
    const sourceBaseline = step(target, "Resolve source checkout upgrade baseline");
    const producer = job(release, "prepare_release_package");
    const packageBaseline = step(producer, "Resolve package upgrade baseline");
    const installSmoke = job(release, "install_smoke_release_checks");
    const crossOs = job(release, "cross_os_release_checks");
    const docker = job(release, "docker_e2e_release_checks");
    const packageAcceptance = job(release, "package_acceptance_release_checks");

    expect(target.outputs?.source_upgrade_baseline).toBe(
      "${{ steps.source_upgrade_baseline.outputs.value }}",
    );
    expect(sourceBaseline.if).toBe("steps.inputs.outputs.install_smoke_scheduled == 'true'");
    expect(sourceBaseline.env).toMatchObject({
      GH_TOKEN: "${{ github.token }}",
      TARGET_CONTEXT_REF: "${{ inputs.target_context_ref }}",
      TARGET_SHA: "${{ steps.ref.outputs.sha }}",
    });
    expect(producer.outputs?.upgrade_baseline).toBe("${{ steps.upgrade_baseline.outputs.value }}");
    expect(packageBaseline.env).toMatchObject({
      CANDIDATE_PUBLISHED: "${{ needs.resolve_target.outputs.candidate_published }}",
      CANDIDATE_VERSION:
        "${{ steps.package.outputs.package_version || fromJSON(needs.resolve_target.outputs.candidate_artifact_json || '{}').packageVersion }}",
    });
    expect(packageBaseline.run).toContain("--candidate-published");
    expect(installSmoke.with?.update_baseline_version).toBe(
      "${{ needs.resolve_target.outputs.source_upgrade_baseline }}",
    );
    expect(crossOs.with?.previous_version).toBe(
      "${{ needs.prepare_release_package.outputs.upgrade_baseline }}",
    );
    expect(crossOs.with?.workflow_ref).toBe("${{ github.sha }}");
    expect(docker.with?.published_upgrade_survivor_baseline).toBe(
      "${{ format('openclaw@{0}', needs.prepare_release_package.outputs.upgrade_baseline) }}",
    );
    expect(packageAcceptance.with?.published_upgrade_survivor_baseline).toBe(
      "${{ inputs.qualification_baselines_json != '' && fromJSON(inputs.qualification_baselines_json).upgradeBaseline || (needs.resolve_target.outputs.package_acceptance_package_spec == '' && format('openclaw@{0}', needs.prepare_release_package.outputs.upgrade_baseline) || 'openclaw@latest') }}",
    );
  });

  it("installs trusted workflow dependencies for artifact resolution and upgrade metadata", () => {
    const install = step(prepare, "Install workflow validation dependencies");

    expect(install).toMatchObject({
      "working-directory": "workflow",
      run: "pnpm install --frozen-lockfile --prefer-offline --ignore-scripts",
    });
    expect(install.if).toBeUndefined();
    expect(step(prepare, "Build candidate artifact once").if).toBe(
      "inputs.candidate_artifact_name == ''",
    );
    expect(step(prepare, "Capture baseline metadata").if).toBe("${{ inputs.mode != 'fresh' }}");

    for (const dependentStep of [
      "Resolve provider-owned companion requirements",
      "Resolve provided candidate package",
      "Capture baseline metadata",
    ]) {
      expectBefore(prepare, install.name!, dependentStep);
    }
  });

  it("keeps release artifact tarball filenames local before upload paths use them", () => {
    const source = readFileSync(WORKFLOW_PATH, "utf8");

    expectContains(source, [
      "fileName !== path.basename(fileName)",
      "fileName !== path.win32.basename(fileName)",
    ]);
  });

  it("binds the prepared release package to an immutable artifact and package tuple", () => {
    const producer = job(release, "prepare_release_package");
    for (const [output, primary, fallback] of [
      [
        "artifact_digest",
        "release_package_upload.outputs.artifact-digest",
        "packageArtifactDigest",
      ],
      ["artifact_id", "release_package_upload.outputs.artifact-id", "packageArtifactId"],
      ["artifact_name", "artifact.outputs.name", "packageArtifactName"],
      ["artifact_run_attempt", "artifact.outputs.run_attempt", "packageArtifactRunAttempt"],
      ["artifact_run_id", "artifact.outputs.run_id", "packageArtifactRunId"],
      ["package_file_name", "artifact.outputs.file_name", "packageFileName"],
      ["package_sha256", "package.outputs.sha256", "packageSha256"],
      ["package_version", "package.outputs.package_version", "packageVersion"],
      ["source_sha", "package.outputs.source_sha", "packageSourceSha"],
    ] as const) {
      expect(producer.outputs?.[output], output).toBe(
        expressionBinding(
          `steps.${primary} || fromJSON(needs.resolve_target.outputs.candidate_artifact_json || '{}').${fallback}`,
        ),
      );
    }
    expectBindings(producer.outputs, "steps.", {
      prepublish_plugin_registry_json: "registry_identity.outputs.json",
    });
    expect(step(producer, "Checkout trusted workflow ref").with).toMatchObject({
      ref: "${{ github.sha }}",
      "persist-credentials": false,
    });

    expectRun(producer, "Set artifact metadata", [
      "name=release-package-under-test-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}",
      "file_name=openclaw-current.tgz",
      "run_attempt=${GITHUB_RUN_ATTEMPT}",
      "run_id=${GITHUB_RUN_ID}",
    ]);

    const upload = step(producer, "Upload release package artifact");
    expect(upload.id).toBe("release_package_upload");
    expect(upload.with).toMatchObject({
      name: "${{ steps.artifact.outputs.name }}",
      "if-no-files-found": "error",
    });
    expectRun(producer, "Resolve release package artifact", [
      "--resolve-provider-required-companion-packages",
      ".requiredPrepublishPluginPackages",
      "'$provider + $docker | unique | sort'",
      "--plugin-registry-output-dir",
      "--required-plugin-packages-json",
      'source_args=(--source npm --package-spec "$RELEASE_PACKAGE_SPEC" --package-ref "$PACKAGE_REF")',
    ]);

    const registryUpload = step(producer, "Upload shared prerelease plugin registry artifact");
    expect(registryUpload.with?.name).toBe(
      "docker-e2e-prepublish-plugin-registry-${{ github.run_id }}-${{ github.run_attempt }}",
    );

    const binding = step(producer, "Validate release package artifact binding");
    expectBindings(binding.env, "steps.", {
      ARTIFACT_DIGEST: "release_package_upload.outputs.artifact-digest",
      ARTIFACT_ID: "release_package_upload.outputs.artifact-id",
      ARTIFACT_RUN_ATTEMPT: "artifact.outputs.run_attempt",
      ARTIFACT_RUN_ID: "artifact.outputs.run_id",
      PACKAGE_SHA256: "package.outputs.sha256",
      PACKAGE_SOURCE_SHA: "package.outputs.source_sha",
      PACKAGE_VERSION: "package.outputs.package_version",
    });
    expect(binding.run).toContain('verify-upload "Release package"');
    expect(binding.run).toContain('"$PACKAGE_SHA256" =~ ^[a-f0-9]{64}$');
    expect(binding.run).toContain('"$PACKAGE_SOURCE_SHA" =~ ^[a-f0-9]{40}$');

    const crossOs = job(release, "cross_os_release_checks");
    expectBindings(crossOs.with, "needs.prepare_release_package.outputs.", {
      candidate_artifact_digest: "artifact_digest",
      candidate_artifact_id: "artifact_id",
      candidate_artifact_name: "artifact_name",
      candidate_artifact_run_attempt: "artifact_run_attempt",
      candidate_artifact_run_id: "artifact_run_id",
      candidate_file_name: "package_file_name",
      candidate_sha256: "package_sha256",
      candidate_source_sha: "source_sha",
      candidate_version: "package_version",
      prepublish_plugin_registry_json: "prepublish_plugin_registry_json",
    });
    expectBindings(crossOs.with, "inputs.", { target_context_ref: "target_context_ref" });
    expect(crossOs.with?.required_companion_packages_json).toBeUndefined();

    expect(job(release, "docker_e2e_release_checks").with).toMatchObject({
      prepublish_plugin_registry_artifact_id:
        "${{ fromJSON(needs.prepare_release_package.outputs.prepublish_plugin_registry_json || '{}').prepublishPluginRegistryArtifactId || '' }}",
      prepublish_plugin_registry_manifest_sha256:
        "${{ fromJSON(needs.prepare_release_package.outputs.prepublish_plugin_registry_json || '{}').prepublishPluginRegistryManifestSha256 || '' }}",
    });
    expect(job(release, "package_acceptance_release_checks").with).toMatchObject({
      workflow_ref: "${{ github.sha }}",
    });
  });

  it("builds companion registries only for scheduled cross-OS or Docker consumers", () => {
    const resolveTarget = job(release, "resolve_target");
    expectBindings(resolveTarget.outputs, "steps.inputs.outputs.", {
      cross_os_scheduled: "cross_os_scheduled",
      docker_required: "docker_required",
      package_required: "package_required",
    });

    const producer = job(release, "prepare_release_package");
    expect(producer.if).toBe("needs.resolve_target.outputs.package_required == 'true'");
    expectRun(producer, "Resolve release package artifact", [
      'if [[ "$CROSS_OS_SCHEDULED" == "true" ]]',
      'if [[ "$DOCKER_REQUIRED" == "true" && "$PACKAGE_MODE" == "source" ]]',
      "registry_args=()",
      'if [[ "$CANDIDATE_PUBLISHED" != "true" && "$required_packages" != \'[]\' ]]',
    ]);
    expect(job(release, "cross_os_release_checks").if).toBe(
      "needs.resolve_target.outputs.cross_os_scheduled == 'true'",
    );
    expect(job(release, "docker_e2e_release_checks").if).toBe(
      "needs.resolve_target.outputs.docker_required == 'true'",
    );
    for (const [rerunGroup, phase, repoLiveSuiteFilter, crossOs, docker, packageRequired] of [
      ["install-smoke", "all", "", false, false, false],
      ["cross-os", "all", "", true, false, true],
      ["package", "all", "", false, false, true],
      ["live-e2e", "all", "", false, true, true],
      ["live-e2e", "all", "repo-e2e", false, false, false],
      ["cross-os", "independent", "", false, false, false],
    ] as const) {
      const selected = createReleaseCheckSelection({ rerunGroup, phase, repoLiveSuiteFilter });
      expect(selected, `${rerunGroup}/${phase}/${repoLiveSuiteFilter}`).toMatchObject({
        cross_os_scheduled: crossOs,
        docker_required: docker,
        package_required: packageRequired,
      });
      const context = {
        needs: {
          resolve_target: {
            outputs: Object.fromEntries(
              Object.entries(selected).map(([key, value]) => [key, String(value)]),
            ),
          },
        },
      };
      expect(runInNewContext(producer.if!, context)).toBe(packageRequired);
      expect(runInNewContext(job(release, "cross_os_release_checks").if!, context)).toBe(crossOs);
      expect(runInNewContext(job(release, "docker_e2e_release_checks").if!, context)).toBe(docker);
    }
  });

  it("downloads and re-exports exact candidate artifacts only by immutable id", () => {
    const artifactFields = ["digest", "id", "name", "run_attempt", "run_id"];
    for (const trigger of ["workflow_dispatch", "workflow_call"] as const) {
      const inputs = workflow.on?.[trigger]?.inputs;
      for (const inputName of [
        ...artifactFields.map((field) => `candidate_artifact_${field}`),
        ...["file_name", "sha256", "source_sha", "version"].map((field) => `candidate_${field}`),
        "prepublish_plugin_registry_json",
      ]) {
        expect(inputs?.[inputName], `${trigger}/${inputName}`).toMatchObject({
          default: "",
          type: "string",
        });
      }
      for (const suffix of [
        ...artifactFields.map((field) => `artifact_${field}`),
        "manifest_sha256",
      ]) {
        expect(
          inputs?.[`prepublish_plugin_registry_${suffix}`],
          `${trigger}/${suffix}`,
        ).toBeUndefined();
      }
    }
    expect(workflow.on?.workflow_call?.inputs?.required_companion_packages_json).toBeUndefined();

    for (const artifact of ["baseline", "candidate"]) {
      expectBindings(prepare.outputs, "", {
        [`${artifact}_artifact_digest`]: `steps.upload_${artifact}.outputs.artifact-digest`,
        [`${artifact}_artifact_id`]: `steps.upload_${artifact}.outputs.artifact-id`,
        [`${artifact}_artifact_run_attempt`]: "github.run_attempt",
        [`${artifact}_artifact_run_id`]: "github.run_id",
        [`${artifact}_sha256`]: `steps.${artifact}_metadata.outputs.sha256`,
      });
    }
    expectBindings(prepare.outputs, "steps.", {
      candidate_version: "candidate_metadata.outputs.version",
      prepublish_plugin_registry_json: "registry_identity.outputs.json",
      required_companion_packages_json: "provider_requirements.outputs.json",
      source_sha: "candidate_metadata.outputs.source_sha",
    });
    for (const [jobName, workflowJob] of Object.entries(workflow.jobs)) {
      for (const checkout of workflowJob.steps?.filter((candidate) =>
        candidate.uses?.startsWith("actions/checkout@"),
      ) ?? []) {
        expect(checkout.with?.["persist-credentials"], `${jobName}:${checkout.name}`).toBe(false);
      }
    }

    const inputBinding = step(prepare, "Validate provided candidate artifact binding");
    expectBindings(inputBinding.env, "inputs.candidate_", {
      ARTIFACT_DIGEST: "artifact_digest",
      ARTIFACT_ID: "artifact_id",
      ARTIFACT_RUN_ATTEMPT: "artifact_run_attempt",
      ARTIFACT_RUN_ID: "artifact_run_id",
      CANDIDATE_SHA256: "sha256",
      CANDIDATE_SOURCE_SHA: "source_sha",
      CANDIDATE_VERSION: "version",
    });
    expectContains(inputBinding.run, [
      '! "$ARTIFACT_ID" =~ ^[1-9][0-9]*$',
      '! "$ARTIFACT_DIGEST" =~ ^[a-f0-9]{64}$',
      '[[ "$ARTIFACT_NAME" == *"-${ARTIFACT_RUN_ID}-${ARTIFACT_RUN_ATTEMPT}" ]]',
      'verify-upload "Candidate"',
      '"$CANDIDATE_SOURCE_SHA" != "$INPUT_REF"',
    ]);

    const inputDownload = step(prepare, "Download provided candidate artifact");
    expect(inputDownload.with).toMatchObject({
      "artifact-ids": "${{ inputs.candidate_artifact_id }}",
      "run-id": "${{ inputs.candidate_artifact_run_id }}",
    });
    expect(inputDownload.with?.name).toBeUndefined();
    expectBefore(prepare, inputBinding.name!, inputDownload.name!);

    expectRun(prepare, "Resolve provided candidate package", [
      "resolve-openclaw-package-candidate.mts",
      "--source artifact",
      '--package-sha256 "$INPUT_CANDIDATE_SHA256"',
      '"$actual_sha256" == "$INPUT_CANDIDATE_SHA256"',
      '"$actual_source_sha" == "$INPUT_CANDIDATE_SOURCE_SHA"',
      '"$actual_version" == "$INPUT_CANDIDATE_VERSION"',
    ]);
    for (const artifact of ["candidate", "baseline"]) {
      expect(step(prepare, `Upload ${artifact} artifact`)).toMatchObject({
        id: `upload_${artifact}`,
        with: {
          name: `openclaw-cross-os-release-checks-${artifact}-\${{ github.run_id }}-\${{ github.run_attempt }}`,
        },
      });
    }
    const registryUpload = step(prepare, "Upload source-built prerelease companion registry");
    expect(registryUpload.if).toBe(
      "inputs.candidate_artifact_name == '' && steps.provider_requirements.outputs.json != '[]'",
    );
    expectRun(prepare, "Pack source-built prerelease companion registry", [
      "prepublish-plugin-registry-artifact.mjs create",
      "--repo-root source",
      '--required-packages-json "$REQUIRED_PACKAGES_JSON"',
    ]);
    expectRun(
      prepare,
      "Verify prepared artifact uploads",
      ["Candidate", "Baseline", "Prerelease plugin registry"].map(
        (label) => `verify-upload "${label}"`,
      ),
    );
    expect(consumer.steps?.map((candidate) => candidate.name)).not.toContain(
      "Validate prepared candidate artifact binding",
    );

    for (const artifact of ["candidate", "baseline"]) {
      const download = step(consumer, `Download ${artifact} artifact`);
      expect(download.with).toMatchObject({
        "artifact-ids": `\${{ needs.prepare.outputs.${artifact}_artifact_id }}`,
        "github-token": "${{ github.token }}",
        "run-id": `\${{ needs.prepare.outputs.${artifact}_artifact_run_id }}`,
      });
      expect(download.with?.name).toBeUndefined();
    }
    const verify = step(consumer, "Verify release-check inputs");
    expect(verify.env?.EXPECTED_CANDIDATE_SHA256).toBe(
      "${{ needs.prepare.outputs.candidate_sha256 }}",
    );
    expect(verify.run).toContain('"$actual_sha256" != "$EXPECTED_CANDIDATE_SHA256"');
    expect(verify.env?.EXPECTED_BASELINE_SHA256).toBe(
      "${{ needs.prepare.outputs.baseline_sha256 }}",
    );
    expect(verify.run).toContain('"$actual_baseline_sha256" != "$EXPECTED_BASELINE_SHA256"');
  });

  it("passes and consumes the immutable prerelease companion registry generically", () => {
    const sourceCheckout = step(prepare, "Checkout public source ref");
    expect(sourceCheckout.if).toBe("inputs.candidate_artifact_name == ''");
    expect(sourceCheckout.with?.ref).toBe("${{ inputs.ref }}");
    const download = step(consumer, "Download prerelease plugin registry artifact");
    expect(download.with).toMatchObject({
      "artifact-ids":
        "${{ fromJSON(needs.prepare.outputs.prepublish_plugin_registry_json || '{}').prepublishPluginRegistryArtifactId || '' }}",
      "run-id":
        "${{ fromJSON(needs.prepare.outputs.prepublish_plugin_registry_json || '{}').prepublishPluginRegistryArtifactRunId || '' }}",
    });

    const run = step(consumer, "Run cross-OS release checks");
    expect(run.env).toMatchObject({
      PLUGIN_REGISTRY_JSON: "${{ needs.prepare.outputs.prepublish_plugin_registry_json }}",
      REQUIRED_COMPANION_PACKAGES_JSON:
        "${{ needs.prepare.outputs.required_companion_packages_json }}",
    });
    expect(run.run).toContain('--plugin-registry-dir "$PLUGIN_REGISTRY_DIR"');
    expect(run.run).toContain(
      '"$(jq -r \'.prepublishPluginRegistryManifestSha256\' <<< "$PLUGIN_REGISTRY_JSON")"',
    );
    expect(run.run).not.toContain("--required-companion-packages-json");
    expect(run.run).not.toContain("OPENCLAW_PLUGIN_INSTALL_OVERRIDES");
    expect(JSON.stringify(workflow)).not.toContain("@openclaw/codex");
  });

  it("owns provider companion requirements and fails closed for direct candidates", () => {
    expectRun(prepare, "Resolve provider-owned companion requirements", [
      "--resolve-provider-required-companion-packages",
      '--provider "$PROVIDER"',
    ]);

    expectRun(prepare, "Normalize companion registry contract", [
      "(keys | sort) == ([",
      'all(.[]; type == "string")',
      "Prerelease companion registry must be one closed immutable JSON tuple.",
      "The selected provider requires a complete immutable companion registry tuple.",
      "Source-built candidates produce their own companion registry and reject a second tuple.",
    ]);
    expect(step(prepare, "Verify provided prerelease plugin registry upload").run).toContain(
      'verify-upload "Prerelease plugin registry"',
    );
    const workflowSource = readFileSync(WORKFLOW_PATH, "utf8");
    expect(workflowSource).not.toContain("fromJSON(steps.provided_registry.outputs.json).");
    expect(workflowSource).not.toContain(
      "fromJSON(needs.prepare.outputs.prepublish_plugin_registry_json).",
    );
  });

  it.each([
    ["openai", ["@openclaw/codex"]],
    ["anthropic", []],
    ["minimax", []],
  ])("resolves provider-owned companions for %s", (provider, expected) => {
    const result = runWrapper([
      "--resolve-provider-required-companion-packages",
      "--provider",
      provider,
    ]);
    expect(result).toMatchObject({ stderr: "", status: 0 });
    expect(JSON.parse(result.stdout)).toEqual(expected);
  });

  it("executes the release harness directly with Node without installed packages", () => {
    // Lane tooling has no installed packages. Keep the fixture outside the checkout
    // so a developer's node_modules cannot satisfy an accidental runtime import.
    const fixture = tempDirs.make("cross-os-no-packages-");
    for (const source of ["package.json", "scripts", "packages/normalization-core"]) {
      const target = join(fixture, source);
      mkdirSync(dirname(target), { recursive: true });
      cpSync(source, target, { recursive: true });
    }
    const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
      scripts: Record<string, string>;
    };
    const windowsCiCoverage = [
      packageJson.scripts["test:windows:ci:1"],
      packageJson.scripts["test:windows:ci:2"],
    ].join(" ");

    expect(windowsCiCoverage).toContain("test/scripts/openclaw-cross-os-release-workflow.test.ts");
    const result = runWrapper(
      [
        "--resolve-matrix",
        "--ref",
        "test/native-node",
        "--mode",
        "fresh",
        "--suite-filter",
        "windows/packaged-fresh",
        "--windows-runner",
        "windows-2025",
      ],
      fixture,
      { NODE_OPTIONS: "", NODE_PATH: "" },
    );

    expect(result).toMatchObject({ stderr: "", status: 0 });
    expect(JSON.parse(result.stdout)).toEqual({
      include: [
        {
          ...matrixEntry("windows", "packaged-fresh"),
          runner: "windows-2025",
          node_version: "24.22.1",
        },
        { ...matrixEntry("windows", "packaged-fresh", true), runner: "windows-2025" },
      ],
    });
  });
});
