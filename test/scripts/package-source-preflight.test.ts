import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { validateBundledPackageDependencyAlignment } from "../../scripts/package-source-dependencies.mjs";
import {
  validatePackageSource,
  validatePackageSourceDir,
} from "../../scripts/package-source-preflight.mjs";
import { writeRunSummary } from "../../scripts/test-docker-all.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import {
  readWorkflow,
  readWorkflowOutputs as readOutputs,
  runWorkflowShellScript,
} from "./ci-workflow.test-support.js";
import {
  commitFixture,
  copyFrozenTargetTooling,
  fixtureGit,
} from "./frozen-target-fixture.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const changelog =
  "# Changelog\n\n## Unreleased\n\n- Package source preflight notes with enough detail.\n";

function rootManifest(overrides: Record<string, unknown> = {}) {
  return aiManifest({
    dependencies: { "@openclaw/ai": "workspace:*", openai: "6.49.0" },
    ...overrides,
  });
}

function aiManifest(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    version: "2026.8.1",
    dependencies: { openai: "6.49.0" },
    ...overrides,
  });
}

function validateSource(overrides: Partial<Parameters<typeof validatePackageSource>[0]> = {}) {
  return validatePackageSource({
    aiManifestContent: aiManifest(),
    changelogContent: changelog,
    rootManifestContent: rootManifest(),
    ...overrides,
  });
}

type WorkflowStep = Partial<Record<"if" | "name" | "run" | "uses", string>> & {
  env?: Record<string, string>;
  with?: Record<string, unknown>;
};

type Workflow = { jobs: Record<string, { steps: WorkflowStep[] }> };

function workflowStep(workflow: Workflow, job: string, name: string): WorkflowStep {
  const found = workflow.jobs[job]?.steps.find((step) => step.name === name);
  expect(found, `${job}: ${name}`).toBeDefined();
  return found!;
}

function jobSteps(file: string, job: string) {
  const workflow = readWorkflow(`.github/workflows/${file}.yml`);
  return {
    step: (name: string) => workflowStep(workflow, job, name),
    before: (earlier: WorkflowStep, ...later: WorkflowStep[]) => {
      const index = workflow.jobs[job]!.steps.indexOf(earlier);
      expect(index).toBeGreaterThan(-1);
      for (const step of later) {
        expect(index).toBeLessThan(workflow.jobs[job]!.steps.indexOf(step));
      }
    },
  };
}

function workflowFixture(prefix: string) {
  const root = tempDirs.make(prefix);
  const file = (...parts: string[]) => path.join(root, ...parts);
  mkdirSync(file("bin"));
  return {
    file,
    executable: (name: string, script: string) =>
      writeFileSync(file("bin", name), `#!/usr/bin/env bash\nset -euo pipefail\n${script}\n`, {
        mode: 0o755,
      }),
    run: (step: WorkflowStep, env: NodeJS.ProcessEnv, clearStepEnv = false) =>
      runWorkflowShellScript(step.run ?? "", {
        cwd: root,
        tempDir: root,
        linuxWorkflow: true,
        env: {
          ...process.env,
          ...(clearStepEnv
            ? Object.fromEntries(Object.keys(step.env ?? {}).map((name) => [name, ""]))
            : {}),
          GITHUB_OUTPUT: file("output"),
          GITHUB_STEP_SUMMARY: file("summary"),
          PATH: `${file("bin")}:${process.env.PATH}`,
          ...env,
        },
      }),
  };
}

function runSourceRequirement(step: WorkflowStep, env: Record<string, string>) {
  const f = workflowFixture("openclaw-package-source-workflow-");
  const result = f.run(step, env, true);
  expect(result.status, result.stderr).toBe(0);
  return readFileSync(f.file("output"), "utf8").trim();
}

