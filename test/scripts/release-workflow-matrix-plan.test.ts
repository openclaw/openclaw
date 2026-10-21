import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync } from "node:fs";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { collectBundledPluginBuildEntries } from "../../scripts/lib/bundled-plugin-build-entries.mjs";
import { resolveDockerE2ePlan } from "../../scripts/lib/docker-e2e-plan.mts";
import { allReleasePathLanes } from "../../scripts/lib/docker-e2e-scenarios.mts";
import { createPluginPrereleaseTestPlan } from "../../scripts/lib/plugin-prerelease-test-plan.mts";
import {
  createReleaseSourceSelection,
  createReleaseWorkflowMatrixPlan,
} from "../../scripts/plan-release-workflow-matrix.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { resolveWorkflowBash } from "../helpers/workflow-bash.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function workflow(): WorkflowDocument {
  return parse(
    readFileSync(".github/workflows/openclaw-live-and-e2e-checks-reusable.yml", "utf8"),
  ) as WorkflowDocument;
}

type WorkflowStep = Partial<Record<"id" | "if" | "name" | "run", string>> & {
  "continue-on-error"?: boolean;
  env?: Record<string, string>;
};

type MatrixEntry = {
  advisory?: boolean;
  chunk_id?: string;
  label?: string;
  profiles?: string;
  docker_lanes?: string;
  published_upgrade_survivor_baselines?: string;
  shard_id?: string;
  providers?: string;
  suite_group?: string;
  suite_id?: string;
};

type WorkflowJob = {
  "timeout-minutes"?: string | number;
  env: Record<string, string>;
  if?: string;
  steps: WorkflowStep[];
};

type WorkflowDocument = {
  env: Record<string, string>;
  jobs: Record<string, WorkflowJob>;
  on: Record<"workflow_call" | "workflow_dispatch", { inputs: Record<string, unknown> }>;
};

function requiredJob(definition: WorkflowDocument, name: string): WorkflowJob {
  return expectDefined(definition.jobs[name], `release workflow job ${name}`);
}

function requiredStep(job: WorkflowJob, name: string): WorkflowStep {
  return expectDefined(
    job.steps.find((step) => step.name === name),
    name,
  );
}

function bashRun(command: string, env: NodeJS.ProcessEnv) {
  return spawnSync("bash", ["--noprofile", "--norc", "-c", command], { encoding: "utf8", env });
}

function runFixture(command: string, args: string[], env: NodeJS.ProcessEnv, cwd?: string) {
  const result = spawnSync(command, args, { encoding: "utf8", env, cwd });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
}

