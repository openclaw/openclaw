// Plugin Prerelease Test Plan tests cover plugin prerelease test plan script behavior.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, matchesGlob } from "node:path";
import { runInNewContext } from "node:vm";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { listAvailableExtensionIds } from "../../scripts/lib/changed-extensions.mts";
import { findLaneByName } from "../../scripts/lib/docker-e2e-plan.mts";
import { BUNDLED_PLUGIN_INSTALL_UNINSTALL_SHARDS } from "../../scripts/lib/docker-e2e-scenarios.mts";
import {
  resolveExtensionTestPlan,
  resolveExtensionTestConfig,
} from "../../scripts/lib/extension-test-plan.mts";
import {
  assertPluginPrereleaseTestPlanComplete,
  createPluginPrereleaseTestPlan,
  resolvePluginPrereleaseExtensionRuntime,
} from "../../scripts/lib/plugin-prerelease-test-plan.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { evaluateWorkflowExpression, evaluateWorkflowRunner } from "./ci-workflow.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

type WorkflowStep = {
  id?: string;
  env?: Record<string, string>;
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
};

function readFullReleaseValidationWorkflow() {
  return parse(readFileSync(".github/workflows/full-release-validation.yml", "utf8"));
}

function readPluginPrereleaseWorkflow() {
  return parse(readFileSync(".github/workflows/plugin-prerelease.yml", "utf8"));
}

function getDockerLane(name: string) {
  const lane = findLaneByName(name);
  if (!lane) {
    throw new Error(`Missing Docker E2E lane ${name}`);
  }
  return lane;
}

function pluginCandidateArtifactJson(selectedSha = "a".repeat(40)) {
  return JSON.stringify({
    packageArtifactName: "docker-e2e-package-123-1",
    packageArtifactId: "456",
    packageArtifactDigest: "b".repeat(64),
    packageArtifactRunId: "123",
    packageArtifactRunAttempt: "1",
    packageFileName: "openclaw-current.tgz",
    packageSourceSha: selectedSha,
    packageSha256: "c".repeat(64),
    packageVersion: "2026.8.1",
    imageArtifactName: "docker-e2e-shared-images-123-1",
    imageArtifactId: "789",
    imageArtifactDigest: "d".repeat(64),
    imageArtifactRunId: "123",
    imageArtifactRunAttempt: "1",
    imageArchiveSha256: "e".repeat(64),
  });
}

function runPluginPhaseValidation(params: {
  candidateArtifactJson?: string;
  expectedSha?: string;
  fullReleaseValidation?: boolean;
  phase: string;
}) {
  const workflow = readPluginPrereleaseWorkflow();
  const step = workflow.jobs.preflight.steps.find(
    (candidate: WorkflowStep) => candidate.name === "Validate phase inputs",
  );
  if (!step?.run) {
    throw new Error("Missing plugin prerelease phase validation step");
  }
  return spawnSync("bash", ["-c", step.run], {
    encoding: "utf8",
    env: {
      CANDIDATE_ARTIFACT_JSON: params.candidateArtifactJson ?? "",
      EXPECTED_SHA: params.expectedSha ?? "",
      FULL_RELEASE_VALIDATION: String(params.fullReleaseValidation ?? true),
      PATH: process.env.PATH,
      PHASE: params.phase,
    },
  });
}

function runPluginManifest(
  phase: "all" | "candidate" | "independent",
  eventName = "workflow_dispatch",
) {
  const workflow = readPluginPrereleaseWorkflow();
  const step = workflow.jobs.preflight.steps.find(
    (candidate: WorkflowStep) => candidate.name === "Build plugin prerelease manifest",
  );
  if (!step?.run) {
    throw new Error("Missing plugin prerelease manifest step");
  }
  const root = tempDirs.make("openclaw-plugin-prerelease-phase-");
  const outputPath = join(root, "github-output");
  const result = spawnSync("bash", ["-c", step.run], {
    encoding: "utf8",
    env: {
      FULL_RELEASE_VALIDATION: eventName === "schedule" ? "false" : "true",
      GITHUB_EVENT_NAME: eventName,
      GITHUB_OUTPUT: outputPath,
      PATH: process.env.PATH,
      PHASE: phase,
    },
  });
  return {
    output: existsSync(outputPath) ? readFileSync(outputPath, "utf8") : "",
    result,
  };
}