function runLiveArtifactTupleValidation(packageEnv: Record<string, string>) {
  const workflow = readWorkflow(".github/workflows/openclaw-live-and-e2e-checks-reusable.yml");
  const step = workflowStep(workflow, "validate_selected_ref", "Validate selected ref");
  const f = workflowFixture("openclaw-live-artifact-tuple-");
  const selectedSha = "a".repeat(40);
  mkdirSync(f.file(".release-harness", "scripts"), { recursive: true });
  copyFileSync(
    path.resolve("scripts/resolve-fs-safe-native-contract.mjs"),
    f.file(".release-harness", "scripts/resolve-fs-safe-native-contract.mjs"),
  );
  f.executable(
    "git",
    `if [[ "$1" == "rev-parse" && "$2" == "--verify" ]]; then
  printf '%s\\n' "$SELECTED_SHA"
  exit 0
fi
if [[ "$1" == "merge-base" && "$2" == "--is-ancestor" ]]; then
  exit 0
fi
exit 64`,
  );
  const result = f.run(
    step,
    {
      INPUT_REF: "main",
      PROVIDED_BARE_IMAGE: "ghcr.io/openclaw/openclaw:test",
      SELECTED_SHA: selectedSha,
      SHARED_IMAGE_POLICY: "existing-only",
      TRUSTED_WORKFLOW_SHA: selectedSha,
      ...packageEnv,
    },
    true,
  );
  const output = result.status === 0 ? readOutputs(f.file("output")) : {};
  return { output, result };
}

function createReleaseInputCapture() {
  const workflow = readWorkflow(".github/workflows/openclaw-release-checks.yml");
  const step = workflowStep(workflow, "resolve_target", "Capture selected inputs");
  const f = workflowFixture("openclaw-release-inputs-");
  const tooling = f.file("workflow");
  copyFrozenTargetTooling(tooling, [
    "scripts/plan-release-workflow-matrix.mjs",
    "scripts/lib/direct-run.mjs",
    "scripts/lib/plugin-prerelease-test-plan.mts",
    "scripts/plan-targeted-docker-lane-groups.mjs",
    "scripts/lib/numeric-options.mjs",
    "scripts/github/validate-release-suite-filters.sh",
    "scripts/lib/cross-os-release-checks/suite-filter.mjs",
  ]);
  const { sha: toolingSha } = commitFixture(tooling);
  return (params: { candidateArtifactJson?: string; releasePackageSpec?: string }) => {
    // Each real invocation owns fresh outputs while reusing only immutable tooling.
    writeFileSync(f.file("output"), "");
    const result = f.run(
      step,
      {
        ADMISSION_TOOLING_ROOT: tooling,
        ADMISSION_TOOLING_SHA: toolingSha,
        CANDIDATE_ARTIFACT_JSON_INPUT: params.candidateArtifactJson ?? "",
        RELEASE_FILTER_VALIDATOR: path.join(
          tooling,
          "scripts/github/validate-release-suite-filters.sh",
        ),
        RELEASE_MODE_INPUT: "both",
        RELEASE_PACKAGE_SPEC_INPUT: params.releasePackageSpec ?? "",
        RELEASE_PHASE_INPUT: "all",
        RELEASE_PROFILE_INPUT: "beta",
        RELEASE_PROVIDER_INPUT: "openai",
        RELEASE_REF_INPUT: "main",
        RELEASE_RERUN_GROUP_INPUT: "package",
      },
      true,
    );
    expect(result.status, result.stderr).toBe(0);
    return readOutputs(f.file("output"));
  };
}

it("validates selected split notes instead of accepting an index as package contents", () => {
  const root = tempDirs.make("openclaw-package-source-split-");
  const file = (name: string) => path.join(root, name);
  mkdirSync(file("CHANGELOG"));
  writeFileSync(file("package.json"), rootManifest({ dependencies: {} }));
  writeFileSync(file("CHANGELOG.md"), "# Changelog\n\n- [Release](CHANGELOG/2026.8.1.md)\n");
  writeFileSync(file("CHANGELOG/2026.8.1.md"), changelog.replace("Unreleased", "2026.8.1"));
  expect(validatePackageSourceDir(root)).toBe("2026.8.1");
});

it("accepts aligned prerelease source manifests with Unreleased notes", () => {
  const version = "2026.8.1-beta.4";
  expect(
    validateSource({
      aiManifestContent: aiManifest({ version }),
      allowUnreleasedChangelog: true,
      rootManifestContent: rootManifest({ version }),
    }),
  ).toBe(version);
});

it("rejects source package version drift", () => {
  expect(() =>
    validateSource({
      aiManifestContent: aiManifest({ version: "2026.8.2" }),
      allowUnreleasedChangelog: true,
    }),
  ).toThrow("packages/ai/package.json version must match package.json");
});