function parseOutputs(text: string) {
  return Object.fromEntries(
    text
      .trim()
      .split("\n")
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

// Direct dispatches build from the selected ref. Only trusted workflow callers
// may provide the complete immutable package artifact tuple.
const WORKFLOW_CALL_ONLY_INPUTS = new Set(
  `runner_group package_sha256
prepublish_plugin_registry_manifest_sha256 shared_image_archive_sha256
published_upgrade_survivor_baseline_scope prepare_only emit_candidate_evidence release_soak
package_published package_artifact_name prepared_npm_bundle_json package_artifact_id
package_artifact_digest package_artifact_run_id package_artifact_run_attempt package_file_name
package_source_sha package_version enable_prepublish_plugin_registry
prepublish_plugin_registry_artifact_name prepublish_plugin_registry_artifact_id
prepublish_plugin_registry_artifact_digest prepublish_plugin_registry_artifact_run_id
prepublish_plugin_registry_artifact_run_attempt shared_image_artifact_name shared_image_artifact_id
shared_image_artifact_digest shared_image_artifact_run_id shared_image_artifact_run_attempt`.split(
    /\s+/u,
  ),
);

const PACKAGE_UPDATE_CHUNKS = [
  "package-update-openai",
  "package-update-restart-auth",
  "package-update-onboarding",
  "package-update-migrations",
];

const FULL_DOCKER_CHUNKS = [
  "core",
  ...PACKAGE_UPDATE_CHUNKS,
  "plugins-runtime-plugins",
  "plugins-runtime-services",
  ..."abcdefgh".split("").map((shard) => `plugins-runtime-install-${shard}`),
];

const STABLE_PROVIDERS = ["anthropic", "google", "minimax", "openai"];

function expectStableMatrices(docker: MatrixEntry[], live: MatrixEntry[]) {
  expect(docker.map((row) => row.chunk_id)).toEqual(FULL_DOCKER_CHUNKS);
  expect(live.map((row) => row.providers)).toEqual(STABLE_PROVIDERS);
}

describe("scripts/plan-release-workflow-matrix.mjs", () => {
  it("normalizes an empty CLI profile to stable matrices", () => {
    const stdout = runFixture(process.execPath, ["scripts/plan-release-workflow-matrix.mjs"], {
      ...process.env,
      RELEASE_TEST_PROFILE: "",
      INCLUDE_RELEASE_PATH_SUITES: "true",
      INCLUDE_LIVE_SUITES: "true",
      DOCKER_LANES: "",
      LIVE_MODEL_PROVIDERS: "",
      LIVE_SUITE_FILTER: "",
      LIVE_MODELS_ONLY: "false",
      PREPARE_ONLY: "false",
      GITHUB_STEP_SUMMARY: "",
    });
    const outputs = parseOutputs(stdout);
    expectStableMatrices(
      JSON.parse(expectDefined(outputs.docker_e2e_matrix, "Docker E2E matrix output")).include,
      JSON.parse(expectDefined(outputs.live_models_matrix, "live models matrix output")).include,
    );
    expect(outputs).toMatchObject({
      docker_e2e_count: String(FULL_DOCKER_CHUNKS.length),
      live_models_count: String(STABLE_PROVIDERS.length),
    });
  });

  it("keeps the API strict for an empty CLI profile value", () => {
    expect(() => createReleaseWorkflowMatrixPlan({ releaseProfile: "" })).toThrow(
      "unknown release profile",
    );
  });

  it("keeps prepare-only asset union separate from every execution job", () => {
    const selected = createReleaseSourceSelection({
      releaseProfile: "full",
      prepareOnly: true,
      includeReleasePathSuites: true,
      includeLiveSuites: true,
      includeOpenWebUI: true,
    });
    expect(selected).toMatchObject({ docker: [], consumers: [], codexSuites: [] });
    expect(selected.preparationLanes).toEqual([
      ...new Set([
        ...allReleasePathLanes({ releaseProfile: "full", includeOpenWebUI: true }).map(
          ({ name }) => name,
        ),
        ...createPluginPrereleaseTestPlan().dockerLanes,
      ]),
    ]);
    const jobs = workflow().jobs;
    const running = Object.entries(jobs)
      .filter(([name, job]) => {
        if (!name.startsWith("validate_") || name === "validate_selected_ref") {
          return false;
        }
        return runInNewContext(job.if ?? "true", {
          inputs: {
            prepare_only: true,
            include_release_path_suites: true,
            include_live_suites: true,
            include_openwebui: true,
            include_repo_e2e: true,
            live_suite_filter: "",
            docker_lanes: "",
            live_model_providers: "",
            release_test_profile: "full",
          },
          needs: {
            plan_release_workflow_matrices: {
              outputs: { live_docker_count: "1", docker_e2e_count: "1", live_models_count: "1" },
            },
          },
          startsWith: (value: string, prefix: string) => value.startsWith(prefix),
        });
      })
      .map(([name]) => name);
    expect(running).toEqual([]);
    expect(
      runInNewContext(requiredJob(workflow(), "prepare_docker_e2e_image").if ?? "", {
        inputs: { prepare_only: true },
      }),
    ).toBe(true);
  });

  it.each([
    ["beta", "", 0],
    ["stable", "onboard", 1],
  ])(
    "does not admit an unscheduled OpenWebUI job for %s / %s",
    (releaseProfile, dockerLanes, count) => {
      const selected = createReleaseSourceSelection({
        releaseProfile,
        dockerLanes,
        includeOpenWebUI: true,
      });
      expect(selected.docker).toHaveLength(count);
      expect(
        selected.docker.flatMap((group: { lanes?: string[] }) => group.lanes ?? []),
      ).not.toContain("openwebui");
    },
  );

  it.each(["beta", "minimum", "stable", "full"])(
    "selects prompt-cache checks by default and for focused %s validation",
    (releaseProfile) => {
      const job = requiredJob(workflow(), "validate_release_live_cache");
      expect(job["timeout-minutes"]).toBe(30);
      const condition = expectDefined(job.if, "live-cache job selection");
      for (const [liveSuiteFilter, enabled] of [
        ["", true],
        ["live-cache", true],
        ["docker-live-models", false],
      ] as const) {
        expect(
          runInNewContext(condition, {
            inputs: {
              prepare_only: false,
              include_live_suites: true,
              live_models_only: false,
              live_suite_filter: liveSuiteFilter,
              release_test_profile: releaseProfile,
            },
          }),
        ).toBe(enabled);
      }
      expect(job.steps.map((step) => step.name)).toEqual(
        expect.arrayContaining([
          "Verify live prompt cache floors",
          "Verify live prompt prefix reuse",
          "Verify live agent prompt prefix reuse",
        ]),
      );
    },
  );

  it.each([
    [
      "Verify live prompt prefix reuse",
      "--import ./scripts/tsx.mjs scripts/e2e/anthropic-cache-live.mts",
    ],
    [
      "Verify live agent prompt prefix reuse",
      "test:live src/agents/embedded-agent-runner.cache.live.test.ts --testNamePattern release prompt-prefix gate",
    ],
  ])("propagates harness results from %s to the release gate", (stepName, args) => {
    const job = requiredJob(workflow(), "validate_release_live_cache");
    const step = requiredStep(job, stepName);
    for (const code of [0, 23]) {
      const result = bashRun(
        `timeout() { while [[ "$1" == --* ]]; do shift; done; shift; "$@"; }
node() { printf '%s\\n' "$*"; return "$HARNESS_EXIT"; }
pnpm() { node "$@"; }
${expectDefined(step.run, "prompt-prefix command")}`,
        { PATH: process.env.PATH, HARNESS_EXIT: String(code) },
      );
      expect({ stdout: result.stdout.trim(), status: result.status }, result.stderr).toEqual({
        stdout: args,
        status: code,
      });
    }
    expect(step["continue-on-error"]).not.toBe(true);
  });

  it.each([
    ["validate_docker_e2e", "Run Docker E2E chunk"],
    ["validate_docker_lanes", "Run targeted Docker E2E lanes"],
  ])("drains diagnostics after credential failure in %s", (jobName, runStepName) => {
    const job = requiredJob(workflow(), jobName);
    const credentials = requiredStep(job, "Validate Docker E2E credentials");
    const run = requiredStep(job, runStepName);
    // Credential validation must be reached only after every setup/binding step
    // succeeds; nothing fallible may intervene before diagnostic continuation.
    expect(job.steps.indexOf(run)).toBe(job.steps.indexOf(credentials) + 1);
    expect(credentials["continue-on-error"]).not.toBe(true);
    expect(credentials.if ?? "").not.toMatch(/\b(?:always|cancelled|failure|success)\s*\(/u);

    const preflight = expectDefined(credentials.run, "credential validation command");
    for (const { credential, key, label, alternatives } of [
      { credential: "openai", key: "OPENAI_API_KEY", label: "OpenAI", alternatives: {} },
      { credential: "anthropic", key: "ANTHROPIC_API_TOKEN", label: "Anthropic", alternatives: {} },
      {
        credential: "anthropic-api-key",
        key: "ANTHROPIC_API_KEY",
        label: "Anthropic API key",
        alternatives: {
          ANTHROPIC_API_TOKEN: "synthetic-oauth-token",
          OPENCLAW_CLAUDE_CREDENTIALS_JSON: "synthetic-claude-credentials",
          OPENCLAW_CLAUDE_JSON: "synthetic-claude-config",
        },
      },
    ]) {
      for (const authenticated of [false, true]) {
        const result = bashRun(preflight, {
          PATH: process.env.PATH,
          CREDENTIALS: credential,
          ...alternatives,
          ...(authenticated ? { [key]: "synthetic-api-key" } : {}),
        });
        expect(result.status, result.stderr).toBe(authenticated ? 0 : 1);
        if (!authenticated) {
          expect(result.stderr).toContain(`Missing credential for ${label}`);
        }
        expect(result.stdout + result.stderr).not.toContain("synthetic-");
      }
    }

    for (const [label, success, cancelled, outcome, selected] of [
      ["success", true, false, "success", true],
      ["credential failure", false, false, "failure", true],
      ["setup failure", false, false, "skipped", true],
      ["cancelled", false, true, "failure", true],
      ["unselected profile", true, false, "skipped", false],
    ] as const) {
      const evaluate = (step: WorkflowStep) => {
        const expression = (step.if ?? "success()").replace(/^\$\{\{\s*([\s\S]*?)\s*\}\}$/u, "$1");
        // GitHub implicitly adds success() unless a status function is present.
        const implicitSuccess = /\b(?:always|cancelled|failure|success)\s*\(/u.test(expression)
          ? true
          : success;
        return (
          implicitSuccess &&
          runInNewContext(expression, {
            always: () => true,
            cancelled: () => cancelled,
            failure: () => !success && !cancelled,
            success: () => success,
            contains: (value: string, item: string) => value.includes(item),
            inputs: { release_test_profile: "full" },
            matrix: { profiles: selected ? "stable full" : "beta" },
            steps: { [credentials.id ?? ""]: { outcome } },
          })
        );
      };
      const profileSelected = jobName === "validate_docker_lanes" || selected;
      expect(evaluate(credentials), `${label}: preflight`).toBe(success && profileSelected);
      expect(evaluate(run), `${label}: diagnostics`).toBe(
        !cancelled && profileSelected && (success || outcome === "failure"),
      );
    }
  });

  it("builds provider owners used by every direct and Gateway Docker live lane", () => {
    const definition = workflow();
    const bash = process.platform === "darwin" ? resolveWorkflowBash() : "bash";
    const outputDir = tempDirs.make("openclaw-live-image-selection-");
    const outputPath = path.join(outputDir, "outputs");
    symlinkSync(path.resolve("scripts"), path.join(outputDir, "scripts"), "dir");
    mkdirSync(path.join(outputDir, ".release-target"));
    symlinkSync(
      path.resolve("extensions"),
      path.join(outputDir, ".release-target/extensions"),
      "dir",
    );
    const env = {
      PATH: process.env.PATH,
      GITHUB_REPOSITORY: "openclaw/openclaw",
      GITHUB_OUTPUT: outputPath,
      GITHUB_STEP_SUMMARY: path.join(outputDir, "summary"),
      SELECTED_SHA: "a".repeat(40),
      SHARED_IMAGE_POLICY: "no-push-artifact",
    };
    const plannerJob = requiredJob(definition, "plan_release_workflow_matrices");
    const { steps } = plannerJob;
    const setup = requiredStep(plannerJob, "Setup admission Node.js");
    expect(setup.if).toBeUndefined();
    expect(setup.env).toMatchObject({ REQUESTED_NODE_VERSION: "24.x" });
    expect(setup.run).toContain("source .github/actions/setup-pnpm-store-cache/ensure-node.sh");
    expect(setup.run).toContain('openclaw_ensure_node "$REQUESTED_NODE_VERSION"');
    const planner = requiredStep(plannerJob, "Plan shared live image plugins");
    expect(steps.indexOf(setup)).toBeLessThan(steps.indexOf(planner));
    runFixture(bash, ["-c", expectDefined(planner.run, "planner command")], env, outputDir);
    const selected = readFileSync(outputPath, "utf8").trim().split("=")[1];
    const step = requiredStep(
      requiredJob(definition, "prepare_live_test_image"),
      "Resolve shared live-test image tag",
    );
    runFixture(bash, ["-c", expectDefined(step.run, "selection command")], {
      ...env,
      LIVE_IMAGE_EXTENSIONS: selected,
    });
    const outputs = parseOutputs(readFileSync(outputPath, "utf8"));
    expect(outputs.live_image?.split(":")[1]?.length).toBeLessThanOrEqual(128);
    const builtIds = new Set(
      collectBundledPluginBuildEntries({
        env: { OPENCLAW_INTERNAL_DOCKER_BUILD_PLUGIN_IDS: outputs.live_image_extensions },
      }).map((entry: { id: string }) => entry.id),
    );
    const plan = createReleaseWorkflowMatrixPlan({
      releaseProfile: "full",
      includeLiveSuites: true,
    });
    const providers = new Set(
      plan.liveModels.matrix.include.map((entry: MatrixEntry) => entry.providers),
    );
    for (const entry of plan.liveDocker.matrix.include) {
      for (const match of JSON.stringify(entry).matchAll(
        /OPENCLAW_LIVE_GATEWAY_PROVIDERS=([^\s"]+)/gu,
      )) {
        for (const provider of expectDefined(match[1], "Gateway provider selection").split(",")) {
          providers.add(provider);
        }
      }
    }
    const manifests = readdirSync("extensions").flatMap((id) => {
      const manifestPath = path.join("extensions", id, "openclaw.plugin.json");
      return existsSync(manifestPath)
        ? [{ id, manifest: JSON.parse(readFileSync(manifestPath, "utf8")) }]
        : [];
    });
    for (const provider of providers) {
      const owners = manifests.filter(({ manifest }) => manifest.providers?.includes(provider));
      expect(
        owners.some(({ id }) => builtIds.has(id)),
        `compiled owner for ${String(provider)}`,
      ).toBe(true);
    }
  });

  it("declares shared inputs for both entry points and keeps producer evidence internal", () => {
    const definition = workflow();
    const referencedInputs = new Set<string>();
    for (const match of JSON.stringify(definition.jobs).matchAll(/\binputs\.([a-zA-Z0-9_]+)/gu)) {
      if (match[1]) {
        referencedInputs.add(match[1]);
      }
    }

    expect(Object.keys(definition.on.workflow_call.inputs)).toEqual(
      expect.arrayContaining([...referencedInputs]),
    );
    expect(Object.keys(definition.on.workflow_dispatch.inputs)).toEqual(
      expect.arrayContaining(
        [...referencedInputs].filter((input) => !WORKFLOW_CALL_ONLY_INPUTS.has(input)),
      ),
    );
    expect(Object.keys(definition.on.workflow_dispatch.inputs).length).toBeLessThanOrEqual(25);
    for (const input of WORKFLOW_CALL_ONLY_INPUTS) {
      expect(definition.on.workflow_call.inputs).toHaveProperty(input);
      expect(definition.on.workflow_dispatch.inputs).not.toHaveProperty(input);
    }
    expect(definition.on.workflow_dispatch.inputs.allow_unreleased_changelog).toEqual(
      definition.on.workflow_call.inputs.allow_unreleased_changelog,
    );
    expect(definition.on.workflow_call.inputs.allow_unreleased_changelog).toMatchObject({
      default: false,
      required: false,
      type: "boolean",
    });
    expect(definition.env.OPENCLAW_DOCKER_E2E_ALLOW_UNRELEASED_CHANGELOG).toBe(
      "${{ inputs.allow_unreleased_changelog }}",
    );
    const requiredPackageStep = requiredStep(
      requiredJob(definition, "prepare_docker_e2e_image"),
      "Pack OpenClaw package for Docker E2E",
    );
    expect(requiredPackageStep.env?.ALLOW_UNRELEASED_CHANGELOG).toBe(
      "${{ inputs.allow_unreleased_changelog }}",
    );
    expect(requiredPackageStep.run).toContain("package_args+=(--allow-unreleased-changelog)");
    expect(requiredPackageStep.run).toContain("grep -Fq");
  });

  it("keeps stable release jobs to enabled Docker chunks and live providers", () => {
    const options = {
      includeLiveSuites: true,
      includeReleasePathSuites: true,
      releaseProfile: "stable",
    };
    const plan = createReleaseWorkflowMatrixPlan(options);
    expectStableMatrices(plan.dockerE2e.matrix.include, plan.liveModels.matrix.include);
    for (const [chunk, timeout] of [
      ["package-update-openai", 60],
      ["package-update-restart-auth", 75],
    ]) {
      expect(
        plan.dockerE2e.matrix.include.find((entry: MatrixEntry) => entry.chunk_id === chunk),
      ).toMatchObject({ timeout_minutes: timeout });
    }
    expect(plan.liveModels.matrix.include).toContainEqual({
      provider_label: "MiniMax",
      providers: "minimax",
      models: "minimax/MiniMax-M3,minimax-portal/MiniMax-M3",
      max_models: "2",
      profiles: "stable full",
    });
    const admission = createReleaseSourceSelection(options);
    expect(admission.docker.map((entry) => ("chunk" in entry ? entry.chunk : undefined))).toEqual(
      FULL_DOCKER_CHUNKS,
    );
    expect(admission.codexSuites).toEqual(
      plan.liveDocker.matrix.include
        .filter((entry: MatrixEntry) => entry.suite_id?.startsWith("live-codex-harness"))
        .map((entry: MatrixEntry) => entry.suite_id),
    );
  });

  it("isolates migration baselines without duplicating or dropping upgrade coverage", () => {
    const options = {
      includeReleasePathSuites: true,
      releaseProfile: "beta",
      upgradeSurvivorBaselines: "2026.6.34 2026.8.35 2026.9.7 2026.9.8 2026.9.8",
    };
    const rows: MatrixEntry[] = createReleaseWorkflowMatrixPlan(
      options,
    ).dockerE2e.matrix.include.filter(
      (row: MatrixEntry) => row.chunk_id === "package-update-migrations",
    );
    expect(rows).toHaveLength(5);
    expect(new Set(rows.map((row) => row.shard_id)).size).toBe(5);
    const selection = createReleaseSourceSelection(options).docker.filter(
      (entry) => "chunk" in entry && entry.chunk === "package-update-migrations",
    );
    const plans = selection.map(
      (entry) =>
        resolveDockerE2ePlan({
          includeOpenWebUI: false,
          liveMode: "all",
          orderLanes: (lanes) => lanes,
          planReleaseAll: false,
          profile: "release-path",
          releaseChunk: "package-update-migrations",
          releaseProfile: "beta",
          selectedLaneNames: entry.lanes ?? [],
          upgradeSurvivorBaselines: entry.baselines,
        }).plan,
    );
    expect(plans.map((plan) => plan.lanes.length)).toEqual([1, 1, 1, 1, 1]);
    expect(plans.flatMap((plan) => plan.lanes.map((lane) => lane.name)).toSorted()).toEqual([
      "published-upgrade-survivor-2026.6.34",
      "published-upgrade-survivor-2026.8.35",
      "published-upgrade-survivor-2026.9.7",
      "published-upgrade-survivor-2026.9.8",
      "update-channel-switch",
    ]);
    expect(plans.every((plan) => plan.lanes.every((lane) => lane.weight === 3))).toBe(true);
    expect(rows.map((row) => row.docker_lanes)).toEqual(
      selection.map((entry) => expectDefined(entry.lanes, "migration lane selectors").join(" ")),
    );
    expect(rows.map((row) => row.published_upgrade_survivor_baselines)).toEqual(
      selection.map((entry) => entry.baselines),
    );
  });

  it("keeps live Anthropic cache proof in both stable release-core steps", () => {
    const releaseProfile = "stable";
    const definition = workflow();
    const job = requiredJob(definition, "validate_docker_e2e");
    const directory = tempDirs.make("openclaw-release-core-cache-");
    symlinkSync(process.cwd(), path.join(directory, ".release-harness"), "dir");
    const expressions: Record<string, string> = {
      "inputs.release_test_profile": releaseProfile,
      "inputs.include_openwebui": "false",
      "matrix.chunk_id": "core",
      "matrix.docker_lanes": "",
      "steps.plan.outputs.needs_package": "1",
      "steps.plan.outputs.needs_live_image": "0",
      "needs.prepare_docker_e2e_image.outputs.prepublish_plugin_registry_artifact_id": "",
    };
    const render = (value: string) =>
      value.replace(/\$\{\{\s*(.*?)\s*\}\}/gu, (_, expression: string) =>
        expectDefined(expressions[expression], `release-core fixture expression ${expression}`),
      );
    for (const stepName of ["Plan Docker E2E chunk", "Run Docker E2E chunk"]) {
      const step = requiredStep(job, stepName);
      // Preserve every scheduler selector from the real workflow. PLAN_JSON
      // only substitutes scheduling for execution; it does not change lanes.
      const selectors = Object.fromEntries(
        Object.entries({ ...definition.env, ...job.env, ...step.env })
          .filter(([key]) =>
            /^(?:OPENCLAW_DOCKER_ALL_|DOCKER_E2E_CHUNK$|CHUNK$|INCLUDE_OPENWEBUI$|RELEASE_TEST_PROFILE$)/u.test(
              key,
            ),
          )
          .map(([key, value]) => [key, render(value)]),
      );
      const stdout = runFixture(
        "bash",
        ["--noprofile", "--norc", "-c", render(expectDefined(step.run, stepName))],
        {
          PATH: process.env.PATH,
          GITHUB_WORKSPACE: process.cwd(),
          GITHUB_OUTPUT: path.join(directory, "outputs"),
          TSX_TSCONFIG_PATH: path.resolve("tsconfig.json"),
          OPENCLAW_DOCKER_E2E_REPO_ROOT: process.cwd(),
          ...selectors,
          OPENCLAW_DOCKER_ALL_PLAN_JSON: "1",
        },
        directory,
      );
      const plan = JSON.parse(
        stepName === "Plan Docker E2E chunk"
          ? readFileSync(
              path.join(directory, ".artifacts/docker-tests/release-core-plan.json"),
              "utf8",
            )
          : stdout,
      );
      expect(plan.releaseProfile).toBe(releaseProfile);
      expect(plan.lanes).toContainEqual(
        expect.objectContaining({
          name: "live-anthropic-cache",
          live: true,
          imageKind: "functional",
        }),
      );
      expect(plan.credentials).toContain("anthropic-api-key");
    }
  });

  it("keeps stable and full Anthropic Docker proof blocking", () => {
    const jobs = workflow().jobs;
    const dockerLiveJob = expectDefined(
      jobs.validate_live_docker_provider_suites,
      "live Docker provider suites job",
    );
    const anthropicEntries = ["stable", "full"]
      .flatMap(
        (releaseProfile) =>
          createReleaseWorkflowMatrixPlan({ releaseProfile, includeLiveSuites: true }).liveDocker
            .matrix.include,
      )
      .filter((entry: MatrixEntry) => entry.suite_group === "live-gateway-anthropic-docker")
      .map((entry: MatrixEntry) => [entry.advisory, entry.label, entry.profiles, entry.suite_id]);

    expect(anthropicEntries).toEqual([
      [undefined, "Docker live gateway Anthropic", "stable", "live-gateway-anthropic-docker"],
      [
        undefined,
        "Docker live gateway Anthropic (full)",
        "full",
        "live-gateway-anthropic-docker-full",
      ],
    ]);
    const conditionalSteps = dockerLiveJob.steps.filter((step: WorkflowStep) => step.if);
    expect(conditionalSteps.length).toBeGreaterThan(0);
    for (const step of conditionalSteps) {
      expect(step.if).toContain("inputs.live_suite_filter == matrix.suite_group");
    }
  });

  it("disables live model planning when focused recovery targets another live suite", () => {
    const plan = createReleaseWorkflowMatrixPlan({
      includeLiveSuites: true,
      includeReleasePathSuites: true,
      liveSuiteFilter: "live-cache",
      releaseProfile: "full",
    });

    expect(plan.liveModels.count).toBe(0);
    expect(plan.liveModels.omitted).toHaveLength(10);
    expect(plan.liveModels.omitted[0]?.reason).toBe(
      "Docker live model matrix disabled by input selection",
    );
  });
});