function runPluginSummary(params: {
  docker: string;
  extensions: string;
  inspector?: string;
  node: string;
  runDocker: boolean;
  runExtensions: boolean;
  runNode: boolean;
  runNpmSecurity: boolean;
  runStatic: boolean;
  static: string;
}) {
  const workflow = readPluginPrereleaseWorkflow();
  const step = workflow.jobs["plugin-prerelease-suite"].steps.find(
    (candidate: WorkflowStep) => candidate.name === "Verify plugin prerelease suite",
  );
  if (!step?.run) {
    throw new Error("Missing plugin prerelease summary step");
  }
  return spawnSync("bash", ["-c", step.run], {
    encoding: "utf8",
    env: {
      DOCKER_RESULT: params.docker,
      EXTENSIONS_RESULT: params.extensions,
      INSPECTOR_RESULT: params.inspector ?? "skipped",
      NODE_RESULT: params.node,
      PATH: process.env.PATH,
      RUN_DOCKER: String(params.runDocker),
      RUN_EXTENSIONS: String(params.runExtensions),
      RUN_NODE: String(params.runNode),
      RUN_NPM_SECURITY: String(params.runNpmSecurity),
      RUN_STATIC: String(params.runStatic),
      SECURITY_RESULT: "success",
      STATIC_RESULT: params.static,
    },
  });
}