it("shares exact, workspace, private, and value-type dependency semantics with packaging", () => {
  const align = (
    bundledDependencies: Record<string, unknown>,
    rootDependencies: Record<string, unknown>,
  ) =>
    validateBundledPackageDependencyAlignment({
      bundledDependencies,
      bundledPackageLabel: "packed @openclaw/ai",
      rootDependencies,
    });
  expect(
    align(
      { exact: "1.2.3", private: "0.0.0-private", workspace: "4.5.6" },
      { exact: "1.2.3", workspace: "workspace:4.5.6" },
    ),
  ).toEqual([
    ["exact", "1.2.3"],
    ["workspace", "4.5.6"],
  ]);

  expect(() => align({ invalid: 123 }, { invalid: "123" })).toThrow(
    "packed @openclaw/ai dependency invalid must declare a string version",
  );
  expect(() => align({ invalid: "1.2.3" }, { invalid: 123 })).toThrow(
    "root package.json dependency invalid must declare a string version",
  );
});

it("rejects conflicting bundled dependencies before setup and reads only the selected source", () => {
  const root = tempDirs.make("openclaw-package-source-dependencies-");
  writeFileSync(path.join(root, "package.json"), rootManifest({ dependencies: {} }));
  writeFileSync(path.join(root, "CHANGELOG.md"), changelog);
  const writePlugin = (id: string, metadata: unknown) => {
    const directory = path.join(root, "extensions", id);
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, "package.json"), JSON.stringify(metadata));
  };
  writePlugin("alpha", { dependencies: { shared: "1.0.0" } });
  writePlugin("beta", { optionalDependencies: { shared: "2.0.0" } });
  writePlugin("external", {
    dependencies: { shared: "3.0.0" },
    openclaw: { build: { bundledDist: false } },
  });
  const git = (...args: string[]) => fixtureGit(root, ...args);
  git("init", "-q");
  git("add", ".");
  git("commit", "-qm", "conflicting bundled source");
  const ref = git("rev-parse", "HEAD");
  const run = (...args: string[]) =>
    spawnSync(
      process.execPath,
      [
        path.resolve("scripts/package-source-preflight.mjs"),
        "--allow-unreleased-changelog",
        ...args,
      ],
      { cwd: root, encoding: "utf8" },
    );
  const conflict =
    "dependency 'shared' has conflicting specs: alpha use '1.0.0', beta uses '2.0.0'";
  const directoryFailure = run("--source-dir", root);
  expect(directoryFailure.status).toBe(1);
  expect(directoryFailure.stderr).toContain(conflict);

  writePlugin("beta", { optionalDependencies: { shared: "1.0.0" } });
  expect(run("--source-dir", root).status).toBe(0);
  const committedFailure = run("--ref", ref);
  expect(committedFailure.status).toBe(1);
  expect(committedFailure.stderr).toContain(conflict);
  expect(validatePackageSourceDir(root, { allowUnreleasedChangelog: true })).toBe("2026.8.1");
});

it("normalizes release-check package mode and guards the source resolver", () => {
  const runReleaseInputCapture = createReleaseInputCapture();
  const { step, before } = jobSteps("openclaw-release-checks", "prepare_release_package");
  const preflight = step("Validate release package source metadata");
  const packageStep = step("Resolve release package artifact");
  before(preflight, step("Setup Node environment"), packageStep);
  const expectMode = (
    input: Parameters<typeof runReleaseInputCapture>[0],
    package_mode: string,
    release_package_spec = "",
    candidate_artifact_json = "",
  ) =>
    expect(runReleaseInputCapture(input)).toMatchObject({
      package_mode,
      release_package_spec,
      candidate_artifact_json,
    });
  expectMode({ releasePackageSpec: " \t " }, "source");
  expectMode({ releasePackageSpec: "openclaw@beta" }, "published", "openclaw@beta");
  expectMode({ candidateArtifactJson: " \t " }, "source");
  const artifactJson = '{"packagePublished":false,"packageArtifactId":"1"}';
  expectMode({ candidateArtifactJson: artifactJson }, "artifact", "", artifactJson);
  expect(preflight).toMatchObject({
    if: "needs.resolve_target.outputs.package_mode == 'source'",
    env: { PACKAGE_REF: "${{ needs.resolve_target.outputs.revision }}" },
    run: expect.stringContaining("node scripts/package-source-preflight.mjs"),
  });
});

it("resolves source requirements and orders preflight before setup", () => {
  const { step, before } = jobSteps(
    "openclaw-live-and-e2e-checks-reusable",
    "prepare_docker_e2e_image",
  );
  const sourceRequirement = step("Resolve source package requirement");
  const prepareOnlyPreflight = step("Validate prepare-only Docker E2E package source metadata");
  const plannedPreflight = step("Validate Docker E2E package source metadata");
  const harnessSetup = step("Setup trusted release harness");
  const setup = step("Setup Node environment");
  const pack = step("Pack OpenClaw package for Docker E2E");

  const expectRequirement = (env: Record<string, string>, required: boolean) =>
    expect(runSourceRequirement(sourceRequirement, env)).toBe(`required=${required}`);
  expectRequirement({ PACKAGE_ARTIFACT_PRESENT: "false" }, true);
  expectRequirement({ PACKAGE_ARTIFACT_PRESENT: "true" }, false);
  expectRequirement({ PACKAGE_ARTIFACT_PRESENT: "false", PREPARED_NPM_BUNDLE_JSON: "{}" }, false);
  before(prepareOnlyPreflight, harnessSetup);
  before(step("Plan Docker E2E images"), plannedPreflight);
  before(plannedPreflight, setup, pack);
});

it("treats a whitespace-only artifact tuple as absent", () => {
  const whitespace = " \t\n ";
  const artifactFields = ["DIGEST", "ID", "NAME", "RUN_ATTEMPT", "RUN_ID"];
  const packageFields = ["FILE_NAME", "SHA256", "SOURCE_SHA", "VERSION"];
  const { result, output } = runLiveArtifactTupleValidation(
    Object.fromEntries(
      [...artifactFields.map((field) => `ARTIFACT_${field}`), ...packageFields].map((field) => [
        `PACKAGE_${field}`,
        whitespace,
      ]),
    ),
  );

  expect(result.status, result.stderr).toBe(0);
  expect(output.package_artifact_present).toBe("false");
});

it("records the ephemeral artifact name in summary and failure reports", async () => {
  const reportDir = tempDirs.make("openclaw-live-source-report-");
  await writeRunSummary(
    reportDir,
    {
      failures: [{ name: "live-models", status: 1 }],
      lanes: [],
      status: "failed",
    },
    {
      OPENCLAW_DOCKER_E2E_PACKAGE_ARTIFACT_NAME: "docker-e2e-package",
      OPENCLAW_DOCKER_E2E_SELECTED_SHA: "a".repeat(40),
    },
  );
  const summary = JSON.parse(readFileSync(path.join(reportDir, "summary.json"), "utf8"));
  const failures = JSON.parse(readFileSync(path.join(reportDir, "failures.json"), "utf8"));
  expect(summary.packageArtifactName).toBe("docker-e2e-package");
  expect(failures.packageArtifactName).toBe("docker-e2e-package");
});

it("guards install-smoke candidate packaging before its dependency install", () => {
  const workflow = readWorkflow(".github/workflows/install-smoke-reusable.yml");
  const packageCandidate = workflowStep(
    workflow,
    "installer_smoke_candidate_payload",
    "Package candidate only inside pinned harness",
  );
  expect(packageCandidate.run).toContain('-v "$PWD/.release-harness:/harness:ro"');
  expect(packageCandidate.run).toContain(
    'node /harness/scripts/package-source-preflight.mjs "${preflight_args[@]}"',
  );
  expect(packageCandidate.run!.indexOf("package-source-preflight.mjs")).toBeLessThan(
    packageCandidate.run!.indexOf("pnpm install --frozen-lockfile"),
  );
});

it("guards npm source producers with trusted tooling before Node setup", () => {
  const { step, before } = jobSteps("openclaw-npm-preflight", "prepare_openclaw_npm");
  const checkout = step("Checkout trusted package source preflight");
  const preflight = step("Validate npm package source metadata");
  const setup = step("Setup Node environment");
  const build = step("Build");

  expect(checkout.with).toMatchObject({
    ref: "${{ github.workflow_sha }}",
    path: ".release-harness",
  });
  expect(preflight.run).toContain("node .release-harness/scripts/package-source-preflight.mjs");
  expect(preflight.run).toContain('if [[ "$RELEASE_REF" =~ ^[0-9a-fA-F]{40}$ ]]');
  before(checkout, preflight);
  before(preflight, setup, build);
});