describe("scripts/lib/plugin-prerelease-test-plan.mts", () => {
  it.each([
    {
      name: "ordinary plugin validation",
      fullReleaseValidation: false,
      memory: true,
      vitestArgs: [],
      requiresBun: false,
    },
    {
      name: "full release memory and database-worker groups",
      fullReleaseValidation: true,
      memory: true,
      vitestArgs: [],
      requiresBun: true,
    },

    {
      name: "full release with an explicit report",
      fullReleaseValidation: true,
      memory: true,
      vitestArgs: ["--reporter=json", "--outputFile=report.json"],
      requiresBun: false,
    },
  ])(
    "selects runtime setup for $name",
    async ({ fullReleaseValidation, memory, vitestArgs, requiresBun }) => {
      const planGroups = [
        {
          config: "test/vitest/vitest.extension-database-workers.config.ts",
          roots: ["extensions/memory-lancedb/index.test.ts"],
        },
        ...(memory
          ? [
              {
                config: "test/vitest/vitest.extension-memory.config.ts",
                roots: ["extensions/memory-lancedb"],
              },
            ]
          : []),
      ];

      expect(
        await resolvePluginPrereleaseExtensionRuntime({
          planGroups,
          fullReleaseValidation,
          vitestArgs,
        }),
      ).toEqual({ test_runtime_policy: requiresBun ? "dual" : "node", requires_bun: requiresBun });
    },
  );

  it("runs the package and Docker product lanes through the existing scheduler", () => {
    const plan = assertPluginPrereleaseTestPlanComplete();

    expect(plan.dockerLanes).toEqual([
      "npm-onboard-channel-agent",
      "npm-onboard-discord-candidate-channel-agent",
      "npm-onboard-slack-candidate-channel-agent",
      "doctor-switch",
      "update-channel-switch",
      "plugins-offline",
      "plugins",
      "kitchen-sink-plugin",
      "kitchen-sink-rpc",
      "plugin-update",
      "config-reload",
      "gateway-network",
      "mcp-channels",
      "cron-mcp-cleanup",
      ...Array.from(
        { length: BUNDLED_PLUGIN_INSTALL_UNINSTALL_SHARDS },
        (_, index) => `bundled-plugin-install-uninstall-${index}`,
      ),
    ]);

    for (const lane of plan.dockerLanes) {
      expect(getDockerLane(lane).name).toBe(lane);
    }
    const candidateLane = getDockerLane("npm-onboard-discord-candidate-channel-agent");
    expect(candidateLane.command).toContain("OPENCLAW_DOCKER_E2E_TRUSTED_HARNESS_DIR");
    expect(candidateLane.command).toContain(
      'OPENCLAW_LIVE_DOCKER_REPO_ROOT="${OPENCLAW_DOCKER_E2E_REPO_ROOT:-$PWD}"',
    );
  });

  it("uses kitchen-sink npm and ClawHub scenarios as the registry install canary", () => {
    const lane = getDockerLane("kitchen-sink-plugin");
    const script = readFileSync("scripts/e2e/kitchen-sink-plugin-docker.sh", "utf8");
    const sweepScript = readFileSync("scripts/e2e/lib/kitchen-sink-plugin/sweep.sh", "utf8");
    const assertionsScript = readFileSync(
      "scripts/e2e/lib/kitchen-sink-plugin/assertions.mjs",
      "utf8",
    );

    expect(lane).toEqual({
      command: "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:kitchen-sink-plugin",
      e2eImageKind: "functional",
      live: false,
      name: "kitchen-sink-plugin",
      resources: ["npm"],
      stateScenario: "empty",
      weight: 3,
    });
    expect(script).toContain("npm:@openclaw/kitchen-sink@latest");
    expect(script).toContain("npm-latest-conformance");
    expect(script).toContain("npm-latest-adversarial");
    expect(script).toContain("npm:@openclaw/kitchen-sink@beta");
    expect(script).toContain("clawhub:@openclaw/kitchen-sink@latest");
    expect(script).toContain("clawhub:@openclaw/kitchen-sink@beta");
    expect(script).toContain("OPENCLAW_KITCHEN_SINK_PLUGIN_MAX_MEMORY_MIB");
    expect(script).toContain(
      "npm-to-clawhub|clawhub:@openclaw/kitchen-sink@latest|openclaw-kitchen-sink-fixture|clawhub|success|basic||${KITCHEN_SINK_NPM_SPEC}",
    );
    expect(script).toContain("scripts/e2e/lib/kitchen-sink-plugin/sweep.sh");
    expect(sweepScript).toContain('plugins install "$KITCHEN_SINK_SPEC" --force');
    expect(sweepScript).toContain('plugins install "$KITCHEN_SINK_PREINSTALL_SPEC" --force');
    expect(sweepScript).toContain("assert-cutover-preinstalled");
    expect(sweepScript).toContain('install_args+=("--force")');
    expect(sweepScript).toContain("KITCHEN_SINK_PERSONALITY");
    expect(sweepScript).toContain("OPENCLAW_KITCHEN_SINK_PERSONALITY");
    expect(sweepScript).toContain('plugins uninstall "$KITCHEN_SINK_SPEC" --force');
    const successScenario = sweepScript.slice(
      sweepScript.indexOf("run_success_scenario()"),
      sweepScript.indexOf("run_failure_scenario()"),
    );
    const installIndex = successScenario.indexOf('plugins install "${install_args[@]}" --force');
    const configureIndex = successScenario.indexOf("assertions.mjs configure-runtime");
    const enableIndex = successScenario.indexOf('plugins enable "$KITCHEN_SINK_ID"');
    expect(installIndex).toBeGreaterThanOrEqual(0);
    expect(configureIndex).toBeGreaterThan(installIndex);
    expect(enableIndex).toBeGreaterThan(configureIndex);
    expect(successScenario).toContain('plugins inspect "$KITCHEN_SINK_ID" --runtime --json');
    expect(successScenario).toContain("plugins inspect --all --runtime --json");
    expect(sweepScript).toContain("run_failure_scenario");
    expect(assertionsScript).toContain("assertCutoverPreinstalled");
    expect(assertionsScript).toContain("record.source !== source");
    expect(assertionsScript).toContain("record.clawhubPackage !== packageName");
    expect(assertionsScript).toContain("record.artifactKind");
    expect(assertionsScript).toContain("assertClawHubExternalInstallContract");
    expect(assertionsScript).toContain("expectedErrorMessages");
    expect(assertionsScript).toContain(
      'const INVALID_PROBE_DIAGNOSTIC_SURFACE_MODES = new Set(["full", "adversarial"]);',
    );
    expect(assertionsScript).toContain("!INVALID_PROBE_DIAGNOSTIC_SURFACE_MODES.has(surfaceMode)");
    expect(readFileSync("scripts/e2e/lib/clawhub-fixture-server.cjs", "utf8")).toContain(
      'from "openclaw/plugin-sdk/plugin-entry"',
    );
    expect(readFileSync("scripts/e2e/lib/clawhub-fixture-server.cjs", "utf8")).toContain(
      "X-ClawHub-Artifact-Sha256",
    );
    expect(script).toContain("docker_e2e_sample_stats_until_exit");
    expect(script).toContain("scripts/e2e/lib/docker-stats/assert-resource-ceiling.mjs");
    expect(sweepScript).toContain("assertions.mjs scan-logs");
  });

  it("keeps the generic plugin Docker lane as an external install contract canary", () => {
    const lane = getDockerLane("plugins");
    const sweepScript = readFileSync("scripts/e2e/lib/plugins/sweep.sh", "utf8");
    const clawhubScript = readFileSync("scripts/e2e/lib/plugins/clawhub.sh", "utf8");
    const assertionsScript = readFileSync("scripts/e2e/lib/plugins/assertions.mjs", "utf8");
    const fixtureServer = readFileSync("scripts/e2e/lib/clawhub-fixture-server.cjs", "utf8");
    const prereleasePlan = createPluginPrereleaseTestPlan();

    expect(lane).toEqual({
      command: "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:plugins",
      e2eImageKind: "functional",
      live: false,
      name: "plugins",
      resources: ["npm", "service"],
      stateScenario: "empty",
      weight: 6,
    });
    expect(prereleasePlan.surfaces).toContain("external-install-boundary");
    expect(sweepScript).toContain("run_plugins_clawhub_scenario");
    expect(clawhubScript).toContain('plugins install "$CLAWHUB_PLUGIN_SPEC"');
    expect(assertionsScript).toContain("assertClawHubExternalInstallContract");
    expect(fixtureServer).toContain('"is-number": "7.0.0"');
    expect(fixtureServer).toContain('openclaw: ">=2026.4.11"');
    expect(fixtureServer).toContain(
      "const versionPath = `${packagePath}/versions/${fixture.version}`;",
    );
    expect(fixtureServer).toContain("[`${versionPath}/artifact`, artifactResolverDetail]");
  });

  it("forwards validated frozen-target omissions to the selected shard adapters", () => {
    const workflow = readPluginPrereleaseWorkflow();
    const preflight = workflow.jobs.preflight;
    const nodeStep = workflow.jobs["plugin-prerelease-node-shard"].steps.find(
      (step: WorkflowStep) => step.name === "Run release-only plugin Node shard",
    );
    const extensionStep = workflow.jobs["plugin-prerelease-extension-shard"].steps.find(
      (step: WorkflowStep) => step.name === "Run extension shard",
    );
    expect(preflight.outputs.node_test_exclude_patterns_json).toBe(
      "${{ steps.node_test_exclusions.outputs.patterns_json }}",
    );
    expect(nodeStep.env.NODE_TEST_EXCLUDE_PATTERNS_JSON).toBe(
      "${{ needs.preflight.outputs.node_test_exclude_patterns_json }}",
    );
    expect(extensionStep.env.FRV_TEST_EXCLUDE_PATHS_JSON).toBe(
      "${{ needs.preflight.outputs.extension_test_exclude_patterns_json }}",
    );
    expect(extensionStep.run).not.toContain("extensions/codex/src/app-server/run-attempt.test.ts");
  });

  it("gates plugin Docker fanout on full release validation", () => {
    const workflow = readPluginPrereleaseWorkflow();
    const manifest = workflow.jobs.preflight.steps.find(
      (step: WorkflowStep) => step.name === "Build plugin prerelease manifest",
    );
    const dockerSuite = workflow.jobs["plugin-prerelease-docker-suite"];

    expect(workflow.on.workflow_dispatch.inputs.full_release_validation.default).toBe(false);
    expect(manifest.env.FULL_RELEASE_VALIDATION).toBe(
      "${{ inputs.full_release_validation && 'true' || 'false' }}",
    );
    expect(manifest.run).toContain(
      'const fullReleaseValidation = process.env.FULL_RELEASE_VALIDATION === "true";',
    );
    expect(manifest.run).toContain(
      "const runDocker = runCandidate && fullReleaseValidation && dockerLanes.length > 0;",
    );
    expect(dockerSuite.if).toBe(
      "${{ inputs.full_release_validation && needs.preflight.outputs.run_plugin_prerelease_docker == 'true' }}",
    );
    expect(dockerSuite.secrets).toBeUndefined();
  });

  it("requires a complete immutable candidate for the plugin candidate phase", () => {
    const selectedSha = "a".repeat(40);
    const independent = runPluginPhaseValidation({
      candidateArtifactJson: "",
      phase: "independent",
    });
    const missing = runPluginPhaseValidation({
      candidateArtifactJson: "",
      expectedSha: selectedSha,
      phase: "candidate",
    });
    const valid = runPluginPhaseValidation({
      candidateArtifactJson: pluginCandidateArtifactJson(selectedSha),
      expectedSha: selectedSha,
      phase: "candidate",
    });

    expect(independent.status, independent.stderr).toBe(0);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain(
      "phase=candidate requires the complete immutable package and Docker image artifact tuple.",
    );
    expect(valid.status, valid.stderr).toBe(0);
  });

  it("keeps hourly extension coverage with its complete release owner and required result", () => {
    const workflow = readPluginPrereleaseWorkflow();
    const context = {
      eventName: "schedule" as const,
      repository: "openclaw/openclaw",
      ref: "refs/heads/main",
      sha: "a".repeat(40),
      runAttempt: 1,
    };
    const evaluate = (value: string, overrides = {}) =>
      evaluateWorkflowExpression(value.startsWith("${{") ? value : `\${{ ${value} }}`, {
        ...context,
        ...overrides,
      });
    expect(workflow.on.schedule).toEqual([{ cron: "37 * * * *" }]);
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(evaluate(workflow.jobs.resolve_target.if)).toBe(true);
    expect(evaluate(workflow.jobs.resolve_target.if, { repository: "contributor/openclaw" })).toBe(
      false,
    );
    expect(evaluate(workflow.jobs.resolve_target.if, { ref: "refs/heads/topic" })).toBe(false);
    expect(
      evaluate(workflow.jobs["plugin-prerelease-suite"].if, {
        repository: "contributor/openclaw",
        preflightOutputs: {},
      }),
    ).toBe(false);
    const resolver = workflow.jobs.resolve_target.steps.find(
      (step: WorkflowStep) => step.id === "resolve",
    );
    expect(evaluate(resolver.env.TARGET_REF)).toBe(context.sha);
    expect(evaluate(resolver.env.EXPECTED_SHA)).toBe(context.sha);
    expect(evaluate(workflow.concurrency.group)).toBe("plugin-prerelease-hourly-main");
    expect(evaluate(workflow.concurrency.group, { sha: "b".repeat(40) })).toBe(
      "plugin-prerelease-hourly-main",
    );
    expect(evaluate(workflow.concurrency["cancel-in-progress"])).toBe(false);
    const validation = workflow.jobs.preflight.steps.find(
      (step: WorkflowStep) => step.name === "Validate phase inputs",
    );
    expect(evaluate(validation.env.PHASE)).toBe("independent");
    const exclusions = workflow.jobs.preflight.steps.find(
      (step: WorkflowStep) => step.id === "node_test_exclusions",
    );
    expect(evaluate(exclusions.env.NODE_TEST_EXCLUDE_PATTERNS_JSON)).toBe("[]");
    expect(evaluate(exclusions.env.EXTENSION_TEST_EXCLUDE_PATTERNS_JSON)).toBe("[]");
    expect(workflow.jobs["plugin-prerelease-extension-shard"].strategy["max-parallel"]).toBe(12);

    const hourly = runPluginManifest("independent", "schedule");
    const release = runPluginManifest("independent");
    expect(hourly.result.status, hourly.result.stderr).toBe(0);
    expect(release.result.status, release.result.stderr).toBe(0);
    const outputs = (output: string) =>
      Object.fromEntries(
        output
          .trim()
          .split("\n")
          .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
      );
    const selected = outputs(hourly.output);
    const ownership = (matrix: string | undefined) =>
      JSON.parse(expectDefined(matrix, "extension matrix")).include.map(
        ({ requires_bun: _bun, test_runtime_policy: _runtime, ...row }: Record<string, unknown>) =>
          row,
      );
    expect(ownership(selected.plugin_prerelease_extension_matrix)).toEqual(
      ownership(outputs(release.output).plugin_prerelease_extension_matrix),
    );
    const rows: {
      task: string;
      extensions_csv: string;
      includePatterns?: string[];
      exclusion_configs: { config: string; includePatterns: string[] }[];
      requires_bun?: boolean;
      test_runtime_policy?: string;
    }[] = JSON.parse(
      expectDefined(selected.plugin_prerelease_extension_matrix, "hourly extension matrix"),
    ).include;
    expect(
      rows.every((row) => !row.requires_bun && (row.test_runtime_policy ?? "node") === "node"),
    ).toBe(true);
    const extensionIds = new Set(rows.flatMap((row) => row.extensions_csv.split(",")));
    for (const id of ["device-pair", "active-memory", "talk-voice"]) {
      expect(extensionIds, id).toContain(id);
    }
    expect(listAvailableExtensionIds()).toContain("image-generation-core");
    expect(resolveExtensionTestPlan({ targetArg: "image-generation-core" })).toMatchObject({
      hasTests: false,
      testFileCount: 0,
    });
    expect(extensionIds).not.toContain("image-generation-core");
    const fileTargets = rows
      .filter((row) => row.task === "extension-file-shard")
      .flatMap((row) => row.includePatterns ?? []);
    expect(new Set(fileTargets).size).toBe(fileTargets.length);
    const sourceOnlyFile = "extensions/diffs/src/store.cleanup.test.ts";
    expect(fileTargets).not.toContain(sourceOnlyFile);
    for (const file of [sourceOnlyFile, "extensions/plugin-entry.cli-laziness.test.ts"]) {
      const config = resolveExtensionTestConfig(file);
      expect(
        rows.filter((row) =>
          row.exclusion_configs.some(
            (group) =>
              group.config === config &&
              group.includePatterns.some((pattern) => matchesGlob(file, pattern)),
          ),
        ),
        file,
      ).toHaveLength(1);
    }
    expect(
      rows.filter((row) =>
        row.includePatterns?.includes("extensions/plugin-entry.cli-laziness.test.ts"),
      ),
    ).toEqual([
      expect.objectContaining({
        task: "extension-file-shard",
        vitest_config: "test/vitest/vitest.extensions.config.ts",
      }),
    ]);
    expect(selected.run_plugin_prerelease_extensions).toBe("true");
    expect(selected.run_plugin_prerelease_suite).toBe("true");
    for (const family of ["static", "node", "inspector", "docker"]) {
      expect(selected[`run_plugin_prerelease_${family}`]).toBe("false");
    }
    for (const result of ["success", "failure", "cancelled", "skipped"]) {
      const summary = runPluginSummary({
        docker: "skipped",
        extensions: result,
        node: "skipped",
        static: "skipped",
        runDocker: false,
        runExtensions: true,
        runNode: false,
        runNpmSecurity: false,
        runStatic: false,
      });
      expect(summary.status).toBe(result === "success" ? 0 : 1);
    }
  });

  it("keeps exact release tuples independent without cancelling adopted children", () => {
    const releaseChecksWorkflow = parse(
      readFileSync(".github/workflows/openclaw-release-checks.yml", "utf8"),
    );
    const fullReleaseWorkflow = readFullReleaseValidationWorkflow();

    expect(releaseChecksWorkflow.concurrency).toEqual({
      group:
        "openclaw-release-checks-${{ inputs.expected_sha || inputs.ref }}-${{ github.sha }}-${{ inputs.rerun_group }}-${{ inputs.phase }}-${{ inputs.release_profile == 'minimum' && 'beta' || inputs.release_profile }}-${{ inputs.run_release_soak || inputs.release_profile == 'stable' || inputs.release_profile == 'full' }}",
      "cancel-in-progress": false,
    });
    expect(readPluginPrereleaseWorkflow().concurrency).toEqual({
      group:
        "${{ github.event_name == 'schedule' && 'plugin-prerelease-hourly-main' || format('plugin-prerelease-{0}-{1}-{2}', inputs.target_ref, github.sha, inputs.phase) }}",
      "cancel-in-progress": "${{ github.event_name != 'schedule' && inputs.target_ref == 'main' }}",
    });
    expect(fullReleaseWorkflow.concurrency).toEqual({
      group:
        "full-release-validation-${{ inputs.expected_sha || inputs.ref }}-${{ github.sha }}-${{ inputs.rerun_group }}-${{ inputs.release_profile == 'minimum' && 'beta' || inputs.release_profile }}-${{ inputs.run_release_soak || inputs.release_profile == 'stable' || inputs.release_profile == 'full' }}",
      "cancel-in-progress": false,
    });
    for (const workflow of [fullReleaseWorkflow, releaseChecksWorkflow]) {
      const coverageKey = (profile: string, soak: boolean) =>
        workflow.concurrency.group.replace(
          /\$\{\{\s*([\s\S]*?)\s*\}\}/gu,
          (_: string, expression: string) =>
            String(
              runInNewContext(expression, {
                github: { sha: "a".repeat(40) },
                inputs: {
                  expected_sha: "b".repeat(40),
                  rerun_group: "all",
                  phase: "candidate",
                  release_profile: profile,
                  run_release_soak: soak,
                },
              }),
            ),
        );
      expect(
        new Set([
          coverageKey("beta", false),
          coverageKey("beta", true),
          coverageKey("stable", false),
          coverageKey("full", false),
        ]).size,
      ).toBe(4);
      expect(coverageKey("minimum", false)).toBe(coverageKey("beta", false));
      for (const profile of ["stable", "full"]) {
        expect(coverageKey(profile, false)).toBe(coverageKey(profile, true));
      }
    }
    expect(fullReleaseWorkflow.on.workflow_dispatch.inputs.expected_sha).toEqual({
      description: "Optional full Validation SHA that ref must resolve to",
      required: false,
      default: "",
      type: "string",
    });
    const resolveTargetStep = fullReleaseWorkflow.jobs.resolve_target.steps.find(
      (step: WorkflowStep) => step.name === "Resolve target SHA",
    );
    const targetSummaryStep = fullReleaseWorkflow.jobs.resolve_target.steps.find(
      (step: WorkflowStep) => step.name === "Summarize target",
    );
    expect(resolveTargetStep.env?.EXPECTED_SHA).toBe("${{ inputs.expected_sha }}");
    expect(resolveTargetStep.run).toContain('--expected-sha "$EXPECTED_SHA"');
    expect(targetSummaryStep.run).toContain("- Validation SHA:");
    expect(targetSummaryStep.run).not.toContain("- Code SHA:");
    expect(evaluateWorkflowRunner(releaseChecksWorkflow.jobs.resolve_target["runs-on"])).toBe(
      "ubuntu-24.04",
    );
    expect(
      evaluateWorkflowRunner(releaseChecksWorkflow.jobs.prepare_release_package["runs-on"]),
    ).toBe("ubuntu-24.04");
    expect(evaluateWorkflowRunner(releaseChecksWorkflow.jobs.summary["runs-on"])).toBe(
      "ubuntu-24.04",
    );
    for (const jobName of [
      "normal_ci",
      "plugin_prerelease_independent",
      "plugin_prerelease_candidate",
      "npm_telegram",
      "summary",
    ]) {
      expect(evaluateWorkflowRunner(fullReleaseWorkflow.jobs[jobName]["runs-on"])).toBe(
        "ubuntu-24.04",
      );
    }
    expect(fullReleaseWorkflow.jobs.normal_ci["timeout-minutes"]).toBe(15);
    expect(fullReleaseWorkflow.jobs.normal_ci.needs).toEqual([
      "resolve_target",
      "plugin_compatibility_readiness",
      "evidence_reuse",
    ]);
    expect(fullReleaseWorkflow.jobs.normal_ci.if).toContain(
      "needs.resolve_target.result == 'success'",
    );
    expect(fullReleaseWorkflow.jobs.normal_ci.if).toContain(
      "needs.evidence_reuse.outputs.reuse != 'true'",
    );
    for (const jobName of [
      "plugin_prerelease_independent",
      "plugin_prerelease_candidate",
      "release_checks_independent",
      "release_checks_candidate",
      "npm_telegram",
      "performance",
    ]) {
      expect(fullReleaseWorkflow.jobs[jobName]["timeout-minutes"], jobName).toBe(15);
    }
    const fullReleaseSource = readFileSync(".github/workflows/full-release-validation.yml", "utf8");
    expect(fullReleaseWorkflow.on.workflow_dispatch.inputs.fail_fast).toEqual({
      description:
        "Cancel only an exact active child after its first blocking job; false drains all children and permits same-parent recovery",
      required: false,
      default: false,
      type: "boolean",
    });
    for (const [jobName, kind] of [
      ["normal_ci", "ci"],
      ["plugin_prerelease_independent", "plugin-prerelease"],
      ["plugin_prerelease_candidate", "plugin-prerelease"],
      ["release_checks_independent", "release-checks"],
      ["release_checks_candidate", "release-checks"],
      ["npm_telegram", "npm-telegram"],
    ] as const) {
      const dispatch = expectDefined(
        fullReleaseWorkflow.jobs[jobName].steps.find(
          (step: WorkflowStep) => step.id === "dispatch",
        ) as WorkflowStep | undefined,
        `${jobName} dispatch step`,
      );
      expect(dispatch.env?.CHILD_WORKFLOW_KIND).toBe(kind);
      if (jobName.startsWith("release_checks_")) {
        expect(dispatch.env?.FAIL_FAST).toBe("${{ inputs.fail_fast }}");
        expect(dispatch.run).toContain('-f fail_fast="$FAIL_FAST"');
      } else {
        expect(dispatch.env).not.toHaveProperty("FAIL_FAST");
      }
    }
    expect(
      fullReleaseWorkflow.jobs.performance.steps.find(
        (step: WorkflowStep) => step.id === "dispatch",
      )?.env,
    ).not.toHaveProperty("FAIL_FAST");
    expect(fullReleaseSource).toContain('-f fail_fast="$FAIL_FAST"');
    expect(fullReleaseSource).not.toContain(
      "has failed child jobs before the workflow completed; cancelling the remaining run.",
    );
    expect(fullReleaseSource).not.toContain("trap cancel_child");
    expect(fullReleaseSource).not.toContain("cancel_child_on_failure");
    expect(fullReleaseSource).not.toContain("exit_on_parent_signal");
    expect(fullReleaseSource).not.toContain("disable_child_cleanup");
    expect(fullReleaseSource).not.toContain("cancel_child");
    expect(fullReleaseSource).toContain(
      'if [[ "$child_head_sha" != "$PARENT_WORKFLOW_SHA" ]]; then',
    );
    expect(releaseChecksWorkflow.on.workflow_dispatch.inputs.fail_fast).toEqual({
      description: "Stop the Matrix QA lane after its first failed check or scenario",
      required: false,
      default: false,
      type: "boolean",
    });
    expect(releaseChecksWorkflow.jobs.qa_live_release_checks.with.fail_fast).toBe(
      "${{ fromJSON(needs.resolve_target.outputs.fail_fast) }}",
    );
    const qaLiveSource = readFileSync(".github/workflows/qa-live-transports-convex.yml", "utf8");
    expect(qaLiveSource).toContain('if [[ "$FAIL_FAST" == "true" ]]');
  });

  it("allows Unreleased notes only for current-tree release checks", () => {
    const workflow = parse(readFileSync(".github/workflows/openclaw-release-checks.yml", "utf8"));
    const fullReleaseWorkflow = readFullReleaseValidationWorkflow();
    const resolveTarget = workflow.jobs.resolve_target;
    const captureInputs = resolveTarget.steps.find(
      (step: WorkflowStep) => step.name === "Capture selected inputs",
    );
    const currentTreeAllowance =
      "${{ needs.resolve_target.outputs.allow_unreleased_changelog == 'true' }}";

    expect(workflow.on.workflow_dispatch.inputs.allow_unreleased_changelog).toEqual({
      default: false,
      description: "Allow explicitly opted-in current-tree packaging to use Unreleased notes",
      required: false,
      type: "boolean",
    });
    expect(resolveTarget.outputs.allow_unreleased_changelog).toBe(
      "${{ steps.inputs.outputs.allow_unreleased_changelog }}",
    );
    expect(captureInputs?.run).toContain('RELEASE_REF_INPUT" == "main"');
    expect(captureInputs?.run).toContain('RELEASE_REF_INPUT" == "refs/heads/main"');
    expect(captureInputs?.run).toContain("release/[0-9]{4}");
    expect(captureInputs?.run).toContain("extended-stable/[0-9]{4}");
    expect(captureInputs?.run).toContain("refs/tags/");
    expect(captureInputs?.run).toContain("RELEASE_ALLOW_UNRELEASED_CHANGELOG_INPUT");
    expect(captureInputs?.run).toContain("allow_unreleased_changelog=false");
    const explicitOptIn = captureInputs?.run.indexOf('"$allow_unreleased_changelog" == "true"');
    const releaseRefGuard = captureInputs?.run.indexOf(
      '"$RELEASE_REF_INPUT" =~ ^(refs/heads/)?(release/',
    );
    expect(explicitOptIn).toBeGreaterThanOrEqual(0);
    expect(releaseRefGuard).toBeGreaterThan(explicitOptIn ?? -1);
    expect(workflow.jobs.install_smoke_release_checks.with.allow_unreleased_changelog).toBe(
      currentTreeAllowance,
    );
    expect(workflow.jobs.live_repo_e2e_release_checks.with.allow_unreleased_changelog).toBe(
      currentTreeAllowance,
    );
    expect(workflow.jobs.docker_e2e_release_checks.with.allow_unreleased_changelog).toBe(
      currentTreeAllowance,
    );
    const fullReleaseAllowance =
      "${{ inputs.allow_unreleased_changelog || (inputs.target_context_ref == '' && (inputs.ref == 'main' || inputs.ref == 'refs/heads/main')) }}";
    const summarizeTarget = fullReleaseWorkflow.jobs.resolve_target.steps.find(
      (step: WorkflowStep) => step.name === "Summarize target",
    );
    const releaseChecksDispatch = fullReleaseWorkflow.jobs.release_checks_candidate.steps.find(
      (step: WorkflowStep) => step.name === "Dispatch release checks candidate phase",
    );
    expect(summarizeTarget?.env?.ALLOW_UNRELEASED_CHANGELOG).toBe(fullReleaseAllowance);
    expect(releaseChecksDispatch?.env?.ALLOW_UNRELEASED_CHANGELOG).toBe(fullReleaseAllowance);
  });

  it("keeps runtime tool coverage blocking in release checks", () => {
    const releaseChecksSource = readFileSync(
      ".github/workflows/openclaw-release-checks.yml",
      "utf8",
    );
    const releaseChecksWorkflow = parse(releaseChecksSource);
    const runtimeToolCoverage = releaseChecksWorkflow.jobs.runtime_tool_coverage_release_checks;

    expect(runtimeToolCoverage["continue-on-error"]).toBeUndefined();
    expect(runtimeToolCoverage.needs).toEqual([
      "resolve_target",
      "qa_lab_runtime_parity_release_checks",
    ]);
    expect(runtimeToolCoverage.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "Enforce core runtime tool coverage",
          run: expect.stringContaining("pnpm openclaw qa coverage"),
        }),
      ]),
    );
    expect(runtimeToolCoverage.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "Enforce core runtime tool coverage",
          run: expect.stringContaining(
            "--summary .artifacts/qa-e2e/runtime-pair-core/qa-suite-summary.json",
          ),
        }),
      ]),
    );
    expect(releaseChecksWorkflow.jobs.summary.needs).toContain(
      "runtime_tool_coverage_release_checks",
    );
    const verifyStep = releaseChecksWorkflow.jobs.summary.steps.find(
      (step: { name?: string }) => step.name === "Verify release check results",
    );
    expect(verifyStep.env.RUNTIME_TOOL_COVERAGE_RELEASE_CHECKS_RESULT).toBe(
      "${{ needs.runtime_tool_coverage_release_checks.result }}",
    );
    expect(verifyStep.run).toContain(
      '"runtime_tool_coverage_release_checks=${RUNTIME_TOOL_COVERAGE_RELEASE_CHECKS_RESULT}"',
    );
  });

  it("keeps the live-ish availability check redacted", () => {
    const output = execFileSync(
      process.execPath,
      ["--import", "tsx", "scripts/plugin-prerelease-liveish-matrix.mts"],
      {
        encoding: "utf8",
        env: {
          DISCORD_TOKEN: "discord-token-should-not-print",
          OPENAI_API_KEY: "openai-token-should-not-print",
        },
      },
    );

    expect(output).toContain("provider-openai: present (OPENAI_API_KEY, OPENAI_BASE_URL)");
    expect(output).toContain("channel-discord: present (DISCORD_TOKEN, OPENCLAW_DISCORD_TOKEN)");
    expect(output).not.toContain("openai-token-should-not-print");
    expect(output).not.toContain("discord-token-should-not-print");
  });
});
