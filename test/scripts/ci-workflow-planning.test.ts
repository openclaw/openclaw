import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expectDefined } from "@openclaw/normalization-core";
import { minimatch } from "minimatch";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  detectChangedScope,
  detectNodeFastScope,
  shouldRunNativeI18n,
  writeGitHubOutput,
} from "../../scripts/ci-changed-scope.mjs";
import { resolveShardPlans } from "../../scripts/ci-run-node-test-shard.mts";
import {
  decodeNodeTestGroups,
  encodeNodeTestGroups,
} from "../../scripts/lib/ci-node-test-groups-codec.mts";
import { createNodeTestShardBundles } from "../../scripts/lib/ci-node-test-plan.mts";
import {
  BOUNDARY_CHECKS,
  selectChecksForShard,
} from "../../scripts/run-additional-boundary-checks.mts";
import { buildVitestRunPlans } from "../../scripts/test-projects.test-support.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import {
  startupCorpusTestFiles,
  stateStartupCorpusTestFiles,
} from "../vitest/vitest.startup-corpus-paths.mjs";
import { assertStartupCorpusCommand } from "./ci-startup-corpus.test-support.js";
import {
  AMBIGUOUS_MAIN_PUSH_DIAGNOSTIC,
  CACHE_SAVE_V5,
  CACHE_V5,
  SETUP_GO_V6,
  UPLOAD_ARTIFACT_V7,
  evaluateWorkflowExpression,
  quoteShell,
  readAndroidToolchainAction,
  readBuildArtifactsTestboxWorkflow,
  readCiWorkflow,
  readTrackedText,
  readWorkflow,
  readWorkflowOutputs,
  runGit,
  runWorkflowShellScript,
  testNodeExecPath,
  type WorkflowStep,
  writeExecutable,
} from "./ci-workflow.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function runCiGateFixture(jobResults: string, env: Record<string, string> = {}) {
  const gateStep = readCiWorkflow().jobs["ci-gate"].steps.find(
    (step: WorkflowStep) => step.name === "Verify selected CI lanes",
  );
  // Homebrew Bash 5.3 can block writing this here-string before its reader starts.
  const bash = process.platform === "darwin" ? "/bin/bash" : "bash";
  return spawnSync(bash, ["-c", gateStep.run], {
    encoding: "utf8",
    env: {
      ...process.env,
      JOB_RESULTS: jobResults,
      ...env,
    },
  });
}

function renderCiGateEnvironment(
  context: Partial<Parameters<typeof evaluateWorkflowExpression>[1]> = {},
  results: Record<string, string> = {},
) {
  const workflow = readCiWorkflow();
  const step = workflow.jobs["ci-gate"].steps.find(
    (candidate: WorkflowStep) => candidate.name === "Verify selected CI lanes",
  );
  const preflightOutputs = {
    ...Object.fromEntries(
      Object.keys(workflow.jobs.preflight.outputs)
        .filter((key) => key.startsWith("run_"))
        .map((key) => [key, "true"]),
    ),
    compatibility_target: "false",
    release_scope: "full",
    ...context.preflightOutputs,
  };
  const jobResults: string = step.env.JOB_RESULTS;
  return jobResults.replace(/\$\{\{[\s\S]*?\}\}/gu, (expression) => {
    const result = expression.match(/^\$\{\{\s*needs\.([\w-]+)\.result\s*\}\}$/u);
    if (result) {
      return results[expectDefined(result[1], expression)] ?? "success";
    }
    return String(
      evaluateWorkflowExpression(expression, {
        eventName: "workflow_dispatch",
        repository: "openclaw/openclaw",
        runAttempt: 1,
        ...context,
        preflightOutputs,
      }) ?? "",
    );
  });
}

function runPreflightNodeInvocation(
  script: string,
  options: {
    checkoutRevision: string;
    eventName: "pull_request" | "push" | "workflow_dispatch";
    workflowRevision: string;
  },
) {
  const root = tempDirs.make("openclaw-preflight-runtime-");
  const binDir = path.join(root, "bin");
  const argsPath = path.join(root, "node-args");
  mkdirSync(binDir, { recursive: true });
  const nodePath = path.join(binDir, "node");
  writeFileSync(
    nodePath,
    '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$OPENCLAW_NODE_ARGS"\ncat >/dev/null\n',
  );
  chmodSync(nodePath, 0o755);
  // Avoid Darwin Bash 5.3 heredoc deadlocks while preserving the PATH node spy.
  const bash = process.platform === "darwin" ? "/bin/bash" : "bash";
  const result = spawnSync(bash, ["-c", script], {
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_EVENT_NAME: options.eventName,
      OPENCLAW_CI_CHECKOUT_REVISION: options.checkoutRevision,
      OPENCLAW_CI_WORKFLOW_REVISION: options.workflowRevision,
      OPENCLAW_NODE_ARGS: argsPath,
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    },
  });
  expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
  return readFileSync(argsPath, "utf8").trim().split("\n");
}

function runCiChangedScopeFixture(changedPaths: string[]): Record<string, string> {
  const outputPath = path.join(tempDirs.make("openclaw-ci-scope-"), "scope.out");
  writeGitHubOutput(
    detectChangedScope(changedPaths),
    outputPath,
    undefined,
    detectNodeFastScope(changedPaths),
    shouldRunNativeI18n(changedPaths),
    changedPaths,
  );
  return Object.fromEntries(
    readFileSync(outputPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

function runCiManifestFixture(options: {
  bundledPlanner: boolean;
  nodeTestShards?: Record<string, unknown>[];
  nodeTestGroupsCodec?: boolean;
  bunTestRuntime?: boolean;
  bunUiTestRuntime?: boolean | "requires-ftl-flag";
  startupCorpusCoverage?: boolean;
  startupCorpusSelection?: boolean;
  changedPlannerSource?: string | null;
  changedPlannerDependencies?: string[];
  dockerSeedPlannerSource?: string;
  changedPaths?: string[] | null;
  changedCoreTestSupport?: boolean;
  repository?: string;
  eventName?: "pull_request" | "push" | "workflow_dispatch";
  historicalCompatibility?: boolean;
  iosCapabilities?: boolean;
  iosBuildCapability?: boolean;
  androidCiCapabilities?: boolean;
  nativeI18nCapabilities?: boolean;
  macosNodeParts?: boolean;
  windowsPlanner?: boolean;
  openClawKitTests?: boolean;
  protocolCoverage?: boolean;
  packageVersion?: string;
  qaSmokePlan?: boolean;
  formatCheck?: boolean;
  releaseCandidateCompatibility?: boolean;
  releaseGate?: boolean;
  targetContextCompatibility?: boolean;
  nodeFastOnly?: boolean;
  nodeFastPluginContracts?: boolean;
  nodeFastCiRouting?: boolean;
  runNode?: boolean;
  historicalReader?: boolean;
  toolingOwnerSelection?: boolean;
  runnerBackend?: "blacksmith" | "github" | "hybrid" | "runson";
  nodeRunnerBackend?: "blacksmith" | "github" | "hybrid" | "runson";
  runnerProfile?: "blacksmith" | "github" | "hybrid";
  targetHostedRunnerProfileContract?: boolean;
  uiE2eProjectsCapability?: boolean;
  uiReleaseTier?: boolean;
  uiRealGatewayShards?: boolean;
  remoteTagRefs?: Record<string, string>;
  scopeEnv?: Record<string, string>;
}) {
  const root = mkdtempSync(path.join(tmpdir(), "openclaw-ci-manifest-"));
  try {
    const scriptsDir = path.join(root, "scripts", "lib");
    mkdirSync(scriptsDir, { recursive: true });
    if (options.bunTestRuntime) {
      writeFileSync(
        path.join(scriptsDir, "ci-test-runtime.mts"),
        `${options.bunUiTestRuntime ? `import { ciTestShardRequiresBun as currentRuntime } from ${JSON.stringify(pathToFileURL(path.resolve("scripts/lib/ci-test-runtime.mts")).href)};` : ""}
        export const ciTestShardRequiresBun = (shard, policy) =>
          policy !== "node" && (shard.configs?.includes("fixture-bun.config.ts") ||
            ${options.bunUiTestRuntime === "requires-ftl-flag" ? 'shard.env?.BUN_JSC_useFTLJIT === "false" &&' : ""}
            ${options.bunUiTestRuntime ? `currentRuntime(shard, policy, ${JSON.stringify(process.cwd())})` : "false"});`,
      );
    }
    for (const dependency of options.changedPlannerDependencies ?? []) {
      const destination = path.join(root, dependency);
      mkdirSync(path.dirname(destination), { recursive: true });
      writeFileSync(destination, readFileSync(dependency));
    }
    // The manifest packs grouped Node rows through the target's codec and the
    // shard runner unpacks them; targets that predate the codec omit it.
    if (options.nodeTestGroupsCodec ?? true) {
      writeFileSync(
        path.join(scriptsDir, "ci-node-test-groups-codec.mts"),
        readFileSync("scripts/lib/ci-node-test-groups-codec.mts"),
      );
    }
    writeFileSync(
      path.join(scriptsDir, "ci-node-test-plan.mts"),
      options.nodeTestShards
        ? `export const createNodeTestShards = () => ${JSON.stringify(options.nodeTestShards)};
           export const createNodeTestShardBundles = createNodeTestShards;`
        : options.bundledPlanner
          ? `
          export const createNodeTestShards = () => [{
            checkName: "legacy-node-plan",
            configs: ["test/vitest/legacy.config.ts"],
            requiresDist: false,
            runner: "ubuntu-24.04",
            shardName: "legacy-node-plan",
          }];
          export const createNodeTestShardBundles = (options = {}) => {
            console.log("node-test-plan-options:" + JSON.stringify(options));
            const runson = options.runnerBackend === "runson";
            return [{
              checkName: runson ? "checks-node-changed-runson-cron" : "bundled-node-plan",
              ...(runson ? {
                groups: [{
                  configs: ["test/vitest/vitest.cron.config.ts"],
                  includePatterns: ["src/cron/schedule.test.ts"],
                  env: { OPENCLAW_VITEST_MAX_WORKERS: "2" },
                  shard_name: "core-runtime-cron-parallel-core",
                }],
              } : {
                configs: ["test/vitest/bundled.config.ts"],
                includePatterns: options.changedPaths,
              }),
              env: {
                ...(runson ? { OPENCLAW_VITEST_MAX_WORKERS: "2" } : {}),
                OPENCLAW_CI_TEST_COMPACT_MODE: options.compactMode ?? "full",
                OPENCLAW_CI_TEST_COMPACT_NODE_JOB_CAP: String(options.compactNodeJobCap ?? ""),
                OPENCLAW_CI_TEST_RUNNER_BACKEND: options.runnerBackend ?? "",
                OPENCLAW_CI_TEST_PROOF_TIER: String(options.includeProofTests),
              },
              requiresDist: false,
              runner: runson ? "runson-c8i-8xlarge" : "ubuntu-24.04",
              shardName: runson ? "changed-runson-cron" : "bundled-node-plan",
            }];
          };
        `
          : `
          export const createNodeTestShards = () => [{
            checkName: "legacy-node-plan",
            configs: ["test/vitest/legacy.config.ts"],
            requiresDist: false,
            runner: "ubuntu-24.04",
            shardName: "legacy-node-plan",
          }];
        `,
      "utf8",
    );
    if (options.windowsPlanner ?? options.bundledPlanner) {
      writeFileSync(
        path.join(scriptsDir, "ci-windows-test-plan.mts"),
        `\nexport const createWindowsTestShards = () => Array.from({ length: 5 }, (_, index) => ({
          check_name: "checks-windows-node-test-" + (index + 1),
          targets: ["test/windows-part-" + (index + 1) + ".test.ts"],
          predicted_seconds: 400,
        }));\n`,
      );
    }
    if (options.toolingOwnerSelection) {
      appendFileSync(
        path.join(scriptsDir, "ci-node-test-plan.mts"),
        `\nexport { isToolingTestOwnerPath } from ${JSON.stringify(pathToFileURL(path.resolve("scripts/lib/ci-node-test-plan.mts")).href)};\n`,
      );
    }
    if (options.uiReleaseTier) {
      appendFileSync(
        path.join(scriptsDir, "ci-node-test-plan.mts"),
        `\nexport const createUiTestShardGroups = (options) => ({
          ui: [{configs: ["ui/vitest.config.ts"], shard_name: "ui", env: {fixtureTier: JSON.stringify(options)}}],
          e2e: [{configs: ["test/vitest/vitest.ui-e2e.config.ts"], shard_name: "e2e", env: {fixtureTier: JSON.stringify(options)}}],
        });\n`,
      );
      if (options.uiRealGatewayShards !== false) {
        appendFileSync(
          path.join(scriptsDir, "ci-node-test-plan.mts"),
          `\nexport const createUiRealGatewayTestShards = (groups) => [1, 2].map((shard) => ({
            shard,
            shard_count: 2,
            run_desktop: shard === 1,
            groups: groups.map((group) => ({
              ...group,
              configs: ["test/vitest/vitest.ui-e2e-prebuilt.config.ts"],
              shard_name: "real-gateway-" + shard,
              includePatterns: ["ui/src/e2e/fixture-" + shard + ".real-gateway.e2e.test.ts"],
            })),
          }));\n`,
        );
      }
    }
    if (options.startupCorpusCoverage) {
      appendFileSync(
        path.join(scriptsDir, "ci-node-test-plan.mts"),
        `\nexport { hasCompleteStartupCorpusCoverage } from ${JSON.stringify(pathToFileURL(path.resolve("scripts/lib/ci-node-test-plan.mts")).href)};\n`,
      );
    }
    if (options.startupCorpusSelection ?? options.startupCorpusCoverage) {
      appendFileSync(
        path.join(scriptsDir, "ci-node-test-plan.mts"),
        `\nexport { resolveStartupCorpusTestFiles } from ${JSON.stringify(pathToFileURL(path.resolve("scripts/lib/ci-node-test-plan.mts")).href)};\n`,
      );
      for (const file of startupCorpusTestFiles) {
        const target = path.join(root, file);
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, "export {};\n");
      }
    }
    if (options.changedCoreTestSupport) {
      for (const file of [
        "scripts/changed-lanes.mts",
        "scripts/lib/changed-path-facts.mjs",
        "scripts/lib/release-changelog.mjs",
        "scripts/lib/arg-utils.mts",
        "scripts/lib/arg-utils.runtime.mjs",
        "scripts/lib/direct-run.mjs",
        "scripts/lib/merge-head-diff-base.mjs",
        "scripts/lib/record-shared.mjs",
        "scripts/lib/tsgo-core-test-shards.mts",
        "packages/normalization-core/src/stable-stringify.ts",
        "scripts/run-tsgo-core-test-shards.mts",
        "scripts/run-additional-boundary-checks.mts",
      ]) {
        const target = path.join(root, file);
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, readFileSync(file));
      }
    }
    const iosCapabilities = options.iosCapabilities ?? options.bundledPlanner;
    const iosBuildCapability = options.iosBuildCapability ?? iosCapabilities;
    const nativeI18nCapabilities = options.nativeI18nCapabilities ?? options.bundledPlanner;
    const macosNodeParts = options.macosNodeParts ?? options.bundledPlanner;
    const packageScripts = options.bundledPlanner
      ? {
          ...(nativeI18nCapabilities
            ? {
                "android:i18n:check": "true",
                "apple:i18n:check": "true",
                "native:i18n:check": "true",
              }
            : {}),
          ...(iosBuildCapability ? { "ios:build": "true" } : {}),
          ...(macosNodeParts
            ? Object.fromEntries([1, 2, 3].map((part) => [`test:macos:ci:${part}`, "true"]))
            : {}),
          "check:assertion-safety": "true",
          "check:max-lines-ratchet": "true",
        }
      : {};
    writeFileSync(
      path.join(root, "package.json"),
      `${JSON.stringify({ version: options.packageVersion, scripts: packageScripts })}\n`,
    );
    if (options.bundledPlanner && options.changedPlannerSource !== null) {
      writeFileSync(
        path.join(scriptsDir, "ci-changed-node-test-plan.mts"),
        options.changedPlannerSource ??
          `
          export const createChangedNodeTestShards = (changedPaths) =>
            changedPaths.includes("src/focused.ts") ||
            changedPaths.includes("test/scripts/sqlite-sessions-transcripts-flip-proof.built-cli.e2e.test.ts")
              ? [{
                  checkName: "changed-node-plan",
                  configs: [],
                  requiresDist: false,
                  runner: "ubuntu-24.04",
                  shardName: "changed-node-plan",
                  targets: changedPaths.includes("src/focused.ts")
                    ? ["src/focused.test.ts"]
                    : ["test/scripts/sqlite-sessions-transcripts-flip-proof.built-cli.e2e.test.ts"],
                }]
              : null;
          export const createChangedExtensionFallbackShards = (changedPaths) =>
            changedPaths.some((changedPath) => changedPath.startsWith("extensions/"))
              ? changedPaths.some((changedPath) => changedPath.startsWith("extensions/matrix/"))
                ? [{
                    checkName: "changed-extension-fallback-plan",
                    configs: ["test/vitest/vitest.extension-matrix.config.ts"],
                    includePatterns: [
                      "extensions/matrix/src/client.test.ts",
                      "extensions/matrix/src/monitor.test.ts",
                    ],
                    requiresDist: false,
                    runner: "ubuntu-24.04",
                    shardName: "changed-extension-fallback-plan",
                    predictedSeconds: 120,
                  }]
                : [{
                  checkName: "changed-extension-fallback-plan",
                  configs: [],
                  requiresDist: false,
                  runner: "ubuntu-24.04",
                  shardName: "changed-extension-fallback-plan",
                  predictedSeconds: 120,
                  targets: ["extensions/codex/src/focused.test.ts"],
                }]
              : [];
          export const hasBuildArtifactAffectingChange = (changedPaths) =>
            !changedPaths.includes("test/scripts/sqlite-sessions-transcripts-flip-proof.built-cli.e2e.test.ts");
          export const hasSqliteSessionLifecycleAffectingChange = (changedPaths) =>
            changedPaths.includes("src/sqlite-session-owner.ts") ||
            changedPaths.includes("test/scripts/sqlite-sessions-transcripts-flip-proof.built-cli.e2e.test.ts");
        `,
        "utf8",
      );
    }
    if (options.bundledPlanner) {
      writeFileSync(
        path.join(scriptsDir, "ci-docker-seed-plan.mts"),
        options.dockerSeedPlannerSource ?? readFileSync("scripts/lib/ci-docker-seed-plan.mts"),
      );
      const sqliteLifecycleProof = path.join(
        root,
        "test/scripts/sqlite-sessions-transcripts-flip-proof.built-cli.e2e.test.ts",
      );
      mkdirSync(path.dirname(sqliteLifecycleProof), { recursive: true });
      writeFileSync(sqliteLifecycleProof, "export {};\n");
      writeFileSync(
        path.join(scriptsDir, "channel-contract-test-plan.mts"),
        `export const createChannelContractTestShards = () => ["a", "b"].map((suffix) => ({
          checkName: "channel-contracts-" + suffix,
          includePatterns: ["src/channels/plugins/contracts/fixture-" + suffix + ".test.ts"],
          runtime: "node",
          task: "contracts-channels",
        }));\n`,
      );
      writeFileSync(
        path.join(scriptsDir, "plugin-contract-test-plan.mts"),
        `export const createPluginContractTestShards = () => ["a", "b"].map((suffix) => ({
          checkName: "plugin-contracts-" + suffix,
          includePatterns: ["src/plugins/contracts/fixture-" + suffix + ".test.ts"],
          runtime: "node",
          task: "contracts-plugins",
        }));\n`,
      );
    }
    if (options.qaSmokePlan ?? options.bundledPlanner) {
      const smokePlan = path.join(root, "extensions", "qa-lab", "src", "ci-smoke-plan.ts");
      mkdirSync(path.dirname(smokePlan), { recursive: true });
      writeFileSync(smokePlan, "export {};\n");
    }
    if (iosCapabilities) {
      for (const name of [
        "install-swift-tools.sh",
        "install-xcodegen.sh",
        "lint-swift.sh",
        "format-swift.sh",
      ]) {
        writeFileSync(path.join(root, "scripts", name), "#!/bin/sh\n");
      }
    }
    if (options.protocolCoverage ?? options.bundledPlanner) {
      writeFileSync(path.join(root, "scripts", "check-protocol-event-coverage.mjs"), "");
    }
    const targetWorkflow = path.join(root, ".github", "workflows", "ci.yml");
    mkdirSync(path.dirname(targetWorkflow), { recursive: true });
    writeFileSync(
      targetWorkflow,
      [
        ...((options.formatCheck ?? options.bundledPlanner)
          ? ["pnpm format:check", "pnpm format:check"]
          : []),
        ...((options.androidCiCapabilities ?? options.bundledPlanner)
          ? ["android-ci-contract-v2"]
          : []),
        ...((options.openClawKitTests ?? options.bundledPlanner)
          ? ["openclawkit-tests-contract-v1"]
          : []),
        ...(options.bundledPlanner ? ["docker-seed-e2e-contract-v1"] : []),
        ...((options.targetHostedRunnerProfileContract ?? options.bundledPlanner)
          ? ["hosted-runner-profile-contract-v1"]
          : []),
      ].join("\n"),
    );
    const uiE2eConfig = path.join(root, "test", "vitest", "vitest.ui-e2e.config.ts");
    mkdirSync(path.dirname(uiE2eConfig), { recursive: true });
    writeFileSync(
      uiE2eConfig,
      (options.uiE2eProjectsCapability ?? options.bundledPlanner)
        ? "// ui-e2e-projects-contract-v1\n"
        : 'export default { test: { name: "ui-e2e" } };\n',
    );
    const outputPath = path.join(root, "manifest.out");
    const summaryPath = path.join(root, "summary.md");
    const gitOwner = ".github/actions/git-owner";
    const trustedGitOwner = path.join(root, ".ci-harness", gitOwner);
    mkdirSync(trustedGitOwner, { recursive: true });
    for (const name of ["test-prerequisites.mjs", "test-prerequisites.json"]) {
      writeFileSync(path.join(trustedGitOwner, name), readFileSync(path.join(gitOwner, name)));
    }
    const trustedReleasePolicy = path.join(root, ".ci-harness/scripts/lib");
    mkdirSync(trustedReleasePolicy, { recursive: true });
    for (const name of ["release-context.mjs", "release-version.mjs"]) {
      writeFileSync(path.join(trustedReleasePolicy, name), readFileSync(`scripts/lib/${name}`));
    }
    copyFileSync(
      path.join(scriptsDir, "ci-node-test-plan.mts"),
      path.join(trustedReleasePolicy, "ci-node-test-plan.mts"),
    );
    const fixtureBin = path.join(root, "bin");
    let correctionBaseSha = "";
    if (options.remoteTagRefs) {
      mkdirSync(fixtureBin);
      const ghFixture = path.join(root, "gh.mjs");
      writeFileSync(
        ghFixture,
        `
        const [command, endpoint, queryFlag, query] = process.argv.slice(2);
        const baseRef = ${JSON.stringify(`refs/tags/v${options.packageVersion}`)};
        if (process.env.GH_TOKEN !== "test-token" || command !== "api" ||
            endpoint !== "repos/openclaw/openclaw/commits/" + encodeURIComponent(baseRef) ||
            queryFlag !== "--jq" || query !== ".sha") {
          throw new Error("Expected authenticated, fully qualified correction base lookup");
        }
        const refs = ${JSON.stringify(options.remoteTagRefs)};
        if (!refs[baseRef]) throw new Error("gh: Not Found (HTTP 404)");
        process.stdout.write((refs[baseRef + "^{}"] ?? refs[baseRef]) + "\\n");
      `,
      );
      writeExecutable(path.join(fixtureBin, "gh"), [
        "#!/bin/sh",
        `exec ${quoteShell(process.execPath)} ${quoteShell(ghFixture)} "$@"`,
      ]);
      writeExecutable(path.join(fixtureBin, "git"), [
        "#!/bin/sh",
        "echo 'Anonymous Git transport is unavailable' >&2",
        "exit 128",
      ]);
      const correctionStep = expectDefined(
        readCiWorkflow().jobs.preflight.steps.find(
          (step: WorkflowStep) => step.name === "Resolve release correction base",
        ),
        "trusted correction base producer",
      );
      const correctionOutput = path.join(root, "correction.out");
      writeFileSync(correctionOutput, "");
      const correction = runWorkflowShellScript(correctionStep.run, {
        cwd: root,
        env: {
          PATH: `${fixtureBin}${path.delimiter}${process.env.PATH ?? ""}`,
          GH_TOKEN: correctionStep.env?.GH_TOKEN === "${{ github.token }}" ? "test-token" : "",
          GITHUB_REPOSITORY: "openclaw/openclaw",
          GITHUB_OUTPUT: correctionOutput,
          TARGET_CONTEXT_REF:
            options.scopeEnv?.OPENCLAW_CI_TARGET_CONTEXT_TARGET === "true"
              ? options.scopeEnv.OPENCLAW_CI_TARGET_CONTEXT_REF
              : options.scopeEnv?.OPENCLAW_CI_HISTORICAL_TARGET_TAG,
        },
      });
      if (correction.status !== 0) {
        return {
          output: `${correction.stdout}${correction.stderr}`,
          outputs: {} as Record<string, string>,
          status: correction.status,
          summary: "",
        };
      }
      correctionBaseSha = readWorkflowOutputs(correctionOutput).sha ?? "";
    }
    if (options.historicalReader) {
      const reader = path.join(root, "src/audit/message-delivery-progress-store.test.ts");
      mkdirSync(path.dirname(reader), { recursive: true });
      writeFileSync(reader, "export {};\n");
    }
    writeFileSync(outputPath, "", "utf8");
    writeFileSync(summaryPath, "", "utf8");
    const manifestStep = readCiWorkflow().jobs.preflight.steps.find(
      (step: { name?: string }) => step.name === "Build CI manifest",
    );
    const run = runWorkflowShellScript(manifestStep.run, {
      cwd: root,
      env: {
        ...process.env,
        GH_TOKEN: "",
        GITHUB_TOKEN: "",
        GITHUB_OUTPUT: outputPath,
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_EVENT_NAME: options.eventName ?? "workflow_dispatch",
        GITHUB_STEP_SUMMARY: summaryPath,
        RUNNER_TEMP: root,
        PATH: options.remoteTagRefs
          ? `${fixtureBin}${path.delimiter}${process.env.PATH ?? ""}`
          : process.env.PATH,
        OPENCLAW_CI_CHANGED_PATHS_JSON:
          options.changedPaths === undefined ? undefined : JSON.stringify(options.changedPaths),
        OPENCLAW_CI_CHECKOUT_REVISION: "a".repeat(40),
        OPENCLAW_CI_CORRECTION_BASE_SHA: correctionBaseSha,
        OPENCLAW_CI_DOCS_CHANGED: "true",
        OPENCLAW_CI_DOCS_ONLY: "false",
        OPENCLAW_CI_EVENT_NAME: options.eventName ?? "workflow_dispatch",
        OPENCLAW_CI_HISTORICAL_TARGET:
          (options.historicalCompatibility ?? true) &&
          (options.eventName ?? "workflow_dispatch") === "workflow_dispatch"
            ? "true"
            : "false",
        OPENCLAW_CI_RELEASE_GATE: String(options.releaseGate ?? false),
        OPENCLAW_CI_RELEASE_CANDIDATE_TARGET:
          options.releaseCandidateCompatibility === true ? "true" : "false",
        OPENCLAW_CI_TARGET_CONTEXT_TARGET:
          options.targetContextCompatibility === true ? "true" : "false",
        OPENCLAW_CI_REPOSITORY: options.repository ?? "openclaw/openclaw",
        OPENCLAW_CI_RUN_ANDROID: "true",
        OPENCLAW_CI_RUN_CONTROL_UI_I18N: "true",
        OPENCLAW_CI_RUN_IOS_BUILD: "true",
        OPENCLAW_CI_RUN_MACOS: "true",
        OPENCLAW_CI_RUN_NATIVE_I18N: "true",
        OPENCLAW_CI_RUN_NODE: String(options.runNode ?? true),
        OPENCLAW_CI_RUN_NODE_FAST_CI_ROUTING: String(options.nodeFastCiRouting ?? false),
        OPENCLAW_CI_RUN_NODE_FAST_ONLY: String(options.nodeFastOnly ?? false),
        OPENCLAW_CI_RUN_NODE_FAST_PLUGIN_CONTRACTS: String(
          options.nodeFastPluginContracts ?? false,
        ),
        GITHUB_REF: "refs/heads/main",
        OPENCLAW_CI_HOSTED_HEALTHY: "",
        OPENCLAW_CI_AUTHOR_ASSOCIATION: "CONTRIBUTOR",
        OPENCLAW_CI_HEAD_REPOSITORY: options.repository ?? "openclaw/openclaw",
        OPENCLAW_CI_RUNNER_BACKEND: options.runnerBackend ?? options.runnerProfile ?? "",
        OPENCLAW_CI_RUNNER_PROFILE: options.runnerProfile ?? options.runnerBackend ?? "blacksmith",
        OPENCLAW_CI_NODE_RUNNER_BACKEND: options.nodeRunnerBackend ?? "",
        OPENCLAW_CI_RUN_SKILLS_PYTHON: "true",
        OPENCLAW_CI_RUN_WINDOWS: "true",
        OPENCLAW_CI_WORKFLOW_REVISION: "b".repeat(40),
        ...options.scopeEnv,
      },
    });
    const outputs = Object.fromEntries(
      readFileSync(outputPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => {
          const separator = line.indexOf("=");
          return [line.slice(0, separator), line.slice(separator + 1)];
        }),
    );
    return {
      output: `${run.stdout}${run.stderr}`,
      outputChars: readFileSync(outputPath, "utf8").length,
      outputs,
      status: run.status,
      summary: readFileSync(summaryPath, "utf8"),
    };
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

const readFrozenAdditionalCheckRows = (() => {
  let rows: Array<{ check_name: string; group: string; runner: string }> | undefined;
  return () => {
    if (!rows) {
      const manifest = runCiManifestFixture({
        bundledPlanner: true,
        eventName: "workflow_dispatch",
        historicalCompatibility: true,
        changedPaths: [],
        scopeEnv: {
          OPENCLAW_CI_CHECKOUT_REVISION: "a".repeat(40),
          OPENCLAW_CI_WORKFLOW_REVISION: "b".repeat(40),
        },
      });
      expect(manifest.status, manifest.output).toBe(0);
      rows = JSON.parse(
        expectDefined(manifest.outputs.check_additional_matrix, "additional check matrix"),
      ).include;
    }
    return structuredClone(expectDefined(rows, "frozen additional check rows"));
  };
})();

function runRunnerProfileFixture(options: {
  authorAssociation?: string;
  configuredProfile?: string;
  eventName: "pull_request" | "push" | "workflow_dispatch";
  headRepository?: string;
  repository?: string;
  runAttempt?: number;
  requestedProfile?: "default" | "hybrid" | "runson";
  ciShape?: "default" | "main";
  qualificationDispatch?: boolean;
  targetSupportsRunson?: boolean;
  targetSupportsContract: boolean;
}) {
  const root = mkdtempSync(path.join(tmpdir(), "openclaw-ci-runner-profile-"));
  try {
    const workflowPath = path.join(root, ".github", "workflows", "ci.yml");
    mkdirSync(path.dirname(workflowPath), { recursive: true });
    writeFileSync(
      workflowPath,
      [
        options.targetSupportsContract ? "hosted-runner-profile-contract-v1" : "name: legacy",
        ...(options.targetSupportsRunson ? ["runson-runner-profile-contract-v1"] : []),
      ].join("\n"),
      "utf8",
    );
    const outputPath = path.join(root, "profile.out");
    writeFileSync(outputPath, "", "utf8");
    const step = expectDefined(
      readCiWorkflow().jobs.preflight.steps.find(
        (candidate: WorkflowStep) => candidate.name === "Resolve logical runner profile",
      ),
      "logical runner profile preflight step",
    );
    const result = runWorkflowShellScript(expectDefined(step.run, "runner profile script"), {
      cwd: root,
      env: {
        ...process.env,
        AUTHOR_ASSOCIATION: options.authorAssociation ?? "",
        CONFIGURED_RUNNER_PROFILE: options.configuredProfile ?? "",
        GITHUB_EVENT_NAME: options.eventName,
        GITHUB_OUTPUT: outputPath,
        GITHUB_REPOSITORY: options.repository ?? "openclaw/openclaw",
        HEAD_REPOSITORY: options.headRepository ?? options.repository ?? "openclaw/openclaw",
        GITHUB_RUN_ATTEMPT: String(options.runAttempt ?? 1),
        REQUESTED_RUNNER_PROFILE: options.requestedProfile ?? "default",
        QUALIFICATION_DISPATCH: String(options.qualificationDispatch ?? false),
        CI_SHAPE: options.ciShape ?? "default",
      },
    });
    const outputs = Object.fromEntries(
      readFileSync(outputPath, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const separator = line.indexOf("=");
          return [line.slice(0, separator), line.slice(separator + 1)];
        }),
    );
    return { output: `${result.stdout}${result.stderr}`, outputs, status: result.status };
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

function runCandidateTrustClassification(options: {
  checkoutRevision: string;
  defaultRevision?: string;
  eventName: "pull_request" | "push" | "workflow_dispatch";
  historicalTarget?: boolean;
  ref?: string;
  releaseCandidateTarget?: boolean;
  releaseGate?: boolean;
  targetContextTarget?: boolean;
  targetRef?: string;
  workflowRevision?: string;
}) {
  const root = tempDirs.make("openclaw-ci-candidate-trust-");
  const outputPath = path.join(root, "github-output");
  const binPath = path.join(root, "bin");
  const defaultRevision = options.defaultRevision ?? "b".repeat(40);
  mkdirSync(binPath);
  writeFileSync(outputPath, "", "utf8");
  for (const command of ["git", "gh"]) {
    writeExecutable(path.join(binPath, command), [
      "#!/bin/sh",
      "echo 'Cache trust must consume the resolved default SHA without another lookup' >&2",
      "exit 128",
    ]);
  }
  const step = expectDefined(
    readCiWorkflow().jobs.preflight.steps.find(
      (candidate: WorkflowStep) => candidate.name === "Classify candidate cache trust",
    ),
    "candidate cache trust step",
  );
  const script = expectDefined(step.run, "candidate cache trust script");
  const run = spawnSync("bash", ["-c", script], {
    encoding: "utf8",
    env: {
      ...process.env,
      CHECKOUT_REVISION: options.checkoutRevision,
      DEFAULT_SHA: defaultRevision,
      GITHUB_EVENT_NAME: options.eventName,
      GITHUB_OUTPUT: outputPath,
      GITHUB_REF: options.ref ?? "",
      HISTORICAL_TARGET: String(options.historicalTarget ?? false),
      RUNNER_TEMP: root,
      PATH: `${binPath}:${process.env.PATH ?? ""}`,
      RELEASE_CANDIDATE_TARGET: String(options.releaseCandidateTarget ?? false),
      RELEASE_GATE: String(options.releaseGate ?? false),
      TARGET_CONTEXT_TARGET: String(options.targetContextTarget ?? false),
      TARGET_REF: options.targetRef ?? "",
      WORKFLOW_REVISION: options.workflowRevision ?? "a".repeat(40),
    },
  });
  return {
    output: `${run.stdout}${run.stderr}`,
    outputs: readWorkflowOutputs(outputPath),
    status: run.status,
  };
}

function runDiffBaseFixture(options: {
  commitCount: 1 | 2 | 3;
  eventBaseSha: string;
  defaultBranch?: string;
  manual?: boolean;
  apiError?: "ref" | "comparison";
}) {
  const root = tempDirs.make("openclaw-ci-diff-base-");
  runGit(root, ["init", "-q", "-b", "main"]);
  runGit(root, ["config", "commit.gpgsign", "false"]);
  runGit(root, ["config", "user.email", "ci-fixture@example.com"]);
  runGit(root, ["config", "user.name", "CI Fixture"]);
  for (let index = 1; index <= options.commitCount; index += 1) {
    writeFileSync(path.join(root, "fixture.txt"), `commit ${index}\n`, "utf8");
    runGit(root, ["add", "fixture.txt"]);
    runGit(root, ["commit", "-q", "-m", `fixture ${index}`]);
  }

  const headSha = runGit(root, ["rev-parse", "HEAD"]);
  const parentSha =
    options.commitCount > 1 ? runGit(root, ["rev-parse", "--verify", "HEAD^1"]) : null;
  const eventBaseSha = options.eventBaseSha === "parent" ? parentSha! : options.eventBaseSha;
  const outputPath = path.join(root, "github-output");
  writeFileSync(outputPath, "", "utf8");
  const diffBaseStep = readCiWorkflow().jobs.preflight.steps.find(
    (step: WorkflowStep) => step.name === "Resolve exact diff base",
  );
  const defaultBranch = options.defaultBranch ?? "main";
  const fixtureEnv: NodeJS.ProcessEnv = {};
  if (options.manual) {
    const bin = path.join(root, "bin");
    mkdirSync(bin);
    writeFileSync(
      path.join(root, "ci-git-owner.py"),
      readFileSync(".github/actions/git-owner/owner.py"),
    );
    writeExecutable(path.join(bin, "git"), [
      "#!/bin/sh",
      'if [ "$1" = -C ]; then shift 2; fi',
      `[ "$*" = 'rev-parse HEAD' ] || { echo 'Anonymous Git transport is unavailable' >&2; exit 128; }`,
      `printf '%s\\n' '${headSha}'`,
    ]);
    writeExecutable(path.join(bin, "gh"), [
      "#!/bin/sh",
      '[ "$GH_TOKEN" = test-token ] || exit 4',
      '[ "$1" = api ] || exit 64',
      "shift",
      'if [ "$1" = --method ]; then [ "$2" = GET ] || exit 64; shift 2; fi',
      'case "$*" in',
      `  'repos/openclaw/openclaw/commits/${encodeURIComponent(`refs/heads/${defaultBranch}`)} --jq .sha') kind=ref ;;`,
      `  'repos/openclaw/openclaw/compare/${parentSha}...${headSha} --jq .merge_base_commit.sha') kind=comparison ;;`,
      "  *) exit 64 ;;",
      "esac",
      `printf '%s\\n' '${parentSha}'`,
      'if [ "$MOCK_API_ERROR" = "$kind" ]; then echo "gh: Service Unavailable (HTTP 503)" >&2; exit 1; fi',
    ]);
    fixtureEnv.PATH = `${bin}${path.delimiter}${process.env.PATH ?? ""}`;
    fixtureEnv.GH_TOKEN = evaluateWorkflowExpression(diffBaseStep.env.GH_TOKEN, {
      eventName: "workflow_dispatch",
      repository: "openclaw/openclaw",
      runAttempt: 1,
      workflowToken: "test-token",
    });
    fixtureEnv.RUNNER_TEMP = root;
    fixtureEnv.MOCK_API_ERROR = options.apiError ?? "";
  }
  const run = runWorkflowShellScript(diffBaseStep.run, {
    cwd: root,
    env: {
      ...process.env,
      DEFAULT_BRANCH: defaultBranch,
      EVENT_BASE_SHA: eventBaseSha,
      GITHUB_EVENT_NAME: options.manual ? "workflow_dispatch" : "push",
      GITHUB_OUTPUT: outputPath,
      GITHUB_REPOSITORY: "openclaw/openclaw",
      PULL_REQUEST_NUMBER: "",
      RELEASE_GATE: "false",
      ...fixtureEnv,
    },
  });
  const rawOutputs = readFileSync(outputPath, "utf8").trim();
  const outputs: Record<string, string> =
    rawOutputs === ""
      ? {}
      : Object.fromEntries(
          rawOutputs.split("\n").map((line) => {
            const separator = line.indexOf("=");
            return [line.slice(0, separator), line.slice(separator + 1)];
          }),
        );
  const emittedBaseIsCommit =
    typeof outputs.sha === "string" &&
    spawnSync("git", ["cat-file", "-e", `${outputs.sha}^{commit}`], { cwd: root }).status === 0;
  return {
    emittedBaseIsCommit,
    eventBaseSha,
    headSha,
    output: `${run.stdout}${run.stderr}`,
    outputs,
    parentSha,
    status: run.status,
  };
}

function runCheckShardFixture(options: {
  frozenTarget: boolean;
  scripts: string[];
  task?: "guards" | "npm-lock" | "test-types";
  checkoutBase?: string;
  types?: {
    compose?: boolean;
    profile?: "blacksmith" | "github" | "hybrid";
    eventName?: "pull_request" | "push" | "workflow_dispatch";
    stripeSupport?: boolean;
    hostedContract?: boolean;
    failStripe?: string;
    changedPathsJson?: string;
    boundary?: boolean;
  };
}): {
  calls: string[];
  output: string;
  status: number | null;
  typeCalls: { row: string; command: string; localCheck: string | null }[];
  rows: { name: string; status: number | null }[];
} {
  const root = tempDirs.make("openclaw-ci-guards-");
  const fakeBin = path.join(root, "bin");
  const callsPath = path.join(root, "pnpm-calls.txt");
  const typeCallsPath = path.join(root, "type-calls.txt");
  const typeCheck = options.task === "test-types";
  mkdirSync(fakeBin);
  if (typeCheck) {
    mkdirSync(path.join(root, "scripts"));
    writeFileSync(
      path.join(root, "scripts/run-tsgo-core-test-shards.mts"),
      options.types?.stripeSupport === false ? "// legacy runner\n" : "// --stripe\n",
    );
    writeFileSync(
      path.join(root, "scripts/run-tsgo-core-test-shards.mjs"),
      `import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.TYPE_CALLS, [process.env.TYPE_ROW, process.env.OPENCLAW_LOCAL_CHECK ?? "<unset>", "node " + args.join(" ")].join("\\t") + "\\n");
const stripe = args[args.indexOf("--stripe") + 1];
if (stripe === process.env.FAIL_TYPE_STRIPE) process.exit(17);
`,
    );
  }
  if (options.types?.boundary) {
    // Routing proof records native leaves without executing repository checks.
    writeFileSync(
      path.join(root, "scripts/run-additional-boundary-checks.mts"),
      readFileSync("scripts/run-additional-boundary-checks.mts"),
    );
    for (const directory of ["scripts/lib", "packages", "node_modules"]) {
      symlinkSync(path.resolve(directory), path.join(root, directory), "dir");
    }
    copyFileSync("scripts/tsx.mjs", path.join(root, "scripts/tsx.mjs"));
    writeFileSync(
      path.join(root, "scripts/check-extension-plugin-sdk-boundary.mts"),
      `
import { appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const imports = process.execArgv.map((arg) => arg.startsWith("file:") ? "./" + path.relative(process.cwd(), fileURLToPath(arg)) : arg);
const command = ["node", ...imports, path.relative(process.cwd(), process.argv[1]), ...process.argv.slice(2)].join(" ");
appendFileSync(process.env.TYPE_CALLS, [process.env.TYPE_ROW, process.env.OPENCLAW_LOCAL_CHECK ?? "<unset>", command].join("\\t") + "\\n");
`,
    );
    writeFileSync(
      path.join(root, "scripts/check-native-state-schema-version.mjs"),
      `
import { appendFileSync } from "node:fs";
appendFileSync(process.env.TYPE_CALLS, [process.env.TYPE_ROW, process.env.OPENCLAW_LOCAL_CHECK ?? "<unset>", "node scripts/check-native-state-schema-version.mjs"].join("\\t") + "\\n");
`,
    );
  }
  const scripts = Object.fromEntries(options.scripts.map((name) => [name, "true"]));
  if (options.types?.compose) {
    // The full-path root-coverage probe must see the actual package alias.
    scripts["tsgo:test"] = (
      JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> }
    ).scripts["tsgo:test"]!;
  }
  writeFileSync(path.join(root, "package.json"), `${JSON.stringify({ scripts })}\n`);
  writeExecutable(path.join(fakeBin, "pnpm"), [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    'if [ "$*" = "run --silent" ]; then exit 1; fi',
    'printf "%s\\n" "$*" >> "$PNPM_CALLS"',
    ...(typeCheck
      ? [
          'printf "%s\\t%s\\tpnpm %s\\n" "$TYPE_ROW" "${OPENCLAW_LOCAL_CHECK-<unset>}" "$*" >> "$TYPE_CALLS"',
        ]
      : []),
  ]);
  const workflow = readCiWorkflow();
  const checkShardStep = workflow.jobs["check-shard"].steps.find(
    (step: WorkflowStep) => step.name === "Run check shard",
  );
  const context: Parameters<typeof evaluateWorkflowExpression>[1] = {
    eventName:
      options.types?.eventName ?? (options.frozenTarget ? "workflow_dispatch" : "pull_request"),
    repository: "openclaw/openclaw",
    runAttempt: 1,
    frozenTarget: options.frozenTarget,
    hostedRunnerProfileContract: options.types?.hostedContract ?? true,
    runnerProfile: options.types?.profile ?? "hybrid",
    steps: { "npm-lock-scope": { outputs: { skip: "false" } } },
    preflightOutputs: {
      compatibility_target: String(options.frozenTarget),
      run_format_check: "false",
      changed_core_test_paths_json: options.types?.changedPathsJson ?? "",
    },
  };
  const rows: { name: string; step: WorkflowStep; matrix: Record<string, unknown> }[] = [];
  const coreJob = workflow.jobs["check-test-types-hosted-core-shard"];
  if (options.types?.compose && evaluateWorkflowExpression(coreJob.if, context)) {
    const stripes = evaluateWorkflowExpression(coreJob.strategy.matrix.stripe, context);
    for (const stripe of stripes) {
      rows.push({
        name: `core-${stripe}`,
        step: coreJob.steps.find(
          (step: WorkflowStep) => step.name === "Run hosted core test-types stripe",
        ),
        matrix: { stripe },
      });
    }
  }
  rows.push({ name: "central", step: checkShardStep, matrix: { task: options.task ?? "guards" } });
  if (options.types?.boundary) {
    rows.push({
      name: "boundary",
      step: workflow.jobs["check-additional-shard"].steps.find(
        (step: WorkflowStep) => step.name === "Run additional check shard",
      ),
      matrix: { group: "boundaries" },
    });
  }
  // Rows are independent (matrix fail-fast:false); each real Bash body owns its halt.
  const runs = rows.map((row) => {
    const resolveValue = (value: unknown) =>
      typeof value === "string" && value.startsWith("${{")
        ? evaluateWorkflowExpression(value, { ...context, matrix: row.matrix })
        : value;
    const command = typeCheck
      ? row.step.run!.replace(/\$\{\{[\s\S]*?\}\}/gu, (expression) =>
          String(resolveValue(expression)),
        )
      : row.step.run!;
    return Object.assign(
      spawnSync("bash", ["-c", command], {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          FROZEN_TARGET: options.frozenTarget ? "true" : "false",
          FORMAT_CHECK: "false",
          HISTORICAL_TARGET: options.frozenTarget ? "true" : "false",
          HOSTED_RUNNER_STRIPES: "true",
          CHECKOUT_BASE_SHA: options.checkoutBase ?? "",
          SKIP_NPM_LOCK: "false",
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
          PNPM_CALLS: callsPath,
          TASK: options.task ?? "guards",
          ...(typeCheck
            ? {
                OPENCLAW_LOCAL_CHECK: undefined,
                TYPE_ROW: row.name,
                TYPE_CALLS: typeCallsPath,
                FAIL_TYPE_STRIPE: options.types?.failStripe,
                ...Object.fromEntries(
                  Object.entries(row.step.env ?? {}).map(([key, value]) => [
                    key,
                    String(resolveValue(value)),
                  ]),
                ),
              }
            : {}),
        },
      }),
      { name: row.name },
    );
  });
  const failed = runs.find((run) => run.status !== 0);
  return {
    calls: existsSync(callsPath)
      ? readFileSync(callsPath, "utf8").trim().split("\n").filter(Boolean)
      : [],
    output: runs.map((run) => `${run.stdout}${run.stderr}`).join("\n"),
    status: failed ? failed.status : 0,
    typeCalls: existsSync(typeCallsPath)
      ? readFileSync(typeCallsPath, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            const [row, localCheck, command] = line.split("\t");
            return {
              row: row!,
              command: command!,
              localCheck: localCheck === "<unset>" ? null : localCheck!,
            };
          })
      : [],
    rows: runs.map(({ name, status }) => ({ name, status })),
  };
}

function runDependencyCheckFixture(options: {
  historicalTarget: boolean;
  releaseToolingEntry?: boolean;
  scripts: string[];
}): {
  calls: string[];
  output: string;
  status: number | null;
} {
  const root = mkdtempSync(path.join(tmpdir(), "openclaw-ci-deadcode-"));
  try {
    const fakeBin = path.join(root, "bin");
    const callsPath = path.join(root, "pnpm-calls.txt");
    mkdirSync(fakeBin);
    writeFileSync(
      path.join(root, "package.json"),
      `${JSON.stringify({
        scripts: Object.fromEntries(options.scripts.map((name) => [name, "true"])),
      })}\n`,
    );
    if (options.releaseToolingEntry) {
      mkdirSync(path.join(root, "config"), { recursive: true });
      mkdirSync(path.join(root, "scripts"), { recursive: true });
      writeFileSync(
        path.join(root, "config/knip.config.ts"),
        "const repositoryScriptEntries = [\n] as const;\n",
      );
      writeFileSync(path.join(root, "scripts/generate-dependency-release-evidence.mts"), "");
    }
    writeExecutable(path.join(fakeBin, "pnpm"), [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'if [ "${EXPECT_RELEASE_TOOLING_ENTRY:-false}" = "true" ] &&',
      "  ! grep -Fq '\"scripts/generate-dependency-release-evidence.mts!\"' config/knip.config.ts; then",
      '  echo "release-only helper is missing from Knip entries" >&2',
      "  exit 1",
      "fi",
      'printf "%s\\n" "$*" >> "$PNPM_CALLS"',
    ]);
    const checkShardRun = readCiWorkflow().jobs["check-shard"].steps.find(
      (step: WorkflowStep) => step.name === "Run check shard",
    ).run;
    const run = spawnSync("bash", ["-c", checkShardRun], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        EXPECT_RELEASE_TOOLING_ENTRY: options.releaseToolingEntry ? "true" : "false",
        FROZEN_TARGET: options.historicalTarget ? "true" : "false",
        FORMAT_CHECK: "false",
        HISTORICAL_TARGET: options.historicalTarget ? "true" : "false",
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        PNPM_CALLS: callsPath,
        TASK: "dependencies",
      },
    });
    return {
      calls: existsSync(callsPath)
        ? readFileSync(callsPath, "utf8").trim().split("\n").filter(Boolean)
        : [],
      output: `${run.stdout}${run.stderr}`,
      status: run.status,
    };
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

function runControlUiI18nSourceFixture(options: {
  compatibilityTarget: boolean;
  hasVerifyScript: boolean;
}): { calls: string[]; output: string; summary: string; status: number | null } {
  const root = mkdtempSync(path.join(tmpdir(), "openclaw-ci-control-ui-i18n-"));
  try {
    const fakeBin = path.join(root, "bin");
    const callsPath = path.join(root, "pnpm-calls.txt");
    const summaryPath = path.join(root, "summary.md");
    mkdirSync(fakeBin);
    writeFileSync(
      path.join(root, "package.json"),
      `${JSON.stringify({
        scripts: options.hasVerifyScript ? { "ui:i18n:verify": "true" } : {},
      })}\n`,
    );
    writeExecutable(path.join(fakeBin, "pnpm"), [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'printf "%s\\n" "$*" >> "$PNPM_CALLS"',
    ]);
    const sourceStep = readCiWorkflow().jobs["control-ui-i18n"].steps.find(
      (step: WorkflowStep) => step.name === "Verify Control UI i18n source",
    );
    const run = spawnSync("bash", ["-c", sourceStep.run], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        COMPATIBILITY_TARGET: options.compatibilityTarget ? "true" : "false",
        GITHUB_STEP_SUMMARY: summaryPath,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        PNPM_CALLS: callsPath,
      },
    });
    return {
      calls: existsSync(callsPath)
        ? readFileSync(callsPath, "utf8").trim().split("\n").filter(Boolean)
        : [],
      output: `${run.stdout}${run.stderr}`,
      status: run.status,
      summary: existsSync(summaryPath) ? readFileSync(summaryPath, "utf8") : "",
    };
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}
describe("ci workflow guards", () => {
  it("credits the max-lines baseline only through an emitted required ratchet guard", () => {
    const manifest = runCiManifestFixture({
      bundledPlanner: true,
      eventName: "pull_request",
      changedPaths: ["config/max-lines-baseline.txt"],
      changedPlannerSource: `
        export const hasBuildArtifactAffectingChange = () => false;
        export const createChangedNodeTestShards = (_paths, options) => {
          console.log("max-lines-guard:" + JSON.stringify(options.dedicatedMaxLinesRatchet));
          return [];
        };
        export const createChangedExtensionFallbackShards = () => { throw new Error("Unexpected fallback"); };
      `,
    });
    expect(manifest.status, manifest.output).toBe(0);
    expect(manifest.output).toContain("max-lines-guard:true");
    expect(manifest.outputs.run_baseline_ratchets).toBe("true");
    const context = { preflightOutputs: manifest.outputs };
    expect(runCiGateFixture(renderCiGateEnvironment(context)).status).toBe(0);
    for (const result of ["failure", "skipped"]) {
      expect(
        runCiGateFixture(renderCiGateEnvironment(context, { "checks-baseline-ratchets": result }))
          .status,
      ).toBe(1);
    }
  });

  it("keeps activity unit proof without unrelated dedicated UI E2E on a PR", () => {
    const manifest = runCiManifestFixture({
      bundledPlanner: true,
      eventName: "pull_request",
      changedPaths: ["ui/src/pages/activity/activity-page.test.ts"],
      scopeEnv: { OPENCLAW_CI_RUN_UI_TESTS: "true" },
      changedPlannerSource: `
        export const hasUiE2eAffectingChange = () => false;
        export const hasBuildArtifactAffectingChange = () => false;
        export const createChangedNodeTestShards = (_paths, options) => [{
          checkName: "dedicated-ui-" + options.dedicatedUiE2e,
          configs: [], requiresDist: false, runner: "ubuntu-24.04", shardName: "unit",
        }];
        export const createChangedExtensionFallbackShards = () => [];
      `,
    });
    expect(manifest.status, manifest.output).toBe(0);
    const workflow = readCiWorkflow();
    const context = {
      eventName: "pull_request" as const,
      repository: "openclaw/openclaw",
      runAttempt: 1,
      preflightOutputs: manifest.outputs,
    };
    for (const name of ["checks-ui", "control-ui-performance"]) {
      expect(evaluateWorkflowExpression(`\${{ ${workflow.jobs[name].if} }}`, context)).toBe(true);
    }
    for (const name of ["checks-ui-e2e", "checks-ui-e2e-real-gateway"]) {
      expect(evaluateWorkflowExpression(`\${{ ${workflow.jobs[name].if} }}`, context)).toBe(false);
    }
    expect(JSON.stringify(manifest.outputs)).toContain("dedicated-ui-false");
    expect(
      runCiGateFixture(
        renderCiGateEnvironment(
          { preflightOutputs: manifest.outputs },
          {
            "checks-ui-e2e": "skipped",
            "checks-ui-e2e-real-gateway": "skipped",
          },
        ),
      ).status,
    ).toBe(0);
    expect(
      runCiGateFixture(
        renderCiGateEnvironment(
          { preflightOutputs: manifest.outputs },
          {
            "checks-ui": "skipped",
          },
        ),
      ).status,
    ).toBe(1);
  });

  it.each([
    {
      name: "pull requests",
      eventName: "pull_request" as const,
      changedPaths: ["ui/src/components/app-sidebar.ts"],
      includeReleaseOnlyTests: false,
    },
    {
      name: "main pushes",
      eventName: "push" as const,
      changedPaths: ["ui/src/components/app-sidebar.ts"],
      includeReleaseOnlyTests: false,
    },
    {
      name: "direct matrix edits",
      eventName: "pull_request" as const,
      changedPaths: ["ui/src/e2e/chat-session-entry.e2e.test.ts"],
      includeReleaseOnlyTests: false,
    },
    {
      name: "full release dispatches",
      eventName: "workflow_dispatch" as const,
      changedPaths: ["ui/src/components/app-sidebar.ts"],
      includeReleaseOnlyTests: true,
    },
    {
      name: "older Tooling without the real-Gateway shard helper",
      eventName: "pull_request" as const,
      changedPaths: ["ui/src/components/app-sidebar.ts"],
      includeReleaseOnlyTests: false,
      uiRealGatewayShards: false,
    },
    {
      name: "frozen full release dispatches",
      eventName: "workflow_dispatch" as const,
      changedPaths: ["ui/src/components/app-sidebar.ts"],
      includeReleaseOnlyTests: true,
      frozenTarget: true,
    },
  ])("forwards the UI release-tier selection for $name to all three test jobs", (scenario) => {
    const frozenTarget = "frozenTarget" in scenario && scenario.frozenTarget;
    const uiRealGatewayShards =
      !("uiRealGatewayShards" in scenario) || scenario.uiRealGatewayShards;
    const manifest = runCiManifestFixture({
      bundledPlanner: true,
      uiReleaseTier: true,
      uiRealGatewayShards,
      historicalCompatibility: false,
      eventName: scenario.eventName,
      changedPaths: scenario.changedPaths,
      scopeEnv: {
        OPENCLAW_CI_RUN_UI_TESTS: "true",
        OPENCLAW_CI_WORKFLOW_REVISION: (frozenTarget ? "b" : "a").repeat(40),
      },
    });
    expect(manifest.status, manifest.output).toBe(0);
    const workflow = readCiWorkflow();
    const context = {
      eventName: scenario.eventName,
      repository: "openclaw/openclaw",
      runAttempt: 1,
      preflightOutputs: manifest.outputs,
      steps: { manifest: { outputs: manifest.outputs } },
    };
    const fixtureTier = JSON.stringify({
      includeReleaseOnlyTests: scenario.includeReleaseOnlyTests,
      changedPaths: scenario.changedPaths,
    });
    for (const [name, config, output, job, stepName] of [
      ["ui", "ui/vitest.config.ts", "ui_test_groups_gzip_base64", "checks-ui", "Test Control UI"],
      [
        "e2e",
        "test/vitest/vitest.ui-e2e.config.ts",
        "ui_e2e_test_groups_gzip_base64",
        "checks-ui-e2e",
        "Test Control UI end-to-end",
      ],
    ] as const) {
      const packed = expectDefined(manifest.outputs[output], `${name} packed test selection`);
      expect(decodeNodeTestGroups(packed)).toEqual([
        {
          configs: [config],
          shard_name: name,
          env: { fixtureTier },
        },
      ]);
      expect(evaluateWorkflowExpression(workflow.jobs.preflight.outputs[output], context)).toBe(
        packed,
      );
      const step = expectDefined(
        workflow.jobs[job].steps.find((candidate: WorkflowStep) => candidate.name === stepName),
        `${name} test command`,
      );
      expect(
        evaluateWorkflowExpression(step.env.OPENCLAW_NODE_TEST_GROUPS_GZIP_BASE64, context),
      ).toBe(packed);
    }
    const packedMatrix = expectDefined(
      manifest.outputs.ui_real_gateway_matrix,
      "real-Gateway matrix",
    );
    expect(
      evaluateWorkflowExpression(workflow.jobs.preflight.outputs.ui_real_gateway_matrix, context),
    ).toBe(packedMatrix);
    const matrix: {
      include: Array<{
        shard: number;
        shard_count: number;
        run_desktop: boolean;
        test_groups_gzip_base64: string;
      }>;
    } = JSON.parse(packedMatrix);
    const sharded = !frozenTarget && uiRealGatewayShards;
    expect(matrix.include.map(({ test_groups_gzip_base64: _groups, ...row }) => row)).toEqual(
      sharded
        ? [
            { shard: 1, shard_count: 2, run_desktop: true },
            { shard: 2, shard_count: 2, run_desktop: false },
          ]
        : [{ shard: 1, shard_count: 1, run_desktop: true }],
    );
    const job = workflow.jobs["checks-ui-e2e-real-gateway"];
    const step = expectDefined(
      job.steps.find(
        (candidate: WorkflowStep) =>
          candidate.name === "Test Control UI suites with a real Gateway",
      ),
      "real-Gateway test command",
    );
    for (const row of matrix.include) {
      const packed = row.test_groups_gzip_base64;
      expect(decodeNodeTestGroups(packed)).toEqual(
        sharded
          ? [
              {
                configs: ["test/vitest/vitest.ui-e2e-prebuilt.config.ts"],
                shard_name: `real-gateway-${row.shard}`,
                includePatterns: [`ui/src/e2e/fixture-${row.shard}.real-gateway.e2e.test.ts`],
                env: { fixtureTier },
              },
            ]
          : decodeNodeTestGroups(
              expectDefined(
                manifest.outputs.ui_e2e_test_groups_gzip_base64,
                "real-Gateway test groups",
              ),
            ),
      );
      expect(
        evaluateWorkflowExpression(step.env.OPENCLAW_NODE_TEST_GROUPS_GZIP_BASE64, {
          ...context,
          matrix: row,
        }),
      ).toBe(packed);
    }
  });

  it.each([
    { eventName: "push" as const },
    { eventName: "workflow_dispatch" as const, historicalCompatibility: false },
    { eventName: "workflow_dispatch" as const, historicalCompatibility: true },
    { eventName: "pull_request" as const, repository: "example/openclaw" },
    { eventName: "pull_request" as const, changedPaths: null },
    { eventName: "pull_request" as const, missingSelector: true },
  ])("retains UI E2E outside current known unit-only PR selection %j", (options) => {
    const manifest = runCiManifestFixture({
      bundledPlanner: true,
      changedPaths: ["ui/src/pages/activity/activity-page.test.ts"],
      scopeEnv: { OPENCLAW_CI_RUN_UI_TESTS: "true" },
      ...options,
      changedPlannerSource: `
        ${"missingSelector" in options && options.missingSelector ? "" : "export const hasUiE2eAffectingChange = () => false;"}
        export const createChangedNodeTestShards = () => [];
        export const createChangedExtensionFallbackShards = () => [];
      `,
    });
    // Current PRs with an unusable manifest fail rather than narrowing proof.
    if ("changedPaths" in options && options.changedPaths === null) {
      expect(manifest.status).not.toBe(0);
    } else {
      expect(manifest.status, manifest.output).toBe(0);
      expect(manifest.outputs.run_ui_tests).toBe("true");
      expect(manifest.outputs.run_ui_e2e).toBe("true");
    }
  });

  it.each<Record<string, string>>([
    { OPENCLAW_CI_WORKFLOW_REVISION: "b".repeat(40) },
    { OPENCLAW_CI_RELEASE_GATE: "true" },
    { OPENCLAW_CI_RELEASE_SCOPE: "npm-stable" },
  ])("rejects main-tier release substitutions: %j", (overrides) => {
    const manifest = runCiManifestFixture({
      bundledPlanner: true,
      historicalCompatibility: false,
      scopeEnv: {
        OPENCLAW_CI_VALIDATION_TIER: "main",
        OPENCLAW_CI_WORKFLOW_REVISION: "a".repeat(40),
        ...overrides,
      },
    });
    expect(manifest.status).not.toBe(0);
    expect(manifest.output).toContain(
      "main validation tier requires an ordinary canonical same-revision dispatch",
    );
  });

  it.each(["main", "full"] as const)(
    "keeps complete family coverage with the %s validation tier",
    (tier) => {
      const release = tier === "full";
      const manifest = runCiManifestFixture({
        bundledPlanner: true,
        historicalCompatibility: false,
        uiE2eProjectsCapability: true,
        uiReleaseTier: true,
        changedPaths: null,
        scopeEnv: {
          OPENCLAW_CI_WORKFLOW_REVISION: "a".repeat(40),
          ...(release ? {} : { OPENCLAW_CI_VALIDATION_TIER: tier }),
          OPENCLAW_CI_RUN_UI_TESTS: "true",
        },
      });
      expect(manifest.status, manifest.output).toBe(0);
      expect(manifest.outputs.validation_tier).toBe(tier);
      for (const family of [
        "run_build_artifacts",
        "run_ios_build",
        "run_macos_swift",
        "run_checks_windows",
        "run_ui_tests",
        "run_ui_e2e",
        "run_native_i18n",
        "run_qa_smoke_ci",
        "run_docker_seed_e2e",
      ]) {
        expect(manifest.outputs[family], family).toBe("true");
      }
      const plannerLine = manifest.output
        .split("\n")
        .find((line) => line.startsWith("node-test-plan-options:"));
      const plan = JSON.parse(
        expectDefined(plannerLine, "Node plan options").slice("node-test-plan-options:".length),
      );
      expect(plan).toMatchObject({
        includeProofTests: true,
        includeReleaseOnlyToolingShards: release,
        includeReleaseOnlyRuntimeTests: release,
        includeReleaseOnlyPluginShards: false,
        compact: !release,
      });
      expect(plan.compactMode).toBe(release ? undefined : "push");
      expect(
        decodeNodeTestGroups(
          expectDefined(manifest.outputs.ui_test_groups_gzip_base64, "UI groups"),
        ),
      ).toEqual([
        expect.objectContaining({
          env: {
            fixtureTier: JSON.stringify({ includeReleaseOnlyTests: release, changedPaths: [] }),
          },
        }),
      ]);
      const android = JSON.parse(
        expectDefined(manifest.outputs.android_matrix, "Android matrix"),
      ).include;
      expect(android.some((row: { task: string }) => row.task === "build-play")).toBe(release);
      expect(android.filter((row: { task: string }) => row.task.startsWith("test-"))).toHaveLength(
        3,
      );
      const dockerLanes = expectDefined(manifest.outputs.docker_seed_lanes, "Docker lanes").split(
        " ",
      );
      expect(dockerLanes).toHaveLength(release ? 6 : 1);
      expect(dockerLanes[0]).toBe("published-upgrade-survivor");
      const workflow = readCiWorkflow();
      const context = {
        eventName: "workflow_dispatch" as const,
        repository: "openclaw/openclaw",
        runAttempt: 1,
        preflightOutputs: manifest.outputs,
      };
      for (const job of ["ios-screenshot-shard", "ios-screenshot-evidence", "checks-node-compat"]) {
        const expression = workflow.jobs[job].if;
        expect(
          evaluateWorkflowExpression(
            expression.startsWith("${{") ? expression : "${{ " + expression + " }}",
            context,
          ),
          job,
        ).toBe(release);
      }
      expect(
        evaluateWorkflowExpression(workflow.jobs["ios-build"].strategy.matrix.phase, context),
      ).toEqual(release ? ["release", "tests"] : ["smoke"]);
      const packageStep = workflow.jobs["docker-seed-e2e"].steps.find(
        (step: WorkflowStep) => step.name === "Prepare main Docker smoke package",
      );
      expect(evaluateWorkflowExpression("${{ " + packageStep.if + " }}", context)).toBe(!release);
    },
  );

  it.each([
    ["macos-swift", false, "workflow_dispatch", false, ["release", "tests", "packages"]],
    ["ios-build", false, "workflow_dispatch", false, ["release", "tests"]],
    ["ios-build", true, "workflow_dispatch", false, ["tests"]],
    ["ios-build", false, "pull_request", false, ["smoke"]],
    ["ios-build", false, "push", false, ["smoke"]],
    ["ios-build", false, "workflow_dispatch", true, ["smoke"]],
    ["ios-build", true, "workflow_dispatch", true, ["smoke"]],
  ] as const)(
    "runs %s native phases (historical=%s, event=%s, release_gate=%s)",
    (jobName, historical, eventName, releaseGate, phases) => {
      const workflow = readCiWorkflow();
      const job = workflow.jobs[jobName];
      const context = {
        eventName,
        releaseGate,
        repository: "openclaw/openclaw",
        runAttempt: 1,
        env: { HISTORICAL_TARGET: String(historical), MACOS_PRIMARY_PHASE: "release" },
        fileHashes: { "apps/shared/OpenClawWatchRTC/Cargo.toml": "present" },
        preflightOutputs: {
          compatibility_target: String(historical),
          run_openclawkit_tests: "true",
          release_scope: "full",
        },
      };
      const matrixPhases = job.strategy.matrix.phase;
      expect(
        Array.isArray(matrixPhases)
          ? matrixPhases
          : evaluateWorkflowExpression(matrixPhases, context),
      ).toEqual(phases);
      expect(job.strategy["fail-fast"]).toBe(false);
      expect(job.strategy["max-parallel"]).toBe(2);
      expect(job["continue-on-error"]).not.toBe(true);
      expect(job.needs).toEqual(["preflight"]);
      const workloads =
        jobName === "macos-swift"
          ? {
              smoke: [],
              release: [
                "Native state schema version contract",
                "Swift lint",
                "Swift build (release)",
              ],
              tests: ["Swift test"],
              packages: [
                "OpenClawKit Talk-trait opt-out (no ElevenLabsKit when default traits disabled)",
                "OpenClawKit tests",
                "Swabble tests",
              ],
            }
          : {
              smoke: [
                "Swift lint",
                ...(historical ? [] : ["Prepare iOS simulator"]),
                "Build iOS app",
                ...(historical ? [] : ["Run focused iOS voice cleanup simulator tests"]),
                ...(historical ? [] : ["Run focused iOS lifecycle simulator tests"]),
              ],
              release: ["Build iOS app (Release)"],
              tests: [
                "Test Watch RTC engine",
                "Swift lint",
                "Prepare iOS simulator",
                "Build iOS app",
                "Run focused iOS voice cleanup simulator tests",
                "Run focused iOS lifecycle simulator tests",
                "Run focused Apple Watch operation simulator tests",
              ],
            };
      const names = [];
      for (const phase of phases) {
        const phaseContext = { ...context, matrix: { phase } };
        const expected =
          historical && phase === "tests"
            ? ["Test Watch RTC engine", "Swift lint", "Build iOS app"]
            : workloads[phase];
        names.push(evaluateWorkflowExpression(job.name, phaseContext));
        const selected = job.steps
          .filter((step: WorkflowStep) =>
            Object.values(workloads)
              .flat()
              .includes(step.name ?? ""),
          )
          .filter(
            (step: WorkflowStep) =>
              !step.if || evaluateWorkflowExpression(`\${{ ${step.if} }}`, phaseContext),
          )
          .map((step: WorkflowStep) => step.name);
        expect(selected, phase).toEqual(expected);
        if (jobName === "ios-build") {
          for (const name of [
            "Select Xcode 27",
            "Setup Node environment",
            "Install Watch Rust toolchain",
            "Install iOS Swift tooling",
          ]) {
            const setup = expectDefined(
              job.steps.find((step: WorkflowStep) => step.name === name),
              name,
            );
            expect(
              !setup.if || evaluateWorkflowExpression(`\${{ ${setup.if} }}`, phaseContext),
            ).toBe(true);
          }
        }
      }
      // The release collector keys retained/rerun evidence by the displayed job name.
      expect(new Set(names).size).toBe(phases.length);
      expect(workflow.jobs["ci-gate"].needs).toContain(jobName);
      const gateStep = workflow.jobs["ci-gate"].steps.find(
        (step: WorkflowStep) => step.name === "Verify selected CI lanes",
      );
      expect(gateStep.env.JOB_RESULTS).toContain(`${jobName}=\${{ needs.${jobName}.result }}`);
      for (const conclusion of ["failure", "cancelled", "skipped"]) {
        expect(
          runCiGateFixture(`preflight=success|true\n${jobName}=${conclusion}|true`).status,
        ).toBe(1);
      }
    },
  );

  it.each([
    { eventName: "pull_request", releaseGate: false, full: false },
    { eventName: "push", releaseGate: false, full: false },
    { eventName: "workflow_dispatch", releaseGate: true, full: false },
    { eventName: "workflow_dispatch", releaseGate: false, full: true },
    { eventName: "workflow_dispatch", releaseGate: false, full: true, historical: true },
  ] as const)(
    "retains macOS tests and one guard/cache owner for %j",
    ({ eventName, releaseGate, full, ...target }) => {
      const historical = "historical" in target && target.historical;
      const job = readCiWorkflow().jobs["macos-swift"];
      const manifest = runCiManifestFixture({
        bundledPlanner: true,
        eventName,
        releaseGate,
        runNode: false,
        historicalCompatibility: historical,
      });
      expect(manifest.status, manifest.output).toBe(0);
      expect(manifest.outputs.release_scope).toBe("full");
      const context: Parameters<typeof evaluateWorkflowExpression>[1] = {
        eventName,
        releaseGate,
        releaseScope: "",
        repository: "openclaw/openclaw",
        runAttempt: 1,
        preflightOutputs: {
          ...manifest.outputs,
          cache_write_allowed: "true",
        },
        fileHashes: { "scripts/test-macos-health-render.sh": "present" },
      };
      const phases: string[] = Array.isArray(job.strategy.matrix.phase)
        ? job.strategy.matrix.phase
        : evaluateWorkflowExpression(job.strategy.matrix.phase, context);
      expect(phases).toEqual(full ? ["release", "tests", "packages"] : ["tests", "packages"]);
      expect(job.strategy["max-parallel"]).toBe(2);
      const env = Object.fromEntries(
        Object.entries(job.env).map(([key, value]) => [
          key,
          String(evaluateWorkflowExpression(value, context)),
        ]),
      );
      const selectedPhases = (name: string, overrides: Partial<typeof context> = {}) => {
        const step: WorkflowStep = expectDefined(
          job.steps.find((candidate: WorkflowStep) => candidate.name === name),
          name,
        );
        expect(step["continue-on-error"] === true, name).toBe(name === "Save SwiftPM cache");
        return phases.filter((phase) =>
          evaluateWorkflowExpression(
            step.if?.startsWith("${{") ? step.if : `\${{ ${step.if ?? "true"} }}`,
            {
              ...context,
              env,
              matrix: { phase },
              steps: {
                "swift-test": {
                  outputs: { "debug-tests-built": phase === "tests" ? "true" : "" },
                },
                "swiftpm-cache": { outputs: { "cache-hit": "false" } },
                "swift-cache-budget": { outputs: { allowed: "true" } },
              },
              ...overrides,
            },
          ),
        );
      };
      for (const name of [
        "Install XcodeGen / SwiftLint / SwiftFormat",
        "Native state schema version contract",
        "Swift lint",
        "Save SwiftPM cache",
      ]) {
        expect(selectedPhases(name), name).toEqual([full ? "release" : "tests"]);
      }
      for (const name of [
        "OpenClawKit Talk-trait opt-out (no ElevenLabsKit when default traits disabled)",
        "OpenClawKit tests",
      ]) {
        expect(selectedPhases(name), name).toEqual(["packages"]);
      }
      expect(selectedPhases("Swift test")).toEqual(["tests"]);
      expect(selectedPhases("Swabble tests")).toEqual(historical ? [] : ["packages"]);
      expect(selectedPhases("Swift build (release)")).toEqual(full ? ["release"] : []);
      for (const name of [
        "Detect Swift toolchain cache key",
        "Restore Swift build directory cache",
        "Validate Swift build cache",
      ]) {
        expect(selectedPhases(name), name).toEqual(full ? ["release", "tests"] : ["tests"]);
      }
      expect(selectedPhases("Render isolated macOS health fixtures")).toEqual(
        full ? ["tests"] : [],
      );
      expect(selectedPhases("Render isolated macOS health fixtures", { cancelled: true })).toEqual(
        [],
      );
      expect(
        selectedPhases("Save SwiftPM cache", {
          preflightOutputs: { ...context.preflightOutputs, cache_write_allowed: "false" },
        }),
      ).toEqual([]);
      expect(
        selectedPhases("Save SwiftPM cache", {
          steps: { "swiftpm-cache": { outputs: { "cache-hit": "true" } } },
        }),
      ).toEqual([]);
      for (const result of ["failure", "cancelled", "skipped"]) {
        expect(
          runCiGateFixture(renderCiGateEnvironment(context, { "macos-swift": result })).status,
        ).toBe(1);
      }
    },
  );

  describe("bounded hybrid hosted offload", () => {
    function emittedHostedRows(
      outputs: Record<string, string>,
      overrides: Partial<Parameters<typeof evaluateWorkflowExpression>[1]> = {},
    ) {
      const context = {
        // Count full-manifest rows after admission, not a default security-only push.
        ciOnPush: "true",
        eventName: "push" as const,
        repository: "openclaw/openclaw",
        runAttempt: 1,
        runnerBackend: "hybrid" as const,
        ...overrides,
        preflightOutputs: outputs,
      };
      const evaluate = (value: unknown, matrix: Record<string, unknown> = {}) =>
        typeof value === "string" && value.startsWith("${{")
          ? evaluateWorkflowExpression(value.replaceAll("fromJson(", "fromJSON("), {
              ...context,
              matrix,
            })
          : value;
      const rows: string[] = [];
      const hostedLabels = new Set(["ubuntu-24.04", "windows-2025", "macos-15", "xcode-27"]);
      for (const [name, job] of Object.entries(readCiWorkflow().jobs)) {
        const definition = job as {
          if?: string;
          "runs-on": string;
          strategy?: {
            matrix: string | { include?: Record<string, unknown>[]; [key: string]: unknown };
          };
        };
        const condition = definition.if;
        if (
          condition &&
          !evaluate(condition.startsWith("${{") ? condition : `\${{ ${condition} }}`)
        ) {
          continue;
        }
        const matrix = evaluate(definition.strategy?.matrix) as
          | {
              include?: Record<string, unknown>[];
              [key: string]: unknown;
            }
          | undefined;
        let selectedRows: Record<string, unknown>[] = [{}];
        if (matrix?.include) {
          selectedRows = matrix.include;
        } else if (matrix) {
          for (const [key, value] of Object.entries(matrix)) {
            const values = evaluate(value) as unknown[];
            selectedRows = selectedRows.flatMap((row) =>
              values.map((entry) => Object.assign({}, row, { [key]: entry })),
            );
          }
        }
        for (const row of selectedRows) {
          if (hostedLabels.has(String(evaluate(definition["runs-on"], row)))) {
            rows.push(name);
          }
        }
      }
      return rows;
    }

    it("counts hosted qualification controls and preflight without counting the AWS cron row", () => {
      const common = {
        bundledPlanner: true,
        historicalCompatibility: false,
        runnerBackend: "runson" as const,
        runnerProfile: "hybrid" as const,
        nodeRunnerBackend: "runson" as const,
        changedPaths: [".github/workflows/ci.yml"],
      };
      const ordinary = runCiManifestFixture({ ...common, eventName: "pull_request" });
      const qualification = runCiManifestFixture({
        ...common,
        eventName: "workflow_dispatch",
        releaseGate: true,
        scopeEnv: { OPENCLAW_CI_AUTHOR_ASSOCIATION: "", OPENCLAW_CI_HEAD_REPOSITORY: "" },
      });
      expect(ordinary.status, ordinary.output).toBe(0);
      expect(qualification.status, qualification.output).toBe(0);
      const actual = emittedHostedRows(
        { ...qualification.outputs, node_runner_backend: "runson" },
        {
          eventName: "workflow_dispatch",
          releaseGate: true,
          runnerBackend: "runson",
          runnerProfile: "hybrid",
        },
      );
      expect(actual.filter((job) => job === "checks-node-core-test-nondist-shard")).toHaveLength(1);
      expect(actual).toContain("preflight");
      expect(Number(qualification.outputs.hybrid_hosted_base_rows)).toBe(
        Number(ordinary.outputs.hybrid_hosted_base_rows) + 2,
      );
      expect(Number(qualification.outputs.hybrid_hosted_total_rows)).toBe(actual.length);
    });

    function manifestWithHostedNodeRows(
      count: number,
      options: Partial<Parameters<typeof runCiManifestFixture>[0]> = {},
    ) {
      expect(count).toBeGreaterThanOrEqual(0);
      return runCiManifestFixture({
        bundledPlanner: true,
        eventName: "push",
        historicalCompatibility: false,
        runnerBackend: "hybrid",
        nodeTestShards: Array.from({ length: count }, (_, index) => ({
          checkName: `hosted-node-${index}`,
          configs: [],
          requiresDist: false,
          runner: "ubuntu-24.04",
          shardName: `hosted-node-${index}`,
        })),
        ...options,
        scopeEnv: {
          // Keep room below the admission boundary before adding synthetic Node rows.
          OPENCLAW_CI_RUN_MACOS: "false",
          OPENCLAW_CI_RUN_NATIVE_I18N: "false",
          OPENCLAW_CI_RUN_UI_TESTS: "true",
          ...options.scopeEnv,
        },
      });
    }

    it("counts the actual workflow rows and admits five offloads only below the base threshold", () => {
      const planner = readCiWorkflow().jobs.preflight.steps.find(
        (step: WorkflowStep) => step.name === "Build CI manifest",
      );
      expect(planner.run).toContain("const HYBRID_HOSTED_ROW_LIMIT = 45;");
      expect(planner.run).toContain("const HYBRID_HOSTED_BASE_ROW_LIMIT = 40;");
      const baseline = manifestWithHostedNodeRows(0);
      expect(baseline.status, baseline.output).toBe(0);
      const originalBase = emittedHostedRows({
        ...baseline.outputs,
        hybrid_hosted_offload: "false",
      }).length;
      expect(Number(baseline.outputs.hybrid_hosted_base_rows)).toBe(originalBase);
      for (const baseRows of [40, 41, 45, 46]) {
        const manifest = manifestWithHostedNodeRows(baseRows - originalBase);
        expect(manifest.status, manifest.output).toBe(0);
        if (baseRows === 46) {
          expect(manifest.output).toContain(
            "::warning::Hybrid base manifest has 46 hosted jobs, above the 45-row offload budget; keeping optional offloads on Blacksmith.",
          );
        }
        const hosted = emittedHostedRows(manifest.outputs);
        expect(manifest.outputs.hybrid_hosted_offload).toBe(String(baseRows <= 40));
        expect(Number(manifest.outputs.hybrid_hosted_base_rows)).toBe(baseRows);
        expect(Number(manifest.outputs.hybrid_hosted_total_rows)).toBe(hosted.length);
        expect(hosted.length).toBe(baseRows <= 40 ? baseRows + 5 : baseRows);
        for (const name of ["security-fast", "checks-ui", "checks-ui-e2e"]) {
          expect(hosted.includes(name), name).toBe(baseRows <= 40);
        }
        for (const name of [
          "qa-smoke-ci-profile",
          "checks-ui-e2e-real-gateway",
          "build-artifacts",
          "android",
          "check-test-types-hosted-core-shard",
        ]) {
          expect(hosted, name).not.toContain(name);
        }
        expect(hosted.filter((name) => name === "checks-ui")).toHaveLength(baseRows <= 40 ? 3 : 0);
        expect(hosted.filter((name) => name === "checks-ui-e2e")).toHaveLength(
          baseRows <= 40 ? 1 : 0,
        );
      }
    });

    it("runs the hosted health step from the current checkout without a sparse harness helper", () => {
      const step = readCiWorkflow().jobs.preflight.steps.find(
        (candidate: WorkflowStep) => candidate.id === "hosted_health",
      );
      const root = tempDirs.make("openclaw-hosted-health-step-");
      const helper = "scripts/lib/ci-hybrid-hosted-health.mts";
      mkdirSync(path.join(root, "scripts/lib"), { recursive: true });
      copyFileSync(helper, path.join(root, helper));
      const output = path.join(root, "output");
      const summary = path.join(root, "summary");
      const result = runWorkflowShellScript(step.run, {
        cwd: root,
        env: {
          GITHUB_OUTPUT: output,
          GITHUB_STEP_SUMMARY: summary,
          GITHUB_REPOSITORY: "openclaw/openclaw",
          GITHUB_RUN_ID: "1",
          // Missing credentials exercise the real fail-closed entry point without network.
          GH_TOKEN: "",
        },
      });
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(readFileSync(output, "utf8")).toBe("healthy=false\n");
      expect(readFileSync(summary, "utf8")).toContain("hosted-health-unavailable");
      for (const eventName of ["workflow_dispatch", "push", "pull_request"] as const) {
        expect(
          evaluateWorkflowExpression(`\${{ ${step.if} }}`, {
            eventName,
            repository: "openclaw/openclaw",
            runAttempt: 1,
            runnerBackend: "hybrid",
            ref: "refs/heads/main",
            steps: {
              changed_scope: {
                outputs: {
                  run_node: "true",
                  run_node_fast_only: "false",
                  run_windows: "true",
                },
              },
            },
          }),
        ).toBe(eventName !== "workflow_dispatch");
      }
    });

    it.each([
      { eventName: "push" as const, ref: "refs/heads/main", windows: false, admitted: true },
      { eventName: "push" as const, ref: "refs/heads/feature", windows: false, admitted: false },
      {
        eventName: "pull_request" as const,
        ref: "refs/pull/1/merge",
        windows: false,
        admitted: false,
      },
      {
        eventName: "pull_request" as const,
        ref: "refs/pull/1/merge",
        windows: true,
        admitted: true,
      },
    ])(
      "requires a measured workload with slack ($eventName, Windows=$windows, $ref)",
      ({ eventName, ref, windows, admitted }) => {
        const manifest = manifestWithHostedNodeRows(0, {
          eventName,
          changedPaths: ["src/infra/example.ts"],
          nodeTestShards: [
            {
              checkName: "native-tail",
              shardName: "native-tail",
              configs: [],
              requiresDist: false,
              runner: "blacksmith-16vcpu-ubuntu-2404",
              planConcurrency: 1,
              predictedSeconds: 500,
            },
          ],
          scopeEnv: {
            GITHUB_REF: ref,
            OPENCLAW_CI_RUN_WINDOWS: String(windows),
            OPENCLAW_CI_HOSTED_HEALTHY: "true",
          },
        });
        expect(manifest.status, manifest.output).toBe(0);
        expect(manifest.outputs.run_check).toBe("true");
        expect(manifest.outputs.run_checks_windows).toBe(String(windows));
        expect(manifest.outputs.hybrid_hosted_checks).toBe(String(admitted));
        expect(manifest.outputs.hybrid_hosted_main_checks).toBe(
          String(admitted && eventName === "push"),
        );
        const checkRunner = readCiWorkflow().jobs["check-shard"]["runs-on"];
        for (const task of ["lint", "test-types"]) {
          expect(
            evaluateWorkflowExpression(checkRunner, {
              eventName,
              ref,
              repository: "openclaw/openclaw",
              runAttempt: 1,
              runnerBackend: "hybrid",
              preflightOutputs: manifest.outputs,
              matrix: { task, runner: "blacksmith-16vcpu-ubuntu-2404" },
            }),
          ).toBe(
            admitted && eventName === "push" ? "ubuntu-24.04" : "blacksmith-16vcpu-ubuntu-2404",
          );
        }
        expect(
          evaluateWorkflowExpression(readCiWorkflow().jobs["build-artifacts"]["runs-on"], {
            eventName,
            ref,
            repository: "openclaw/openclaw",
            runAttempt: 1,
            runnerBackend: "hybrid",
            preflightOutputs: manifest.outputs,
          }),
        ).toBe("blacksmith-16vcpu-ubuntu-2404");
        const step = readCiWorkflow().jobs.preflight.steps.find(
          (candidate: WorkflowStep) => candidate.id === "hosted_health",
        );
        expect(
          evaluateWorkflowExpression(`\${{ ${step.if} }}`, {
            eventName,
            ref,
            repository: "openclaw/openclaw",
            runAttempt: 1,
            runnerBackend: "hybrid",
            steps: {
              changed_scope: {
                outputs: {
                  run_node: "true",
                  run_node_fast_only: "false",
                  run_windows: String(windows),
                },
              },
            },
          }),
        ).toBe(admitted);
      },
    );

    it.each([
      { seconds: 499, concurrency: 1, changedPath: "src/infra/example.ts" },
      { seconds: 500, concurrency: 2, changedPath: "src/infra/example.ts" },
      { seconds: 500, concurrency: 1, changedPath: "src/focused.ts" },
    ])(
      "retains PR check capacity without a serial compact latency floor (%#)",
      ({ seconds, concurrency, changedPath }) => {
        const nativeTail = {
          checkName: "native-tail",
          shardName: "native-tail",
          configs: [],
          requiresDist: false,
          runner: "blacksmith-16vcpu-ubuntu-2404",
          planConcurrency: concurrency,
          predictedSeconds: seconds,
        };
        const manifest = manifestWithHostedNodeRows(0, {
          eventName: "pull_request",
          changedPaths: [changedPath],
          nodeTestShards: [nativeTail],
          changedPlannerSource:
            changedPath === "src/focused.ts"
              ? `export const createChangedNodeTestShards = () => [${JSON.stringify(nativeTail)}];
               export const createChangedExtensionFallbackShards = () => [];`
              : undefined,
          scopeEnv: {
            OPENCLAW_CI_RUN_WINDOWS: "true",
            OPENCLAW_CI_HOSTED_HEALTHY: "true",
          },
        });
        expect(manifest.status, manifest.output).toBe(0);
        expect(manifest.outputs.hybrid_hosted_checks).toBe("false");
      },
    );

    it("admits measured checks only with healthy assignment and space inside the existing budget", () => {
      const preflight = readCiWorkflow().jobs.preflight;
      const manifestStep = preflight.steps.find((step: WorkflowStep) => step.id === "manifest");
      expect(manifestStep.env.OPENCLAW_CI_HOSTED_HEALTHY).toBe(
        "${{ steps.hosted_health.outputs.healthy }}",
      );
      expect(preflight.outputs.hybrid_hosted_checks).toBe(
        "${{ steps.manifest.outputs.hybrid_hosted_checks }}",
      );
      expect(preflight.outputs.hybrid_hosted_main_checks).toBe(
        "${{ steps.manifest.outputs.hybrid_hosted_main_checks }}",
      );
      const baseline = manifestWithHostedNodeRows(0);
      const originalBase = Number(baseline.outputs.hybrid_hosted_base_rows);
      for (const healthy of ["true", "false", ""]) {
        for (const baseRows of [30, 31, 32, 33, 40, 41, 45, 46]) {
          const manifest = manifestWithHostedNodeRows(baseRows - originalBase, {
            scopeEnv: { OPENCLAW_CI_HOSTED_HEALTHY: healthy },
          });
          expect(manifest.status, manifest.output).toBe(0);
          const admitted = healthy === "true" && baseRows <= 32;
          const mainAdmitted = admitted && baseRows <= 30;
          expect(manifest.outputs.hybrid_hosted_checks).toBe(String(admitted));
          expect(manifest.outputs.hybrid_hosted_main_checks).toBe(String(mainAdmitted));
          const hosted = emittedHostedRows(manifest.outputs);
          const withoutChecks = emittedHostedRows({
            ...manifest.outputs,
            hybrid_hosted_checks: "false",
            hybrid_hosted_main_checks: "false",
          });
          expect(Number(manifest.outputs.hybrid_hosted_total_rows)).toBe(hosted.length);
          expect(hosted.length - withoutChecks.length).toBe(
            (admitted ? 8 : 0) + (mainAdmitted ? 2 : 0),
          );
          expect(hosted).not.toContain("build-artifacts");
          expect(
            hosted.filter((name) => name === "check-test-types-hosted-core-shard"),
          ).toHaveLength(admitted ? 5 : 0);
          for (const name of ["check-shard", "check-additional-shard"]) {
            expect(
              hosted.filter((row) => row === name).length -
                withoutChecks.filter((row) => row === name).length,
            ).toBe(admitted ? (name === "check-shard" ? 1 + (mainAdmitted ? 2 : 0) : 2) : 0);
          }
          // The old UI/security decision remains independent of the new check admission.
          expect(manifest.outputs.hybrid_hosted_offload).toBe(String(baseRows <= 40));
          for (const name of [
            "checks-node-core-test-nondist-shard",
            "qa-smoke-ci-profile",
            "checks-ui-e2e-real-gateway",
            "android",
          ]) {
            expect(hosted.filter((row) => row === name)).toEqual(
              withoutChecks.filter((row) => row === name),
            );
          }
        }
      }
    });

    it.each([
      {
        label: "same-repo PR",
        eventName: "pull_request" as const,
        runnerProfile: "hybrid" as const,
        headRepository: "openclaw/openclaw",
      },
      {
        label: "trusted fork PR",
        eventName: "pull_request" as const,
        runnerProfile: "github" as const,
        headRepository: "contributor/openclaw",
      },
      {
        label: "main",
        eventName: "push" as const,
        runnerProfile: "hybrid" as const,
        headRepository: "openclaw/openclaw",
      },
    ])("counts all selected rows for $label", ({ eventName, runnerProfile, headRepository }) => {
      const manifest = manifestWithHostedNodeRows(0, {
        eventName,
        runnerProfile,
        changedPaths: [".github/workflows/ci.yml"],
        scopeEnv: {
          OPENCLAW_CI_HEAD_REPOSITORY: headRepository,
          OPENCLAW_CI_RUN_MACOS_NODE: "true",
        },
      });
      expect(manifest.status, manifest.output).toBe(0);
      expect(manifest.outputs.hybrid_hosted_offload).toBe("true");
      const context = { eventName, runnerProfile, headRepository };
      const base = emittedHostedRows(
        { ...manifest.outputs, hybrid_hosted_offload: "false" },
        context,
      );
      expect(Number(manifest.outputs.hybrid_hosted_base_rows)).toBe(base.length);
      expect(Number(manifest.outputs.hybrid_hosted_total_rows)).toBe(
        emittedHostedRows(manifest.outputs, context).length,
      );
      expect(base.filter((name) => name === "macos-node")).toHaveLength(3);
      expect(base.filter((name) => name === "check-lint-hosted-extension-shard")).toHaveLength(
        runnerProfile === "hybrid" ? 6 : 0,
      );
    });

    it.each<{ label: string } & Partial<Parameters<typeof runCiManifestFixture>[0]>>([
      { label: "retry", scopeEnv: { GITHUB_RUN_ATTEMPT: "2" } },
      { label: "missing attempt", scopeEnv: { GITHUB_RUN_ATTEMPT: "" } },
      {
        label: "untrusted author",
        eventName: "pull_request" as const,
        changedPaths: [".github/workflows/ci.yml"],
        scopeEnv: { OPENCLAW_CI_AUTHOR_ASSOCIATION: "NONE" },
      },
      { label: "manual", eventName: "workflow_dispatch" as const },
      { label: "frozen", eventName: "workflow_dispatch" as const, historicalCompatibility: true },
      { label: "noncanonical", repository: "contributor/openclaw" },
      { label: "GitHub backend", runnerBackend: "github" as const },
      { label: "Blacksmith backend", runnerBackend: "blacksmith" as const },
    ])(
      "leaves $label routing outside optional offload admission",
      ({ label: _label, ...options }) => {
        const manifest = manifestWithHostedNodeRows(0, {
          ...options,
          scopeEnv: { OPENCLAW_CI_HOSTED_HEALTHY: "true", ...options.scopeEnv },
        });
        expect(manifest.status, manifest.output).toBe(0);
        expect(manifest.outputs.hybrid_hosted_offload).toBe("false");
        expect(manifest.outputs.hybrid_hosted_checks).toBe("false");
        expect(manifest.outputs.hybrid_hosted_main_checks).toBe("false");
      },
    );

    it("runs security after preflight failures and skips a cancelled workflow", () => {
      const job = readCiWorkflow().jobs["security-fast"];
      expect(job.needs).toEqual(["preflight"]);
      const context = {
        eventName: "push" as const,
        repository: "openclaw/openclaw",
        runAttempt: 1,
        runnerBackend: "hybrid" as const,
        failed: true,
      };
      expect(evaluateWorkflowExpression(job.if, context)).toBe(true);
      expect(evaluateWorkflowExpression(job["runs-on"], context)).toBe(
        "blacksmith-4vcpu-ubuntu-2404",
      );
      expect(evaluateWorkflowExpression(job.if, { ...context, cancelled: true })).toBe(false);
    });
  });

  it.each<{
    eventName: "pull_request" | "push" | "workflow_dispatch";
    production: boolean;
    expected: boolean;
    legacyPlanner?: boolean;
  }>([
    { eventName: "pull_request" as const, production: false, expected: false },
    { eventName: "pull_request" as const, production: true, expected: false },
    { eventName: "push" as const, production: false, expected: true },
    { eventName: "push" as const, production: true, expected: true },
    { eventName: "workflow_dispatch" as const, production: false, expected: true },
    { eventName: "push", production: false, expected: true, legacyPlanner: true },
    { eventName: "workflow_dispatch", production: false, expected: true, legacyPlanner: true },
  ])(
    "routes published-upgrade proof for $eventName (production=$production, legacy=$legacyPlanner)",
    (options) => {
      const changedPaths = [
        "src/commands/doctor-config-preflight.admission.process.test.ts",
        "src/commands/doctor-config-runtime.test-support.ts",
        ...(options.production ? ["src/commands/doctor-config-preflight.ts"] : []),
      ];
      const result = runCiManifestFixture({
        bundledPlanner: true,
        runNode: false,
        changedPaths,
        eventName: options.eventName,
        scopeEnv: { GITHUB_REF: "refs/heads/main" },
        ...(options.legacyPlanner ? { dockerSeedPlannerSource: "export {};" } : {}),
      });
      expect(result.status, result.output).toBe(0);
      expect(result.outputs.run_docker_seed_e2e).toBe(String(options.expected));
      expect(result.outputs.docker_seed_lanes).toBe(
        options.eventName === "workflow_dispatch" && !options.legacyPlanner
          ? "published-upgrade-survivor mcp-channels cron-mcp-cleanup mcp-code-mode-gateway update-channel-switch fleet-cache"
          : options.expected
            ? "published-upgrade-survivor"
            : "",
      );
    },
  );

  it.each([
    { repository: "openclaw/openclaw", ref: "refs/heads/main", expected: true },
    { repository: "openclaw/openclaw", ref: "refs/heads/feature", expected: false },
    { repository: "fork/openclaw", ref: "refs/heads/main", expected: false },
  ])(
    "gates only canonical main pushes admitted by CI ($repository $ref)",
    ({ repository, ref, expected }) => {
      const push = readCiWorkflow().on.push;
      expect(push.branches).toEqual(["main"]);
      expect(push).not.toHaveProperty("paths");
      expect(push["paths-ignore"]).toEqual(["**/*.md", "docs/**"]);
      const result = runCiManifestFixture({
        bundledPlanner: true,
        eventName: "push",
        repository,
        changedPaths: ["scripts/e2e/docker-openai-seed.ts"],
        scopeEnv: { GITHUB_REF: ref },
      });
      expect(result.status, result.output).toBe(0);
      expect(result.outputs.run_docker_seed_e2e).toBe(String(expected));
      expect(result.outputs.docker_seed_lanes).toBe(expected ? "published-upgrade-survivor" : "");
    },
  );

  it.each([
    { paths: ["README.md"], admitted: false },
    { paths: [".agents/skills/example/SKILL.md"], admitted: false },
    { paths: ["docs/ci.md", "docs/images/diagram.svg"], admitted: false },
    { paths: ["docs/reference/schema.json"], admitted: false },
    { paths: ["src/ordinary.ts"], admitted: true },
    { paths: ["assets/logo.svg"], admitted: true },
    { paths: ["README.md", "src/ordinary.ts"], admitted: true },
    { paths: ["docs/ci.md", "assets/logo.svg"], admitted: true },
  ])("admits main push paths $paths to CI: $admitted", ({ paths, admitted }) => {
    const ignored: string[] = readCiWorkflow().on.push["paths-ignore"] ?? [];
    // GitHub skips paths-ignore only when every changed path matches a pattern.
    const runsCi = paths.some(
      (changedPath) => !ignored.some((pattern) => minimatch(changedPath, pattern, { dot: true })),
    );
    expect(runsCi).toBe(admitted);
    if (!runsCi) {
      return;
    }
    const result = runCiManifestFixture({
      bundledPlanner: true,
      eventName: "push",
      repository: "openclaw/openclaw",
      changedPaths: paths,
      scopeEnv: { GITHUB_REF: "refs/heads/main" },
    });
    expect(result.status, result.output).toBe(0);
    expect(result.outputs.run_docker_seed_e2e).toBe("true");
    expect(result.outputs.docker_seed_lanes).toBe("published-upgrade-survivor");
  });

  it.each([
    {
      eventName: "push" as const,
      changedPaths: ["src/cli/cron-cli/shared.ts"],
      qa: false,
      performance: false,
    },
    {
      eventName: "pull_request" as const,
      changedPaths: ["src/cli/cron-cli/shared.ts"],
      qa: false,
      performance: false,
    },
    {
      eventName: "push" as const,
      changedPaths: ["extensions/qa-lab/src/ci-smoke-plan.ts"],
      qa: true,
      performance: false,
    },
    {
      eventName: "pull_request" as const,
      changedPaths: ["extensions/telegram/src/index.ts"],
      qa: false,
      performance: false,
    },
    { eventName: "push" as const, changedPaths: ["ui/src/main.ts"], qa: false, performance: true },
    {
      eventName: "push" as const,
      changedPaths: ["src/gateway/control-ui-asset-manifest.ts"],
      qa: false,
      performance: true,
    },
    { eventName: "push" as const, changedPaths: null, qa: true, performance: true },
    {
      eventName: "workflow_dispatch" as const,
      changedPaths: ["src/cli/cron-cli/shared.ts"],
      qa: true,
      performance: true,
    },
  ])("selects owner/release coverage for $eventName $changedPaths", (fixture) => {
    const plannerUrl = pathToFileURL(
      path.resolve("scripts/lib/ci-changed-node-test-plan.mts"),
    ).href;
    const result = runCiManifestFixture({
      ...fixture,
      bundledPlanner: true,
      historicalCompatibility: false,
      changedPlannerSource: `
        import { hasQaSmokeAffectingChange, hasControlUiPerformanceAffectingChange as performance } from ${JSON.stringify(plannerUrl)};
        export { hasQaSmokeAffectingChange };
        export const hasControlUiPerformanceAffectingChange = paths => performance(paths, { cwd: ${JSON.stringify(process.cwd())} });
        export const createChangedNodeTestShards = () => null;
        export const createChangedExtensionFallbackShards = () => [];
      `,
    });
    expect(result.status, result.output).toBe(0);
    expect(result.outputs.run_qa_smoke_ci).toBe(String(fixture.qa));
    expect(result.outputs.run_control_ui_performance).toBe(String(fixture.performance));
  });

  it.each([
    { eventName: "pull_request" as const, releaseGate: false, proof: false },
    { eventName: "push" as const, releaseGate: false, proof: true },
    { eventName: "workflow_dispatch" as const, releaseGate: false, proof: true },
    { eventName: "workflow_dispatch" as const, releaseGate: true, proof: false },
  ])("routes proof and boundary coverage for $eventName (releaseGate=$releaseGate)", (fixture) => {
    const manifest = runCiManifestFixture({
      ...fixture,
      bundledPlanner: true,
      historicalCompatibility: false,
      changedPaths: [
        "package.json",
        "scripts/e2e/docker-openai-seed.ts",
        "src/sqlite-session-owner.ts",
      ],
      scopeEnv: {
        GITHUB_REF: "refs/heads/main",
        OPENCLAW_CI_RUN_UI_TESTS: "true",
        OPENCLAW_CI_WORKFLOW_REVISION: "a".repeat(40),
      },
    });
    expect(manifest.status, manifest.output).toBe(0);
    for (const flag of [
      "run_proof_tier",
      "run_docker_seed_e2e",
      "run_qa_smoke_ci",
      "run_sqlite_session_lifecycle",
    ]) {
      expect(manifest.outputs[flag], flag).toBe(String(fixture.proof));
    }
    for (const flag of [
      "run_build_artifacts",
      "run_ui_tests",
      "run_ui_e2e",
      "run_checks_windows",
      "run_channel_contracts_shards",
    ]) {
      expect(manifest.outputs[flag], flag).toBe("true");
    }
    const nodeRows = JSON.parse(
      expectDefined(manifest.outputs.checks_node_core_nondist_matrix, "Node matrix"),
    ).include;
    expect(nodeRows).toContainEqual(
      expect.objectContaining({
        check_name: "bundled-node-plan",
        env: expect.objectContaining({ OPENCLAW_CI_TEST_PROOF_TIER: String(fixture.proof) }),
      }),
    );

    const workflow = readCiWorkflow();
    const context = {
      ...fixture,
      repository: "openclaw/openclaw",
      runAttempt: 1,
      preflightOutputs: { ...manifest.outputs, run_checks_node_core_dist: "true" },
    };
    const evaluateCondition = (expression: string) =>
      evaluateWorkflowExpression(
        expression.startsWith("${{") ? expression : `\${{ ${expression} }}`,
        context,
      );
    expect(evaluateCondition(workflow.jobs["checks-ui-e2e"].if)).toBe(true);
    expect(evaluateCondition(workflow.jobs["checks-ui-e2e-real-gateway"].if)).toBe(fixture.proof);
    const steps = workflow.jobs["build-artifacts"].steps as WorkflowStep[];
    const verifiers = expectDefined(
      steps.find((step) => step.name === "Run built artifact checks"),
      "built verifiers",
    );
    for (const name of ["RUN_PROCESS_PROOFS", "RUN_GATEWAY_WATCH", "RUN_TUI_PTY"]) {
      expect(String(evaluateWorkflowExpression(verifiers.env?.[name], context)), name).toBe(
        String(fixture.proof),
      );
    }
    for (const name of ["RUN_CHANNELS", "RUN_CORE_SUPPORT_BOUNDARY"]) {
      expect(String(evaluateWorkflowExpression(verifiers.env?.[name], context)), name).toBe("true");
    }
    for (const name of [
      "Verify built browser native host",
      "Upload Discord component attachment proof",
      "Upload gateway watch regression artifacts",
    ]) {
      const step = expectDefined(
        steps.find((candidate) => candidate.name === name),
        name,
      );
      expect(evaluateCondition(expectDefined(step.if, name)), name).toBe(fixture.proof);
    }
  });

  it("uses target-owned Windows shards on every runner backend and preserves frozen plans", () => {
    const workflow = readCiWorkflow();
    const runStep = workflow.jobs["checks-windows"].steps.find(
      (step: WorkflowStep) => step.name === "Run ${{ matrix.task }} (${{ matrix.runtime }})",
    );
    const blacksmith = runCiManifestFixture({
      bundledPlanner: true,
      eventName: "push",
      historicalCompatibility: false,
      runnerBackend: "blacksmith",
    });
    const github = runCiManifestFixture({
      bundledPlanner: true,
      eventName: "push",
      historicalCompatibility: false,
      runnerBackend: "github",
    });
    const hybrid = runCiManifestFixture({
      bundledPlanner: true,
      eventName: "push",
      historicalCompatibility: false,
      runnerBackend: "hybrid",
    });
    const hybridDispatch = runCiManifestFixture({
      bundledPlanner: true,
      eventName: "workflow_dispatch",
      historicalCompatibility: false,
      runnerBackend: "hybrid",
    });

    expect(blacksmith.status, blacksmith.output).toBe(0);
    expect(github.status, github.output).toBe(0);
    expect(hybrid.status, hybrid.output).toBe(0);
    expect(hybridDispatch.status, hybridDispatch.output).toBe(0);
    const expectedWindowsMatrix = Array.from({ length: 5 }, (_, index) =>
      expect.objectContaining({
        check_name: `checks-windows-node-test-${index + 1}`,
        targets: [`test/windows-part-${index + 1}.test.ts`],
        predicted_seconds: 400,
      }),
    );
    for (const [label, manifest] of [
      ["Blacksmith", blacksmith],
      ["GitHub", github],
      ["hybrid", hybrid],
      ["hybrid dispatch", hybridDispatch],
    ] as const) {
      expect(
        JSON.parse(expectDefined(manifest.outputs.checks_windows_matrix, `${label} Windows matrix`))
          .include,
        label,
      ).toEqual(expectedWindowsMatrix);
    }
    const frozen = runCiManifestFixture({ bundledPlanner: true, windowsPlanner: false });
    expect(frozen.status, frozen.output).toBe(0);
    expect(
      JSON.parse(expectDefined(frozen.outputs.checks_windows_matrix, "frozen Windows matrix"))
        .include,
    ).toEqual([
      { check_name: "checks-windows-node-test-1", runtime: "node", task: "test-1" },
      { check_name: "checks-windows-node-test-2", runtime: "node", task: "test-2" },
    ]);
    expect(runStep.run).toContain('scripts?.["test:windows:ci:1"]');
    expect(runStep.run).toContain('scripts?.["test:windows:ci:2"]');
    expect(runStep.run).toContain("pnpm test:windows:ci");
    expect(runStep.run).toContain("target's combined Windows suite ran in test-1");
    expect(runStep.run).not.toContain("pnpm test:windows:ci:3");
  });

  it.skipIf(process.platform === "win32").for(["blacksmith", "github", "hybrid"] as const)(
    "executes each Mac partition once and keeps historical coverage on %s",
    (runnerBackend) => {
      const workflow = readCiWorkflow();
      const job = workflow.jobs["macos-node"];
      const runStep = job.steps.find((step: WorkflowStep) => step.name === "TS tests (macOS)");
      const cwd = tempDirs.make("macos-partition-routing-");
      const bin = path.join(cwd, "bin");
      mkdirSync(bin);
      writeFileSync(path.join(bin, "pnpm"), '#!/bin/sh\nprintf "selected=%s\\n" "$*"\n');
      chmodSync(path.join(bin, "pnpm"), 0o755);
      for (const partsSupported of [true, false]) {
        const manifest = runCiManifestFixture({
          bundledPlanner: true,
          eventName: "workflow_dispatch",
          historicalCompatibility: !partsSupported,
          macosNodeParts: partsSupported,
          runnerBackend,
        });
        expect(manifest.status, manifest.output).toBe(0);
        const rows = JSON.parse(
          expectDefined(manifest.outputs.macos_node_matrix, "Mac Node matrix"),
        ).include as Array<{ task: string }>;
        expect(rows.map(({ task }) => task)).toEqual(
          partsSupported ? ["test-1", "test-2", "test-3"] : ["test"],
        );
        const commands = rows.map(({ task }) => {
          const result = runWorkflowShellScript(runStep.run, {
            cwd,
            env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, TASK: task },
          });
          expect(result.status, result.stdout + result.stderr).toBe(0);
          return result.stdout.match(/^selected=(.*)$/m)?.[1];
        });
        expect(commands).toEqual(
          partsSupported
            ? ["test:macos:ci:1", "test:macos:ci:2", "test:macos:ci:3"]
            : ["test:macos:ci"],
        );
      }
      expect(job.strategy["max-parallel"]).toBe(3);
      expect(runStep.env.OPENCLAW_VITEST_MAX_WORKERS).toBe(2);
    },
  );

  describe("Android validation tiers", () => {
    function runAndroidTask(
      row: Record<string, unknown>,
      context: Parameters<typeof evaluateWorkflowExpression>[1],
      failTask = "",
    ) {
      const step: WorkflowStep = expectDefined(
        readCiWorkflow().jobs.android.steps.find(
          (candidate: WorkflowStep) => candidate.name === "Run Android ${{ matrix.task }}",
        ),
        "Android task runner",
      );
      const root = tempDirs.make("openclaw-android-tier-");
      const callsPath = path.join(root, "gradle-calls.jsonl");
      const clockPath = path.join(root, "clock-reads.jsonl");
      const gradleJavaHome = path.join(root, "gradle jdk");
      const action = readAndroidToolchainAction();
      const setupStep: WorkflowStep = expectDefined(
        readCiWorkflow().jobs.android.steps.find(
          (candidate: WorkflowStep) => candidate.name === "Setup Android toolchain",
        ),
        "Android toolchain setup",
      );
      const gradleJavaOutputs = {
        path: gradleJavaHome,
        version: "21.0.12+101.0.LTS",
      };
      const setupOutputs = Object.fromEntries(
        ["gradle-java-home", "gradle-java-version"].map((key) => [
          key,
          String(
            evaluateWorkflowExpression(action.outputs[key].value, {
              ...context,
              steps: { "gradle-java": { outputs: gradleJavaOutputs } },
            }),
          ),
        ]),
      );
      writeExecutable(path.join(root, "date"), [
        "#!/usr/bin/env node",
        'const fs = require("node:fs");',
        'const previous = fs.existsSync(process.env.CLOCK_READS) ? fs.readFileSync(process.env.CLOCK_READS, "utf8").trim().split("\\n") : [];',
        "const instant = new Date(1700000000000 + previous.length * 1000).toISOString();",
        'fs.appendFileSync(process.env.CLOCK_READS, instant + "\\n");',
        "console.log(instant);",
      ]);
      writeExecutable(path.join(root, "gradlew"), [
        "#!/usr/bin/env node",
        'require("node:fs").appendFileSync(process.env.GRADLE_CALLS, JSON.stringify({ args: process.argv.slice(2), javaHome: process.env.JAVA_HOME }) + "\\n");',
        "if (process.argv.includes(process.env.FAIL_GRADLE_TASK)) process.exit(23);",
      ]);
      const result = runWorkflowShellScript(expectDefined(step.run, "Android commands"), {
        linuxWorkflow: true,
        cwd: root,
        env: {
          ...process.env,
          JAVA_HOME: path.join(root, "sdk jdk 17"),
          ...Object.fromEntries(
            Object.entries(step.env ?? {}).map(([key, value]) => [
              key,
              String(
                evaluateWorkflowExpression(value, {
                  ...context,
                  matrix: row,
                  steps: {
                    ...context.steps,
                    [expectDefined(setupStep.id, "Android toolchain step id")]: {
                      outputs: setupOutputs,
                    },
                  },
                }),
              ),
            ]),
          ),
          GITHUB_EVENT_NAME: context.eventName,
          OPENCLAW_ROBOLECTRIC_INIT: "robolectric.gradle",
          GRADLE_CALLS: callsPath,
          FAIL_GRADLE_TASK: failTask,
          CLOCK_READS: clockPath,
          PATH: `${root}${path.delimiter}${process.env.PATH}`,
        },
      });
      const invocations: Array<{ args: string[]; javaHome: string }> = existsSync(callsPath)
        ? readFileSync(callsPath, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line))
        : [];
      const calls = invocations.map(({ args }) => args);
      expect(invocations.map(({ javaHome }) => javaHome)).toEqual(calls.map(() => gradleJavaHome));
      const clockReads = existsSync(clockPath)
        ? readFileSync(clockPath, "utf8").trim().split("\n")
        : [];
      return {
        ...result,
        calls,
        clockReads,
        tasks: calls.flat().filter((arg) => arg.startsWith(":")),
      };
    }

    it.each([
      { task: "test-wear", lint: true, app_lint: "third-party", build_benchmark: false, calls: 3 },
      { task: "ktlint", lint: false, app_lint: "play", build_benchmark: false, calls: 2 },
      { task: "ktlint", lint: false, app_lint: "play", build_benchmark: true, calls: 3 },
    ])(
      "reuses one build instant across every command in $task with benchmark=$build_benchmark",
      ({ calls, ...row }) => {
        const result = runAndroidTask(row, {
          eventName: "pull_request",
          repository: "openclaw/openclaw",
          runAttempt: 1,
        });
        expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
        expect(result.calls).toHaveLength(calls);
        const metadata = result.calls.map((call) =>
          call.filter((arg) => arg.startsWith("-PopenclawBuildTimestamp=")),
        );
        expect(result.clockReads).toHaveLength(1);
        expect(metadata).toEqual(
          result.calls.map(() => [`-PopenclawBuildTimestamp=${result.clockReads[0]}`]),
        );
      },
    );

    it.each([
      { eventName: "pull_request", releaseGate: false, full: false, legacy: false },
      { eventName: "push", releaseGate: false, full: false, legacy: false },
      { eventName: "workflow_dispatch", releaseGate: true, full: false, legacy: false },
      { eventName: "workflow_dispatch", releaseGate: false, full: true, legacy: false },
      { eventName: "workflow_dispatch", releaseGate: false, full: true, legacy: true },
    ] as const)(
      "executes Android test/lint and retained full-tier commands for %j",
      ({ eventName, releaseGate, full, legacy }) => {
        const manifest = runCiManifestFixture({
          bundledPlanner: !legacy,
          eventName,
          releaseGate,
          historicalCompatibility: true,
          changedPaths: ["apps/android/app/src/main/java/ai/openclaw/app/Example.kt"],
        });
        expect(manifest.status, manifest.output).toBe(0);
        const rows: Record<string, unknown>[] = JSON.parse(
          expectDefined(manifest.outputs.android_matrix, "Android matrix"),
        ).include;
        expect(rows.map(({ task }) => task)).toEqual(
          legacy
            ? ["test-play-compat", "test-third-party", "build-play-compat"]
            : [
                "test-play",
                "test-third-party",
                "test-wear",
                ...(full ? ["build-play", "build-wear"] : []),
                "ktlint",
              ],
        );
        const context = {
          eventName,
          releaseGate,
          repository: "openclaw/openclaw",
          runAttempt: 1,
          preflightOutputs: manifest.outputs,
        };
        const tasks = rows.flatMap((row) => {
          const result = runAndroidTask(row, context);
          expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
          for (const call of result.calls) {
            expect(call).toContain("--no-daemon");
            expect(call).toContain("--build-cache");
            const testCall = call.some((arg) => arg.endsWith("UnitTest"));
            expect(call.includes("--init-script")).toBe(testCall);
          }
          if (row.lint !== true && !row.app_lint) {
            expect(result.clockReads).toEqual([]);
            expect(
              result.calls.flat().filter((arg) => arg.startsWith("-PopenclawBuildTimestamp=")),
            ).toEqual([]);
          }
          if (row.task === "build-play") {
            expect(result.calls.map((call) => call.filter((arg) => arg.startsWith(":")))).toEqual([
              [":app:assemblePlayDebug", ":app:lintPlayDebug"],
              [":app:assembleThirdPartyDebug", ":app:lintThirdPartyDebug"],
              [":benchmark:assembleDebug", ":wear-shared:assembleDebug", ":wear-shared:lintDebug"],
            ]);
          }
          return result.tasks;
        });
        expect(tasks.toSorted()).toEqual(
          (legacy
            ? [
                ":app:testPlayDebugUnitTest",
                ":app:testThirdPartyDebugUnitTest",
                ":app:assemblePlayDebug",
              ]
            : [
                ":app:testPlayDebugUnitTest",
                ":wear-shared:testDebugUnitTest",
                ":app:testThirdPartyDebugUnitTest",
                ":wear:testDebugUnitTest",
                ":app:lintPlayDebug",
                ":app:lintThirdPartyDebug",
                ":wear-shared:lintDebug",
                ":wear:lintDebug",
                ":app:ktlintCheck",
                ":benchmark:ktlintCheck",
                ":wear:ktlintCheck",
                ":wear-shared:ktlintCheck",
                ...(full
                  ? [
                      ":app:assemblePlayDebug",
                      ":app:assembleThirdPartyDebug",
                      ":benchmark:assembleDebug",
                      ":wear-shared:assembleDebug",
                      ":wear:assembleDebug",
                    ]
                  : []),
              ]
          ).toSorted(),
        );
        expect(new Set(tasks).size, "no duplicate lint or build invocations").toBe(tasks.length);
        for (const result of ["failure", "cancelled", "skipped"]) {
          expect(
            runCiGateFixture(renderCiGateEnvironment(context, { android: result })).status,
          ).toBe(1);
        }
      },
    );

    it.each([
      { paths: ["apps/android/benchmark/src/main/Example.kt"], build: true },
      { paths: ["apps/android/build.gradle.kts"], build: true },
      { paths: ["apps/android/app/build.gradle.kts"], build: true },
      { paths: ["apps/android/settings.gradle.kts"], build: true },
      { paths: ["apps/android/gradle.properties"], build: true },
      { paths: ["apps/android/gradle/libs.versions.toml"], build: true },
      { paths: ["apps/android/gradle/wrapper/gradle-wrapper.properties"], build: true },
      { paths: ["apps/android/gradlew"], build: true },
      { paths: ["apps/android/Config/Version.properties"], build: true },
      { paths: ["apps/android/app/src/main/java/ai/openclaw/app/Example.kt"], build: false },
      { paths: ["apps/android/wear/src/main/Example.kt"], build: false },
      { paths: ["docs/ci.md"], build: false },
      { paths: [], build: true },
      { paths: [""], build: true },
      { paths: null, build: true },
      { paths: undefined, build: true },
      { paths: undefined, json: "{", build: true },
      { paths: undefined, json: "[42]", build: true },
    ])("retains benchmark assembly for changed or unknown inputs: %j", ({ paths, json, build }) => {
      const manifest = runCiManifestFixture({
        bundledPlanner: true,
        eventName: "pull_request",
        runNode: false,
        changedPaths: paths,
        ...(json ? { scopeEnv: { OPENCLAW_CI_CHANGED_PATHS_JSON: json } } : {}),
      });
      expect(manifest.status, manifest.output).toBe(0);
      const rows: Record<string, unknown>[] = JSON.parse(
        expectDefined(manifest.outputs.android_matrix, "Android matrix"),
      ).include;
      expect(rows).toHaveLength(4);
      const result = runAndroidTask(
        expectDefined(
          rows.find(({ task }) => task === "ktlint"),
          "Kotlin lint row",
        ),
        {
          eventName: "pull_request",
          repository: "openclaw/openclaw",
          runAttempt: 1,
        },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.tasks.includes(":benchmark:assembleDebug")).toBe(build);
    });

    it.each([
      { task: "test-play", failTask: ":app:testPlayDebugUnitTest", calls: 1 },
      { task: "test-third-party", failTask: ":app:testThirdPartyDebugUnitTest", calls: 1 },
      {
        task: "test-wear",
        lint: true,
        app_lint: "third-party",
        failTask: ":wear:testDebugUnitTest",
        calls: 1,
      },
      {
        task: "test-wear",
        lint: true,
        app_lint: "third-party",
        failTask: ":wear:lintDebug",
        calls: 2,
      },
      {
        task: "test-wear",
        lint: true,
        app_lint: "third-party",
        failTask: ":app:lintThirdPartyDebug",
        calls: 3,
      },
      {
        task: "ktlint",
        app_lint: "play",
        build_benchmark: true,
        failTask: ":benchmark:assembleDebug",
        calls: 2,
      },
      {
        task: "ktlint",
        app_lint: "play",
        build_benchmark: true,
        failTask: ":app:lintPlayDebug",
        calls: 3,
      },
    ])("propagates $task failure from $failTask", ({ failTask, calls, ...row }) => {
      const result = runAndroidTask(
        row,
        { eventName: "pull_request", repository: "openclaw/openclaw", runAttempt: 1 },
        failTask,
      );
      expect(result.status).toBe(23);
      expect(result.calls).toHaveLength(calls);
    });
  });

  describe("CI workflow admission", () => {
    type EventContext = Parameters<typeof evaluateWorkflowExpression>[1];
    type AdmissionRun = {
      context: EventContext;
      group: string;
      state: "pending" | "running" | "cancelling" | "cancelled" | "completed" | "skipped";
      eligibleJobs?: string[];
    };
    const guardedJobs = ["preflight", "security-fast", "ci-gate"];
    const event = (runId: number, overrides: Partial<EventContext> = {}): EventContext => ({
      eventName: "pull_request",
      action: "ready_for_review",
      draft: false,
      pullRequestNumber: 7,
      headSha: "a".repeat(40),
      sha: "b".repeat(40),
      ref: "refs/pull/7/merge",
      repository: "openclaw/openclaw",
      workflow: "CI",
      runAttempt: 1,
      runId,
      runNumber: runId,
      ...overrides,
    });

    function admissionDriver() {
      const workflow = readCiWorkflow();
      const runs: AdmissionRun[] = [];
      const active = (run: AdmissionRun) => run.state === "running" || run.state === "cancelling";
      return {
        admit(context: EventContext): AdmissionRun {
          if (context.eventName === "pull_request") {
            expect(workflow.on.pull_request.types).toContain(context.action);
          }
          const group: string = evaluateWorkflowExpression(workflow.concurrency.group, context);
          const cancel = evaluateWorkflowExpression(
            workflow.concurrency["cancel-in-progress"],
            context,
          );
          // GitHub replaces pending work even without active cancellation:
          // https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency
          for (const previous of runs.filter(
            (run) => run.group.toLowerCase() === group.toLowerCase(),
          )) {
            if (previous.state === "pending") {
              previous.state = "cancelled";
            }
            if (active(previous) && cancel) {
              previous.state = "cancelling";
            }
          }
          const run: AdmissionRun = { context, group, state: "pending" };
          runs.push(run);
          return run;
        },
        start(run: AdmissionRun) {
          if (
            run.state !== "pending" ||
            runs.some((other) => other.group === run.group && active(other))
          ) {
            return;
          }
          // Admission precedes job conditions. This probes eligibility, not the job DAG.
          run.eligibleJobs = guardedJobs.filter((job) => {
            const condition: string = workflow.jobs[job].if;
            return evaluateWorkflowExpression(
              condition.startsWith("${{") ? condition : `\${{ ${condition} }}`,
              run.context,
            );
          });
          run.state = run.eligibleJobs.length ? "running" : "skipped";
        },
        finish(run: AdmissionRun) {
          expect(active(run)).toBe(true);
          run.state = run.state === "cancelling" ? "cancelled" : "completed";
        },
        cancel(run: AdmissionRun) {
          run.state = "cancelled";
        },
      };
    }

    // Synthetic admission orders, not recovered webhook payloads.
    it.each(
      ["opened", "reopened", "synchronize"].flatMap((action) =>
        ["pending", "running"].map((state) => ({ action, state })),
      ),
    )("preserves $state ready CI after a delayed draft $action", ({ action, state }) => {
      const scheduler = admissionDriver();
      const predecessor = scheduler.admit(event(1, { action: "opened" }));
      scheduler.start(predecessor);
      const ready = scheduler.admit(event(2));
      if (state === "running") {
        scheduler.finish(predecessor);
        scheduler.start(ready);
      }
      expect(ready.state).toBe(state);
      const lateDraft = scheduler.admit(event(3, { action, draft: true }));
      expect(ready.state, "late draft displaced runnable ready CI").toBe(state);
      scheduler.start(lateDraft);
      expect(lateDraft.state).toBe("skipped");
      expect(lateDraft.eligibleJobs).toEqual([]);
      const anotherDraft = scheduler.admit(event(4, { action, draft: true }));
      expect(anotherDraft.group).not.toBe(lateDraft.group);
      expect(lateDraft.group).not.toBe(ready.group);
      if (state === "pending") {
        expect(ready.eligibleJobs).toBeUndefined();
        scheduler.start(ready);
        expect(ready.state).toBe("pending");
        scheduler.finish(predecessor);
        scheduler.start(ready);
      }
      expect(ready.state).toBe("running");
      expect(ready.eligibleJobs).toEqual(guardedJobs);
    });

    it("admits ready CI after the forward draft-to-ready sequence", () => {
      const scheduler = admissionDriver();
      const draft = scheduler.admit(event(1, { action: "opened", draft: true }));
      scheduler.start(draft);
      expect(draft.eligibleJobs).toEqual([]);
      expect(draft.state).toBe("skipped");
      const ready = scheduler.admit(event(2));
      scheduler.start(ready);
      expect(ready.group).toBe("CI-v7-7");
      expect(ready.eligibleJobs).toEqual(guardedJobs);
    });

    it.each(["pending", "running"])(
      "converted_to_draft cancels %s CI and skips its jobs",
      (state) => {
        const scheduler = admissionDriver();
        const previous = scheduler.admit(event(1));
        scheduler.start(previous);
        const ready = state === "pending" ? scheduler.admit(event(2)) : previous;
        const converted = scheduler.admit(event(3, { action: "converted_to_draft", draft: true }));
        expect(converted.group).toBe("CI-v7-7");
        expect(ready.state).toBe(state === "pending" ? "cancelled" : "cancelling");
        expect(previous.state).toBe("cancelling");
        scheduler.finish(previous);
        scheduler.start(converted);
        expect(converted.state).toBe("skipped");
        expect(converted.eligibleJobs).toEqual([]);
      },
    );

    it.each(["pending", "running"])(
      "a newer non-draft head supersedes %s CI only for its PR",
      (state) => {
        const scheduler = admissionDriver();
        const otherPr = scheduler.admit(
          event(1, { pullRequestNumber: 8, ref: "refs/pull/8/merge" }),
        );
        scheduler.start(otherPr);
        const old = scheduler.admit(event(2));
        if (state === "running") {
          scheduler.start(old);
        }
        const next = scheduler.admit(
          event(3, {
            action: "synchronize",
            headSha: "c".repeat(40),
            sha: "d".repeat(40),
          }),
        );
        expect(next.group).toBe(old.group);
        expect(old.state).toBe(state === "pending" ? "cancelled" : "cancelling");
        expect(otherPr.state).toBe("running");
        if (state === "running") {
          scheduler.finish(old);
        }
        scheduler.start(next);
        expect(next.eligibleJobs).toEqual(guardedJobs);
      },
    );

    it("isolates manual dispatches on the same target from each other and PR CI", () => {
      const scheduler = admissionDriver();
      const ready = scheduler.admit(event(1));
      scheduler.start(ready);
      const manual = [2, 3].map((runId) =>
        scheduler.admit(
          event(runId, {
            eventName: "workflow_dispatch",
            targetRef: "a".repeat(40),
          }),
        ),
      );
      for (const run of manual) {
        scheduler.start(run);
        expect(run.state).toBe("running");
        expect(run.eligibleJobs).toEqual(guardedJobs);
      }
      expect(manual.map((run) => run.group)).toEqual(["CI-manual-v1-2", "CI-manual-v1-3"]);
      expect(ready.state).toBe("running");
    });

    it.each(["pending", "running"])(
      "passive drafts do not resurrect explicitly cancelled %s CI",
      (state) => {
        const scheduler = admissionDriver();
        const ready = scheduler.admit(event(1));
        if (state === "running") {
          scheduler.start(ready);
        }
        scheduler.cancel(ready);
        const draft = scheduler.admit(event(2, { action: "synchronize", draft: true }));
        scheduler.start(draft);
        scheduler.start(ready);
        expect(ready.state).toBe("cancelled");
        expect(draft.state).toBe("skipped");
        expect(draft.eligibleJobs).toEqual([]);
        expect(
          evaluateWorkflowExpression(readCiWorkflow().jobs["ci-gate"].if, {
            ...ready.context,
            cancelled: ready.state === "cancelled",
          }),
        ).toBe(false);
      },
    );

    it("pipelines opted-in canonical main across two non-canceling slots with coalesced pending work", () => {
      const workflow = readCiWorkflow();
      const scheduler = admissionDriver();
      const push = (runId: number) =>
        event(runId, {
          ciOnPush: "true",
          eventName: "push",
          ref: "refs/heads/main",
          sha: runId.toString(16).padStart(40, "0"),
        });
      for (let digit = 0; digit < 10; digit++) {
        expect(evaluateWorkflowExpression(workflow.concurrency.group, push(100 + digit))).toBe(
          `CI-v8-refs/heads/main-${digit % 2 === 0 ? "a" : "b"}`,
        );
        expect(
          evaluateWorkflowExpression(workflow.concurrency["cancel-in-progress"], push(100 + digit)),
        ).toBe(false);
      }
      const active = [20, 21].map((id) => scheduler.admit(push(id)));
      active.forEach((run) => scheduler.start(run));
      const pending = [22, 23].map((id) => scheduler.admit(push(id)));
      const newest = [24, 25].map((id) => scheduler.admit(push(id)));
      expect(active.map((run) => run.state)).toEqual(["running", "running"]);
      expect(pending.map((run) => run.state)).toEqual(["cancelled", "cancelled"]);
      for (const run of newest) {
        scheduler.start(run);
        expect(run.state).toBe("pending");
        expect(run.eligibleJobs).toBeUndefined();
      }
      scheduler.finish(active[0]!);
      newest.forEach((run) => scheduler.start(run));
      expect(newest.map((run) => run.state)).toEqual(["running", "pending"]);
      scheduler.finish(active[1]!);
      scheduler.start(newest[1]!);
      expect(newest.map((run) => run.state)).toEqual(["running", "running"]);
      expect(workflow.jobs["runner-admission"]).toBeUndefined();
      expect(workflow.jobs.preflight.needs).toBeUndefined();
      expect(workflow.jobs["security-fast"].needs).toEqual(["preflight"]);
    });

    it.each([
      ["openclaw/openclaw", "refs/heads/topic", "CI-v7-refs/heads/topic"],
      ["contributor/fork", "refs/heads/main", `CI-v7-refs/heads/main-${"b".repeat(40)}`],
      ["contributor/fork", "refs/heads/topic", `CI-v7-refs/heads/topic-${"b".repeat(40)}`],
    ])("preserves push grouping for %s on %s", (repository, ref, group) => {
      const workflow = readCiWorkflow();
      const context = event(1, { eventName: "push", repository, ref });
      expect(evaluateWorkflowExpression(workflow.concurrency.group, context)).toBe(group);
      expect(evaluateWorkflowExpression(workflow.concurrency["cancel-in-progress"], context)).toBe(
        false,
      );
    });
  });

  it.each([
    {
      buildImpact: false,
      uiE2e: false,
      distRequired: false,
      nativePaths: [],
      nativeChecks: { macos: false, ios: false, android: false },
    },
    {
      buildImpact: true,
      uiE2e: true,
      distRequired: false,
      nativePaths: ["apps/shared/OpenClawKit/Sources/OpenClawKit/Example.swift"],
      nativeChecks: { macos: true, ios: true, android: false },
    },
    {
      buildImpact: false,
      uiE2e: false,
      distRequired: true,
      nativePaths: ["apps/android/app/src/main/java/Example.kt"],
      nativeChecks: { macos: false, ios: false, android: true },
    },
  ])(
    "composes dedicated suite coverage before precise planning (build=$buildImpact, UI=$uiE2e, dist=$distRequired)",
    ({ buildImpact, uiE2e, distRequired, nativePaths, nativeChecks }) => {
      const runnerProfile = buildImpact || distRequired ? "hybrid" : "blacksmith";
      const manifest = runCiManifestFixture({
        runnerProfile,
        bundledPlanner: true,
        eventName: "pull_request",
        changedPaths: [
          buildImpact ? "src/fixture.ts" : "src/plugins/contracts/fixture-a.test.ts",
          ...nativePaths,
        ],
        scopeEnv: {
          OPENCLAW_CI_RUN_UI_TESTS: String(uiE2e),
          OPENCLAW_CI_RUN_MACOS: String(nativeChecks.macos),
          OPENCLAW_CI_RUN_IOS_BUILD: String(nativeChecks.ios),
          OPENCLAW_CI_RUN_ANDROID: String(nativeChecks.android),
        },
        changedPlannerSource: `
        export const createChangedNodeTestShards = (_paths, options = {}) => {
          console.log("dedicated-coverage:" + JSON.stringify(options));
          return ${
            buildImpact
              ? "[]"
              : `[{ checkName: "changed-boundary", shardName: "changed-boundary",
            configs: ["test/vitest/vitest.boundary.config.ts"], requiresDist: ${distRequired},
            runner: "ubuntu-24.04" }]`
          };
        };
        export const createChangedExtensionFallbackShards = () => { throw new Error("Unexpected broad fallback"); };
        export const hasBuildArtifactAffectingChange = () => ${buildImpact};
        export const hasSqliteSessionLifecycleAffectingChange = () => false;
      `,
      });
      expect(manifest.status, manifest.output).toBe(0);
      const dedicated = ["plugin", "channel"].flatMap((family) => {
        expect(manifest.outputs[`run_${family}_contracts_shards`]).toBe("true");
        const rows = JSON.parse(
          expectDefined(manifest.outputs[`${family}_contracts_matrix`], family),
        ).include;
        expect(rows).toHaveLength(1);
        return rows.flatMap((row: { groups: unknown[] }) => row.groups);
      });
      expect(dedicated).toHaveLength(4);
      const coverage = expectDefined(
        manifest.output.split("\n").find((line) => line.startsWith("dedicated-coverage:")),
        "precise planner coverage input",
      );
      expect(JSON.parse(coverage.slice("dedicated-coverage:".length))).toEqual({
        includeReleaseOnlyToolingShards: false,
        includeReleaseOnlyRuntimeTests: false,
        runnerBackend: runnerProfile,
        dedicatedContractShards: dedicated,
        dedicatedCoreTypeChecks: true,
        dedicatedNativeChecks: nativeChecks,
        dedicatedUiE2e: uiE2e,
        dedicatedMaxLinesRatchet: true,
      });
      const workflow = readCiWorkflow();
      const typeContext = {
        eventName: "pull_request",
        repository: "openclaw/openclaw",
        runAttempt: 1,
        runnerProfile,
        preflightOutputs: manifest.outputs,
      } satisfies Parameters<typeof evaluateWorkflowExpression>[1];
      expect(manifest.outputs.changed_core_test_paths_json).toBe("");
      expect(evaluateWorkflowExpression(workflow.jobs["check-shard"].if, typeContext)).toBe(true);
      expect(workflow.jobs["check-shard"].strategy.matrix.include).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ task: "prod-types" }),
          expect.objectContaining({ task: "test-types" }),
        ]),
      );
      expect(manifest.outputs.run_check_additional).toBe("true");
      expect(
        JSON.parse(expectDefined(manifest.outputs.check_additional_matrix, "type boundaries"))
          .include,
      ).toContainEqual(expect.objectContaining({ group: "boundaries" }));
      const hostedTypes = workflow.jobs["check-test-types-hosted-core-shard"];
      expect(evaluateWorkflowExpression(hostedTypes.if, typeContext)).toBe(
        runnerProfile === "hybrid",
      );
      if (runnerProfile === "hybrid") {
        expect(evaluateWorkflowExpression(hostedTypes.strategy.matrix.stripe, typeContext)).toEqual(
          [1, 2, 3, 4, 5],
        );
      }
      for (const [job, admitted] of [
        ["macos-swift", nativeChecks.macos],
        ["ios-build", nativeChecks.ios],
        ["android", nativeChecks.android],
      ] as const) {
        expect(
          evaluateWorkflowExpression(`\${{ ${workflow.jobs[job].if} }}`, typeContext),
          job,
        ).toBe(admitted);
      }
      for (const job of ["checks-ui-e2e", "checks-ui-e2e-real-gateway"]) {
        expect(
          evaluateWorkflowExpression(`\${{ ${readCiWorkflow().jobs[job].if} }}`, {
            eventName: "pull_request",
            repository: "openclaw/openclaw",
            runAttempt: 1,
            preflightOutputs: manifest.outputs,
          }),
          job,
        ).toBe(job === "checks-ui-e2e" && uiE2e);
      }
      const nodeRows = JSON.parse(
        expectDefined(manifest.outputs.checks_node_core_nondist_matrix, "precise matrix"),
      ).include;
      expect(nodeRows).toEqual(
        buildImpact || distRequired
          ? []
          : [expect.objectContaining({ shard_name: "changed-boundary" })],
      );
      expect(manifest.outputs.run_build_artifacts).toBe(String(buildImpact || distRequired));
      expect(manifest.outputs.run_checks_node_core_dist).toBe(String(buildImpact || distRequired));
    },
  );

  it.each([
    ["push", "blacksmith", false],
    ["pull_request", "github", false],
    ["pull_request", "hybrid", false],
    ["workflow_dispatch", "blacksmith", false],
    ["workflow_dispatch", "blacksmith", true],
    ["workflow_dispatch", "github", true],
  ] as const)(
    "shares contract setup while retaining process envelopes (%s, %s, frozen=%s)",
    (eventName, runnerProfile, frozenTarget) => {
      const manifest = runCiManifestFixture({
        bundledPlanner: true,
        changedPaths: ["package.json"],
        eventName,
        runnerProfile,
        scopeEnv: {
          OPENCLAW_CI_WORKFLOW_REVISION: (frozenTarget ? "b" : "a").repeat(40),
        },
      });
      expect(manifest.status, manifest.output).toBe(0);
      for (const family of ["plugin", "channel"] as const) {
        const outputName = `${family}_contracts_matrix`;
        const rows = JSON.parse(expectDefined(manifest.outputs[outputName], outputName)).include;
        const expected = ["a", "b"].map((suffix) => ({
          checkName: `${family}-contracts-${suffix}`,
          includePatterns: [
            `${family === "plugin" ? "src/plugins" : "src/channels/plugins"}/contracts/fixture-${suffix}.test.ts`,
          ],
          runtime: "node",
          task: `contracts-${family}s`,
        }));
        expect(rows).toHaveLength(frozenTarget ? 2 : 1);
        expect(rows.flatMap((row: { groups: unknown[] }) => row.groups)).toEqual(expected);
        expect(rows.map((row: { checkName: string }) => row.checkName)).toEqual(
          frozenTarget
            ? expected.map((shard) => shard.checkName)
            : [`checks-fast-contracts-${family}s`],
        );
      }
    },
  );

  it("resolves one event-aware logical runner profile without changing physical routing", () => {
    const scenarios: {
      expected: string;
      expectedNode?: string;
      name: string;
      options: Parameters<typeof runRunnerProfileFixture>[0];
    }[] = [
      {
        expected: "github",
        name: "current manual dispatch ignores configured Blacksmith",
        options: {
          configuredProfile: "blacksmith",
          eventName: "workflow_dispatch" as const,
          targetSupportsContract: true,
        },
      },
      {
        expected: "blacksmith",
        name: "canonical trusted push keeps the default",
        options: {
          eventName: "push" as const,
          targetSupportsContract: true,
        },
      },
      {
        expected: "github",
        name: "canonical trusted push keeps configured GitHub",
        options: {
          configuredProfile: "github",
          eventName: "push" as const,
          targetSupportsContract: true,
        },
      },
      {
        expected: "hybrid",
        name: "canonical trusted hybrid retry keeps the hybrid workload shape",
        options: {
          authorAssociation: "CONTRIBUTOR",
          configuredProfile: "hybrid",
          eventName: "pull_request" as const,
          runAttempt: 2,
          targetSupportsContract: true,
        },
      },
      {
        expected: "github",
        name: "fork pull request is hosted",
        options: {
          configuredProfile: "hybrid",
          eventName: "pull_request" as const,
          headRepository: "contributor/openclaw",
          targetSupportsContract: true,
        },
      },
      {
        expected: "github",
        name: "untrusted same-repository pull request is hosted",
        options: {
          authorAssociation: "NONE",
          configuredProfile: "blacksmith",
          eventName: "pull_request" as const,
          targetSupportsContract: true,
        },
      },
      {
        expected: "github",
        name: "noncanonical repository is hosted",
        options: {
          configuredProfile: "blacksmith",
          eventName: "push" as const,
          repository: "fork/openclaw",
          targetSupportsContract: true,
        },
      },
      {
        expected: "blacksmith",
        name: "frozen target without the marker keeps legacy dispatch behavior",
        options: {
          configuredProfile: "blacksmith",
          eventName: "workflow_dispatch" as const,
          targetSupportsContract: false,
        },
      },
      {
        expected: "github",
        name: "frozen target with the marker uses event-aware dispatch behavior",
        options: {
          configuredProfile: "blacksmith",
          eventName: "workflow_dispatch" as const,
          targetSupportsContract: true,
        },
      },
      ...[
        { name: "trusted canonical PR", expected: "hybrid", expectedNode: "runson" },
        { name: "PR retry", expected: "hybrid", expectedNode: "hybrid", runAttempt: 2 },
        { name: "returning-contributor fork", expected: "github", headRepository: "fork/openclaw" },
        { name: "untrusted author", expected: "github", authorAssociation: "NONE" },
        { name: "noncanonical repository", expected: "github", repository: "fork/openclaw" },
        { name: "push", expected: "hybrid", eventName: "push" as const },
        { name: "ordinary dispatch", expected: "github", eventName: "workflow_dispatch" as const },
        { name: "target without RunsOn contract", expected: "hybrid", targetSupportsRunson: false },
        {
          name: "validated exact-head dispatch override",
          expected: "hybrid",
          expectedNode: "runson",
          configuredProfile: "hybrid",
          eventName: "workflow_dispatch" as const,
          requestedProfile: "runson" as const,
          qualificationDispatch: true,
        },
        {
          name: "validated dispatch retry",
          expected: "github",
          eventName: "workflow_dispatch" as const,
          requestedProfile: "runson" as const,
          qualificationDispatch: true,
          runAttempt: 2,
        },
      ].map(({ name, expected, expectedNode, ...overrides }) => ({
        name: `RunsOn ${name}`,
        expected,
        expectedNode,
        options: {
          configuredProfile: "runson",
          authorAssociation: "CONTRIBUTOR",
          eventName: "pull_request" as const,
          targetSupportsContract: true,
          targetSupportsRunson: true,
          ...overrides,
        },
      })),
    ];

    for (const { expected, expectedNode = expected, name, options } of scenarios) {
      const result = runRunnerProfileFixture(options);
      expect(result.status, `${name}: ${result.output}`).toBe(0);
      expect(result.outputs.runner_profile, name).toBe(expected);
      expect(result.outputs.node_runner_backend, name).toBe(expectedNode);
      expect(result.outputs.hosted_runner_profile_contract, name).toBe(
        String(options.targetSupportsContract),
      );
    }

    const invalid = runRunnerProfileFixture({
      configuredProfile: "other",
      eventName: "push",
      targetSupportsContract: true,
    });
    expect(invalid.status).toBe(1);
    expect(invalid.output).toContain(
      "OPENCLAW_CI_RUNNER_BACKEND must be github, hybrid, blacksmith, or runson",
    );

    const workflow = readCiWorkflow();
    expect(workflow.jobs.preflight.outputs.runner_profile).toBe(
      "${{ steps.runner_profile.outputs.runner_profile }}",
    );
    expect(workflow.jobs.preflight.outputs.node_runner_backend).toBe(
      "${{ steps.runner_profile.outputs.node_runner_backend }}",
    );
    expect(workflow.jobs.preflight["runs-on"]).toContain("vars.OPENCLAW_CI_RUNNER_BACKEND");

    const dispatchManifest = runCiManifestFixture({
      bundledPlanner: true,
      eventName: "workflow_dispatch",
      historicalCompatibility: false,
      runnerBackend: "blacksmith",
      runnerProfile: "github",
    });
    expect(dispatchManifest.status, dispatchManifest.output).toBe(0);
    expect(
      JSON.parse(expectDefined(dispatchManifest.outputs.ui_e2e_matrix, "dispatch UI E2E matrix"))
        .include,
    ).toHaveLength(13);
    expect(
      JSON.parse(
        expectDefined(dispatchManifest.outputs.qa_smoke_ci_matrix, "dispatch QA smoke matrix"),
      ).include,
    ).toHaveLength(6);
  });

  it("admits CI qualification only for a maintainer's open exact-head canonical main PR", () => {
    const step = expectDefined(
      readCiWorkflow().jobs.preflight.steps.find(
        (candidate: WorkflowStep) => candidate.name === "Validate CI qualification dispatch",
      ),
      "CI qualification dispatch validation",
    );
    const sha = "a".repeat(40);
    const scenarios = [
      { name: "admin", permission: "admin", admitted: true },
      { name: "maintainer", permission: "maintain", admitted: true },
      { name: "writer", permission: "write", admitted: true },
      { name: "main hybrid", ciShape: "main", requestedProfile: "hybrid", admitted: true },
      {
        name: "main configured backend",
        ciShape: "main",
        requestedProfile: "default",
        admitted: true,
      },
      { name: "main Spot", ciShape: "main", requestedProfile: "runson", admitted: true },
      { name: "different checkout", githubSha: "b".repeat(40), admitted: false },
      { name: "different PR branch", prBranch: "other-branch", admitted: false },
      { name: "different base branch", prBase: "release", admitted: false },
      { name: "different base repository", baseRepository: "fork/openclaw", admitted: false },
      { name: "release scope", releaseScope: "npm-beta", admitted: false },
      { name: "historical target", historicalTag: "v2026.8.1", admitted: false },
      { name: "unsupported shape", ciShape: "other", admitted: false },
      { name: "unsupported backend", requestedProfile: "other", admitted: false },
      { name: "reader", permission: "read", admitted: false },
      { name: "closed PR", prState: "closed", admitted: false },
      { name: "moved PR head", prHead: "b".repeat(40), admitted: false },
      { name: "fork PR", prRepository: "fork/openclaw", admitted: false },
      { name: "different workflow revision", workflowRevision: "b".repeat(40), admitted: false },
      { name: "ordinary dispatch", releaseGate: false, admitted: false },
      { name: "noncanonical repository", repository: "fork/openclaw", admitted: false },
      { name: "permission API failure", apiFailure: "permission", admitted: false },
      { name: "PR API failure", apiFailure: "pr", admitted: false },
    ];
    const root = tempDirs.make("openclaw-runson-dispatch-");
    const bin = path.join(root, "bin");
    mkdirSync(bin);
    writeExecutable(path.join(bin, "gh"), [
      "#!/bin/sh",
      '[ "$1" = api ] || exit 64',
      'case "$2" in',
      "  repos/openclaw/openclaw/collaborators/maintainer/permission)",
      '    [ "$MOCK_API_FAILURE" != permission ] || exit 1',
      '    printf "%s\\n" "$MOCK_PERMISSION" ;;',
      "  repos/openclaw/openclaw/pulls/123)",
      '    [ "$MOCK_API_FAILURE" != pr ] || exit 1',
      '    printf "%s\\n" "$MOCK_PR" ;;',
      "  *) exit 64 ;;",
      "esac",
    ]);
    for (const scenario of scenarios) {
      const output = path.join(root, "output");
      writeFileSync(output, "");
      const result = runWorkflowShellScript(expectDefined(step.run, "dispatch script"), {
        cwd: root,
        // Bash 3.2 does not honor errexit for the final false term in this [[ ... && ... ]].
        linuxWorkflow: true,
        env: {
          ...process.env,
          PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
          GITHUB_ACTOR: "maintainer",
          GITHUB_SHA: scenario.githubSha ?? sha,
          GITHUB_REF_NAME: "qualification-branch",
          CI_SHAPE: scenario.ciShape ?? "default",
          REQUESTED_RUNNER_PROFILE: scenario.requestedProfile ?? "runson",
          RELEASE_SCOPE: scenario.releaseScope ?? "full",
          HISTORICAL_TARGET_TAG: scenario.historicalTag ?? "",
          RELEASE_CANDIDATE_REF: "",
          TARGET_CONTEXT_REF: "",
          GITHUB_REPOSITORY: scenario.repository ?? "openclaw/openclaw",
          GITHUB_OUTPUT: output,
          RUNNER_TEMP: root,
          RELEASE_GATE: String(scenario.releaseGate ?? true),
          PULL_REQUEST_NUMBER: "123",
          TARGET_REF: sha,
          WORKFLOW_REVISION: scenario.workflowRevision ?? sha,
          MOCK_PERMISSION: scenario.permission ?? "write",
          MOCK_API_FAILURE: scenario.apiFailure ?? "",
          MOCK_PR: JSON.stringify({
            state: scenario.prState ?? "open",
            head: scenario.prHead ?? sha,
            repository: scenario.prRepository ?? "openclaw/openclaw",
            branch: scenario.prBranch ?? "qualification-branch",
            base: scenario.prBase ?? "main",
            baseRepository: scenario.baseRepository ?? "openclaw/openclaw",
          }),
        },
      });
      expect(result.status === 0, `${scenario.name}: ${result.stderr}`).toBe(scenario.admitted);
      expect(readWorkflowOutputs(output), scenario.name).toEqual(
        scenario.admitted ? { eligible: "true" } : {},
      );
    }
  });

  it("resolves admitted main qualification profiles without changing ordinary main routing", () => {
    for (const [configuredProfile, backend] of (
      ["", "github", "blacksmith", "hybrid"] as const
    ).flatMap((configured) =>
      (["hybrid", "runson"] as const).map((requested) => [configured, requested] as const),
    )) {
      const fixture = {
        configuredProfile,
        eventName: "workflow_dispatch" as const,
        requestedProfile: backend,
        ciShape: "main" as const,
        targetSupportsContract: true,
        targetSupportsRunson: true,
      };
      const denied = runRunnerProfileFixture(fixture);
      expect(denied.status).not.toBe(0);
      const admitted = runRunnerProfileFixture({ ...fixture, qualificationDispatch: true });
      expect(admitted.status, admitted.output).toBe(0);
      expect(admitted.outputs).toMatchObject({
        runner_profile: "hybrid",
        node_runner_backend: backend,
        ci_shape: "main",
        ci_qualification: "true",
        qualification_runner_backend: "hybrid",
      });
      const workflow = readCiWorkflow();
      const context = {
        eventName: "workflow_dispatch" as const,
        repository: "openclaw/openclaw",
        runnerBackend: configuredProfile,
        runAttempt: 1,
        releaseGate: true,
        requestedRunnerBackend: backend,
        ciShape: "main" as const,
        matrix: {
          runner: "blacksmith-8vcpu-ubuntu-2404",
          check_name: "fixture",
          task: "build-play",
        },
        steps: {
          runner_profile: { outputs: admitted.outputs },
          qualification_dispatch: { outputs: { eligible: "true" } },
          changed_scope: { outputs: { run_node: "true", run_node_fast_only: "false" } },
        },
      };
      const manifest = workflow.jobs.preflight.steps.find(
        (step: WorkflowStep) => step.name === "Build CI manifest",
      );
      expect(evaluateWorkflowExpression(manifest.env.OPENCLAW_CI_RUNNER_BACKEND, context)).toBe(
        "hybrid",
      );
      const health = workflow.jobs.preflight.steps.find(
        (step: WorkflowStep) => step.id === "hosted_health",
      );
      expect(evaluateWorkflowExpression(`\${{ ${health.if} }}`, context)).toBe(true);
      for (const hosted of ["false", "true"]) {
        const qualified = {
          ...context,
          preflightOutputs: {
            ...admitted.outputs,
            hybrid_hosted_offload: hosted,
            hybrid_hosted_checks: hosted,
            hybrid_hosted_main_checks: hosted,
          },
        };
        for (const [name, rawJob] of Object.entries(workflow.jobs)) {
          const job = rawJob as {
            needs?: string[] | string;
            "runs-on": string;
            "timeout-minutes"?: string | number;
          };
          if (!String(job.needs).includes("preflight")) {
            continue;
          }
          for (const key of ["runs-on", "timeout-minutes"] as const) {
            const expression = job[key];
            if (typeof expression !== "string" || !expression.startsWith("${{")) {
              continue;
            }
            expect(
              evaluateWorkflowExpression(expression, qualified),
              `${configuredProfile}/${backend}/${hosted}/${name}.${key}`,
            ).toEqual(
              evaluateWorkflowExpression(expression, { ...qualified, runnerBackend: "hybrid" }),
            );
            // Failed-job-only retries retain the successful preflight's first-attempt outputs.
            expect(evaluateWorkflowExpression(expression, { ...qualified, runAttempt: 2 })).toEqual(
              evaluateWorkflowExpression(expression, {
                ...qualified,
                runAttempt: 2,
                runnerBackend: "github",
                preflightOutputs: {
                  ...qualified.preflightOutputs,
                  ci_qualification: "false",
                  qualification_runner_backend: "",
                },
              }),
            );
          }
        }
        for (const task of ["dependencies", "lint", "test-types"]) {
          const matrix = expectDefined(
            workflow.jobs["check-shard"].strategy.matrix.include.find(
              (candidate: { task: string }) => candidate.task === task,
            ),
            `check matrix task ${task}`,
          );
          const row = { ...qualified, matrix };
          expect(evaluateWorkflowExpression(workflow.jobs["check-shard"]["runs-on"], row)).toBe(
            hosted === "true" ? "ubuntu-24.04" : "blacksmith-16vcpu-ubuntu-2404",
          );
        }
      }
      const retry = runRunnerProfileFixture({
        ...fixture,
        qualificationDispatch: true,
        runAttempt: 2,
      });
      expect(retry.status, retry.output).toBe(0);
      expect(retry.outputs).toMatchObject({
        runner_profile: "github",
        node_runner_backend: "github",
        ci_shape: "main",
        qualification_runner_backend: "",
      });
      expect(
        evaluateWorkflowExpression(manifest.env.OPENCLAW_CI_RUNNER_BACKEND, {
          ...context,
          runAttempt: 2,
          steps: { ...context.steps, runner_profile: { outputs: retry.outputs } },
        }),
      ).toBe("github");
      for (const [jobName, runner, timeout] of [
        ["android", "ubuntu-24.04", 35],
        ["checks-ui-e2e-real-gateway", "ubuntu-24.04", 40],
        ["build-artifacts", "ubuntu-24.04", 35],
        ["checks-ui", "ubuntu-24.04", 35],
      ] as const) {
        const job = workflow.jobs[jobName];
        const retainedRetry = { ...context, runAttempt: 2, preflightOutputs: admitted.outputs };
        expect(evaluateWorkflowExpression(job["runs-on"], retainedRetry), jobName).toBe(runner);
        if (typeof job["timeout-minutes"] === "string") {
          expect(evaluateWorkflowExpression(job["timeout-minutes"], retainedRetry), jobName).toBe(
            timeout,
          );
        }
      }
    }
    const ordinaryMain = runRunnerProfileFixture({
      configuredProfile: "runson",
      eventName: "push",
      targetSupportsContract: true,
      targetSupportsRunson: true,
    });
    expect(ordinaryMain.status, ordinaryMain.output).toBe(0);
    expect(ordinaryMain.outputs).toMatchObject({
      runner_profile: "hybrid",
      node_runner_backend: "hybrid",
      ci_qualification: "false",
      ci_shape: "default",
      qualification_runner_backend: "",
    });
  });

  it("detects and retains docs-only coverage for default PR-shaped qualification", () => {
    const workflow = readCiWorkflow();
    const profile = runRunnerProfileFixture({
      eventName: "workflow_dispatch",
      requestedProfile: "hybrid",
      qualificationDispatch: true,
      targetSupportsContract: true,
    });
    expect(profile.status, profile.output).toBe(0);
    const context = {
      eventName: "workflow_dispatch" as const,
      repository: "openclaw/openclaw",
      runAttempt: 1,
      releaseGate: true,
      steps: { runner_profile: { outputs: profile.outputs } },
    };
    const docsStep = expectDefined(
      workflow.jobs.preflight.steps.find((step: WorkflowStep) => step.id === "docs_scope"),
      "docs scope owner",
    );
    expect(evaluateWorkflowExpression(`\${{ ${docsStep.if} }}`, context)).toBe(true);
    const root = tempDirs.make("openclaw-qualification-docs-");
    runGit(root, ["init", "--quiet"]);
    runGit(root, ["config", "user.name", "CI Fixture"]);
    runGit(root, ["config", "user.email", "ci-fixture@example.invalid"]);
    runGit(root, ["config", "commit.gpgsign", "false"]);
    writeFileSync(path.join(root, "README.md"), "before\n");
    runGit(root, ["add", "README.md"]);
    runGit(root, ["commit", "--quiet", "-m", "fixture base"]);
    const base = runGit(root, ["rev-parse", "HEAD"]);
    writeFileSync(path.join(root, "README.md"), "after\n");
    runGit(root, ["add", "README.md"]);
    runGit(root, ["commit", "--quiet", "-m", "fixture docs"]);
    const outputPath = path.join(root, "docs.out");
    const detector = readWorkflow(".github/actions/detect-docs-changes/action.yml");
    const detected = runWorkflowShellScript(detector.runs.steps[0].run, {
      cwd: root,
      env: { ...process.env, BASE_SHA: base, GITHUB_OUTPUT: outputPath },
    });
    expect(detected.status, detected.stderr).toBe(0);
    const changedPaths = ["README.md"];
    const manifestStep = workflow.jobs.preflight.steps.find(
      (step: WorkflowStep) => step.name === "Build CI manifest",
    );
    const scopeContext = {
      ...context,
      steps: {
        ...context.steps,
        docs_scope: { outputs: readWorkflowOutputs(outputPath) },
        changed_scope: { outputs: runCiChangedScopeFixture(changedPaths) },
      },
    };
    const scopeEnv = Object.fromEntries(
      Object.entries(manifestStep.env)
        .filter(
          ([key]) => key.startsWith("OPENCLAW_CI_RUN_") || key.startsWith("OPENCLAW_CI_DOCS_"),
        )
        .map(([key, expression]) => [
          key,
          String(evaluateWorkflowExpression(expression, scopeContext)),
        ]),
    );
    const result = runCiManifestFixture({
      bundledPlanner: true,
      eventName: "workflow_dispatch",
      historicalCompatibility: false,
      releaseGate: true,
      runnerBackend: "hybrid",
      runnerProfile: "hybrid",
      nodeRunnerBackend: "hybrid",
      changedPaths,
      scopeEnv: { ...scopeEnv, OPENCLAW_CI_QUALIFICATION: "true", OPENCLAW_CI_SHAPE: "default" },
    });
    expect(result.status, result.output).toBe(0);
    expect(result.outputs).toMatchObject({
      docs_only: "true",
      docs_changed: "true",
      run_check_docs: "true",
      run_node: "false",
    });
  });

  it.each(["hybrid", "runson"] as const)(
    "executes main-shaped %s qualification with push coverage and no comparison rows",
    (backend) => {
      const fixture = {
        bundledPlanner: true,
        historicalCompatibility: false,
        runnerBackend: "hybrid" as const,
        runnerProfile: "hybrid" as const,
        nodeRunnerBackend: backend,
        bunTestRuntime: true,
        changedPaths: [
          ".github/workflows/ci.yml",
          "extensions/matrix/src/client.ts",
          "scripts/e2e/docker-openai-seed.ts",
          "src/sqlite-session-owner.ts",
        ],
      };
      const ordinaryPush = runCiManifestFixture({ ...fixture, eventName: "push" });
      const qualification = runCiManifestFixture({
        ...fixture,
        eventName: "workflow_dispatch",
        releaseGate: true,
        scopeEnv: {
          OPENCLAW_CI_QUALIFICATION: "true",
          OPENCLAW_CI_SHAPE: "main",
          GITHUB_REF: "refs/heads/qualification-branch",
        },
      });
      expect(ordinaryPush.status, ordinaryPush.output).toBe(0);
      expect(qualification.status, qualification.output).toBe(0);
      const options = JSON.parse(
        expectDefined(
          qualification.output.match(/node-test-plan-options:(.+)/u)?.[1],
          "Node options",
        ),
      );
      expect(options).toMatchObject({
        compactMode: "push",
        compactNodeJobCap: 70,
        runnerBackend: backend,
        includeProofTests: true,
        includeReleaseOnlyToolingShards: false,
      });
      // The real manifest owns every selected lane; only hosted preflight admission differs.
      const coverage = (outputs: Record<string, string>) =>
        Object.fromEntries(
          Object.entries(outputs).filter(([key]) => !key.startsWith("hybrid_hosted_")),
        );
      expect(coverage(qualification.outputs)).toEqual(coverage(ordinaryPush.outputs));
      const rows = JSON.parse(qualification.outputs.checks_node_core_nondist_matrix!).include;
      expect(rows).toHaveLength(1);
      expect(rows[0].test_runtime_policy).toBe("node");
      expect(qualification.outputs.run_qa_smoke_ci).toBe("true");
      expect(JSON.parse(qualification.outputs.qa_smoke_ci_matrix!).include).toHaveLength(4);
      expect(qualification.outputs.run_docker_seed_e2e).toBe("true");
      expect(qualification.outputs.docker_seed_lanes).toBe("published-upgrade-survivor");
      expect(qualification.outputs.run_sqlite_session_lifecycle).toBe("true");
      const overCap = runCiManifestFixture({
        ...fixture,
        eventName: "workflow_dispatch",
        releaseGate: true,
        nodeTestShards: Array.from({ length: 71 }, (_, index) => ({
          checkName: `node-${index}`,
          shardName: `node-${index}`,
          configs: ["fixture-bun.config.ts"],
          runner: "ubuntu-24.04",
        })),
        scopeEnv: { OPENCLAW_CI_QUALIFICATION: "true", OPENCLAW_CI_SHAPE: "main" },
      });
      expect(overCap.status).not.toBe(0);
      expect(overCap.output).toContain("exceeding limit 70");
    },
  );

  it("passes RunsOn only to the Node planner and keeps default qualification dispatches PR-shaped", () => {
    const fixture = {
      bundledPlanner: true,
      eventName: "workflow_dispatch" as const,
      historicalCompatibility: false,
      releaseGate: true,
      runnerBackend: "hybrid" as const,
      runnerProfile: "hybrid" as const,
      nodeRunnerBackend: "runson" as const,
      changedPaths: [".github/workflows/ci.yml"],
    };
    const manifest = runCiManifestFixture({
      ...fixture,
      scopeEnv: { OPENCLAW_CI_AUTHOR_ASSOCIATION: "", OPENCLAW_CI_HEAD_REPOSITORY: "" },
    });
    expect(manifest.status, manifest.output).toBe(0);
    expect(Number(manifest.outputs.hybrid_hosted_base_rows)).toBeGreaterThan(0);
    const options = JSON.parse(
      expectDefined(manifest.output.match(/node-test-plan-options:(.+)/u)?.[1], "Node options"),
    );
    expect(options).toMatchObject({
      compact: true,
      compactMode: "pull-request",
      runnerBackend: "runson",
      includeReleaseOnlyToolingShards: false,
      includeProofTests: false,
    });
    expect(options.compactNodeJobCap).toBeLessThanOrEqual(130);
    const rows = JSON.parse(
      expectDefined(manifest.outputs.checks_node_core_nondist_matrix, "qualification Node rows"),
    ).include as Record<string, unknown>[];
    const cron = expectDefined(
      rows.find((row) => row.runner === "runson-c8i-8xlarge"),
      "RunsOn cron row",
    );
    expect(cron.env).toMatchObject({ OPENCLAW_VITEST_MAX_WORKERS: "2" });
    for (const [provider, runner] of [
      ["blacksmith", "blacksmith-32vcpu-ubuntu-2404"],
      ["github", "ubuntu-24.04"],
    ] as const) {
      expect(
        rows.find((row) => row.check_name === `checks-node-runson-cron-${provider}-control`),
      ).toEqual({
        ...cron,
        check_name: `checks-node-runson-cron-${provider}-control`,
        shard_name: `runson-cron-${provider}-control`,
        runner,
      });
    }
    const ordinaryPr = runCiManifestFixture({
      ...fixture,
      eventName: "pull_request",
      releaseGate: false,
    });
    expect(ordinaryPr.status, ordinaryPr.output).toBe(0);
    const ordinaryRows = JSON.parse(
      expectDefined(ordinaryPr.outputs.checks_node_core_nondist_matrix, "ordinary PR Node rows"),
    ).include as Record<string, unknown>[];
    expect(rows).toHaveLength(ordinaryRows.length + 2);
    expect(ordinaryRows.some((row) => row.runner === "runson-c8i-8xlarge")).toBe(true);
    expect(ordinaryRows.some((row) => String(row.check_name).endsWith("-control"))).toBe(false);
    const fastRows = JSON.parse(
      expectDefined(manifest.outputs.checks_fast_core_matrix, "qualification fast checks"),
    ).include as { task: string }[];
    expect(fastRows.some((row) => row.task.startsWith("release-lint-"))).toBe(false);
    const noCron = runCiManifestFixture({ ...fixture, nodeTestShards: [] });
    expect(noCron.status).not.toBe(0);
    expect(noCron.output).toContain("RunsOn qualification requires selected cron tests");
    const step = readCiWorkflow().jobs.preflight.steps.find(
      (candidate: WorkflowStep) => candidate.name === "Build CI manifest",
    );
    expect(step.env.OPENCLAW_CI_RUNNER_PROFILE).toBe(
      "${{ steps.runner_profile.outputs.runner_profile }}",
    );
    expect(step.env.OPENCLAW_CI_NODE_RUNNER_BACKEND).toBe(
      "${{ steps.runner_profile.outputs.node_runner_backend }}",
    );
  });

  it("uses bundled Node shards and telemetry-backed runner sizes", () => {
    const workflow = readCiWorkflow();
    const buildArtifactsTestbox = readBuildArtifactsTestboxWorkflow();
    const source = readFileSync(".github/workflows/ci.yml", "utf8");

    expect(source).toContain("createNodeTestShardBundles");
    const artifactRunner = workflow.jobs["build-artifacts"]["runs-on"];
    for (const [frozenTarget, expected] of [
      ["false", "blacksmith-16vcpu-ubuntu-2404"],
      ["true", "blacksmith-16vcpu-ubuntu-2404"],
      ["", "blacksmith-16vcpu-ubuntu-2404"],
    ] as const) {
      const context = {
        eventName: "push",
        repository: "openclaw/openclaw",
        runAttempt: 1,
        preflightOutputs: { frozen_target: frozenTarget },
      } as const;
      for (const runnerBackend of ["", "blacksmith", "hybrid"] as const) {
        for (const eventName of ["push", "pull_request"] as const) {
          expect(
            evaluateWorkflowExpression(artifactRunner, { ...context, runnerBackend, eventName }),
            `build-artifacts: ${runnerBackend || "default"}/${eventName}/frozen=${frozenTarget}`,
          ).toBe(expected);
        }
      }
      for (const override of [
        { runnerBackend: "github" },
        { runnerBackend: "hybrid", runAttempt: 2 },
        { eventName: "workflow_dispatch" },
        { eventName: "pull_request", authorAssociation: "NONE", headRepository: "fork/openclaw" },
      ] as const) {
        expect(evaluateWorkflowExpression(artifactRunner, { ...context, ...override })).toBe(
          "ubuntu-24.04",
        );
      }
    }
    expect(workflow.jobs["build-artifacts"]["timeout-minutes"]).toBe(
      "${{ ((needs.preflight.outputs.ci_qualification == 'true' && (github.run_attempt == 1 && needs.preflight.outputs.qualification_runner_backend || 'github') || vars.OPENCLAW_CI_RUNNER_BACKEND) == 'github' || (contains(fromJSON('[\"hybrid\",\"runson\"]'), (needs.preflight.outputs.ci_qualification == 'true' && (github.run_attempt == 1 && needs.preflight.outputs.qualification_runner_backend || 'github') || vars.OPENCLAW_CI_RUNNER_BACKEND)) && github.run_attempt > 1) || (github.event_name == 'workflow_dispatch' && needs.preflight.outputs.ci_shape != 'main') || (github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name != github.repository)) && 35 || 20 }}",
    );
    // PR events validate the artifact build on hosted runners (landing gate
    // stays satisfiable during Blacksmith outages); Testbox leases are
    // dispatch-only, mirroring ci-check-testbox.yml.
    expect(buildArtifactsTestbox.jobs["build-artifacts"]["runs-on"]).toBe(
      "${{ github.event_name == 'pull_request' && 'ubuntu-24.04' || 'blacksmith-16vcpu-ubuntu-2404' }}",
    );
    for (const stepName of ["Begin Testbox", "Run Testbox"]) {
      expect(
        buildArtifactsTestbox.jobs["build-artifacts"].steps.find(
          (step: { name?: string }) => step.name === stepName,
        ).if,
      ).toContain("github.event_name == 'workflow_dispatch'");
    }
    expect(
      buildArtifactsTestbox.jobs["build-artifacts"].steps.find(
        (step: { name?: string }) => step.name === "Build dist on cache miss",
      ).env.NODE_OPTIONS,
    ).toBe(
      "${{ github.event_name == 'pull_request' && '--max-old-space-size=8192' || '--max-old-space-size=16384' }}",
    );
    expect(workflow.jobs["checks-node-core-test-nondist-shard"]["runs-on"]).toContain(
      "blacksmith-4vcpu-ubuntu-2404",
    );
    for (const task of ["dependencies", "test-types"]) {
      expect(workflow.jobs["check-shard"].strategy.matrix.include).toContainEqual({
        check_name: `check-${task}`,
        task,
        runner: "blacksmith-16vcpu-ubuntu-2404",
      });
    }
    expect(workflow.jobs["check-additional-shard"]["runs-on"]).toContain("matrix.runner");
    expect(readFrozenAdditionalCheckRows()).toContainEqual({
      check_name: "check-additional-runtime-topology-architecture",
      group: "runtime-topology-architecture",
      runner: "blacksmith-16vcpu-ubuntu-2404",
    });
    expect(readFrozenAdditionalCheckRows()).toContainEqual({
      check_name: "check-session-accessor-boundary",
      group: "session-accessor-boundary",
      runner: "blacksmith-4vcpu-ubuntu-2404",
    });
    expect(readFrozenAdditionalCheckRows()).toContainEqual({
      check_name: "check-export-name-collisions",
      group: "export-name-collisions",
      runner: "blacksmith-4vcpu-ubuntu-2404",
    });
    expect(readFrozenAdditionalCheckRows()).toContainEqual({
      check_name: "check-sqlite-session-schema-baseline",
      group: "sqlite-session-schema-baseline",
      runner: "blacksmith-4vcpu-ubuntu-2404",
    });
    // The Windows matrix carries no per-row runner: both parts share one class.
    expect(workflow.jobs["checks-windows"]["runs-on"]).not.toContain("matrix.runner");
    expect(source).toContain("blacksmith-16vcpu-windows-2025");
  });

  it("keeps the extension boundary sticky disk on one protected key", () => {
    const workflow = readCiWorkflow();
    const warmer = parse(readFileSync(".github/workflows/vitest-cache-warm.yml", "utf8"));
    const additionalJob = workflow.jobs["check-additional-shard"];
    const checkShardJob = workflow.jobs["check-shard"];
    const hostedCoreJob = workflow.jobs["check-lint-hosted-core-shard"];

    // Cold SDK preparation and plugin compilation need CPU and memory headroom.
    expect(readFrozenAdditionalCheckRows()).toContainEqual({
      check_name: "check-additional-extension-package-boundary",
      group: "extension-package-boundary",
      runner: "blacksmith-16vcpu-ubuntu-2404",
    });
    const runStep = additionalJob.steps.find(
      (step: WorkflowStep) => step.name === "Run additional check shard",
    );
    expect(runStep.env.OPENCLAW_EXTENSION_BOUNDARY_CONCURRENCY).toBe(16);

    // O(1) disks: Blacksmith caps sticky disks per installation, and the old
    // per-PR/per-config keys minted new disks until every mount 429-failed
    // fleet-wide. Snapshot validity lives in the in-job marker, not the key.
    const boundaryMount = additionalJob.steps.find(
      (step: WorkflowStep) => step.name === "Mount extension boundary sticky disk",
    );
    const lintMount = checkShardJob.steps.find(
      (step: WorkflowStep) => step.name === "Mount extension boundary sticky disk",
    );
    const boundaryCache = expectDefined(
      additionalJob.steps.find(
        (step: WorkflowStep) => step.name === "Cache extension package boundary artifacts",
      ),
      "extension package boundary cache",
    );
    const hostedLintCache = expectDefined(
      checkShardJob.steps.find(
        (step: WorkflowStep) =>
          step.name === "Cache extension package boundary artifacts for hosted lint",
      ),
      "hosted lint extension package boundary cache",
    );
    const hostedCoreCache = expectDefined(
      hostedCoreJob.steps.find(
        (step: WorkflowStep) =>
          step.name === "Cache extension package boundary artifacts for hosted core lint",
      ),
      "hosted core extension package boundary cache",
    );
    expect(boundaryMount.with.key).toBe("${{ github.repository }}-ext-boundary-v2");
    expect(lintMount.with.key).toBe(boundaryMount.with.key);
    for (const gate of [boundaryMount, lintMount]) {
      expect(gate.if).toContain("vars.OPENCLAW_CI_RUNNER_BACKEND != 'github'");
    }
    expect(hostedLintCache.if).toBe(
      "needs.preflight.outputs.cache_mode != 'off' && matrix.task == 'lint' && steps.extension-boundary-inputs.outputs.enabled == 'true' && (needs.preflight.outputs.runner_profile == 'github' || needs.preflight.outputs.runner_profile == 'hybrid')",
    );
    expect(boundaryCache.if).toBe(
      "needs.preflight.outputs.cache_mode != 'off' && matrix.group == 'extension-package-boundary' && steps.extension-boundary-inputs.outputs.enabled == 'true'",
    );
    expect(hostedCoreCache.if).toBe(
      "needs.preflight.outputs.cache_mode != 'off' && needs.preflight.outputs.runner_profile == 'github' && !inputs.release_gate && steps.extension-boundary-inputs.outputs.enabled == 'true'",
    );
    for (const cache of [hostedLintCache, hostedCoreCache]) {
      expect(cache.uses).toBe(CACHE_V5);
      expect(cache.with).toEqual(boundaryCache.with);
    }
    const fingerprintReference = "${{ steps.extension-boundary-inputs.outputs.fingerprint }}";
    expect(boundaryCache.with.key).toBe(
      "${{ runner.os }}-extension-package-boundary-v4-${{ steps.extension-boundary-inputs.outputs.fingerprint }}",
    );
    expect(boundaryCache.with.path.trim().split("\n")).toEqual([
      "packages/plugin-sdk/dist",
      ".artifacts/extension-package-boundary/plugins",
      ".artifacts/extension-package-boundary/*.json",
      ".artifacts/extension-package-boundary/compile",
    ]);
    const fingerprintSteps = [additionalJob, checkShardJob, hostedCoreJob].map((job) =>
      expectDefined(
        job.steps.find(
          (step: WorkflowStep) => step.name === "Compute extension boundary input fingerprint",
        ),
        "extension boundary input fingerprint step",
      ),
    );
    for (const step of fingerprintSteps) {
      expect(step.id).toBe("extension-boundary-inputs");
      expect(step.run).toContain('fingerprint="$(git rev-parse HEAD)"');
      expect(step.run).toContain('echo "enabled=false" >> "$GITHUB_OUTPUT"');
    }
    expect(fingerprintSteps[0]?.run).toBe(fingerprintSteps[1]?.run);
    expect(fingerprintSteps[1]?.run).toBe(fingerprintSteps[2]?.run);
    expect(fingerprintSteps[2]?.if).toBe(
      "needs.preflight.outputs.runner_profile == 'github' && !inputs.release_gate",
    );
    expect(hostedCoreJob.steps.indexOf(fingerprintSteps[2])).toBeLessThan(
      hostedCoreJob.steps.indexOf(hostedCoreCache),
    );
    expect(hostedCoreJob.steps.indexOf(hostedCoreCache)).toBeLessThan(
      hostedCoreJob.steps.findIndex(
        (step: WorkflowStep) => step.name === "Run hosted core lint stripe",
      ),
    );
    expect(
      hostedCoreJob.steps.some((step: WorkflowStep) =>
        step.uses?.startsWith("actions/cache/save@"),
      ),
    ).toBe(false);
    const warmerBoundaryRestore = expectDefined(
      warmer.jobs.warm.steps.find(
        (step: WorkflowStep) => step.name === "Restore native SDK boundary cache",
      ),
      "warmer boundary restore",
    );
    const warmerBoundarySave = expectDefined(
      warmer.jobs.warm.steps.find(
        (step: WorkflowStep) => step.name === "Save native SDK boundary cache",
      ),
      "warmer boundary save",
    );
    expect(warmerBoundaryRestore.with.path).toBe(boundaryCache.with.path);
    expect(warmerBoundaryRestore.with["restore-keys"]).toBe(boundaryCache.with["restore-keys"]);
    expect(warmerBoundarySave.with.path).toBe(boundaryCache.with.path);
    // Single semantic writer: protected pushes commit explicitly (not
    // on-change/if-missing, whose allocated-byte heuristic can strand a stale
    // marker); PR clones and the lint consumer stay read-only.
    expect(boundaryMount.with.commit).toBe(
      "${{ github.event_name != 'pull_request' && 'true' || 'false' }}",
    );
    expect(lintMount.with.commit).toBe("false");

    // Transport keys use the same commit; native owner records independently
    // validate source content and output integrity after restoration.
    const restoreStep = additionalJob.steps.find(
      (step: WorkflowStep) => step.name === "Restore extension boundary artifacts from sticky disk",
    );
    const lintRestoreStep = checkShardJob.steps.find(
      (step: WorkflowStep) => step.name === "Restore extension boundary artifacts from sticky disk",
    );
    const seedStep = additionalJob.steps.find(
      (step: WorkflowStep) => step.name === "Seed extension boundary sticky disk",
    );
    for (const gate of [restoreStep, lintRestoreStep, seedStep]) {
      expect(gate.run).toContain(fingerprintReference);
      expect(gate.run).toContain(".source-fingerprint");
      expect(gate.run).not.toContain("git rev-parse HEAD:");
      expect(gate.run).not.toContain("BOUNDARY_CONFIG_HASH");
      expect(gate.if).toContain("vars.OPENCLAW_CI_RUNNER_BACKEND != 'github'");
    }
    // Seeding is writer-only work: PR mounts never commit, so seeding there
    // would burn wall clock on a discarded clone.
    expect(seedStep.if).toContain("github.event_name != 'pull_request'");
    expect(seedStep.if).toContain("steps.boundary-sticky-restore.outputs.restored == 'false'");
    expect(seedStep.run).toContain(
      "rsync -aR --exclude='*.lock*' .artifacts/extension-package-boundary",
    );
    for (const step of [restoreStep, lintRestoreStep]) {
      expect(step.run).toContain("for payload in packages .artifacts;");
    }
  });

  it("selects every supplemental boundary check exactly once across the CI matrix", () => {
    const job = readCiWorkflow().jobs["check-additional-shard"];
    const step = job.steps.find(
      (entry: WorkflowStep) => entry.name === "Run additional check shard",
    );
    const selector = String(step?.env?.OPENCLAW_ADDITIONAL_BOUNDARY_SHARD ?? "");
    const rows = readFrozenAdditionalCheckRows();
    const selected = rows
      .filter((row) => row.group === "boundaries")
      .flatMap(() => selectChecksForShard(BOUNDARY_CHECKS, selector));
    expect(selected.toSorted((left, right) => left.label.localeCompare(right.label))).toEqual(
      BOUNDARY_CHECKS.toSorted((left, right) => left.label.localeCompare(right.label)),
    );
  });

  it("groups current source checks and allocates SDK reports only for dispatch", () => {
    const workflow = readCiWorkflow();
    const additionalJob = workflow.jobs["check-additional-shard"];
    expect(additionalJob.strategy.matrix).toBe(
      "${{ fromJSON(needs.preflight.outputs.check_additional_matrix) }}",
    );
    expect(workflow.jobs.preflight.outputs.check_additional_matrix).toBe(
      "${{ steps.manifest.outputs.check_additional_matrix }}",
    );
    const frozenGroups = [
      "boundaries",
      "prompt-snapshots",
      "export-name-collisions",
      "session-accessor-boundary",
      "sqlite-session-schema-baseline",
      "plugin-sdk-api-diff",
      "extension-package-boundary",
      "runtime-topology-architecture",
    ];
    for (const [eventName, frozen] of [
      ["push", false],
      ["pull_request", false],
      ["workflow_dispatch", false],
      ["workflow_dispatch", true],
    ] as const) {
      const manifest = runCiManifestFixture({
        bundledPlanner: true,
        eventName,
        historicalCompatibility: frozen,
        changedPaths: [],
        scopeEnv: {
          OPENCLAW_CI_CHECKOUT_REVISION: "a".repeat(40),
          OPENCLAW_CI_WORKFLOW_REVISION: (frozen ? "b" : "a").repeat(40),
        },
      });
      expect(manifest.status, manifest.output).toBe(0);
      const rows = JSON.parse(
        expectDefined(manifest.outputs.check_additional_matrix, "additional check matrix"),
      ).include;
      const expectedGroups = frozen
        ? frozenGroups
        : [
            "boundaries",
            "prompt-snapshots",
            "source-contracts",
            ...(eventName === "workflow_dispatch" ? ["plugin-sdk-api-diff"] : []),
            "extension-package-boundary",
            "runtime-topology-architecture",
          ];
      expect(rows.map((row: { group: string }) => row.group)).toEqual(expectedGroups);
      expect(manifest.outputs.run_check_additional).toBe("true");
      for (const row of rows) {
        if (row.group === "source-contracts") {
          expect(row).toEqual({
            check_name: "check-source-contracts",
            group: "source-contracts",
            runner: "blacksmith-4vcpu-ubuntu-2404",
          });
        } else {
          expect(readFrozenAdditionalCheckRows()).toContainEqual(row);
        }
      }
    }
    for (const selection of [{ runNode: false }, { nodeFastOnly: true }]) {
      const manifest = runCiManifestFixture({
        bundledPlanner: true,
        eventName: "pull_request",
        changedPaths: [],
        ...selection,
      });
      expect(manifest.status, manifest.output).toBe(0);
      expect(manifest.outputs.run_check_additional).toBe("false");
      expect(
        JSON.parse(
          expectDefined(manifest.outputs.check_additional_matrix, "additional check matrix"),
        ).include,
      ).toEqual([]);
    }

    expect(workflow.jobs.preflight.outputs.diff_head_revision).toBe(
      "${{ steps.diff_base.outputs.head_sha }}",
    );
    const ensureHeadStep = additionalJob.steps.find(
      (step: WorkflowStep) => step.name === "Ensure Plugin SDK API diff head commit",
    );
    expect(ensureHeadStep.with["base-sha"]).toBe(
      "${{ needs.preflight.outputs.diff_head_revision }}",
    );
    expect(ensureHeadStep.with["fetch-ref"]).toContain("refs/pull/{0}/merge");

    for (const revision of ["base", "head"]) {
      const ensureRevisionStep = additionalJob.steps.find(
        (step: WorkflowStep) => step.name === `Ensure Plugin SDK API diff ${revision} commit`,
      );
      for (const [eventName, group, eligible] of [
        ["pull_request", "plugin-sdk-api-diff", false],
        ["push", "plugin-sdk-api-diff", false],
        ["workflow_dispatch", "plugin-sdk-api-diff", true],
        ["workflow_dispatch", "boundaries", false],
      ] as const) {
        expect(
          evaluateWorkflowExpression(`\${{ ${ensureRevisionStep.if} }}`, {
            eventName,
            matrix: { group },
            repository: "openclaw/openclaw",
            runAttempt: 1,
          }),
          `${revision} preparation for ${eventName}/${group}`,
        ).toBe(eligible);
      }
    }

    const runStep = additionalJob.steps.find(
      (step: WorkflowStep) => step.name === "Run additional check shard",
    );
    expect(runStep.run).toContain("plugin-sdk-api-diff)");
    expect(runStep.run).toContain('run_check "plugin-sdk:api:diff" pnpm run plugin-sdk:api:diff');
    expect(runStep.run).toContain('--base "${{ needs.preflight.outputs.diff_base_revision }}"');
    expect(runStep.run).toContain('--head "${{ needs.preflight.outputs.diff_head_revision }}"');
    expect(runStep.run).not.toContain('--head "${{ needs.preflight.outputs.checkout_revision }}"');
  });

  it("uses native preflight tooling unless a dispatch selects a different revision", () => {
    const workflow = readCiWorkflow();
    const steps = workflow.jobs.preflight.steps as WorkflowStep[];
    const setupPnpm = expectDefined(
      steps.find((step) => step.name === "Setup manifest pnpm"),
      "manifest pnpm setup",
    );
    const installDependencies = expectDefined(
      steps.find((step) => step.name === "Install manifest dependencies"),
      "manifest dependency install",
    );
    const buildManifest = expectDefined(
      steps.find((step) => step.name === "Build CI manifest"),
      "manifest builder",
    );
    const checkProtocolCoverage = expectDefined(
      steps.find((step) => step.name === "Check mobile protocol event coverage"),
      "protocol coverage owner",
    );
    const workflowSha = "a".repeat(40);
    const otherSha = "b".repeat(40);
    const cases = [
      ["same-revision dispatch", "workflow_dispatch", workflowSha, "", false, false],
      [
        "same-revision explicit target dispatch",
        "workflow_dispatch",
        workflowSha,
        workflowSha,
        false,
        false,
      ],
      ["same-revision release gate", "workflow_dispatch", workflowSha, workflowSha, true, false],
      ["push", "push", otherSha, "", false, false],
      ["pull request", "pull_request", otherSha, "", false, false],
      ["different-revision dispatch", "workflow_dispatch", otherSha, otherSha, false, true],
      ["different-revision release gate", "workflow_dispatch", otherSha, otherSha, true, true],
    ] as const;

    for (const [
      label,
      eventName,
      checkoutRevision,
      targetRef,
      releaseGate,
      usesCompatibilityTooling,
    ] of cases) {
      const context = {
        eventName,
        releaseGate,
        repository: "openclaw/openclaw",
        runAttempt: 1,
        steps: { checkout_ref: { outputs: { sha: checkoutRevision } } },
        targetRef,
        workflowSha,
      };
      const evaluateStep = (step: WorkflowStep) =>
        evaluateWorkflowExpression(`\${{ ${step.if} }}`, context);
      expect([evaluateStep(setupPnpm), evaluateStep(installDependencies)], label).toEqual([
        usesCompatibilityTooling,
        usesCompatibilityTooling,
      ]);
      const invocationOptions = (step: WorkflowStep) => ({
        checkoutRevision: String(
          evaluateWorkflowExpression(step.env?.OPENCLAW_CI_CHECKOUT_REVISION, context),
        ),
        eventName,
        workflowRevision: String(
          evaluateWorkflowExpression(step.env?.OPENCLAW_CI_WORKFLOW_REVISION, context),
        ),
      });
      expect(
        runPreflightNodeInvocation(
          expectDefined(buildManifest.run, "manifest script"),
          invocationOptions(buildManifest),
        ),
        label,
      ).toEqual(
        usesCompatibilityTooling
          ? ["--import", "tsx", "--input-type=module"]
          : ["--input-type=module"],
      );
      expect(
        runPreflightNodeInvocation(
          expectDefined(checkProtocolCoverage.run, "protocol coverage script"),
          invocationOptions(checkProtocolCoverage),
        ),
        label,
      ).toEqual([
        usesCompatibilityTooling
          ? "scripts/check-protocol-event-coverage.mjs"
          : "scripts/check-protocol-event-coverage.mts",
      ]);
    }
  });

  it("classifies cache write authority from proven candidate identity", () => {
    const workflowRevision = "a".repeat(40);
    const defaultRevision = "b".repeat(40);
    const arbitraryRevision = "c".repeat(40);
    const cases = [
      {
        expected: { cache_mode: "off", cache_write_allowed: "false", trust: "untrusted" },
        options: {
          checkoutRevision: arbitraryRevision,
          eventName: "workflow_dispatch" as const,
          targetRef: arbitraryRevision,
          workflowRevision,
        },
      },
      {
        expected: { cache_mode: "restore", cache_write_allowed: "false", trust: "workflow" },
        options: {
          checkoutRevision: workflowRevision,
          eventName: "workflow_dispatch" as const,
          workflowRevision,
        },
      },
      {
        expected: { cache_mode: "restore", cache_write_allowed: "true", trust: "main" },
        options: {
          checkoutRevision: defaultRevision,
          defaultRevision,
          eventName: "workflow_dispatch" as const,
          targetRef: defaultRevision,
          workflowRevision,
        },
      },
      {
        expected: { cache_mode: "restore", cache_write_allowed: "true", trust: "release" },
        options: {
          checkoutRevision: arbitraryRevision,
          eventName: "workflow_dispatch" as const,
          targetContextTarget: true,
          targetRef: arbitraryRevision,
          workflowRevision,
        },
      },
      {
        expected: {
          cache_mode: "restore",
          cache_write_allowed: "false",
          trust: "pull-request",
        },
        options: {
          checkoutRevision: arbitraryRevision,
          eventName: "workflow_dispatch" as const,
          releaseGate: true,
          targetRef: arbitraryRevision,
          workflowRevision,
        },
      },
      {
        expected: {
          cache_mode: "restore",
          cache_write_allowed: "false",
          trust: "pull-request",
        },
        options: {
          checkoutRevision: arbitraryRevision,
          eventName: "pull_request" as const,
          workflowRevision,
        },
      },
      {
        expected: { cache_mode: "restore", cache_write_allowed: "true", trust: "main" },
        options: {
          checkoutRevision: defaultRevision,
          eventName: "push" as const,
          ref: "refs/heads/main",
          workflowRevision,
        },
      },
    ];

    for (const testCase of cases) {
      const result = runCandidateTrustClassification(testCase.options);
      expect(result.status, result.output).toBe(0);
      expect(result.outputs).toMatchObject(testCase.expected);
    }
  });

  it.each([
    { label: "manual run", checkoutBase: "", changedScript: true },
    { label: "target without changed checks", checkoutBase: "c".repeat(40), changedScript: false },
  ])("keeps the full npm-lock sweep for $label", ({ checkoutBase, changedScript }) => {
    const result = runCheckShardFixture({
      task: "npm-lock",
      frozenTarget: false,
      checkoutBase,
      scripts: ["deps:npm-lock:check", ...(changedScript ? ["deps:npm-lock:check:changed"] : [])],
    });
    expect(result.status, result.output).toBe(0);
    expect(result.calls).toEqual(["deps:npm-lock:check"]);
  });

  it.each([false, true])(
    "preserves absent npm-lock capability handling (historical=%s)",
    (historical) => {
      const result = runCheckShardFixture({
        task: "npm-lock",
        frozenTarget: historical,
        scripts: [],
      });
      expect(result.status, result.output).toBe(historical ? 0 : 1);
      expect(result.calls).toEqual([]);
      expect(result.output).toContain(
        historical
          ? "[skip] historical target predates the transient npm lock contract"
          : "Current CI targets must provide the deps:npm-lock:check package script.",
      );
    },
  );

  it("runs temp path guardrails in the hosted guard shard", () => {
    const requiredScripts = [
      "check:doctor-deprecation-registry",
      "check:browser-inspect-script:swift",
      "check:coercion-helpers",
    ];
    const current = runCheckShardFixture({
      frozenTarget: false,
      scripts: [...requiredScripts, "check:temp-path-guardrails"],
    });
    expect(current.status, current.output).toBe(0);
    expect(current.calls).toContain("check:temp-path-guardrails");
    expect(current.calls.indexOf("check:temp-path-guardrails")).toBeLessThan(
      current.calls.indexOf("dup:check"),
    );

    const frozenMissing = runCheckShardFixture({
      frozenTarget: true,
      scripts: requiredScripts,
    });
    expect(frozenMissing.status, frozenMissing.output).toBe(0);
    expect(frozenMissing.calls).not.toContain("check:temp-path-guardrails");
    expect(frozenMissing.calls).toContain("dup:check:coverage");
    expect(frozenMissing.output).toContain(
      "[skip] frozen target predates the temp path guardrails",
    );

    const currentMissing = runCheckShardFixture({
      frozenTarget: false,
      scripts: requiredScripts,
    });
    expect(currentMissing.status).toBe(1);
    expect(currentMissing.calls).not.toContain("check:temp-path-guardrails");
    expect(currentMissing.calls).not.toContain("dup:check");
    expect(currentMissing.output).toContain(
      "Current CI targets must provide the check:temp-path-guardrails package script.",
    );
  });

  it.each([
    {
      scripts: ["tsgo:scripts", "tsgo:test:root"],
      frozenTarget: false,
      status: 0,
      calls: ["tsgo:extensions:test", "tsgo:scripts", "tsgo:test:root"],
    },
    {
      scripts: ["tsgo:scripts"],
      frozenTarget: false,
      status: 1,
      calls: ["tsgo:extensions:test", "tsgo:scripts"],
    },
    {
      scripts: [],
      frozenTarget: false,
      status: 1,
      calls: ["tsgo:extensions:test"],
    },
    {
      scripts: [],
      frozenTarget: true,
      status: 0,
      calls: ["tsgo:extensions:test"],
    },
    {
      scripts: ["tsgo:test:root"],
      frozenTarget: true,
      status: 0,
      calls: ["tsgo:extensions:test", "tsgo:test:root"],
    },
  ])(
    "runs declared typechecks for scripts=$scripts frozen=$frozenTarget",
    ({ scripts, frozenTarget, status, calls }) => {
      const result = runCheckShardFixture({ scripts, frozenTarget, task: "test-types" });
      expect(result.status, result.output).toBe(status);
      expect(result.calls).toEqual(calls);
    },
  );

  it.each(
    (["blacksmith", "github", "hybrid"] as const).flatMap((profile) => [
      {
        profile,
        label: "test leaves",
        paths: ["src/commands/doctor-config-preflight.plugin-persistence.test.ts"],
      },
      {
        profile,
        label: "source inputs and their test consumers",
        paths: [
          "src/shared/reply-payload.types.ts",
          "src/commands/doctor-config-preflight.plugin-persistence.test.ts",
        ],
      },
    ]),
  )("retains compiler coverage for $label on $profile", ({ paths, profile }) => {
    const targeted = profile === "blacksmith";
    const compilerPaths = paths.toSorted();
    const manifest = runCiManifestFixture({
      bundledPlanner: true,
      changedCoreTestSupport: true,
      changedPlannerDependencies: paths,
      eventName: "pull_request",
      runnerProfile: profile,
      changedPaths: [...paths, "docs/ci.md"],
      changedPlannerSource: `
        export const createChangedNodeTestShards = (_paths, options) => {
          console.log("dedicated-core-types:" + JSON.stringify(options.dedicatedCoreTypeChecks));
          return [];
        };
        export const createChangedExtensionFallbackShards = () => { throw new Error("Unexpected broad fallback"); };
      `,
    });
    expect(manifest.status, manifest.output).toBe(0);
    expect(manifest.outputs.changed_core_test_paths_json).toBe(
      targeted ? JSON.stringify(compilerPaths) : "",
    );
    expect(manifest.output).toContain("dedicated-core-types:true");
    const result = runCheckShardFixture({
      frozenTarget: false,
      task: "test-types",
      scripts: ["tsgo:scripts", "tsgo:test:root"],
      types: {
        compose: true,
        profile,
        changedPathsJson: manifest.outputs.changed_core_test_paths_json,
        boundary: true,
      },
    });
    expect(result.status, result.output).toBe(0);
    const stripes = targeted ? [] : [1, 2, 3, 4, 5];
    expect(result.rows).toEqual([
      ...stripes.map((stripe) => ({ name: `core-${stripe}`, status: 0 })),
      { name: "central", status: 0 },
      { name: "boundary", status: 0 },
    ]);
    expect(result.typeCalls.filter((call) => call.row !== "boundary")).toEqual([
      ...stripes.map((stripe) => ({
        row: `core-${stripe}`,
        localCheck: null,
        command: `node --stripe ${stripe}/5 --concurrency 2`,
      })),
      ...(targeted
        ? [
            {
              row: "central",
              localCheck: null,
              command: `node --changed-paths-json ${JSON.stringify(compilerPaths)} --concurrency 2`,
            },
          ]
        : []),
      ...["tsgo:extensions:test", "tsgo:scripts", "tsgo:test:root"].map((command) => ({
        row: "central",
        localCheck: "0",
        command: `pnpm ${command}`,
      })),
    ]);
    expect(
      result.typeCalls
        .filter((call) => call.row === "boundary")
        .map((call) => call.command)
        .toSorted(),
    ).toEqual(
      BOUNDARY_CHECKS.filter((check) => !targeted || check.label !== "lint:tmp:tsgo-core-boundary")
        .map((check) => [check.command, ...check.args].join(" "))
        .toSorted(),
    );
  });

  it.each([
    { changedPaths: null, invalid: true },
    { changedPaths: [] },
    { changedPaths: ["docs/ci.md"] },
    {
      changedPaths: [
        "src/commands/doctor-config-preflight.plugin-persistence.test.ts",
        "src/commands/deleted-core-leaf.test.ts",
        "docs/ci.md",
      ],
      changedPlannerDependencies: [
        "src/commands/doctor-config-preflight.plugin-persistence.test.ts",
      ],
    },
    { changedPaths: ["src/commands/doctor.test.ts", "package.json"] },
    { changedPaths: ["src/commands/doctor.test.ts", "src/shared.test-support.ts"] },
    { changedPaths: ["packages/mermaid-renderer/src/render.test.ts"] },
    { changedPaths: ["src/gateway/gateway-acp-bind.live.test.ts"] },
    { changedPaths: ["src/commands/doctor.test.ts"], changedCoreTestSupport: false },
    { changedPaths: ["src/commands/doctor.test.ts"], eventName: "push" as const },
    { changedPaths: ["src/commands/doctor.test.ts"], eventName: "workflow_dispatch" as const },
    {
      changedPaths: ["src/commands/doctor.test.ts"],
      scopeEnv: { OPENCLAW_CI_CHANGED_PATHS_JSON: "invalid" },
      invalid: true,
    },
  ])("retains full type owners for ineligible manifest inputs %j", (options) => {
    const manifest = runCiManifestFixture({
      bundledPlanner: true,
      changedCoreTestSupport: true,
      eventName: "pull_request",
      runnerProfile: "hybrid",
      ...options,
    });
    if ("invalid" in options) {
      expect(manifest.status).not.toBe(0);
      expect(manifest.output).toContain("Current PR CI requires complete changed paths");
      expect(manifest.outputs.changed_core_test_paths_json).toBeUndefined();
    } else {
      expect(manifest.status, manifest.output).toBe(0);
      expect(manifest.outputs.changed_core_test_paths_json).toBe("");
      expect(
        evaluateWorkflowExpression(readCiWorkflow().jobs["check-test-types-hosted-core-shard"].if, {
          eventName: options.eventName ?? "pull_request",
          repository: "openclaw/openclaw",
          runAttempt: 1,
          runnerProfile: "hybrid",
          preflightOutputs: manifest.outputs,
        }),
      ).toBe(true);
    }
  });

  it("reuses isolated test-type caches without bypassing compilation or cache authority", () => {
    const workflow = readCiWorkflow();
    for (const [jobId, runName] of [
      ["check-shard", "Run check shard"],
      ["check-test-types-hosted-core-shard", "Run hosted core test-types stripe"],
    ] as const) {
      const steps = workflow.jobs[jobId].steps as WorkflowStep[];
      const restore = expectDefined(
        steps.find((step) => step.id === "test-type-cache"),
        `${jobId} compiler cache`,
      );
      const save = expectDefined(
        steps.find(
          (step) => step.name?.startsWith("Save") && step.with?.path === ".artifacts/tsgo-cache",
        ),
        `${jobId} compiler cache writer`,
      );
      const run = expectDefined(
        steps.find((step) => step.name === runName),
        `${jobId} compiler`,
      );
      expect(steps.indexOf(restore)).toBeLessThan(steps.indexOf(run));
      expect(steps.indexOf(save)).toBeGreaterThan(steps.indexOf(run));
      expect(run.if).toBeUndefined();
      expect(run.run).not.toContain("cache-hit");
      expect(restore.with?.path).toBe(".artifacts/tsgo-cache");
      expect(restore.with?.key).toContain("pnpm-lock.yaml");
      expect(restore.with?.key).toContain("test/tsconfig/*.json");
      expect(restore.with?.key).toContain(
        jobId === "check-shard" ? "matrix.task" : "matrix.stripe",
      );
      expect(save.with?.key).toBe("${{ steps.test-type-cache.outputs.cache-primary-key }}");
      for (const [cacheMode, writable, frozen, failed, canRestore, canSave] of [
        ["restore", false, false, false, true, false],
        ["restore", true, false, false, true, true],
        ["off", true, false, false, false, false],
        ["restore", true, true, false, false, false],
        ["restore", true, false, true, true, false],
      ] as const) {
        const context: Parameters<typeof evaluateWorkflowExpression>[1] = {
          eventName: writable ? "push" : "pull_request",
          repository: "openclaw/openclaw",
          runAttempt: 1,
          frozenTarget: frozen,
          failed,
          matrix: { task: "test-types", stripe: 1 },
          preflightOutputs: { cache_mode: cacheMode, cache_write_allowed: String(writable) },
          steps: { "test-type-cache": { outputs: { "cache-hit": "false" } } },
        };
        expect(evaluateWorkflowExpression("${{ " + restore.if + " }}", context)).toBe(canRestore);
        expect(evaluateWorkflowExpression("${{ " + save.if + " }}", context)).toBe(canSave);
      }
    }
  });

  it.each([
    ["hybrid", "pull_request", false, true, true, true],
    ["github", "workflow_dispatch", false, true, true, true],
    ["blacksmith", "push", false, true, true, false],
    ["hybrid", "workflow_dispatch", true, false, true, false],
    ["hybrid", "workflow_dispatch", true, true, false, false],
    ["hybrid", "workflow_dispatch", true, true, true, true],
  ] as const)(
    "preserves type workload for %s %s frozen=%s hosted-contract=%s stripe-support=%s",
    (profile, eventName, frozenTarget, hostedContract, stripeSupport, striped) => {
      const result = runCheckShardFixture({
        task: "test-types",
        scripts: ["tsgo:scripts", "tsgo:test:root"],
        frozenTarget,
        types: { compose: true, profile, eventName, hostedContract, stripeSupport },
      });
      expect(result.status, result.output).toBe(0);
      const stripes = result.typeCalls.filter((call) => call.command.startsWith("node "));
      const packages = result.typeCalls.filter((call) => call.command.startsWith("pnpm "));
      expect(packages.map((call) => call.localCheck)).toEqual(packages.map(() => "0"));
      if (striped) {
        expect(result.rows).toHaveLength(frozenTarget ? 3 : 6);
        expect(
          result.rows.map((row) =>
            stripes
              .filter((call) => call.row === row.name)
              .map((call) => call.command.split(" ")[2]),
          ),
        ).toEqual(
          frozenTarget
            ? [["1/5", "2/5"], ["3/5", "4/5"], ["5/5"]]
            : [["1/5"], ["2/5"], ["3/5"], ["4/5"], ["5/5"], []],
        );
        for (const call of stripes) {
          const args = call.command.split(" ").slice(1);
          expect(args).toEqual(["--stripe", expect.any(String), "--concurrency", "2"]);
          expect(call.localCheck).toBeNull();
        }
        expect(result.calls).toEqual(["tsgo:extensions:test", "tsgo:scripts", "tsgo:test:root"]);
      } else {
        expect(stripes).toEqual([]);
        expect(result.calls).toEqual(["check:test-types", "tsgo:scripts"]);
      }
    },
  );

  it.each([
    { failStripe: "1/5", frozenTarget: false },
    { failStripe: "5/5", frozenTarget: false },
    { failStripe: "1/5", frozenTarget: true },
    { failStripe: "5/5", frozenTarget: true },
  ])(
    "halts only the type row whose first stripe $failStripe fails (frozen=$frozenTarget)",
    ({ failStripe, frozenTarget }) => {
      const result = runCheckShardFixture({
        task: "test-types",
        scripts: ["tsgo:scripts", "tsgo:test:root"],
        frozenTarget,
        types: { compose: true, failStripe },
      });
      expect(result.status, result.output).toBe(17);
      expect(
        readCiWorkflow().jobs["check-test-types-hosted-core-shard"].strategy["fail-fast"],
      ).toBe(false);
      const failed = result.rows.filter((row) => row.status !== 0);
      expect(failed).toHaveLength(1);
      expect(result.rows.filter((row) => row.status === 0)).toHaveLength(frozenTarget ? 2 : 5);
      expect(
        result.typeCalls.filter((call) => call.row === failed[0]!.name).map((call) => call.command),
      ).toEqual([`node --stripe ${failStripe} --concurrency 2`]);
      expect(result.calls).toEqual(
        frozenTarget && failStripe === "5/5"
          ? []
          : ["tsgo:extensions:test", "tsgo:scripts", "tsgo:test:root"],
      );
    },
  );

  it.each(["main", "trunk/release"])(
    "resolves manual diff and cache bases from authenticated %s when anonymous Git is unavailable",
    (defaultBranch) => {
      const result = runDiffBaseFixture({
        commitCount: 2,
        eventBaseSha: "",
        defaultBranch,
        manual: true,
      });
      expect(result.status, result.output).toBe(0);
      expect(result.outputs).toEqual({
        default_sha: result.parentSha,
        sha: result.parentSha,
        head_sha: result.headSha,
      });
      expect(result.emittedBaseIsCommit).toBe(true);
    },
  );

  it.each(["ref", "comparison"] as const)(
    "rejects unavailable authenticated manual diff-base %s evidence",
    (apiError) => {
      const result = runDiffBaseFixture({
        commitCount: 2,
        eventBaseSha: "",
        manual: true,
        apiError,
      });
      expect(result.status).not.toBe(0);
      expect(result.output).toContain("HTTP 503");
      expect(result.outputs).not.toHaveProperty("sha");
    },
  );

  it("rejects ambiguous zero-before main pushes and preserves concrete bases", () => {
    const zeroSha = "0".repeat(40);
    const threeCommit = runDiffBaseFixture({ commitCount: 3, eventBaseSha: zeroSha });
    expect(threeCommit.status, threeCommit.output).toBe(1);
    expect(threeCommit.output).toContain(AMBIGUOUS_MAIN_PUSH_DIAGNOSTIC);
    expect(threeCommit.outputs).not.toHaveProperty("sha");
    expect(threeCommit.emittedBaseIsCommit).toBe(false);

    const rootCommit = runDiffBaseFixture({ commitCount: 1, eventBaseSha: zeroSha });
    expect(rootCommit.status, rootCommit.output).toBe(1);
    expect(rootCommit.output).toContain(AMBIGUOUS_MAIN_PUSH_DIAGNOSTIC);
    expect(rootCommit.outputs).not.toHaveProperty("sha");
    expect(rootCommit.emittedBaseIsCommit).toBe(false);

    const concreteBase = runDiffBaseFixture({
      commitCount: 3,
      eventBaseSha: "parent",
    });
    expect(concreteBase.status, concreteBase.output).toBe(0);
    expect(concreteBase.outputs.sha).toBe(concreteBase.eventBaseSha);
    expect(concreteBase.emittedBaseIsCommit).toBe(true);
  });

  it("uses stable deadcode checks for current and frozen checkouts", () => {
    const modern = runDependencyCheckFixture({
      historicalTarget: false,
      scripts: ["deadcode:dependencies", "deadcode:unused-files", "deadcode:exports"],
    });
    expect(modern.status, modern.output).toBe(0);
    // The scripts launch concurrently; completion order is nondeterministic.
    expect(modern.calls.toSorted()).toEqual([
      "deadcode:dependencies",
      "deadcode:exports",
      "deadcode:unused-files",
    ]);

    const frozenWithExports = runDependencyCheckFixture({
      historicalTarget: true,
      releaseToolingEntry: true,
      scripts: ["deadcode:dependencies", "deadcode:unused-files", "deadcode:exports"],
    });
    expect(frozenWithExports.status, frozenWithExports.output).toBe(0);
    expect(frozenWithExports.calls.toSorted()).toEqual([
      "deadcode:dependencies",
      "deadcode:exports",
      "deadcode:unused-files",
    ]);

    const frozen = runDependencyCheckFixture({
      historicalTarget: true,
      scripts: [
        "deadcode:ci",
        "deadcode:dependencies",
        "deadcode:report:ci:ts-unused",
        "deadcode:unused-files",
      ],
    });
    expect(frozen.status, frozen.output).toBe(0);
    expect(frozen.calls.toSorted()).toEqual(["deadcode:dependencies", "deadcode:unused-files"]);

    const currentWithoutExports = runDependencyCheckFixture({
      historicalTarget: false,
      scripts: ["deadcode:dependencies", "deadcode:unused-files"],
    });
    expect(currentWithoutExports.status).toBe(1);
    // The missing-script contract violation now fails fast before launching
    // the concurrent scans instead of wasting two Knip runs first.
    expect(currentWithoutExports.calls).toEqual([]);
    expect(currentWithoutExports.output).toContain(
      "Current CI targets must provide the deadcode:exports package script.",
    );

    const legacy = runDependencyCheckFixture({
      historicalTarget: true,
      scripts: ["deadcode:ci"],
    });
    expect(legacy.status, legacy.output).toBe(0);
    expect(legacy.calls).toEqual(["deadcode:ci"]);

    const incompleteCurrent = runDependencyCheckFixture({
      historicalTarget: false,
      scripts: ["deadcode:dependencies"],
    });
    expect(incompleteCurrent.status).toBe(1);
    expect(incompleteCurrent.calls).toEqual([]);
    expect(incompleteCurrent.output).toContain(
      "Target does not provide a supported deadcode check.",
    );
  });

  it.each([
    {
      eventName: "pull_request",
      capability: true,
      uiCapability: true,
      policy: "bun-compatible",
      uiPolicy: "bun-compatible",
      bun: true,
    },
    {
      eventName: "workflow_dispatch",
      capability: true,
      uiCapability: true,
      policy: "dual",
      uiPolicy: "dual",
      bun: true,
    },
    {
      eventName: "workflow_dispatch",
      releaseGate: true,
      capability: true,
      uiCapability: true,
      policy: "bun-compatible",
      uiPolicy: "bun-compatible",
      bun: true,
    },
    {
      eventName: "push",
      capability: true,
      uiCapability: true,
      policy: "node",
      uiPolicy: "node",
      bun: false,
    },
    {
      eventName: "workflow_dispatch",
      capability: false,
      uiCapability: false,
      policy: "node",
      uiPolicy: "node",
      bun: false,
    },
    {
      eventName: "pull_request",
      capability: true,
      uiCapability: false,
      policy: "bun-compatible",
      uiPolicy: "node",
      bun: true,
    },
    {
      eventName: "workflow_dispatch",
      capability: true,
      uiCapability: "requires-ftl-flag",
      policy: "dual",
      uiPolicy: "node",
      bun: true,
    },
    {
      eventName: "workflow_dispatch",
      historicalCompatibility: true,
      capability: true,
      uiCapability: true,
      policy: "dual",
      uiPolicy: "node",
      bun: true,
    },
  ] as const)(
    "routes test runtimes without adding jobs ($eventName, capability=$capability)",
    (scenario) => {
      const { eventName, capability, uiCapability, policy, uiPolicy, bun } = scenario;
      const manifest = runCiManifestFixture({
        historicalCompatibility: false,
        ...scenario,
        bundledPlanner: true,
        bunTestRuntime: capability,
        bunUiTestRuntime: uiCapability,
        eventName,
        nodeTestShards: [
          {
            checkName: "runtime-proof",
            shardName: "runtime-proof",
            configs: ["fixture-bun.config.ts"],
            requiresDist: false,
            runner: "ubuntu-24.04",
          },
        ],
        changedPaths: ["scripts/lib/ci-node-test-plan.mts"],
      });
      expect(manifest.status, manifest.output).toBe(0);
      const rows = JSON.parse(
        expectDefined(manifest.outputs.checks_node_core_nondist_matrix, "Node test matrix"),
      ).include;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ test_runtime_policy: policy, requires_bun: bun });
      expect(manifest.outputs.ui_test_runtime_policy).toBe(uiPolicy);
      const job = readCiWorkflow().jobs["checks-node-core-test-nondist-shard"];
      const context = {
        eventName,
        repository: "openclaw/openclaw",
        matrix: rows[0],
        runAttempt: 1,
      };
      const setup = job.steps.find((step: WorkflowStep) => step.name === "Setup Node environment");
      const run = job.steps.find((step: WorkflowStep) => step.name === "Run Node test shard");
      expect(setup.with["install-bun"]).toBe("false");
      const bunSetup = job.steps.find(
        (step: WorkflowStep) => step.name === "Setup pinned Bun test runtime",
      );
      expect(bunSetup.uses).toBe("./.ci-harness/.github/actions/setup-test-bun");
      expect(evaluateWorkflowExpression(`\${{ ${bunSetup.if} }}`, context)).toBe(bun);
      expect(evaluateWorkflowExpression(run.env.OPENCLAW_CI_TEST_RUNTIME_POLICY, context)).toBe(
        policy,
      );
      const ui = readCiWorkflow().jobs["checks-ui"];
      const uiContext = { ...context, preflightOutputs: manifest.outputs };
      const uiBunSetup = ui.steps.find(
        (step: WorkflowStep) => step.name === "Setup pinned Bun test runtime",
      );
      expect(uiBunSetup.uses).toBe("./.ci-harness/.github/actions/setup-test-bun");
      expect(evaluateWorkflowExpression(`\${{ ${uiBunSetup.if} }}`, uiContext)).toBe(
        uiPolicy !== "node",
      );
      const uiRun = ui.steps.find((step: WorkflowStep) => step.name === "Test Control UI");
      expect(evaluateWorkflowExpression(uiRun.env.OPENCLAW_CI_TEST_RUNTIME_POLICY, uiContext)).toBe(
        uiPolicy,
      );
    },
  );

  it("runs the selected startup corpus once when a canonical PR admits every selected Node file", () => {
    const revision = "a".repeat(40);
    const shards = createNodeTestShardBundles({
      compactMode: "pull-request",
      includeReleaseOnlyPluginShards: false,
      includeReleaseOnlyRuntimeTests: false,
    });
    const manifest = runCiManifestFixture({
      bundledPlanner: true,
      eventName: "pull_request",
      nodeTestShards: shards,
      startupCorpusCoverage: true,
      changedPaths: ["scripts/lib/ci-node-test-plan.mts"],
      scopeEnv: { OPENCLAW_CI_WORKFLOW_REVISION: revision },
    });
    expect(manifest.status, manifest.output).toBe(0);
    expect(manifest.outputs.startup_corpus_node_revision).toBe(revision);
    expect(
      JSON.parse(
        expectDefined(manifest.outputs.startup_corpus_test_files_json, "startup corpus inventory"),
      ),
    ).toEqual(["src/config/config-startup-corpus.test.ts"]);
    expect(manifest.outputs.run_checks_node_core_nondist).toBe("true");
    const step = readCiWorkflow().jobs["checks-fast-core"].steps.find(
      (entry: WorkflowStep) => entry.name === "Check startup corpus",
    );
    expect(
      evaluateWorkflowExpression(`\${{ ${step.if} }}`, {
        eventName: "pull_request",
        repository: "openclaw/openclaw",
        matrix: { task: "startup-corpus" },
        runAttempt: 1,
        preflightOutputs: { ...manifest.outputs, checkout_revision: revision },
      }),
    ).toBe(false);
    for (const result of ["failure", "skipped"]) {
      expect(
        runCiGateFixture(
          `checks-fast-core=success|true\nchecks-node-core-test-nondist-shard=${result}|true`,
        ).status,
      ).toBe(1);
    }
  });

  it.each<{ label: string } & Partial<Parameters<typeof runCiManifestFixture>[0]>>([
    { label: "missing planner capability", startupCorpusCoverage: false },
    {
      label: "directly edited state wrapper missing from Node coverage",
      changedPaths: ["src/config/state-startup-corpus.part-2.test.ts"],
      nodeTestShards: [
        {
          checkName: "config-corpus-only",
          shardName: "config-corpus-only",
          requiresDist: false,
          runner: "ubuntu-24.04",
          configs: [],
          groups: [
            {
              shard_name: "core-runtime-config",
              requiresDist: false,
              runner: "ubuntu-24.04",
              configs: ["test/vitest/vitest.runtime-config.config.ts"],
              includePatterns: ["src/config/config-startup-corpus.test.ts"],
            },
          ],
        },
      ],
    },
    { label: "different source tree", scopeEnv: { OPENCLAW_CI_WORKFLOW_REVISION: "b".repeat(40) } },
    {
      label: "unknown source",
      scopeEnv: { OPENCLAW_CI_CHECKOUT_REVISION: "", OPENCLAW_CI_WORKFLOW_REVISION: "" },
    },
    { label: "fast-only PR", nodeFastOnly: true },
    { label: "Node not admitted", runNode: false },
    { label: "different repository", repository: "fixture/openclaw" },
    { label: "release merge", eventName: "workflow_dispatch", releaseGate: true },
    {
      label: "frozen target",
      eventName: "workflow_dispatch",
      scopeEnv: { OPENCLAW_CI_WORKFLOW_REVISION: "b".repeat(40) },
    },
  ])(
    "retains the startup corpus without a coverage receipt: $label",
    ({ label: _label, ...options }) => {
      const manifest = runCiManifestFixture({
        bundledPlanner: true,
        startupCorpusCoverage: true,
        eventName: "pull_request",
        changedPaths: ["scripts/lib/ci-node-test-plan.mts"],
        scopeEnv: { OPENCLAW_CI_WORKFLOW_REVISION: "a".repeat(40) },
        nodeTestShards: [
          {
            checkName: "complete-corpus",
            shardName: "complete-corpus",
            requiresDist: false,
            configs: [],
            runner: "ubuntu-24.04",
            groups: [
              {
                shard_name: "core-runtime-config",
                requiresDist: false,
                runner: "ubuntu-24.04",
                configs: ["test/vitest/vitest.runtime-config.config.ts"],
                includePatterns: startupCorpusTestFiles,
              },
            ],
          },
        ],
        ...options,
      });
      expect(manifest.status, manifest.output).toBe(0);
      expect(manifest.outputs.startup_corpus_node_revision).toBe("");
    },
  );

  it.each(["", "b".repeat(40)])(
    "retains the startup corpus for an unbound receipt %j",
    (revision) => {
      const step = readCiWorkflow().jobs["checks-fast-core"].steps.find(
        (entry: WorkflowStep) => entry.name === "Check startup corpus",
      );
      expect(
        evaluateWorkflowExpression(`\${{ ${step.if} }}`, {
          eventName: "pull_request",
          repository: "openclaw/openclaw",
          matrix: { task: "startup-corpus" },
          runAttempt: 1,
          preflightOutputs: {
            startup_corpus_node_revision: revision,
            checkout_revision: "a".repeat(40),
          },
        }),
      ).toBe(true);
    },
  );

  it("runs the regular startup corpus once on full canonical main pushes", () => {
    const files = ["src/config/config-startup-corpus.test.ts"];
    const groups = createNodeTestShardBundles({
      compactMode: "push",
      includeReleaseOnlyPluginShards: false,
      includeReleaseOnlyRuntimeTests: false,
    }).flatMap((shard) => shard.groups);
    const steps: WorkflowStep[] = readCiWorkflow().jobs["checks-fast-core"].steps;
    for (const file of files) {
      expect(
        buildVitestRunPlans([file]).map((plan) => plan.config),
        file,
      ).toEqual(["test/vitest/vitest.runtime-config.config.ts"]);
      const nodeOwners = groups.filter(
        (group) =>
          group.configs.includes("test/vitest/vitest.runtime-config.config.ts") &&
          (!group.includePatterns ||
            group.includePatterns.some((pattern) => minimatch(file, pattern))),
      );
      expect(nodeOwners, file).toHaveLength(1);
      const extraOwners = steps.filter(
        (step) =>
          step.run?.includes(file) &&
          (!step.if ||
            evaluateWorkflowExpression(`\${{ ${step.if} }}`, {
              eventName: "push",
              repository: "openclaw/openclaw",
              ref: "refs/heads/main",
              matrix: { task: "startup-corpus" },
              runCheck: true,
              runAttempt: 1,
            })),
      );
      expect(nodeOwners.length + extraOwners.length, file).toBe(1);
    }
  });

  it.each<{
    label: string;
    eventName: "pull_request" | "push" | "workflow_dispatch";
    expectedFiles: readonly string[];
    changedPaths?: readonly string[];
    repository?: string;
    releaseGate?: boolean;
    frozenTarget?: boolean;
    selectionCapability?: boolean;
    splitCorpus?: boolean;
  }>([
    {
      label: "automatic PR source change",
      eventName: "pull_request",
      changedPaths: ["src/config/io.ts"],
      expectedFiles: ["src/config/config-startup-corpus.test.ts"],
    },
    {
      label: "automatic PR directly edited wrappers",
      eventName: "pull_request",
      changedPaths: [
        "src/config/state-startup-corpus.part-2.test.ts",
        "src/config/state-startup-corpus.part-4.test.ts",
      ],
      expectedFiles: [
        "src/config/config-startup-corpus.test.ts",
        "src/config/state-startup-corpus.part-2.test.ts",
        "src/config/state-startup-corpus.part-4.test.ts",
      ],
    },
    {
      label: "automatic main without Node coverage",
      eventName: "push",
      expectedFiles: ["src/config/config-startup-corpus.test.ts"],
    },
    {
      label: "noncanonical PR",
      eventName: "pull_request",
      repository: "fixture/openclaw",
      expectedFiles: startupCorpusTestFiles,
    },
    {
      label: "manual Full Release Validation child",
      eventName: "workflow_dispatch",
      expectedFiles: startupCorpusTestFiles,
    },
    {
      label: "exact-head PR release-gate substitute",
      eventName: "workflow_dispatch",
      releaseGate: true,
      changedPaths: ["src/config/state-startup-corpus.part-2.test.ts"],
      expectedFiles: [
        "src/config/config-startup-corpus.test.ts",
        "src/config/state-startup-corpus.part-2.test.ts",
      ],
    },
    {
      label: "frozen target with selection capability",
      eventName: "workflow_dispatch",
      frozenTarget: true,
      expectedFiles: startupCorpusTestFiles,
    },
    {
      label: "frozen target before selection capability",
      eventName: "workflow_dispatch",
      frozenTarget: true,
      selectionCapability: false,
      expectedFiles: [
        "src/config/config-startup-corpus.test.ts",
        ...stateStartupCorpusTestFiles.toSorted(),
      ],
    },
    {
      label: "frozen target before corpus split",
      eventName: "workflow_dispatch",
      frozenTarget: true,
      selectionCapability: false,
      splitCorpus: false,
      expectedFiles: startupCorpusTestFiles,
    },
  ])("executes the manifest-selected startup fallback: $label", (scenario) => {
    const repository = scenario.repository ?? "openclaw/openclaw";
    const frozenTarget = scenario.frozenTarget ?? false;
    const releaseGate = scenario.releaseGate ?? false;
    const selectionCapability = scenario.selectionCapability ?? true;
    const splitCorpus = scenario.splitCorpus ?? true;
    const manifest = runCiManifestFixture({
      bundledPlanner: true,
      eventName: scenario.eventName,
      repository,
      releaseGate,
      runNode: false,
      changedPaths: [...(scenario.changedPaths ?? ["src/config/io.ts"])],
      startupCorpusSelection: selectionCapability,
      scopeEnv: {
        OPENCLAW_CI_WORKFLOW_REVISION: (frozenTarget ? "b" : "a").repeat(40),
      },
    });
    expect(manifest.status, manifest.output).toBe(0);
    expect(manifest.outputs.startup_corpus_node_revision).toBe("");
    expect(manifest.outputs.startup_corpus_test_files_json).toBe(
      selectionCapability ? JSON.stringify(scenario.expectedFiles) : "",
    );
    const steps: WorkflowStep[] = readCiWorkflow().jobs["checks-fast-core"].steps;
    const step = expectDefined(
      steps.find((entry) => entry.name === "Check startup corpus"),
      "startup corpus step",
    );
    const inventoryExpression = step.env?.OPENCLAW_CI_STARTUP_CORPUS_TEST_FILES_JSON;
    if (typeof inventoryExpression !== "string") {
      throw new TypeError("Startup corpus inventory must use a workflow expression");
    }
    const context = {
      eventName: scenario.eventName,
      repository,
      releaseGate,
      frozenTarget,
      matrix: { task: "startup-corpus" },
      runAttempt: 1,
      preflightOutputs: manifest.outputs,
    };
    expect(evaluateWorkflowExpression(`\${{ ${step.if} }}`, context)).toBe(true);
    const directory = tempDirs.make("startup-corpus-command-");
    const bin = path.join(directory, "bin");
    const argsPath = path.join(directory, "args");
    mkdirSync(bin);
    if (splitCorpus) {
      mkdirSync(path.join(directory, "test/vitest"), { recursive: true });
      writeFileSync(path.join(directory, "test/vitest/vitest.startup-corpus-paths.mjs"), "");
      mkdirSync(path.join(directory, "src/config"), { recursive: true });
      for (const file of startupCorpusTestFiles) {
        writeFileSync(path.join(directory, file), "");
      }
    }
    writeExecutable(path.join(bin, "pnpm"), [
      "#!/bin/sh",
      '[ "$*" = "build qaRuntime" ] || exit 1',
      "mkdir dist || exit 1",
      "touch dist/.buildstamp",
    ]);
    writeExecutable(path.join(bin, "node"), [
      "#!/bin/sh",
      'test -f dist/.buildstamp || { echo "runtime not prepared" >&2; exit 1; }',
      'if [ "$1" = "-p" ]; then exec "$STARTUP_CORPUS_NODE" "$@"; fi',
      'label="${OPENCLAW_TEST_STARTUP_CORPUS_SHARD:-config}"',
      'case "$label" in */*) label="${label%/*}-${label#*/}" ;; esac',
      'printf "%s\\n" "$@" > "$STARTUP_CORPUS_ARGS.$label"',
    ]);
    const script = expectDefined(step.run, "startup corpus command").replace(
      /\$\{\{[\s\S]*?\}\}/gu,
      (expression) => String(evaluateWorkflowExpression(expression, context)),
    );
    const result = runWorkflowShellScript(script, {
      cwd: directory,
      env: {
        ...process.env,
        PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
        STARTUP_CORPUS_ARGS: argsPath,
        STARTUP_CORPUS_NODE: testNodeExecPath,
        OPENCLAW_CI_STARTUP_CORPUS_TEST_FILES_JSON: String(
          evaluateWorkflowExpression(inventoryExpression, context),
        ),
      },
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const readArgs = (label: string) =>
      readFileSync(`${argsPath}.${label.replace("/", "-")}`, "utf8")
        .trim()
        .split("\n");
    const commonArgs = [
      "scripts/run-vitest.mjs",
      "run",
      "--config",
      "test/vitest/vitest.runtime-config.config.ts",
      ...(frozenTarget
        ? []
        : [
            "--reporter",
            "verbose",
            "--reporter",
            "github-actions",
            "--reporter",
            "./scripts/lib/vitest-resource-reporter.mts",
          ]),
    ];
    if (splitCorpus) {
      expect(readArgs("config")).toEqual([
        ...commonArgs,
        `--maxWorkers=${Math.min(4, availableParallelism())}`,
        ...scenario.expectedFiles,
      ]);
      expect(readdirSync(directory).filter((file) => file.startsWith("args."))).toEqual([
        "args.config",
      ]);
    } else {
      expect(readArgs("config")).toEqual([
        ...commonArgs,
        "src/config/config-startup-corpus.test.ts",
      ]);
      for (const shard of ["1/4", "2/4", "3/4", "4/4"]) {
        expect(readArgs(shard), shard).toEqual([
          ...commonArgs,
          "src/config/state-startup-corpus.test.ts",
        ]);
      }
    }
  });

  it.each([
    { cpus: 1, slots: 1 },
    { cpus: 2, slots: 1 },
    { cpus: 4, slots: 1 },
    { cpus: 8, slots: 2 },
    { cpus: 32, slots: 5 },
    { cpus: 2, slots: 1, fail: "1/4" },
  ])("bounds frozen legacy startup corpus admission: %j", (scenario) => {
    const steps: WorkflowStep[] = readCiWorkflow().jobs["checks-fast-core"].steps;
    const step = steps.find((candidate) => candidate.name === "Check startup corpus");
    const script = expectDefined(step?.run, "startup corpus command").replace(
      /\$\{\{[\s\S]*?\}\}/gu,
      (expression) =>
        String(
          evaluateWorkflowExpression(expression, {
            eventName: "workflow_dispatch",
            repository: "openclaw/openclaw",
            releaseGate: true,
            frozenTarget: true,
            runAttempt: 1,
          }),
        ),
    );
    assertStartupCorpusCommand(
      script,
      tempDirs.make("startup-corpus-admission-"),
      { ...scenario, frozenTarget: true },
      runWorkflowShellScript,
    );
  });

  it("gates Node fanout on selected ratchets without waiting for startup or unrelated checks", () => {
    const workflow = readCiWorkflow();
    const nodeJob = workflow.jobs["checks-node-core-test-nondist-shard"];
    expect(nodeJob.needs).toEqual(["preflight", "checks-baseline-ratchets"]);
    expect(workflow.jobs["checks-fast-core"].needs).toEqual(["preflight"]);
    const ratchet = workflow.jobs["checks-baseline-ratchets"];
    expect(ratchet.steps.some((step: WorkflowStep) => step.name === "Check startup corpus")).toBe(
      false,
    );
    expect(ratchet.env.CHECKOUT_BASE_SHA).toBe("${{ needs.preflight.outputs.diff_base_revision }}");
    for (const selected of ["true", "false"]) {
      for (const result of ["success", "failure", "cancelled", "skipped"]) {
        for (const nodeSelected of ["true", "false"]) {
          for (const cancelled of [true, false]) {
            const admitted = evaluateWorkflowExpression(nodeJob.if, {
              eventName: "pull_request",
              repository: "openclaw/openclaw",
              runAttempt: 1,
              cancelled,
              preflightOutputs: {
                run_baseline_ratchets: selected,
                run_checks_node_core_nondist: nodeSelected,
              },
              jobResults: { "checks-baseline-ratchets": result },
            });
            expect(admitted).toBe(
              !cancelled &&
                nodeSelected === "true" &&
                (result === "success" || (selected === "false" && result === "skipped")),
            );
          }
        }
      }
    }
    expect(
      evaluateWorkflowExpression(nodeJob.if, {
        eventName: "pull_request",
        repository: "openclaw/openclaw",
        runAttempt: 1,
        preflightOutputs: { run_baseline_ratchets: "true", run_checks_node_core_nondist: "true" },
        jobResults: { preflight: "failure" },
      }),
    ).toBe(false);
  });

  it("runs all baseline ratchets against the exact tested tree", () => {
    const workflow = readCiWorkflow();
    const maxLinesRatchet = readFileSync("scripts/check-max-lines-ratchet.mts", "utf8");
    const checksFastJob = workflow.jobs["checks-fast-core"];
    const checksFastSteps = checksFastJob.steps;
    const ratchetJob = workflow.jobs["checks-baseline-ratchets"];
    const ratchetRun = ratchetJob.steps.find(
      (step: WorkflowStep) => step.name === "Run baseline ratchets",
    );
    const checkout = checksFastSteps.find((step: WorkflowStep) => step.name === "Checkout");
    const checksFastRun = checksFastSteps.find(
      (step: WorkflowStep) => step.name === "Run ${{ matrix.task }} (${{ matrix.runtime }})",
    );
    const releaseGateMerge = checksFastSteps.find(
      (step: WorkflowStep) => step.name === "Prepare release-gate ratchet merge tree",
    );
    expect(
      checksFastSteps.some((step: WorkflowStep) => step.name === "Resolve manual protocol base"),
    ).toBe(false);

    expect(workflow.jobs["checks-fast-core"].permissions).toEqual({
      contents: "read",
      "pull-requests": "read",
    });
    expect(checkout.env.CHECKOUT_SHA).toBe("${{ needs.preflight.outputs.checkout_revision }}");
    expect(releaseGateMerge.if).toBe(
      "(matrix.task == 'startup-corpus' || startsWith(matrix.task, 'release-lint-')) && github.event_name == 'workflow_dispatch' && inputs.release_gate",
    );
    expect(checksFastRun.run).toContain("startup-corpus)");
    expect(checksFastRun.run).toContain("coercion-helpers)");
    expect(checksFastRun.run).toContain("pnpm check:coercion-helpers");
    expect(checksFastRun.run).toContain("bun-launcher)");
    expect(checksFastRun.run).toContain(
      "OPENCLAW_E2E_SKIP_BUILD=1 OPENCLAW_TEST_BUN_LAUNCHER=1 pnpm test test/openclaw-launcher.e2e.test.ts",
    );
    expect(checksFastRun.run).toContain(
      "if [[ -f src/plugins/plugin-module-generation.test.ts ]]; then",
    );
    expect(checksFastRun.run).toContain(
      'elif [[ "${{ needs.preflight.outputs.frozen_target }}" != "true" ]]; then',
    );
    expect(ratchetRun.run).toContain(
      "for required_script in check:max-lines-ratchet check:assertion-safety config:docs:check plugins:inventory:check; do",
    );
    expect(ratchetRun.run).toContain('has_package_script "$required_script"');
    expect(ratchetRun.env.RATCHET_PR_HEAD_SHA).toBe(
      "${{ github.event_name == 'pull_request' && github.event.pull_request.head.sha || '' }}",
    );
    expect(ratchetRun.env).not.toHaveProperty("RATCHET_EVENT_BASE_SHA");
    expect(ratchetRun.env).not.toHaveProperty("RATCHET_MANUAL_TARGET_SHA");
    expect(ratchetRun.env).not.toHaveProperty("GH_TOKEN");
    expect(ratchetRun.env).not.toHaveProperty("PROTOCOL_MANUAL_BASE_SHA");
    expect(checksFastRun.env.PROTOCOL_SINCE_BASE_SHA).toBe(
      "${{ needs.preflight.outputs.diff_base_revision }}",
    );
    expect(releaseGateMerge.run).toContain(
      'gh api --method GET "repos/${GITHUB_REPOSITORY}/pulls/${PULL_REQUEST_NUMBER}"',
    );
    expect(releaseGateMerge.run).toContain(
      "release-gate pull request must be open and match the target head",
    );
    expect(releaseGateMerge.run).toContain("for attempt in {1..6}");
    expect(releaseGateMerge.run).toContain(
      '"+refs/pull/${PULL_REQUEST_NUMBER}/merge:refs/remotes/origin/ci-ratchet-merge"',
    );
    expect(releaseGateMerge.run).toContain('"$merge_head" == "$TARGET_SHA"');
    expect(releaseGateMerge.run).toContain('git show -s --format=%P "$merge_sha"');
    expect(releaseGateMerge.run).toContain(
      "Freeze GitHub's canonical merge snapshot once it contains the exact head",
    );
    expect(releaseGateMerge.run).toContain(
      "Base freshness belongs to the landing gate; chasing moving main here can never converge",
    );
    expect(releaseGateMerge.run).toContain(
      "release-gate merge tree did not refresh to the target head",
    );
    expect(releaseGateMerge.run).not.toContain(".base.sha");
    expect(releaseGateMerge.run).toContain('--git 0 checkout --detach "$merge_sha"');
    expect(releaseGateMerge.run).toContain(
      'echo "RATCHET_BASE_REF=${frozen_base_sha}" >> "$GITHUB_ENV"',
    );
    expect(checksFastRun.run).not.toContain("PROTOCOL_MANUAL_BASE_SHA");
    expect(checksFastRun.run).not.toContain("protocol-since-base");
    expect(checksFastRun.run).toContain(
      'test "$(git rev-parse refs/remotes/origin/ci-ratchet-base^{commit})" = "$PROTOCOL_SINCE_BASE_SHA"',
    );
    expect(ratchetRun.run).toContain(
      'base_ref="${RATCHET_BASE_REF:-refs/remotes/origin/ci-ratchet-base}"',
    );
    expect(ratchetRun.run).toContain('git cat-file -e "${base_ref}^{commit}"');
    expect(ratchetRun.run).toContain(
      "mapfile -t merge_parents < <(git cat-file -p HEAD | sed -n 's/^parent //p')",
    );
    expect(ratchetRun.run).toContain('"${#merge_parents[@]}" != "2"');
    expect(ratchetRun.run).toContain('"${merge_parents[1]:-}" != "$RATCHET_PR_HEAD_SHA"');
    expect(ratchetRun.run).toContain('prepared_base="$(git rev-parse "$base_ref")"');
    expect(ratchetRun.run).toContain('"${merge_parents[0]}" != "$prepared_base"');
    expect(ratchetRun.run).not.toContain("ci-ratchet-target^");
    expect(ratchetRun.run).not.toContain("resolve_manual_merge_base");
    expect(ratchetRun.run).not.toContain("+${merge_base}:refs/remotes/origin/ci-ratchet-base");
    expect(ratchetRun.run).toContain('pnpm check:max-lines-ratchet --base "$base_ref"');
    expect(ratchetRun.run).toMatch(
      /if \[\[ -n "\$\{RATCHET_PR_HEAD_SHA:-\}" \]\]; then\s+pnpm check:line-cap-ratchet --base "\$base_ref"\s+fi/u,
    );
    expect(ratchetRun.run).toContain('pnpm check:assertion-safety --base "$base_ref"');
    expect(ratchetRun.run).toContain("pnpm config:docs:check");
    expect(ratchetRun.run).toContain("pnpm plugins:inventory:check");
    expect(maxLinesRatchet).toContain('} from "./check-env-var-count.mts";');
    expect(maxLinesRatchet).toContain(
      "checkEnvVarCount(envVarCountArgs(argv), root, envVarNames);",
    );
    expect(checksFastRun.run).toContain(
      '--only=core --split-core --core-stripe="${stripe}/5" --threads=1',
    );
    expect(checksFastRun.run).toContain(
      "node --import tsx scripts/run-oxlint-shards.mts --only=extensions --threads=1",
    );
    expect(checksFastRun.run).not.toContain(
      "node scripts/run-oxlint.mjs src ui/src packages extensions",
    );

    const fastOnly = runCiManifestFixture({
      bundledPlanner: true,
      eventName: "pull_request",
      historicalCompatibility: false,
      nodeFastOnly: true,
      nodeFastPluginContracts: true,
    });
    expect(fastOnly.status, fastOnly.output).toBe(0);
    expect(fastOnly.outputs.run_check).toBe("false");
    expect(fastOnly.outputs.run_checks_fast_core).toBe("true");
    expect(
      JSON.parse(expectDefined(fastOnly.outputs.checks_fast_core_matrix, "fast-only checks matrix"))
        .include,
    ).toEqual([
      {
        check_name: "checks-fast-startup-corpus",
        runtime: "node",
        task: "startup-corpus",
      },
      {
        check_name: "checks-fast-coercion-helpers",
        runtime: "node",
        task: "coercion-helpers",
      },
    ]);

    const releaseGate = runCiManifestFixture({
      bundledPlanner: true,
      eventName: "workflow_dispatch",
      historicalCompatibility: false,
      releaseGate: true,
      runnerProfile: "github",
    });
    expect(releaseGate.status, releaseGate.output).toBe(0);
    expect(
      JSON.parse(
        expectDefined(releaseGate.outputs.checks_fast_core_matrix, "release-gate checks matrix"),
      ).include.filter((entry: { task: string }) => entry.task.startsWith("release-lint-")),
    ).toEqual([
      ...Array.from({ length: 5 }, (_, index) => {
        const stripe = index + 1;
        return {
          check_name: `checks-fast-release-lint-core-${stripe}`,
          runtime: "node",
          stripe,
          task: `release-lint-core-${stripe}`,
        };
      }),
      {
        check_name: "checks-fast-release-lint-extensions",
        runtime: "node",
        task: "release-lint-extensions",
      },
    ]);
  });

  it.each([
    {
      label: "test-only routing",
      changedPath: "test/scripts/changed-path-facts.test.ts",
      taskOverride: null,
    },
    {
      label: "source-only routing",
      changedPath: "scripts/lib/changed-path-facts.mjs",
      taskOverride: null,
    },
    {
      label: "legacy combined contract and routing task",
      changedPath: "test/scripts/changed-path-facts.test.ts",
      taskOverride: "contracts-plugins-ci-routing",
    },
  ])(
    "executes standalone changed-path-facts coverage for $label",
    ({ changedPath, taskOverride }) => {
      const root = tempDirs.make("openclaw-fast-ci-routing-");
      const changedPaths = [changedPath];
      const scopeEnv = Object.fromEntries(
        Object.entries(runCiChangedScopeFixture(changedPaths)).map(([key, value]) => [
          `OPENCLAW_CI_${key.toUpperCase()}`,
          value,
        ]),
      );
      const manifest = runCiManifestFixture({
        bundledPlanner: true,
        eventName: "pull_request",
        historicalCompatibility: false,
        changedPaths,
        scopeEnv: { ...scopeEnv, OPENCLAW_CI_DOCS_CHANGED: "false" },
      });
      expect(manifest.status, manifest.output).toBe(0);
      expect(
        Object.entries(manifest.outputs)
          .filter(([key, value]) => key.startsWith("run_") && value === "true")
          .map(([key]) => key)
          .toSorted(),
      ).toEqual([
        "run_baseline_ratchets",
        "run_checks_fast_core",
        "run_format_check",
        "run_node",
        "run_protocol_event_coverage",
      ]);
      for (const matrix of [
        "checks_node_core_nondist_matrix",
        "plugin_contracts_matrix",
        "channel_contracts_matrix",
        "checks_windows_matrix",
        "macos_node_matrix",
        "android_matrix",
      ]) {
        expect(JSON.parse(expectDefined(manifest.outputs[matrix], matrix)).include, matrix).toEqual(
          [],
        );
      }
      const fastTasks = JSON.parse(
        expectDefined(manifest.outputs.checks_fast_core_matrix, "fast checks matrix"),
      ).include as Array<{ task: string }>;
      expect(fastTasks.map(({ task }) => task)).toEqual([
        "startup-corpus",
        "coercion-helpers",
        "ci-routing",
      ]);
      const routingTask = expectDefined(
        fastTasks.find(({ task }) => task === "ci-routing"),
        "CI routing task",
      );
      const runStep = readCiWorkflow().jobs["checks-fast-core"].steps.find(
        (step: WorkflowStep) => step.name === "Run ${{ matrix.task }} (${{ matrix.runtime }})",
      );
      const fakeBin = path.join(root, "bin");
      const callsPath = path.join(root, "pnpm-calls.jsonl");
      mkdirSync(fakeBin);
      writeExecutable(path.join(fakeBin, "pnpm"), [
        "#!/usr/bin/env node",
        'require("node:fs").appendFileSync(process.env.PNPM_CALLS, JSON.stringify(process.argv.slice(2)) + "\\n");',
      ]);
      // The current manifest selects ci-routing; exercise the retained combined Bash case directly.
      const run = spawnSync("bash", ["-c", runStep.run], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
          PNPM_CALLS: callsPath,
          TASK: taskOverride ?? routingTask.task,
        },
      });
      expect(run.status, `${run.stdout}${run.stderr}`).toBe(0);
      const calls = readFileSync(callsPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
      expect(calls.map(([command]) => command)).toEqual(
        taskOverride ? ["test:contracts:plugins", "test"] : ["test"],
      );
      expect(
        calls.find(([command]) => command === "test"),
        "executed routing test argv",
      ).toContain("test/scripts/changed-path-facts.test.ts");
    },
  );

  it.each<{
    label: string;
    changedPath: string;
    eventName?: "pull_request" | "push" | "workflow_dispatch";
    releaseGate?: boolean;
    legacyOutput?: boolean;
    selectedJobs: string[];
  }>([
    {
      label: "Git-owner action",
      changedPath: ".github/actions/git-owner/owner.py",
      selectedJobs: ["macos-node", "checks-windows"],
    },
    {
      label: "Android toolchain action",
      changedPath: ".github/actions/setup-android-toolchain/action.yml",
      selectedJobs: ["android"],
    },
    {
      label: "Docs Agent",
      changedPath: ".github/workflows/docs-agent.yml",
      selectedJobs: ["macos-node", "checks-windows"],
    },
    ...[
      ".github/workflows/openclaw-performance.yml",
      "test/scripts/openclaw-performance-workflow.test-support.ts",
      "test/scripts/openclaw-performance-git-lifecycle.test.ts",
      "test/scripts/openclaw-performance-workflow.test.ts",
    ].map((changedPath) => ({
      label: `Performance owner ${changedPath}`,
      changedPath,
      selectedJobs: ["macos-node", "checks-windows"],
    })),
    {
      label: "Git-owner fixture",
      changedPath: "test/scripts/fixtures/ci-platform-checkout.mjs",
      selectedJobs: ["macos-node", "checks-windows"],
    },
    {
      label: "Windows process census fixture",
      changedPath: "test/scripts/fixtures/ci-windows-process-census.py",
      selectedJobs: ["macos-node", "checks-windows"],
    },
    {
      label: "Mac app",
      changedPath: "apps/macos/Sources/Foo.swift",
      selectedJobs: ["macos-node", "macos-swift"],
    },
    {
      label: "Mac artifact proof",
      changedPath: "test/scripts/mac-elevation-artifact.test.ts",
      selectedJobs: ["macos-node", "macos-swift"],
    },
    {
      label: "iOS app pull request",
      changedPath: "apps/ios/Sources/Foo.swift",
      selectedJobs: ["ios-build"],
    },
    {
      label: "iOS app main push",
      changedPath: "apps/ios/Sources/Foo.swift",
      eventName: "push",
      selectedJobs: ["ios-build"],
    },
    {
      label: "iOS app exact-head release gate",
      changedPath: "apps/ios/Sources/Foo.swift",
      eventName: "workflow_dispatch",
      releaseGate: true,
      selectedJobs: ["checks-windows", "ios-build", "android"],
    },
    {
      label: "shared native",
      changedPath: "apps/shared/OpenClawKit/Sources/Foo.swift",
      selectedJobs: ["macos-node", "macos-swift", "ios-build", "android"],
    },
    { label: "docs", changedPath: "docs/ci.md", selectedJobs: [] },
    {
      label: "unrelated CI workflow",
      changedPath: ".github/workflows/ci.yml",
      selectedJobs: ["checks-windows"],
    },
    {
      label: "ordinary manual",
      changedPath: ".github/actions/git-owner/owner.py",
      eventName: "workflow_dispatch",
      selectedJobs: ["macos-node", "macos-swift", "checks-windows", "ios-build"],
    },
    {
      label: "historical Mac scope without native Node output",
      changedPath: "apps/macos/Sources/Foo.swift",
      eventName: "workflow_dispatch",
      releaseGate: true,
      legacyOutput: true,
      selectedJobs: ["macos-node", "macos-swift", "checks-windows", "android"],
    },
    {
      label: "historical non-Mac scope without native Node output",
      changedPath: "src/config/defaults.ts",
      eventName: "workflow_dispatch",
      releaseGate: true,
      legacyOutput: true,
      selectedJobs: ["checks-windows", "android"],
    },
  ])(
    "routes native CI jobs through scope output and manifest ($label)",
    ({
      changedPath,
      eventName = "pull_request",
      releaseGate = false,
      legacyOutput,
      selectedJobs,
    }) => {
      const workflow = readCiWorkflow();
      const manifestStep = workflow.jobs.preflight.steps.find(
        (step: WorkflowStep) => step.name === "Build CI manifest",
      );
      const changedPaths = [changedPath];
      const scopeOutputs = runCiChangedScopeFixture(changedPaths);
      if (legacyOutput) {
        delete scopeOutputs.run_macos_node;
      }
      const context = {
        eventName,
        releaseGate,
        repository: "openclaw/openclaw",
        runAttempt: 1,
        steps: { changed_scope: { outputs: scopeOutputs } },
      };
      const scopeEnv = Object.fromEntries(
        Object.entries(manifestStep.env)
          .filter(([key]) => key.startsWith("OPENCLAW_CI_RUN_"))
          .map(([key, expression]) => [
            key,
            String(evaluateWorkflowExpression(expression, context)),
          ]),
      );
      const manifest = runCiManifestFixture({
        bundledPlanner: !legacyOutput,
        changedPaths,
        eventName,
        releaseGate,
        scopeEnv,
      });
      expect(manifest.status, manifest.output).toBe(0);
      const preflightOutputs = Object.fromEntries(
        Object.entries(workflow.jobs.preflight.outputs)
          .filter(([, expression]) => String(expression).includes("steps.manifest.outputs."))
          .map(([key, expression]) => [
            key,
            String(
              evaluateWorkflowExpression(expression, {
                ...context,
                steps: { manifest: { outputs: manifest.outputs } },
              }),
            ),
          ]),
      );
      for (const jobName of [
        "macos-node",
        "macos-swift",
        "checks-windows",
        "ios-build",
        "android",
      ]) {
        const job = workflow.jobs[jobName];
        const expression = job.if.startsWith("${{") ? job.if : `\${{ ${job.if} }}`;
        expect(
          evaluateWorkflowExpression(expression, { ...context, preflightOutputs }),
          jobName,
        ).toBe(selectedJobs.includes(jobName));
      }
      expect(
        JSON.parse(expectDefined(manifest.outputs.macos_node_matrix, "Mac Node matrix")).include,
      ).toEqual(
        selectedJobs.includes("macos-node")
          ? legacyOutput
            ? [{ check_name: "macos-node", runtime: "node", task: "test" }]
            : [1, 2, 3].map((part) => ({
                check_name: `macos-node-${part}`,
                runtime: "node",
                task: `test-${part}`,
              }))
          : [],
      );
      expect(
        JSON.parse(expectDefined(manifest.outputs.checks_windows_matrix, "Windows matrix")).include,
      ).toHaveLength(selectedJobs.includes("checks-windows") ? (legacyOutput ? 2 : 5) : 0);
      if (eventName === "pull_request" && selectedJobs.includes("android")) {
        expect(
          JSON.parse(expectDefined(preflightOutputs.android_matrix, "Android matrix")).include,
        ).toEqual([
          { check_name: "android-test-play", task: "test-play" },
          { check_name: "android-test-third-party", task: "test-third-party" },
          {
            check_name: "android-test-wear",
            task: "test-wear",
            lint: true,
            app_lint: "third-party",
          },
          { check_name: "android-ktlint", task: "ktlint", app_lint: "play" },
        ]);
      }
    },
  );

  it.each(
    [
      { scope: "npm-beta", packageVersion: "2026.9.1-beta.1", branch: "release/2026.9.1" },
      { scope: "npm-stable", packageVersion: "2026.9.1", branch: "release/2026.9.1" },
      { scope: "npm-stable", packageVersion: "2026.9.1-1", branch: "release/2026.9.1-1" },
    ].flatMap(({ scope, packageVersion, branch }) =>
      ["release branch", "release tag"].map((context) => ({
        scope,
        packageVersion,
        branch,
        context,
      })),
    ),
  )(
    "qualifies $scope $packageVersion without native app jobs through a validated $context",
    ({ scope, packageVersion, branch, context }) => {
      const options = {
        bundledPlanner: true,
        packageVersion,
        scopeEnv: {
          OPENCLAW_CI_TARGET_REF: "a".repeat(40),
          OPENCLAW_CI_TARGET_CONTEXT_REF: context === "release branch" ? branch : "",
          OPENCLAW_CI_TARGET_CONTEXT_TARGET: String(context === "release branch"),
          OPENCLAW_CI_HISTORICAL_TARGET_TAG: context === "release tag" ? `v${packageVersion}` : "",
          OPENCLAW_CI_HISTORICAL_TARGET: String(context === "release tag"),
          OPENCLAW_CI_RUN_UI_TESTS: "true",
        },
      };
      const full = runCiManifestFixture(options);
      const qualification = runCiManifestFixture({
        ...options,
        scopeEnv: { ...options.scopeEnv, OPENCLAW_CI_RELEASE_SCOPE: scope },
      });
      expect(full.status, full.output).toBe(0);
      expect(qualification.status, qualification.output).toBe(0);
      expect(qualification.output).toContain(`CI release scope: ${scope}`);
      expect(qualification.summary).toContain(`Scope: \`${scope}\``);
      expect(qualification.summary).toContain("Native app qualification: deferred");
      expect(qualification.outputs).toEqual({
        ...full.outputs,
        release_scope: scope,
        run_macos_swift: "false",
        run_openclawkit_tests: "false",
        run_ios_build: "false",
        run_android: "false",
        run_android_job: "false",
        run_native_i18n: "false",
        android_matrix: JSON.stringify({ include: [] }),
      });
      for (const output of [
        "run_node",
        "run_macos_node",
        "run_checks_windows",
        "run_build_artifacts",
        "run_check_additional",
        "run_protocol_event_coverage",
        "run_ui_tests",
      ]) {
        expect(qualification.outputs[output], output).toBe("true");
      }
      for (const jobName of ["ios-screenshot-shard", "ios-screenshot-evidence"]) {
        expect(
          evaluateWorkflowExpression(readCiWorkflow().jobs[jobName].if, {
            eventName: "workflow_dispatch",
            repository: "openclaw/openclaw",
            runAttempt: 1,
            preflightOutputs: {
              ...qualification.outputs,
              compatibility_target: "false",
              run_ios_screenshots: "true",
            },
          }),
          jobName,
        ).toBe(false);
      }
    },
  );

  it.skipIf(process.platform === "win32").each([
    { label: "base branch correction", context: "branch", direct: "a", accepted: true },
    { label: "base tag correction", context: "tag", direct: "a", accepted: true },
    { label: "annotated base tag", context: "tag", direct: "c", peeled: "a", accepted: true },
    {
      label: "versioned correction without a base lookup",
      context: "branch",
      packageVersion: "2026.9.1-1",
      accepted: true,
    },
    { label: "missing base tag", context: "branch", accepted: false },
    { label: "different base source", context: "branch", direct: "c", accepted: false },
    { label: "different peeled source", context: "tag", direct: "a", peeled: "c", accepted: false },
  ])(
    "binds npm stable $label to the exact source",
    ({ context, direct, peeled, packageVersion, accepted }) => {
      const result = runCiManifestFixture({
        bundledPlanner: true,
        packageVersion: packageVersion ?? "2026.9.1",
        remoteTagRefs: {
          ...(direct ? { "refs/tags/v2026.9.1": direct.repeat(40) } : {}),
          ...(peeled ? { "refs/tags/v2026.9.1^{}": peeled.repeat(40) } : {}),
        },
        scopeEnv: {
          OPENCLAW_CI_RELEASE_SCOPE: "npm-stable",
          OPENCLAW_CI_TARGET_REF: "a".repeat(40),
          OPENCLAW_CI_TARGET_CONTEXT_REF: context === "branch" ? "release/2026.9.1-1" : "",
          OPENCLAW_CI_TARGET_CONTEXT_TARGET: String(context === "branch"),
          OPENCLAW_CI_HISTORICAL_TARGET_TAG: context === "tag" ? "v2026.9.1-1" : "",
          OPENCLAW_CI_HISTORICAL_TARGET: String(context === "tag"),
        },
      });
      expect(result.status === 0, result.output).toBe(accepted);
      if (accepted) {
        expect(result.outputs.run_ios_build).toBe("false");
        expect(result.outputs.run_node).toBe("true");
      } else {
        expect(result.output).toContain(
          direct ? "correction base v2026.9.1 does not resolve" : "HTTP 404",
        );
        expect(result.outputs).not.toHaveProperty("run_node");
      }
    },
  );

  it.each<{ label: string } & Omit<Parameters<typeof runCiManifestFixture>[0], "bundledPlanner">>([
    { label: "stable target", packageVersion: "2026.9.1" },
    { label: "alpha target", packageVersion: "2026.9.1-alpha.1" },
    { label: "PR event", eventName: "pull_request" as const },
    { label: "fork repository", repository: "example/openclaw" },
    { label: "PR release gate", releaseGate: true },
    { label: "PR number", scopeEnv: { OPENCLAW_CI_PULL_REQUEST_NUMBER: "123" } },
    { label: "mutable target", scopeEnv: { OPENCLAW_CI_TARGET_REF: "release/2026.9.1" } },
    { label: "wrong target", scopeEnv: { OPENCLAW_CI_TARGET_REF: "c".repeat(40) } },
    { label: "unvalidated branch", scopeEnv: { OPENCLAW_CI_TARGET_CONTEXT_TARGET: "false" } },
    {
      label: "wrong release train",
      scopeEnv: { OPENCLAW_CI_TARGET_CONTEXT_REF: "release/2026.9.2" },
    },
    {
      label: "wrong release tag",
      scopeEnv: {
        OPENCLAW_CI_TARGET_CONTEXT_TARGET: "false",
        OPENCLAW_CI_HISTORICAL_TARGET: "true",
        OPENCLAW_CI_HISTORICAL_TARGET_TAG: "v2026.9.2-beta.1",
      },
    },
    { label: "unknown scope", scopeEnv: { OPENCLAW_CI_RELEASE_SCOPE: "package" } },
    ...["2026.9.1-beta.1", "2026.9.1-alpha.1", "2026.9.33", "2026.9.33-1"].map(
      (packageVersion) => ({
        label: `npm-stable with ${packageVersion}`,
        packageVersion,
        scopeEnv: { OPENCLAW_CI_RELEASE_SCOPE: "npm-stable" },
      }),
    ),
    {
      label: "correction package in a different release context",
      packageVersion: "2026.9.1-1",
      scopeEnv: { OPENCLAW_CI_RELEASE_SCOPE: "npm-stable" },
    },
  ])(
    "rejects scoped npm CI qualification for $label",
    ({ label: _label, scopeEnv, ...options }) => {
      const result = runCiManifestFixture({
        bundledPlanner: true,
        historicalCompatibility: false,
        packageVersion: "2026.9.1-beta.1",
        ...options,
        scopeEnv: {
          OPENCLAW_CI_RELEASE_SCOPE: "npm-beta",
          OPENCLAW_CI_TARGET_REF: "a".repeat(40),
          OPENCLAW_CI_TARGET_CONTEXT_REF: "release/2026.9.1",
          OPENCLAW_CI_TARGET_CONTEXT_TARGET: "true",
          ...scopeEnv,
        },
      });
      expect(result.status, result.output).not.toBe(0);
      expect(result.output).toContain("release_scope");
      expect(result.outputs).not.toHaveProperty("run_node");
    },
  );

  it.each([
    { changedPath: "scripts/lib/ci-changed-node-test-plan.mts", docsOnly: false },
    { changedPath: "scripts/README.md", docsOnly: true },
    { changedPath: "test/scripts/changed-lanes.test.ts", docsOnly: false },
  ])(
    "retains executable tooling owners without overriding docs-only scope for $changedPath",
    ({ changedPath, docsOnly }) => {
      const manifest = runCiManifestFixture({
        bundledPlanner: true,
        toolingOwnerSelection: true,
        changedPaths: [changedPath],
        eventName: "pull_request",
        nodeFastOnly: true,
        runNode: !docsOnly,
        scopeEnv: { OPENCLAW_CI_DOCS_ONLY: String(docsOnly) },
      });
      expect(manifest.status, manifest.output).toBe(0);
      expect(manifest.outputs.run_node).toBe(String(!docsOnly));
      expect(manifest.outputs.run_checks_node_core_nondist).toBe(String(!docsOnly));
      const rows = JSON.parse(
        expectDefined(manifest.outputs.checks_node_core_nondist_matrix, "tooling matrix"),
      ).include;
      expect(rows).toHaveLength(docsOnly ? 0 : 1);
      if (!docsOnly) {
        expect(rows[0].check_name).toBe("bundled-node-plan");
      }
    },
  );

  it.each(
    (["pull_request", "push", "workflow_dispatch"] as const).flatMap((eventName) =>
      [
        "ui/src/i18n/locales/de.ts",
        "src/wizard/i18n/locales/zh-CN.ts",
        "ui/src/i18n/.i18n/catalog-fallbacks.json",
      ].map((changedPath) => ({
        eventName,
        changedPath,
      })),
    ),
  )(
    "keeps catalog-only PRs out of Node rows while $eventName retains its tier: $changedPath",
    ({ eventName, changedPath }) => {
      const changedPaths = [changedPath];
      const runUiVerification = changedPath.startsWith("ui/") || eventName === "workflow_dispatch";
      const workflow = readCiWorkflow();
      const manifestStep = workflow.jobs.preflight.steps.find(
        (step: WorkflowStep) => step.name === "Build CI manifest",
      );
      const scopeOutputs = runCiChangedScopeFixture(changedPaths);
      const context = {
        eventName,
        repository: "openclaw/openclaw",
        runAttempt: 1,
        steps: { changed_scope: { outputs: scopeOutputs } },
      };
      const scopeEnv = Object.fromEntries(
        [
          "OPENCLAW_CI_NODE_TEST_DATA_ONLY",
          "OPENCLAW_CI_RUN_UI_TESTS",
          "OPENCLAW_CI_RUN_CONTROL_UI_I18N",
        ].map((key) => [key, String(evaluateWorkflowExpression(manifestStep.env[key], context))]),
      );
      const manifest = runCiManifestFixture({
        bundledPlanner: true,
        eventName,
        changedPaths,
        changedPlannerSource: `
          export const createChangedNodeTestShards = () => { throw new Error("catalog PR must not enter the Node planner"); };
          export const createChangedExtensionFallbackShards = () => [];
        `,
        scopeEnv,
      });
      expect(manifest.status, manifest.output).toBe(0);
      expect(manifest.outputs.run_control_ui_i18n).toBe(String(runUiVerification));
      expect(manifest.outputs.run_node).toBe(String(eventName !== "pull_request"));
      expect(manifest.outputs.run_check).toBe(
        String(eventName !== "pull_request" || changedPath.endsWith(".ts")),
      );
      expect(manifest.outputs.run_ui_tests).toBe(
        String(eventName !== "pull_request" && runUiVerification),
      );
    },
  );

  it.each([
    ["pull_request", "openclaw/openclaw", true, false],
    ["pull_request", "example/openclaw", false, false],
    ["push", "openclaw/openclaw", false, false],
    ["push", "example/openclaw", false, false],
    ["workflow_dispatch", "openclaw/openclaw", false, false],
    ["workflow_dispatch", "openclaw/openclaw", true, true],
  ] as const)(
    "forwards release tiers and canonical PR changed paths (%s, %s, changed paths=%s, release gate=%s)",
    (eventName, repository, forwardsChangedPaths, releaseGate) => {
      const changedPaths = [
        "src/plugins/manifest-tool-availability.ts",
        "src/plugins/tools.optional.test.ts",
      ];
      const manifest = runCiManifestFixture({
        bundledPlanner: true,
        changedPlannerSource: `
          export const createChangedNodeTestShards = (_paths, options) => {
            if (options.includeReleaseOnlyToolingShards !== false) {
              throw new Error("automatic precise plan must defer unrelated tooling");
            }
            if (options.includeReleaseOnlyRuntimeTests !== false) {
              throw new Error("automatic precise plan must defer release-only runtime tests");
            }
            return null;
          };
          export const createChangedExtensionFallbackShards = () => [];
        `,
        changedPaths,
        eventName,
        repository,
        releaseGate,
      });
      expect(manifest.status, manifest.output).toBe(0);
      const plannerOptions = JSON.parse(
        expectDefined(
          manifest.output.split("\n").find((line) => line.startsWith("node-test-plan-options:")),
          "Node planner invocation",
        ).slice("node-test-plan-options:".length),
      );
      expect(plannerOptions).toMatchObject({
        includeReleaseOnlyPluginShards: false,
        includeReleaseOnlyToolingShards:
          eventName === "workflow_dispatch" || repository !== "openclaw/openclaw",
        includeReleaseOnlyRuntimeTests:
          (eventName === "workflow_dispatch" && !releaseGate) || repository !== "openclaw/openclaw",
      });
      const rows = JSON.parse(
        expectDefined(manifest.outputs.checks_node_core_nondist_matrix, "fallback matrix"),
      ).include;
      expect(rows).toHaveLength(1);
      expect(rows[0].check_name).toBe("bundled-node-plan");
      const plans = resolveShardPlans({
        OPENCLAW_NODE_TEST_GROUPS_GZIP_BASE64: rows[0].groups_gzip_base64,
        OPENCLAW_NODE_TEST_CONFIGS_JSON: JSON.stringify(rows[0].configs),
        OPENCLAW_NODE_TEST_INCLUDE_PATTERNS_JSON: JSON.stringify(rows[0].includePatterns),
      });
      expect(plans).toHaveLength(1);
      const plan = expectDefined(plans[0], "resolved fallback plan");
      expect(plan.kind === "group" ? (plan.plan.includePatterns ?? null) : undefined).toEqual(
        forwardsChangedPaths ? changedPaths : null,
      );
    },
  );

  it.each([false, true])(
    "projects immutable reader history only when the selected target has the reader (present=%s)",
    (historicalReader) => {
      const manifest = runCiManifestFixture({
        bundledPlanner: true,
        changedPaths: ["src/audit/message-delivery-progress-store.test.ts"],
        eventName: "pull_request",
        historicalReader,
      });
      expect(manifest.status, manifest.output).toBe(0);
      const rows = JSON.parse(
        expectDefined(manifest.outputs.checks_node_core_nondist_matrix, "reader matrix"),
      ).include;
      expect(rows).toHaveLength(1);
      expect(rows[0].git_commits).toEqual(
        historicalReader ? ["5dc4cf602bc5e263e83cd16a12bb1e100544f4c3"] : [],
      );
    },
  );

  it.each([
    ["pull_request", "compact", "blacksmith", 130],
    ["pull_request", "precise", "github", 130],
    ["push", "compact", "hybrid", 70],
    ["workflow_dispatch", "compact", "blacksmith", null],
  ] as const)(
    "bounds the final Node matrix for %s %s plans",
    (eventName, selection, runnerProfile, limit) => {
      for (const count of [limit ?? 130, (limit ?? 130) + 1]) {
        const hasFallback = eventName === "pull_request" && selection === "compact";
        const nodeTestShards = Array.from({ length: count - Number(hasFallback) }, (_, index) => ({
          checkName: `node-admission-${index}`,
          shardName: `node-admission-${index}`,
          configs: ["test/vitest/vitest.infra.config.ts"],
          runner: "blacksmith-8vcpu-ubuntu-2404",
          requiresDist: false,
        }));
        const result = runCiManifestFixture({
          bundledPlanner: true,
          changedPaths: ["extensions/matrix/src/channel.ts"],
          changedPlannerSource:
            selection === "precise"
              ? `export { createNodeTestShards as createChangedNodeTestShards } from "./ci-node-test-plan.mts";
                 export const createChangedExtensionFallbackShards = () => [];`
              : undefined,
          eventName,
          nodeTestShards: [
            ...nodeTestShards,
            {
              checkName: "node-admission-dist",
              shardName: "node-admission-dist",
              configs: ["test/vitest/vitest.infra.config.ts"],
              runner: "blacksmith-8vcpu-ubuntu-2404",
              requiresDist: true,
            },
          ],
          runnerProfile,
        });
        if (limit !== null && count > limit) {
          expect(result.status, result.output).toBe(1);
          expect(result.output).toContain(
            `Canonical ${eventName} Node matrix has ${count} jobs, exceeding limit ${limit}`,
          );
          expect(result.outputs.checks_node_core_nondist_matrix).toBeUndefined();
          expect(result.outputs.run_checks_node_core_nondist).toBeUndefined();
        } else {
          expect(result.status, result.output).toBe(0);
          const rows = JSON.parse(
            expectDefined(result.outputs.checks_node_core_nondist_matrix, "bounded Node matrix"),
          ).include;
          expect(rows.map((row: { check_name: string }) => row.check_name)).toEqual([
            ...(hasFallback ? ["changed-extension-fallback-plan"] : []),
            ...nodeTestShards.map((shard) => shard.checkName),
          ]);
          expect(result.outputs.run_checks_node_core_dist).toBe("true");
        }
      }
    },
  );

  it("admits slow compact and plugin fallback rows before shorter work", () => {
    const result = runCiManifestFixture({
      bundledPlanner: true,
      changedPaths: ["extensions/matrix/src/channel.ts"],
      eventName: "pull_request",
      nodeTestShards: [30, 240, 240].map((predictedSeconds, index) => ({
        checkName: `compact-${index}`,
        shardName: `compact-${index}`,
        configs: ["test/vitest/vitest.infra.config.ts"],
        runner: "ubuntu-24.04",
        requiresDist: false,
        predictedSeconds,
      })),
    });
    expect(result.status, result.output).toBe(0);
    const rows = JSON.parse(
      expectDefined(result.outputs.checks_node_core_nondist_matrix, "Node matrix"),
    ).include;
    expect(rows.map((row: { check_name: string }) => row.check_name)).toEqual([
      "compact-1",
      "compact-2",
      "changed-extension-fallback-plan",
      "compact-0",
    ]);
    expect(rows.map((row: { predicted_seconds: number }) => row.predicted_seconds)).toEqual([
      240, 240, 120, 30,
    ]);
  });

  it("uses target-owned CI plans and capabilities for older release checkouts", () => {
    const androidRun = readCiWorkflow().jobs.android.steps.find(
      (step: WorkflowStep) => step.name === "Run Android ${{ matrix.task }}",
    ).run;
    expect(androidRun).toContain("build-play-compat)");
    expect(androidRun).toContain("test-play-compat)");
    expect(androidRun).toContain(":app:assemblePlayDebug");

    const legacy = runCiManifestFixture({ bundledPlanner: false });
    expect(legacy.status, legacy.output).toBe(0);
    expect(legacy.outputs.historical_target).toBe("true");
    expect(legacy.outputs.use_compatible_android_ci).toBe("true");
    expect(legacy.outputs.run_ios_build).toBe("false");
    expect(legacy.outputs.run_native_i18n).toBe("false");
    expect(legacy.outputs.run_openclawkit_tests).toBe("false");
    expect(legacy.outputs.run_qa_smoke_ci).toBe("false");
    expect(legacy.outputs.run_docker_seed_e2e).toBe("false");
    expect(legacy.outputs.docker_seed_lanes).toBe("");
    expect(legacy.outputs.run_channel_contracts_shards).toBe("false");
    expect(legacy.outputs.run_protocol_event_coverage).toBe("false");
    expect(
      JSON.parse(expectDefined(legacy.outputs.android_matrix, "legacy Android matrix output"))
        .include,
    ).toEqual([
      { check_name: "android-test-play", task: "test-play-compat" },
      { check_name: "android-test-third-party", task: "test-third-party" },
      { check_name: "android-build-play", task: "build-play-compat" },
    ]);
    expect(
      JSON.parse(
        expectDefined(
          legacy.outputs.checks_node_core_nondist_matrix,
          "legacy node core nondist matrix output",
        ),
      ).include,
    ).toContainEqual(
      expect.objectContaining({
        check_name: "legacy-node-plan",
        shard_name: "legacy-node-plan",
      }),
    );

    const current = runCiManifestFixture({ bundledPlanner: true });
    expect(current.status, current.output).toBe(0);
    expect(current.outputs.use_compatible_android_ci).toBe("false");
    expect(current.outputs.run_ios_build).toBe("true");
    expect(current.outputs.run_native_i18n).toBe("true");
    expect(current.outputs.run_openclawkit_tests).toBe("true");
    expect(current.outputs.run_qa_smoke_ci).toBe("true");
    expect(current.outputs.run_docker_seed_e2e).toBe("true");
    expect(current.outputs.docker_seed_lanes).toBe(
      "published-upgrade-survivor mcp-channels cron-mcp-cleanup mcp-code-mode-gateway update-channel-switch fleet-cache",
    );
    expect(current.outputs.run_sqlite_session_lifecycle).toBe("true");
    expect(current.outputs.run_channel_contracts_shards).toBe("true");
    expect(current.outputs.run_protocol_event_coverage).toBe("true");
    expect(current.outputs.run_format_check).toBe("true");
    expect(
      JSON.parse(expectDefined(current.outputs.android_matrix, "current Android matrix output"))
        .include,
    ).toEqual([
      { check_name: "android-test-play", task: "test-play" },
      { check_name: "android-test-third-party", task: "test-third-party" },
      { check_name: "android-test-wear", task: "test-wear" },
      { check_name: "android-build-play", task: "build-play" },
      { check_name: "android-build-wear", task: "build-wear" },
      { check_name: "android-ktlint", task: "ktlint" },
    ]);

    const currentMissingAndroidCapabilities = runCiManifestFixture({
      androidCiCapabilities: false,
      bundledPlanner: true,
      changedPaths: ["package.json"],
      eventName: "pull_request",
    });
    expect(currentMissingAndroidCapabilities.status, currentMissingAndroidCapabilities.output).toBe(
      0,
    );
    expect(
      JSON.parse(
        expectDefined(
          currentMissingAndroidCapabilities.outputs.android_matrix,
          "current fallback-resistant Android matrix output",
        ),
      ).include,
    ).toEqual([
      { check_name: "android-test-play", task: "test-play" },
      { check_name: "android-test-third-party", task: "test-third-party" },
      {
        check_name: "android-test-wear",
        task: "test-wear",
        lint: true,
        app_lint: "third-party",
      },
      { check_name: "android-ktlint", task: "ktlint", app_lint: "play" },
    ]);

    expect(
      JSON.parse(
        expectDefined(
          current.outputs.checks_node_core_nondist_matrix,
          "current node core nondist matrix output",
        ),
      ).include,
    ).toContainEqual(
      expect.objectContaining({
        check_name: "bundled-node-plan",
        env: {
          OPENCLAW_CI_TEST_COMPACT_MODE: "full",
          OPENCLAW_CI_TEST_COMPACT_NODE_JOB_CAP: "70",
          OPENCLAW_CI_TEST_RUNNER_BACKEND: "blacksmith",
          OPENCLAW_CI_TEST_PROOF_TIER: "true",
        },
        shard_name: "bundled-node-plan",
      }),
    );

    for (const runnerBackend of [undefined, "github", "hybrid"] as const) {
      const push = runCiManifestFixture({
        bundledPlanner: true,
        eventName: "push",
        runnerBackend,
      });
      expect(push.status, push.output).toBe(0);
      expect(
        JSON.parse(
          expectDefined(
            push.outputs.checks_node_core_nondist_matrix,
            `${runnerBackend ?? "default"} push node core nondist matrix output`,
          ),
        ).include,
      ).toContainEqual(
        expect.objectContaining({
          check_name: "bundled-node-plan",
          env: {
            OPENCLAW_CI_TEST_COMPACT_MODE: "push",
            OPENCLAW_CI_TEST_COMPACT_NODE_JOB_CAP: "70",
            OPENCLAW_CI_TEST_RUNNER_BACKEND: runnerBackend ?? "blacksmith",
            OPENCLAW_CI_TEST_PROOF_TIER: "true",
          },
        }),
      );
    }

    const dockerSeedPath = "scripts/e2e/docker-openai-seed.ts";
    const changedPullRequest = runCiManifestFixture({
      bundledPlanner: true,
      changedPaths: ["src/focused.ts", "extensions/codex/src/focused.ts", dockerSeedPath],
      eventName: "pull_request",
    });
    expect(changedPullRequest.status, changedPullRequest.output).toBe(0);
    expect(
      JSON.parse(
        expectDefined(
          changedPullRequest.outputs.checks_node_core_nondist_matrix,
          "changed PR node matrix output",
        ),
      ).include,
    ).toEqual([
      expect.objectContaining({
        check_name: "changed-node-plan",
        shard_name: "changed-node-plan",
        targets: ["src/focused.test.ts"],
      }),
    ]);
    expect(
      JSON.parse(
        expectDefined(
          changedPullRequest.outputs.checks_node_core_nondist_matrix,
          "changed PR node matrix output",
        ),
      ).include,
    ).not.toContainEqual(
      expect.objectContaining({ check_name: "changed-extension-fallback-plan" }),
    );
    expect(changedPullRequest.outputs.run_checks_node_core_dist).toBe("true");
    expect(changedPullRequest.outputs.run_sqlite_session_lifecycle).toBe("false");
    expect(changedPullRequest.outputs.run_docker_seed_e2e).toBe("false");
    expect(changedPullRequest.outputs.docker_seed_lanes).toBe("");

    const mixedFallbackPullRequest = runCiManifestFixture({
      bundledPlanner: true,
      changedPaths: [
        "packages/gateway-protocol/src/frame-guards.ts",
        "extensions/codex/src/focused.ts",
      ],
      eventName: "pull_request",
    });
    expect(mixedFallbackPullRequest.status, mixedFallbackPullRequest.output).toBe(0);
    expect(
      JSON.parse(
        expectDefined(
          mixedFallbackPullRequest.outputs.checks_node_core_nondist_matrix,
          "mixed fallback PR node matrix output",
        ),
      ).include,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          check_name: "bundled-node-plan",
          env: {
            OPENCLAW_CI_TEST_COMPACT_MODE: "pull-request",
            OPENCLAW_CI_TEST_COMPACT_NODE_JOB_CAP: "129",
            OPENCLAW_CI_TEST_RUNNER_BACKEND: "blacksmith",
            OPENCLAW_CI_TEST_PROOF_TIER: "false",
          },
        }),
        expect.objectContaining({ check_name: "changed-extension-fallback-plan" }),
      ]),
    );

    const matrixFallbackPullRequest = runCiManifestFixture({
      bundledPlanner: true,
      changedPaths: [
        "packages/gateway-protocol/src/frame-guards.ts",
        "extensions/matrix/src/channel.ts",
      ],
      eventName: "pull_request",
    });
    expect(matrixFallbackPullRequest.status, matrixFallbackPullRequest.output).toBe(0);
    const matrixFallbackRows = JSON.parse(
      expectDefined(
        matrixFallbackPullRequest.outputs.checks_node_core_nondist_matrix,
        "Matrix fallback PR node matrix output",
      ),
    ).include;
    const matrixFallbackRow = expectDefined(
      matrixFallbackRows.find(
        (row: { check_name: string }) => row.check_name === "changed-extension-fallback-plan",
      ),
      "Matrix fallback row",
    );
    expect(
      resolveShardPlans({
        OPENCLAW_NODE_TEST_GROUPS_GZIP_BASE64: matrixFallbackRow.groups_gzip_base64,
        OPENCLAW_NODE_TEST_GROUPS_JSON: JSON.stringify(matrixFallbackRow.groups),
        OPENCLAW_NODE_TEST_CONFIGS_JSON: JSON.stringify(matrixFallbackRow.configs),
        OPENCLAW_NODE_TEST_ENV_JSON: JSON.stringify(matrixFallbackRow.env),
        OPENCLAW_NODE_TEST_INCLUDE_PATTERNS_JSON: JSON.stringify(matrixFallbackRow.includePatterns),
        OPENCLAW_NODE_TEST_TARGETS_JSON: JSON.stringify(matrixFallbackRow.targets),
        OPENCLAW_VITEST_SHARD_NAME: matrixFallbackRow.shard_name,
      }),
    ).toEqual([
      expect.objectContaining({
        kind: "group",
        plan: expect.objectContaining({
          configs: ["test/vitest/vitest.extension-matrix.config.ts"],
          includePatterns: [
            "extensions/matrix/src/client.test.ts",
            "extensions/matrix/src/monitor.test.ts",
          ],
        }),
      }),
    ]);

    const sqliteLifecycleTestPullRequest = runCiManifestFixture({
      bundledPlanner: true,
      changedPaths: ["test/scripts/sqlite-sessions-transcripts-flip-proof.built-cli.e2e.test.ts"],
      eventName: "pull_request",
    });
    expect(sqliteLifecycleTestPullRequest.status, sqliteLifecycleTestPullRequest.output).toBe(0);
    expect(sqliteLifecycleTestPullRequest.outputs.run_sqlite_session_lifecycle).toBe("false");
    expect(sqliteLifecycleTestPullRequest.outputs.run_build_artifacts).toBe("false");

    const emptyPullRequest = runCiManifestFixture({
      bundledPlanner: true,
      changedPaths: [],
      eventName: "pull_request",
    });
    expect(emptyPullRequest.status, emptyPullRequest.output).toBe(0);
    const emptyRows = JSON.parse(
      expectDefined(emptyPullRequest.outputs.checks_node_core_nondist_matrix, "empty PR matrix"),
    ).include;
    expect(emptyRows).toEqual([expect.objectContaining({ check_name: "bundled-node-plan" })]);
    const [emptyRow] = emptyRows;
    expect(
      resolveShardPlans({
        OPENCLAW_NODE_TEST_GROUPS_GZIP_BASE64: emptyRow.groups_gzip_base64,
        OPENCLAW_NODE_TEST_GROUPS_JSON: JSON.stringify(emptyRow.groups),
        OPENCLAW_NODE_TEST_CONFIGS_JSON: JSON.stringify(emptyRow.configs),
        OPENCLAW_NODE_TEST_ENV_JSON: JSON.stringify(emptyRow.env),
        OPENCLAW_NODE_TEST_INCLUDE_PATTERNS_JSON: JSON.stringify(emptyRow.includePatterns),
        OPENCLAW_NODE_TEST_TARGETS_JSON: JSON.stringify(emptyRow.targets),
        OPENCLAW_VITEST_SHARD_NAME: emptyRow.shard_name,
      }),
    ).toEqual([
      expect.objectContaining({
        kind: "group",
        plan: expect.objectContaining({ includePatterns: [] }),
      }),
    ]);

    for (const [changedPlannerSource, error] of [
      [null, "Current CI target does not provide ./scripts/lib/ci-changed-node-test-plan.mjs"],
      ['throw new Error("planner import failure");', "planner import failure"],
      [
        "export const createChangedExtensionFallbackShards = () => [];",
        "Current PR CI target does not export createChangedNodeTestShards",
      ],
      [
        "export const createChangedNodeTestShards = () => [];",
        "Current PR CI target does not export createChangedExtensionFallbackShards",
      ],
      [
        `export const createChangedNodeTestShards = () => { throw new Error("precise planning failure"); };
         export const createChangedExtensionFallbackShards = () => [];`,
        "precise planning failure",
      ],
      [
        `export const createChangedNodeTestShards = () => null;
         export const createChangedExtensionFallbackShards = () => { throw new Error("fallback planning failure"); };`,
        "fallback planning failure",
      ],
    ] as const) {
      const failure = runCiManifestFixture({
        bundledPlanner: true,
        changedPaths: ["package.json", "extensions/codex/src/focused.ts"],
        changedPlannerSource,
        eventName: "pull_request",
      });
      expect(failure.status, failure.output).toBe(1);
      expect(failure.output).toContain(error);
      expect(failure.outputs.checks_node_core_nondist_matrix).toBeUndefined();
    }
    for (const changedPaths of [undefined, null]) {
      const failure = runCiManifestFixture({
        bundledPlanner: true,
        changedPaths,
        eventName: "pull_request",
      });
      expect(failure.status, failure.output).toBe(1);
      expect(failure.output).toContain(
        "Current PR CI requires complete changed paths for Node test planning",
      );
      expect(failure.outputs.checks_node_core_nondist_matrix).toBeUndefined();
    }

    const currentMissingIos = runCiManifestFixture({
      bundledPlanner: true,
      changedPaths: ["package.json"],
      eventName: "pull_request",
      iosCapabilities: false,
    });
    expect(currentMissingIos.status, currentMissingIos.output).toBe(0);
    expect(currentMissingIos.outputs.historical_target).toBe("false");
    expect(currentMissingIos.outputs.run_ios_build).toBe("true");
    expect(currentMissingIos.outputs.run_macos_swift).toBe("true");

    const currentMissingQaPlan = runCiManifestFixture({
      bundledPlanner: true,
      changedPaths: ["package.json"],
      eventName: "pull_request",
      qaSmokePlan: false,
    });
    expect(currentMissingQaPlan.status, currentMissingQaPlan.output).toBe(0);
    expect(currentMissingQaPlan.outputs.run_qa_smoke_ci).toBe("false");

    const frozenMissingCurrentCapabilities = runCiManifestFixture({
      bundledPlanner: true,
      historicalCompatibility: false,
      iosCapabilities: false,
      iosBuildCapability: true,
      nativeI18nCapabilities: false,
      protocolCoverage: false,
      qaSmokePlan: false,
      formatCheck: false,
    });
    expect(frozenMissingCurrentCapabilities.status, frozenMissingCurrentCapabilities.output).toBe(
      0,
    );
    expect(frozenMissingCurrentCapabilities.outputs.historical_target).toBe("false");
    expect(frozenMissingCurrentCapabilities.outputs.frozen_target).toBe("true");
    expect(frozenMissingCurrentCapabilities.outputs.run_ios_build).toBe("false");
    expect(frozenMissingCurrentCapabilities.outputs.run_macos_swift).toBe("false");
    expect(frozenMissingCurrentCapabilities.outputs.run_native_i18n).toBe("false");
    expect(frozenMissingCurrentCapabilities.outputs.run_qa_smoke_ci).toBe("false");
    expect(frozenMissingCurrentCapabilities.outputs.run_protocol_event_coverage).toBe("false");
    expect(frozenMissingCurrentCapabilities.outputs.run_format_check).toBe("false");

    const releaseCandidateMissingSwiftWrappers = runCiManifestFixture({
      bundledPlanner: true,
      historicalCompatibility: false,
      iosCapabilities: false,
      iosBuildCapability: true,
      releaseCandidateCompatibility: true,
    });
    expect(releaseCandidateMissingSwiftWrappers.status).toBe(0);
    expect(releaseCandidateMissingSwiftWrappers.outputs.compatibility_target).toBe("true");
    expect(releaseCandidateMissingSwiftWrappers.outputs.use_compatible_android_ci).toBe("false");
    expect(releaseCandidateMissingSwiftWrappers.outputs.run_ios_build).toBe("true");
    expect(releaseCandidateMissingSwiftWrappers.outputs.run_macos_swift).toBe("true");

    const releaseCandidateMissingIosBuild = runCiManifestFixture({
      bundledPlanner: true,
      historicalCompatibility: false,
      iosCapabilities: false,
      iosBuildCapability: false,
      releaseCandidateCompatibility: true,
    });
    expect(releaseCandidateMissingIosBuild.status).toBe(0);
    expect(releaseCandidateMissingIosBuild.outputs.run_ios_build).toBe("false");

    const frozenTargetContext = runCiManifestFixture({
      bundledPlanner: false,
      historicalCompatibility: false,
      targetContextCompatibility: true,
    });
    expect(frozenTargetContext.status, frozenTargetContext.output).toBe(0);
    expect(frozenTargetContext.outputs.compatibility_target).toBe("true");
    expect(
      JSON.parse(
        expectDefined(
          frozenTargetContext.outputs.checks_node_core_nondist_matrix,
          "frozen target context node core nondist matrix output",
        ),
      ).include,
    ).toContainEqual(expect.objectContaining({ check_name: "legacy-node-plan" }));

    const pullRequestMissingProtocolCoverage = runCiManifestFixture({
      bundledPlanner: true,
      changedPaths: ["package.json"],
      eventName: "pull_request",
      protocolCoverage: false,
    });
    expect(
      pullRequestMissingProtocolCoverage.status,
      pullRequestMissingProtocolCoverage.output,
    ).toBe(0);
    expect(pullRequestMissingProtocolCoverage.outputs.historical_target).toBe("false");
    expect(pullRequestMissingProtocolCoverage.outputs.run_protocol_event_coverage).toBe("true");

    const currentMissingPlanner = runCiManifestFixture({
      bundledPlanner: false,
      eventName: "pull_request",
    });
    expect(currentMissingPlanner.status).not.toBe(0);
    expect(currentMissingPlanner.output).toContain(
      "CI target does not export a supported Node test shard planner",
    );

    const workflow = readCiWorkflow();
    const historicalTargetStep = workflow.jobs.preflight.steps.find(
      (step: { name?: string }) => step.name === "Validate historical release target",
    );
    expect(historicalTargetStep.if).toBe("inputs.historical_target_tag != ''");
    expect(historicalTargetStep.run).toContain('[[ "$tag_sha" != "$EXPECTED_SHA" ]]');
    const releaseCandidateStep = workflow.jobs.preflight.steps.find(
      (step: { name?: string }) => step.name === "Validate release candidate target",
    );
    expect(releaseCandidateStep.if).toBe("inputs.release_candidate_ref != ''");
    expect(releaseCandidateStep.run).toContain('[[ "$branch_sha" != "$EXPECTED_SHA" ]]');
    expect(workflow.jobs["qa-smoke-ci-profile"].if).toBe(
      "needs.preflight.outputs.run_qa_smoke_ci == 'true'",
    );
    expect(workflow.jobs["checks-fast-channel-contracts-shard"].if).toBe(
      "needs.preflight.outputs.run_channel_contracts_shards == 'true'",
    );
    const swiftInstall = workflow.jobs["macos-swift"].steps.find(
      (step: { name?: string }) => step.name === "Install XcodeGen / SwiftLint / SwiftFormat",
    );
    const swiftLint = workflow.jobs["macos-swift"].steps.find(
      (step: { name?: string }) => step.name === "Swift lint",
    );
    const openClawKitTests = workflow.jobs["macos-swift"].steps.find(
      (step: { name?: string }) => step.name === "OpenClawKit tests",
    );
    expect(swiftInstall.run).toContain("brew install xcodegen swiftlint");
    expect(swiftInstall.run).not.toContain("brew install xcodegen swiftlint swiftformat");
    expect(swiftInstall.run).toContain(
      "https://github.com/nicklockwood/SwiftFormat/releases/download/$swiftformat_version/swiftformat.zip",
    );
    expect(swiftInstall.run).toContain(
      'swiftformat_checksum="b990400779aceb7d7020796eb9ba814d4480543f671d38fc0ff48cb72f04c584"',
    );
    expect(swiftInstall.run).toContain(
      'swiftformat_checksum="7cb1cb1fae04932047c7015441c543848e8e60e1572d808d080e0a1f1661114a"',
    );
    expect(swiftInstall.run).toContain(
      'swiftformat_min_version="$(awk \'$1 == "--min-version" { print $2; exit }\' config/swiftformat)"',
    );
    expect(swiftInstall.run).toContain(
      'echo "Unsupported frozen-target SwiftFormat minimum: $swiftformat_min_version" >&2',
    );
    expect(swiftInstall.run).toContain('echo "$swift_tools_dir" >> "$GITHUB_PATH"');
    expect(swiftInstall.run).toContain(
      '[[ "$("$swift_tools_dir/swiftformat" --version)" == "$swiftformat_version" ]]',
    );
    expect(workflow.jobs["macos-swift"].env.HISTORICAL_TARGET).toBe(
      "${{ needs.preflight.outputs.compatibility_target }}",
    );
    expect(swiftInstall.run).toContain('elif [[ "$HISTORICAL_TARGET" == "true" ]]');
    expect(swiftLint.run).toContain("swiftlint lint --config config/swiftlint.yml");
    expect(swiftLint.run).toContain('elif [[ "$HISTORICAL_TARGET" == "true" ]]');
    expect(openClawKitTests.if).toBe(
      "matrix.phase == 'packages' && needs.preflight.outputs.run_openclawkit_tests == 'true'",
    );

    const checkShard = workflow.jobs["check-shard"].steps.find(
      (step: { name?: string }) => step.name === "Run check shard",
    );
    expect(checkShard.env.HISTORICAL_TARGET).toBe(
      "${{ needs.preflight.outputs.compatibility_target }}",
    );
    const uiInstall = workflow.jobs["checks-ui"].steps.find(
      (step: { name?: string }) => step.name === "Install Playwright Chromium",
    );
    const uiBrowserCache = workflow.jobs["checks-ui"].steps.find(
      (step: { name?: string }) => step.name === "Cache Playwright Chromium",
    );
    const uiTest = workflow.jobs["checks-ui"].steps.find(
      (step: { name?: string }) => step.name === "Test Control UI",
    );
    expect(workflow.jobs["checks-ui"].env.COMPATIBILITY_TARGET).toBe(
      "${{ needs.preflight.outputs.compatibility_target }}",
    );
    expect(uiInstall.env.FROZEN_TARGET).toBe("${{ needs.preflight.outputs.frozen_target }}");
    expect(uiInstall.run).toContain('if [[ "${COMPATIBILITY_TARGET:-false}" == "true" ]]');
    expect(uiInstall.run).toContain("pnpm --dir ui exec playwright install chromium");
    expect(uiInstall.run).toContain("node --import tsx scripts/ensure-playwright-chromium.mts");
    expect(uiInstall.run).toContain(".mts --require-playwright-chromium");
    expect(uiInstall.run).toContain(
      'elif [[ "$FROZEN_TARGET" == "true" && -f scripts/ensure-playwright-chromium.mjs ]]',
    );
    expect(uiInstall.run).toContain("node scripts/ensure-playwright-chromium.mjs");
    expect(uiInstall.run).toContain(
      "Target does not provide a supported Playwright Chromium installer.",
    );
    expect(uiInstall.run).not.toContain("OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM");
    const playwrightVersion = JSON.parse(readFileSync("package.json", "utf8")).devDependencies
      .playwright;
    expect(playwrightVersion).toBe(
      JSON.parse(readFileSync("ui/package.json", "utf8")).devDependencies.playwright,
    );
    expect(uiBrowserCache).toMatchObject({
      if: "needs.preflight.outputs.cache_mode != 'off' && needs.preflight.outputs.compatibility_target != 'true'",
      uses: CACHE_V5,
      with: {
        key: "${{ runner.os }}-playwright-chromium-" + playwrightVersion,
        path: "~/.cache/ms-playwright",
      },
    });
    expect(uiTest.run).toContain('if [[ "$COMPATIBILITY_TARGET" == "true" ]]');
    expect(uiTest.run).toContain("pnpm --dir ui test --testTimeout=30000 --isolate");
    expect(uiTest.run).not.toContain("--retry");
    expect(uiTest.run).toContain("pnpm --dir ui test");
  });

  it("uses the target-owned UI project capability for frozen manual matrices and commands", () => {
    for (const [runnerBackend, legacyJobCount] of [
      ["blacksmith", 4],
      ["github", 14],
      ["hybrid", 14],
    ] as const) {
      for (const uiE2eProjectsCapability of [false, true]) {
        const jobCount = uiE2eProjectsCapability ? 13 : legacyJobCount;
        const manifest = runCiManifestFixture({
          bundledPlanner: true,
          eventName: "workflow_dispatch",
          historicalCompatibility: false,
          runnerBackend,
          uiE2eProjectsCapability,
          scopeEnv: { OPENCLAW_CI_RUN_UI_TESTS: "true" },
        });
        expect(manifest.status, manifest.output).toBe(0);
        expect(manifest.outputs.frozen_target).toBe("true");
        expect(manifest.outputs.compatibility_target).toBe("false");
        expect(manifest.outputs.ui_test_groups_gzip_base64).toBe("");
        expect(manifest.outputs.ui_e2e_test_groups_gzip_base64).toBe("");
        expect(
          JSON.parse(expectDefined(manifest.outputs.ui_real_gateway_matrix, "real-Gateway matrix")),
        ).toEqual({
          include: [{ shard: 1, shard_count: 1, run_desktop: true, test_groups_gzip_base64: "" }],
        });
        expect(
          JSON.parse(
            expectDefined(manifest.outputs.ui_e2e_matrix, `${runnerBackend} UI E2E matrix`),
          ),
        ).toEqual({
          include: Array.from({ length: jobCount }, (_, index) => {
            const shard = index + 1;
            return {
              shard,
              shard_count: jobCount,
              task: shard === jobCount ? "browser-extension" : "control-ui",
              vitest_shard_count: jobCount - 1,
              vitest_max_workers: 2,
            };
          }),
        });
      }
    }

    const uiE2E = readCiWorkflow().jobs["checks-ui-e2e"];
    const scenario = expectDefined(
      uiE2E.steps.find((step: WorkflowStep) => step.name === "Test Control UI end-to-end"),
      "Control UI E2E suite",
    );
    const commandRoot = tempDirs.make("openclaw-ui-e2e-project-command-");
    const commandBin = path.join(commandRoot, "bin");
    const commandArgs = path.join(commandRoot, "args");
    const commandInclude = path.join(commandRoot, "include-path");
    const commandNativeWorkers = path.join(commandRoot, "native-workers");
    const workerEnvKey = expectDefined(
      Object.entries(scenario.env ?? {}).find(
        ([, value]) => value === "${{ matrix.vitest_max_workers || 2 }}",
      )?.[0],
      "Control UI E2E worker count",
    );
    mkdirSync(commandBin);
    writeExecutable(path.join(commandBin, "node"), [
      "#!/bin/sh",
      'printf "%s\\n" "$@" > "$UI_E2E_COMMAND_ARGS"',
      'printf "%s" "${OPENCLAW_VITEST_INCLUDE_FILE:-}" > "$UI_E2E_COMMAND_INCLUDE"',
      'printf "%s" "${VITEST_MAX_WORKERS:-}" > "$UI_E2E_COMMAND_NATIVE_WORKERS"',
    ]);
    const runCommand = (env: Record<string, string>) => {
      const result = runWorkflowShellScript(expectDefined(scenario.run, "UI E2E command"), {
        cwd: commandRoot,
        env: {
          ...process.env,
          OPENCLAW_NODE_TEST_GROUPS_GZIP_BASE64: "",
          OPENCLAW_VITEST_INCLUDE_FILE: "",
          OPENCLAW_VITEST_MAX_WORKERS: undefined,
          VITEST_MAX_WORKERS: undefined,
          RUNNER_TEMP: commandRoot,
          ...env,
          PATH: `${commandBin}:${process.env.PATH ?? ""}`,
          UI_E2E_COMMAND_ARGS: commandArgs,
          UI_E2E_COMMAND_INCLUDE: commandInclude,
          UI_E2E_COMMAND_NATIVE_WORKERS: commandNativeWorkers,
        },
      });
      expect(result.status, result.stdout + result.stderr).toBe(0);
      // Vitest's native env override defeats the source-server project's serial limit.
      expect(readFileSync(commandNativeWorkers, "utf8")).toBe("");
      return readFileSync(commandArgs, "utf8").trim().split("\n");
    };
    const shardEnv = { VITEST_SHARD_COUNT: "3", VITEST_SHARD_INDEX: "1" };
    const expectedArgs = [
      "scripts/run-vitest.mjs",
      "run",
      "--config",
      "test/vitest/vitest.ui-e2e.config.ts",
      "--configLoader",
      "runner",
      "--maxWorkers",
      "2",
      "--shard",
      "1/3",
    ];
    expect(runCommand(shardEnv)).toEqual(expectedArgs);
    expect(runCommand({ ...shardEnv, [workerEnvKey]: "3" })).toEqual(
      expectedArgs.with(expectedArgs.indexOf("--maxWorkers") + 1, "3"),
    );
    expect(readFileSync(commandInclude, "utf8")).toBe("");

    const codec = "scripts/lib/ci-node-test-groups-codec.mts";
    mkdirSync(path.dirname(path.join(commandRoot, codec)), { recursive: true });
    copyFileSync(codec, path.join(commandRoot, codec));
    const group = {
      configs: ["test/vitest/vitest.ui-e2e.config.ts"],
      shard_name: "test/vitest/vitest.ui-e2e.config.ts",
    };
    const includePatterns = [
      "ui/src/e2e/chat-flow.navigation-presentation.e2e.test.ts",
      "ui/src/e2e/chat-session-entry.e2e.test.ts",
    ];
    expect(
      runCommand({
        ...shardEnv,
        OPENCLAW_NODE_TEST_GROUPS_GZIP_BASE64: encodeNodeTestGroups([
          { ...group, includePatterns },
        ]),
      }),
    ).toEqual(expectedArgs);
    const includeFile = readFileSync(commandInclude, "utf8");
    expect(includeFile).toBe(path.join(commandRoot, "ui-e2e-include.json"));
    expect(JSON.parse(readFileSync(includeFile, "utf8"))).toEqual(includePatterns);
    expect(
      runCommand({
        ...shardEnv,
        OPENCLAW_NODE_TEST_GROUPS_GZIP_BASE64: encodeNodeTestGroups([group]),
        OPENCLAW_VITEST_INCLUDE_FILE: includeFile,
      }),
    ).toEqual(expectedArgs);
    expect(readFileSync(commandInclude, "utf8")).toBe("");

    expect(
      evaluateWorkflowExpression(`\${{ ${uiE2E.if} }}`, {
        eventName: "workflow_dispatch",
        preflightOutputs: { compatibility_target: "true", run_ui_tests: "true" },
        repository: "openclaw/openclaw",
        runAttempt: 1,
      }),
    ).toBe(false);
  });

  it("gates current Control UI changes on ordinary and real-Gateway Chromium E2E", () => {
    const workflow = readCiWorkflow();
    const ui = workflow.jobs["checks-ui"];
    const uiE2e = workflow.jobs["checks-ui-e2e"];
    const uiE2eRealGateway = workflow.jobs["checks-ui-e2e-real-gateway"];

    expect(readFileSync("test/vitest/vitest.ui-e2e.config.ts", "utf8")).toContain(
      "ui-e2e-projects-contract-v1",
    );

    expect(uiE2e.permissions).toEqual({ contents: "read" });
    expect(uiE2e.needs).toEqual(["preflight"]);
    expect(uiE2e.if).toBe(
      "needs.preflight.outputs.run_ui_e2e == 'true' && needs.preflight.outputs.compatibility_target != 'true'",
    );
    expect(uiE2e["runs-on"]).not.toBe(ui["runs-on"]);
    expect(uiE2e["timeout-minutes"]).toBe(25);
    expect(uiE2e.env).toEqual({ OPENCLAW_UI_E2E_SKIP_REAL_GATEWAY: "1" });
    expect(uiE2e.strategy["fail-fast"]).toBe(false);
    expect(uiE2e.strategy["max-parallel"]).toBe(14);
    expect(uiE2e.strategy.matrix).toBe("${{ fromJson(needs.preflight.outputs.ui_e2e_matrix) }}");
    const expectedUiE2eMatrices = [6, 8, 12].map((vitestShardCount) => ({
      include: Array.from({ length: vitestShardCount + 1 }, (_, index) => {
        const shard = index + 1;
        return {
          shard,
          shard_count: vitestShardCount + 1,
          task: shard === vitestShardCount + 1 ? "browser-extension" : "control-ui",
          vitest_shard_count: vitestShardCount,
          vitest_max_workers: vitestShardCount === 8 ? 3 : 2,
        };
      }),
    }));
    for (const runnerBackend of ["blacksmith", "github", "hybrid"] as const) {
      for (const eventName of ["push", "pull_request"] as const) {
        for (const runAttempt of ["1", "2", ""]) {
          const manifest = runCiManifestFixture({
            bundledPlanner: true,
            changedPaths: [],
            eventName,
            historicalCompatibility: false,
            runnerBackend,
            uiE2eProjectsCapability: true,
            scopeEnv: { GITHUB_RUN_ATTEMPT: runAttempt },
          });
          const assertionName = `${runnerBackend} ${eventName} attempt ${runAttempt || "missing"}`;
          expect(manifest.status, manifest.output).toBe(0);
          expect(
            JSON.parse(expectDefined(manifest.outputs.ui_e2e_matrix, assertionName)),
            assertionName,
          ).toEqual(expectedUiE2eMatrices[1]);
        }
      }
    }
    expect(workflow.jobs["ci-gate"].needs).toContain("checks-ui-e2e");
    expect(workflow.jobs["ci-gate"].needs).toContain("checks-ui-e2e-real-gateway");

    expect(uiE2eRealGateway.permissions).toEqual(uiE2e.permissions);
    expect(uiE2eRealGateway.needs).toEqual(uiE2e.needs);
    expect(uiE2eRealGateway.if).toBe(
      "needs.preflight.outputs.run_proof_tier == 'true' && needs.preflight.outputs.run_ui_e2e == 'true' && needs.preflight.outputs.compatibility_target != 'true'",
    );
    expect(uiE2eRealGateway.env).toBeUndefined();
    expect(uiE2eRealGateway.strategy).toEqual({
      "fail-fast": false,
      "max-parallel": 2,
      matrix: "${{ fromJson(needs.preflight.outputs.ui_real_gateway_matrix) }}",
    });

    const uiE2eSetup = expectDefined(
      uiE2e.steps.find((step: WorkflowStep) => step.name === "Setup Node environment"),
      "Control UI E2E Node setup",
    );
    expect(uiE2eSetup.uses).toBe("./.ci-harness/.github/actions/setup-node-env");
    const expectedSharedUiE2eSetup = {
      "cache-mode": "${{ needs.preflight.outputs.cache_mode }}",
      "node-version": "24.x",
      "install-bun": "false",
      "dependency-cache": expect.any(String),
    } as const;
    const expectedUiE2eSetup = {
      ...expectedSharedUiE2eSetup,
      "restore-test-caches":
        "${{ (needs.preflight.outputs.runner_profile == 'github' || needs.preflight.outputs.runner_profile == 'hybrid') && 'true' || 'false' }}",
    } as const;
    expect(uiE2eSetup.with).toEqual(expectedUiE2eSetup);
    const realGatewaySetup = expectDefined(
      uiE2eRealGateway.steps.find((step: WorkflowStep) => step.name === "Setup Node environment"),
      "real-Gateway Control UI E2E Node setup",
    );
    expect(realGatewaySetup).toMatchObject({
      uses: uiE2eSetup.uses,
      with: expectedSharedUiE2eSetup,
    });
    expect(realGatewaySetup.with).toEqual(expectedSharedUiE2eSetup);

    // Failed-job retries can retain an earlier six-shard plan while live routing
    // selects hosted runners. Both widths retain the cache and contributor boundaries.
    const routedUiE2eJobs = [
      ...expectedUiE2eMatrices
        .flatMap(({ include }) => include)
        .map((matrix) => ({
          job: uiE2e,
          name: `checks-ui-e2e (${matrix.shard}/${matrix.shard_count})`,
          setup: uiE2eSetup,
          matrix,
          blacksmithRunner:
            matrix.task === "control-ui"
              ? "blacksmith-16vcpu-ubuntu-2404"
              : "blacksmith-8vcpu-ubuntu-2404",
        })),
      ...[
        { shard: 1, shard_count: 2, run_desktop: true },
        { shard: 2, shard_count: 2, run_desktop: false },
        { shard: 1, shard_count: 1, run_desktop: true },
      ].map((matrix) => ({
        job: uiE2eRealGateway,
        name:
          matrix.shard_count === 1
            ? "checks-ui-e2e-real-gateway"
            : `checks-ui-e2e-real-gateway (${matrix.shard}/${matrix.shard_count})`,
        setup: realGatewaySetup,
        matrix,
        blacksmithRunner: "blacksmith-32vcpu-ubuntu-2404",
      })),
    ] as const;
    expect(new Set(routedUiE2eJobs.map((job) => job.name)).size).toBe(routedUiE2eJobs.length);
    const routingScenarios = [
      {
        name: "same-repo pull request first attempt",
        context: {
          eventName: "pull_request",
          headRepository: "openclaw/openclaw",
          repository: "openclaw/openclaw",
          runAttempt: 1,
        },
        expected: { blacksmith: true, dependencyCache: "true" },
      },
      {
        name: "same-repo pull request with GitHub backend",
        context: {
          eventName: "pull_request",
          headRepository: "openclaw/openclaw",
          repository: "openclaw/openclaw",
          runnerBackend: "github",
          runAttempt: 1,
        },
        expected: { blacksmith: false, dependencyCache: "false" },
      },
      {
        name: "same-repo pull request with hybrid backend",
        context: {
          eventName: "pull_request",
          headRepository: "openclaw/openclaw",
          repository: "openclaw/openclaw",
          runnerBackend: "hybrid",
          runAttempt: 1,
        },
        expected: { blacksmith: true, dependencyCache: "true" },
      },
      {
        name: "same-repo pull request retry",
        context: {
          eventName: "pull_request",
          headRepository: "openclaw/openclaw",
          repository: "openclaw/openclaw",
          runAttempt: 2,
        },
        expected: { blacksmith: false, dependencyCache: "false" },
      },
      {
        name: "same-repo pull request with hybrid backend retry",
        context: {
          eventName: "pull_request",
          headRepository: "openclaw/openclaw",
          repository: "openclaw/openclaw",
          runnerBackend: "hybrid",
          runAttempt: 2,
        },
        expected: { blacksmith: false, dependencyCache: "false" },
      },
      {
        name: "canonical hybrid push retry",
        context: {
          eventName: "push",
          repository: "openclaw/openclaw",
          runnerBackend: "hybrid",
          runAttempt: 2,
        },
        expected: { blacksmith: false, dependencyCache: "false" },
      },
      {
        // Runner routing follows contributor trust; the exact dependency cache
        // stays fork-gated either way, so a fork never writes what main reads.
        name: "fork pull request from returning contributor",
        context: {
          authorAssociation: "CONTRIBUTOR",
          eventName: "pull_request",
          headRepository: "contributor/openclaw",
          repository: "openclaw/openclaw",
          runAttempt: 1,
        },
        expected: { blacksmith: true, dependencyCache: "false" },
      },
      {
        name: "fork pull request from unknown author",
        context: {
          authorAssociation: "NONE",
          eventName: "pull_request",
          headRepository: "contributor/openclaw",
          repository: "openclaw/openclaw",
          runAttempt: 1,
        },
        expected: { blacksmith: false, dependencyCache: "false" },
      },
      {
        name: "workflow dispatch",
        context: {
          eventName: "workflow_dispatch",
          repository: "openclaw/openclaw",
          runAttempt: 1,
        },
        expected: { blacksmith: false, dependencyCache: "false" },
      },
      {
        name: "canonical push retry",
        context: {
          eventName: "push",
          repository: "openclaw/openclaw",
          runAttempt: 2,
        },
        expected: { blacksmith: true, dependencyCache: "true" },
      },
    ] as const;
    for (const { blacksmithRunner, job, matrix, name: jobName, setup } of routedUiE2eJobs) {
      for (const { context, expected, name: scenarioName } of routingScenarios) {
        const assertionName = `${jobName}: ${scenarioName}`;
        const expectedRunner = expected.blacksmith ? blacksmithRunner : "ubuntu-24.04";
        expect(
          String(job.name).replace(/\$\{\{[\s\S]*?\}\}/gu, (expression) =>
            String(evaluateWorkflowExpression(expression, { ...context, matrix })),
          ),
          assertionName,
        ).toBe(jobName);
        expect(
          evaluateWorkflowExpression(job["runs-on"], { ...context, matrix }),
          assertionName,
        ).toBe(expectedRunner);
        expect(
          evaluateWorkflowExpression(setup.with?.["dependency-cache"], {
            ...context,
            matrix,
            runnerEnvironment: expected.blacksmith ? "self-hosted" : "github-hosted",
          }),
          assertionName,
        ).toBe(expected.dependencyCache);
        expect(setup.with?.["cache-mode"], assertionName).toBe(
          "${{ needs.preflight.outputs.cache_mode }}",
        );
      }
    }

    const chromiumInstall = expectDefined(
      uiE2e.steps.find((step: WorkflowStep) => step.name === "Install Playwright Chromium"),
      "Control UI E2E Chromium installation",
    );
    expect(chromiumInstall.env.FROZEN_TARGET).toBe("${{ needs.preflight.outputs.frozen_target }}");
    expect(chromiumInstall.run).toContain(
      "node --import tsx scripts/ensure-playwright-chromium.mts",
    );
    expect(chromiumInstall.run).toContain("node scripts/ensure-playwright-chromium.mjs");
    const chromiumCache = expectDefined(
      uiE2e.steps.find((step: WorkflowStep) => step.name === "Cache Playwright Chromium"),
      "Control UI E2E Chromium cache",
    );
    const realGatewayChromiumInstall = expectDefined(
      uiE2eRealGateway.steps.find(
        (step: WorkflowStep) => step.name === "Install Playwright Chromium",
      ),
      "real-Gateway Control UI E2E Chromium installation",
    );
    expect(realGatewayChromiumInstall).toEqual(chromiumInstall);
    const realGatewayChromiumCache = expectDefined(
      uiE2eRealGateway.steps.find(
        (step: WorkflowStep) => step.name === "Cache Playwright Chromium",
      ),
      "real-Gateway Control UI E2E Chromium cache",
    );
    expect(realGatewayChromiumCache).toEqual(chromiumCache);

    const scenario = expectDefined(
      uiE2e.steps.find((step: WorkflowStep) => step.name === "Test Control UI end-to-end"),
      "Control UI E2E suite",
    );
    expect(scenario.if).toBe("matrix.task == 'control-ui'");
    expect(scenario.env).toEqual({
      OPENCLAW_UI_E2E_DIAGNOSTIC_DIR:
        ".artifacts/control-ui-e2e-timeouts/shard-${{ matrix.shard }}-attempt-${{ github.run_attempt }}",
      VITEST_SHARD_INDEX: "${{ matrix.shard }}",
      VITEST_SHARD_COUNT: "${{ matrix.vitest_shard_count }}",
      OPENCLAW_VITEST_MAX_WORKERS: "${{ matrix.vitest_max_workers || 2 }}",
      OPENCLAW_NODE_TEST_GROUPS_GZIP_BASE64:
        "${{ needs.preflight.outputs.ui_e2e_test_groups_gzip_base64 }}",
    });
    expect(scenario.run).not.toContain("--project");
    const timeoutDiagnostics = expectDefined(
      uiE2e.steps.find(
        (step: WorkflowStep) => step.name === "Upload Control UI E2E timeout diagnostics",
      ),
      "Control UI E2E timeout diagnostic upload",
    );
    expect(timeoutDiagnostics).toEqual({
      name: "Upload Control UI E2E timeout diagnostics",
      if: "failure() && matrix.task == 'control-ui'",
      uses: UPLOAD_ARTIFACT_V7,
      with: {
        name: "control-ui-e2e-timeout-${{ matrix.shard }}-${{ github.run_attempt }}",
        path: ".artifacts/control-ui-e2e-timeouts/shard-${{ matrix.shard }}-attempt-${{ github.run_attempt }}/failure-*/failure.public.json",
        "if-no-files-found": "ignore",
        "retention-days": 7,
      },
    });
    const browserExtension = expectDefined(
      uiE2e.steps.find(
        (step: WorkflowStep) => step.name === "Test browser extension bootstrap end-to-end",
      ),
      "browser extension bootstrap E2E suite",
    );
    expect(browserExtension.if).toBe("matrix.task == 'browser-extension'");
    expect(browserExtension.run).toBe("pnpm test:e2e:browser-extension");
    for (const { job } of routedUiE2eJobs) {
      const jobContract = JSON.stringify(job);
      expect(jobContract).not.toContain("OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM");
      expect(jobContract).not.toContain("OPENCLAW_VITEST_NO_OUTPUT_RETRY");
    }

    const realGatewaySteps = uiE2eRealGateway.steps.filter((step: WorkflowStep) =>
      step.name?.includes("with a real Gateway"),
    );
    expect(realGatewaySteps).toHaveLength(1);
    const realGatewayStep = expectDefined(
      realGatewaySteps[0],
      "combined real-Gateway Control UI E2E suite",
    );
    expect(realGatewayStep.run).not.toContain("--retry");
    expect(realGatewayStep.run).not.toContain("--hookTimeout");
    expect(realGatewayStep.run).not.toContain("--testTimeout");

    const proofUploadIndex = uiE2eRealGateway.steps.findIndex(
      (step: WorkflowStep) => step.name === "Upload sanitized Control UI real-Gateway proof",
    );
    const proofUpload = uiE2eRealGateway.steps[proofUploadIndex];
    const realGatewayIndex = uiE2eRealGateway.steps.indexOf(realGatewayStep);
    const realGatewayFailureDiagnostics = expectDefined(
      uiE2eRealGateway.steps.find(
        (step: WorkflowStep) => step.name === "Upload Control UI real-Gateway failure diagnostics",
      ),
      "real-Gateway Control UI failure diagnostic upload",
    );
    expect(realGatewayFailureDiagnostics).toEqual({
      name: "Upload Control UI real-Gateway failure diagnostics",
      if: "failure()",
      uses: UPLOAD_ARTIFACT_V7,
      with: {
        name: "control-ui-real-gateway-timeout-${{ github.run_attempt }}-${{ matrix.shard }}",
        path: [
          ".artifacts/control-ui-e2e-timeouts/real-gateway-attempt-${{ github.run_attempt }}/failure-*/failure.public.json",
          "",
        ].join("\n"),
        "if-no-files-found": "ignore",
        "retention-days": 7,
      },
    });
    expect(uiE2eRealGateway.steps.indexOf(realGatewayFailureDiagnostics)).toBeGreaterThan(
      realGatewayIndex,
    );
    const quotaDiagnostics = expectDefined(
      uiE2eRealGateway.steps.find(
        (step: WorkflowStep) => step.name === "Upload quota auth and transport diagnostics",
      ),
      "quota diagnostics retained on success and failure",
    );
    expect(quotaDiagnostics).toEqual({
      name: "Upload quota auth and transport diagnostics",
      if: "always()",
      uses: UPLOAD_ARTIFACT_V7,
      with: {
        name: "control-ui-quota-diagnostics-${{ github.run_attempt }}-${{ matrix.shard }}",
        path: ".artifacts/control-ui-e2e/real-gateway/quota-refresh-*/quota.public.json",
        "if-no-files-found": "ignore",
        "retention-days": 7,
      },
    });
    expect(uiE2eRealGateway.steps.indexOf(quotaDiagnostics)).toBeGreaterThan(realGatewayIndex);
    // Same-origin admission compares exact build IDs, including the build timestamp.
    // Include private QA so media bootstrap cannot rebuild runtime behind the UI.
    const realGatewayBuild = expectDefined(
      uiE2eRealGateway.steps.find(
        (step: WorkflowStep) =>
          step.name === "Build runtime and Control UI artifacts for real-Gateway tests",
      ),
      "paired runtime and Control UI build",
    );
    expect(realGatewayBuild.run).toBe("pnpm build");
    expect(realGatewayBuild.if).toBeUndefined();
    expect(realGatewayBuild["continue-on-error"]).toBeUndefined();
    expect(realGatewayBuild.env).toEqual({
      OPENCLAW_BUILD_PRIVATE_QA: "1",
      OPENCLAW_RUN_NODE_SKIP_DTS_BUILD: "1",
    });
    const realGatewayBuildIndex = uiE2eRealGateway.steps.indexOf(realGatewayBuild);
    expect(realGatewayBuildIndex).toBeGreaterThan(uiE2eRealGateway.steps.indexOf(realGatewaySetup));
    expect(realGatewayBuildIndex).toBeLessThan(realGatewayIndex);
    const desktopProof = expectDefined(
      uiE2eRealGateway.steps.find(
        (step: WorkflowStep) => step.name === "Prove desktop resize over node and SSH",
      ),
      "real desktop fixture proof",
    );
    expect(desktopProof).toEqual({
      name: "Prove desktop resize over node and SSH",
      if: "matrix.run_desktop",
      env: {
        FROZEN_TARGET: "${{ needs.preflight.outputs.frozen_target }}",
        DESKTOP_PROOF_CHECKOUT_SHA: "${{ needs.preflight.outputs.checkout_revision }}",
        DESKTOP_PROOF_PR_HEAD_SHA: "${{ github.event.pull_request.head.sha }}",
        DESKTOP_PROOF_PR_BASE_SHA: "${{ github.event.pull_request.base.sha }}",
        DESKTOP_PROOF_WORKFLOW_SHA: "${{ github.workflow_sha }}",
      },
      run: expect.stringContaining('node --import tsx "$bootstrap"'),
    });
    expect(uiE2eRealGateway.steps.indexOf(desktopProof)).toBeGreaterThan(realGatewayBuildIndex);
    expect(uiE2eRealGateway.steps.indexOf(desktopProof)).toBeLessThan(realGatewayIndex);
    const desktopUpload = expectDefined(
      uiE2eRealGateway.steps.find(
        (step: WorkflowStep) => step.name === "Upload sanitized desktop resize proof",
      ),
      "sanitized desktop upload",
    );
    expect(desktopUpload).toEqual({
      name: "Upload sanitized desktop resize proof",
      if: "always() && matrix.run_desktop",
      uses: UPLOAD_ARTIFACT_V7,
      with: {
        name: "desktop-resize-proof-${{ github.run_id }}-${{ github.run_attempt }}",
        path: ".artifacts/control-ui-e2e/real-gateway/desktop-resize",
        "if-no-files-found": "warn",
        "retention-days": 14,
      },
    });
    expect(uiE2eRealGateway.steps.indexOf(desktopUpload)).toBeGreaterThan(realGatewayIndex);
    expect(realGatewayStep.env).toEqual({
      FROZEN_TARGET: "${{ needs.preflight.outputs.frozen_target }}",
      OPENCLAW_CAPTURE_UI_PROOF:
        "${{ github.event_name == 'workflow_dispatch' && inputs.capture_ui_proof && '1' || '0' }}",
      OPENCLAW_UI_E2E_ARTIFACT_DIR: proofUpload.with.path,
      OPENCLAW_UI_E2E_DIAGNOSTIC_DIR:
        ".artifacts/control-ui-e2e-timeouts/real-gateway-attempt-${{ github.run_attempt }}",
      OPENCLAW_NODE_TEST_GROUPS_GZIP_BASE64: "${{ matrix.test_groups_gzip_base64 }}",
    });
    expect(proofUploadIndex).toBeGreaterThan(realGatewayIndex);
    expect(proofUpload.with.name).toBe(
      "control-ui-real-gateway-proof-${{ github.run_id }}-${{ github.run_attempt }}-${{ matrix.shard }}",
    );
    const realGatewayRows = routedUiE2eJobs.filter(
      (row) => row.job === uiE2eRealGateway && row.matrix.shard_count === 2,
    );
    for (const step of [desktopProof, desktopUpload]) {
      expect(
        realGatewayRows.filter(({ matrix }) =>
          evaluateWorkflowExpression(`\${{ ${step.if} }}`, {
            eventName: "push",
            repository: "openclaw/openclaw",
            runAttempt: 1,
            matrix,
          }),
        ),
      ).toHaveLength(1);
    }
    for (const step of uiE2eRealGateway.steps.filter(
      (candidate: WorkflowStep) =>
        candidate.uses === UPLOAD_ARTIFACT_V7 && candidate !== desktopUpload,
    )) {
      const names = realGatewayRows.map(({ matrix }) =>
        String(step.with.name).replace(/\$\{\{[\s\S]*?\}\}/gu, (expression) =>
          String(
            evaluateWorkflowExpression(expression, {
              eventName: "push",
              repository: "openclaw/openclaw",
              runAttempt: 1,
              runId: 2,
              matrix,
            }),
          ),
        ),
      );
      expect(new Set(names).size, step.name).toBe(2);
    }
  });

  it("keeps automatic source-only Control UI locale drift advisory and manual CI strict", () => {
    const workflow = readCiWorkflow();
    const workflowSource = readFileSync(".github/workflows/ci.yml", "utf8");
    const buildArtifactSteps = workflow.jobs["build-artifacts"].steps;
    const localeJob = workflow.jobs["control-ui-i18n"];
    const sourceStep = localeJob.steps.find(
      (step: WorkflowStep) => step.name === "Verify Control UI i18n source",
    );
    const localeStep = localeJob.steps.find(
      (step: WorkflowStep) => step.name === "Check Control UI locale parity",
    );

    expect(buildArtifactSteps).not.toContainEqual(
      expect.objectContaining({ run: "pnpm ui:i18n:check" }),
    );
    expect(JSON.parse(readFileSync("package.json", "utf8")).scripts["test:ui"]).not.toContain(
      "ui:i18n:check",
    );
    expect(workflowSource.match(/pnpm ui:i18n:verify/gu)).toHaveLength(1);
    expect(workflowSource.match(/pnpm ui:i18n:check/gu)).toHaveLength(1);
    expect(readFileSync("ui/src/i18n/test/translate.test.ts", "utf8")).not.toContain(
      "keeps shipped locales structurally aligned with English",
    );
    expect(localeJob.needs).toEqual(["preflight"]);
    expect(localeJob.if).toBe("needs.preflight.outputs.run_control_ui_i18n == 'true'");
    expect(localeJob["continue-on-error"]).toBeUndefined();
    expect(localeJob.env.COMPATIBILITY_TARGET).toBe(
      "${{ needs.preflight.outputs.compatibility_target }}",
    );
    expect(workflow.jobs.preflight.outputs.strict_control_ui_i18n).toBe(
      "${{ github.event_name == 'workflow_dispatch' && !inputs.release_gate && 'true' || steps.changed_scope.outputs.strict_control_ui_i18n }}",
    );
    expect(
      evaluateWorkflowExpression(
        "${{ github.event_name == 'workflow_dispatch' && !inputs.release_gate && 'true' || 'false' }}",
        {
          eventName: "workflow_dispatch",
          releaseGate: false,
          repository: "openclaw/openclaw",
          runAttempt: 1,
        },
      ),
    ).toBe("true");
    expect(
      evaluateWorkflowExpression(
        "${{ github.event_name == 'workflow_dispatch' && !inputs.release_gate && 'true' || 'false' }}",
        {
          eventName: "workflow_dispatch",
          releaseGate: true,
          repository: "openclaw/openclaw",
          runAttempt: 1,
        },
      ),
    ).toBe("false");
    expect(sourceStep["continue-on-error"]).toBeUndefined();
    const compatibilityWithoutVerify = runControlUiI18nSourceFixture({
      compatibilityTarget: true,
      hasVerifyScript: false,
    });
    expect(compatibilityWithoutVerify.status, compatibilityWithoutVerify.output).toBe(0);
    expect(compatibilityWithoutVerify.calls).toEqual([]);
    expect(compatibilityWithoutVerify.summary).toContain(
      "Skipping ui:i18n:verify: unavailable on the selected compatibility target.",
    );

    const currentWithoutVerify = runControlUiI18nSourceFixture({
      compatibilityTarget: false,
      hasVerifyScript: false,
    });
    expect(currentWithoutVerify.status).toBe(1);
    expect(currentWithoutVerify.calls).toEqual([]);
    expect(currentWithoutVerify.output).toContain(
      "ui:i18n:verify is required for non-compatibility targets.",
    );

    const currentWithVerify = runControlUiI18nSourceFixture({
      compatibilityTarget: false,
      hasVerifyScript: true,
    });
    expect(currentWithVerify.status, currentWithVerify.output).toBe(0);
    expect(currentWithVerify.calls).toEqual(["ui:i18n:verify"]);
    expect(localeStep["continue-on-error"]).toBe(
      "${{ needs.preflight.outputs.strict_control_ui_i18n != 'true' }}",
    );
    expect(localeStep.run).toBe("pnpm ui:i18n:check");
    expect(readFileSync(".github/workflows/full-release-validation.yml", "utf8")).toContain(
      'dispatch_child ci.yml "$dispatch_run_name"',
    );
  });

  it.each([
    { selected: false, exitCode: 0 },
    { selected: true, exitCode: 0 },
    { selected: true, exitCode: 1 },
    { selected: true, exitCode: 143 },
  ])(
    "runs the built SQLite verifier (selected=$selected, exit=$exitCode)",
    ({ selected, exitCode }) => {
      const workflow = readCiWorkflow();
      const additionalJob = workflow.jobs["check-additional-shard"];
      const additionalRunStep = additionalJob.steps.find(
        (step: WorkflowStep) => step.name === "Run additional check shard",
      );
      const verifier = workflow.jobs["build-artifacts"].steps.find(
        (step: WorkflowStep) => step.name === "Run built artifact checks",
      );
      const selection = expectDefined(
        verifier.run.match(
          /if \[ "\$RUN_SQLITE_SESSION_LIFECYCLE" = "true" \]; then\n[\s\S]*?\nfi/u,
        )?.[0],
        "scoped SQLite verifier invocation",
      );

      expect(readFrozenAdditionalCheckRows()).not.toContainEqual(
        expect.objectContaining({ group: "sqlite-session-flip-proof" }),
      );
      expect(additionalRunStep.run).not.toContain("sqlite-session-flip-proof)");
      expect(workflow.jobs["sqlite-session-lifecycle"]).toBeUndefined();
      expect(verifier.env.RUN_SQLITE_SESSION_LIFECYCLE).toBe(
        "${{ needs.preflight.outputs.run_sqlite_session_lifecycle }}",
      );
      expect(workflow.jobs["ci-gate"].needs).toContain("build-artifacts");
      expect(workflow.jobs["ci-gate"].needs).not.toContain("sqlite-session-lifecycle");
      const memoryBarrier = verifier.run.indexOf(
        "\nwait_checks\n",
        verifier.run.indexOf('run_verifier "startup-memory"'),
      );
      expect(verifier.run.indexOf(selection)).toBeGreaterThan(memoryBarrier);
      expect(verifier.run.indexOf(selection)).toBeLessThan(
        verifier.run.indexOf('start_check "channels"'),
      );
      const root = tempDirs.make("openclaw-sqlite-verifier-");
      mkdirSync(path.join(root, "scripts"));
      writeFileSync(
        path.join(root, "scripts/run-vitest.mjs"),
        `
      import { writeFileSync } from "node:fs";
      writeFileSync("invocation.json", JSON.stringify({
        args: process.argv.slice(2),
        prebuilt: process.env.OPENCLAW_E2E_USE_PREBUILT_DIST,
        watchdog: process.env.OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS,
      }));
      process.exit(${exitCode});
    `,
      );
      // Exercise the selected command at the existing verifier boundary. The full
      // wave's associative-array scheduler needs native CI's Bash for execution.
      const result = runWorkflowShellScript(
        `
      run_verifier() {
        printf '%s\\n' "$1" > verifier-name
        shift
        "$@"
      }
      ${selection}
    `,
        { cwd: root, env: { ...process.env, RUN_SQLITE_SESSION_LIFECYCLE: String(selected) } },
      );
      expect(result.status, result.stderr).toBe(selected ? exitCode : 0);
      expect(existsSync(path.join(root, "invocation.json"))).toBe(selected);
      if (selected) {
        expect(readFileSync(path.join(root, "verifier-name"), "utf8").trim()).toBe(
          "sqlite-session-lifecycle",
        );
        expect(JSON.parse(readFileSync(path.join(root, "invocation.json"), "utf8"))).toEqual({
          args: [
            "run",
            "--config",
            "test/vitest/vitest.e2e.config.ts",
            "test/scripts/sqlite-sessions-transcripts-flip-proof.built-cli.e2e.test.ts",
          ],
          prebuilt: "1",
          watchdog: "660000",
        });
      }
    },
  );

  it("keeps docs i18n CI on the workflow-owned Go toolchain", () => {
    const workflow = readCiWorkflow();
    const nodeTestJob = workflow.jobs["checks-node-core-test-nondist-shard"];
    const setupGoStep = nodeTestJob.steps.find(
      (step: WorkflowStep) => step.name === "Setup Go for docs i18n",
    );
    const verifyGoStep = nodeTestJob.steps.find(
      (step: WorkflowStep) => step.name === "Verify docs i18n Go toolchain",
    );
    const resolveGoCacheStep = nodeTestJob.steps.find(
      (step: WorkflowStep) => step.name === "Resolve docs i18n Go cache",
    );
    const restoreGoCacheStep = nodeTestJob.steps.find(
      (step: WorkflowStep) => step.name === "Restore docs i18n Go cache",
    );
    const saveGoCacheStep = nodeTestJob.steps.find(
      (step: WorkflowStep) => step.name === "Save docs i18n Go cache",
    );
    expect(setupGoStep).toMatchObject({
      if: "matrix.requires_go == true",
      uses: SETUP_GO_V6,
      with: {
        cache: false,
        "go-version": "1.27.1",
      },
    });
    expect(setupGoStep.with).not.toHaveProperty("go-version-file");
    expect(resolveGoCacheStep).toMatchObject({
      if: "matrix.requires_go == true && needs.preflight.outputs.cache_mode != 'off'",
      env: {
        DEPENDENCY_HASH: "${{ hashFiles('scripts/docs-i18n/go.sum') }}",
      },
    });
    expect(resolveGoCacheStep.run).toContain(
      "key=setup-go-${RUNNER_OS}-${arch}-${image_prefix}go-${version#go}-${DEPENDENCY_HASH}",
    );
    expect(restoreGoCacheStep).toMatchObject({
      if: "matrix.requires_go == true && needs.preflight.outputs.cache_mode != 'off'",
      uses: CACHE_V5,
    });
    expect(saveGoCacheStep).toMatchObject({
      if: expect.stringContaining("needs.preflight.outputs.cache_write_allowed == 'true'"),
      uses: CACHE_SAVE_V5,
    });
    expect(verifyGoStep).toMatchObject({
      if: "matrix.requires_go == true",
      run: 'test "$(go env GOVERSION)" = "go1.27.1"',
    });

    const goMod = readTrackedText("scripts/docs-i18n/go.mod");
    expect(goMod).toMatch(/^go 1\.26\.0$/mu);
    expect(goMod).toMatch(/^toolchain go1\.27\.1$/mu);

    const tooling = {
      configs: ["test/vitest/vitest.tooling.config.ts"],
      shard_name: "core-tooling-1",
    };
    const goTest = "test/scripts/docs-i18n.test.ts";
    const otherTest = "test/scripts/ci-git-owner.test.ts";
    const selections = [
      { includePatterns: [goTest] },
      { includePatterns: [otherTest] },
      { includePatterns: ["test/scripts/docs-*.test.ts"] },
      { targets: [goTest] },
      { targets: [otherTest] },
      {},
      { groups: [{ ...tooling, includePatterns: [otherTest] }] },
      {
        groups: [
          { ...tooling, includePatterns: [otherTest] },
          { ...tooling, includePatterns: [goTest] },
        ],
      },
      { groups: [{ ...tooling, configs: ["test/vitest/legacy-tooling.config.ts"] }] },
      { groups: [{ ...tooling, configs: ["test/vitest/vitest.tooling-isolated.config.ts"] }] },
      { groups: [{ ...tooling, configs: ["test/vitest/vitest.tooling-docker.config.ts"] }] },
      {
        groups: [
          {
            ...tooling,
            configs: [
              "test/vitest/vitest.tooling-docker.config.ts",
              "test/vitest/vitest.tooling-isolated.config.ts",
            ],
          },
        ],
      },
      {
        groups: [
          {
            ...tooling,
            configs: [...tooling.configs, "test/vitest/vitest.tooling-isolated.config.ts"],
          },
        ],
      },
      {
        groups: [
          {
            ...tooling,
            configs: [
              "test/vitest/vitest.tooling-isolated.config.ts",
              "test/vitest/legacy-tooling.config.ts",
            ],
          },
        ],
      },
      { groups: [{ ...tooling, configs: undefined }] },
      {
        groups: [
          {
            ...tooling,
            configs: ["test/vitest/vitest.tooling-isolated.config.ts"],
            includePatterns: [goTest],
          },
        ],
      },
    ];
    const result = runCiManifestFixture({
      bundledPlanner: true,
      nodeTestShards: selections.map((selection, index) =>
        Object.assign(
          {
            checkName: `tooling-${index}`,
            configs: tooling.configs,
            requiresDist: false,
            runner: "ubuntu-24.04",
            shardName: "groups" in selection ? "compact-small-1" : "core-tooling-1",
          },
          selection,
        ),
      ),
    });
    expect(result.status, result.output).toBe(0);
    const matrix = JSON.parse(
      expectDefined(result.outputs.checks_node_core_nondist_matrix, "non-dist Node matrix"),
    ) as {
      include: { requires_go: boolean }[];
    };
    expect(matrix.include.map((row) => row.requires_go)).toEqual([
      true,
      false,
      true,
      true,
      false,
      true,
      false,
      true,
      true,
      false,
      false,
      false,
      true,
      true,
      true,
      true,
    ]);
  });

  it.each(["grouped", "single-env", "single-no-env"] as const)(
    "packs Node matrix rows and unpacks them in the shard runner (%s)",
    (mode) => {
      const grouped = mode === "grouped";
      const jobEnv = { OPENCLAW_VITEST_MAX_WORKERS: "1" };
      const groups = [
        {
          configs: ["test/vitest/vitest.unit-fast.config.ts"],
          env: undefined,
          fallbackMaxWorkers: 2,
          minTotalMemoryBytes: 28 * 1024 ** 3,
          includePatterns: ["src/a.test.ts", "src/b.test.ts"],
          requiresDist: false,
          runner: "ubuntu-24.04",
          shard_name: "core-unit-fast-1",
          timing_key: "core-unit-fast-1#include-2-abcd",
        },
        {
          configs: ["test/vitest/vitest.infra.config.ts"],
          env: { OPENCLAW_VITEST_MAX_WORKERS: "2" },
          requiresDist: false,
          runner: "ubuntu-24.04",
          shard_name: "core-runtime-infra-misc",
        },
      ];
      const firstGroup = expectDefined(groups[0], "first compact group");
      const singleGroup = {
        configs: firstGroup.configs,
        env:
          mode === "single-no-env"
            ? undefined
            : {
                OPENCLAW_VITEST_MAX_WORKERS: "2",
                OPENCLAW_NODE_TEST_VITEST_ARGS_JSON: '["--shard=1/2"]',
              },
        includePatterns: firstGroup.includePatterns,
        shard_name: "core-unit-fast-1",
      };
      const projectedGroups = grouped
        ? groups.map(
            ({
              configs,
              env,
              fallbackMaxWorkers,
              includePatterns,
              minTotalMemoryBytes,
              shard_name,
              timing_key,
            }) => ({
              configs,
              env,
              fallbackMaxWorkers,
              includePatterns,
              minTotalMemoryBytes,
              shard_name,
              timing_key,
            }),
          )
        : [singleGroup];
      const manifest = runCiManifestFixture({
        bundledPlanner: true,
        nodeTestShards: [
          {
            checkName: "checks-node-compact-small-1",
            ...(grouped
              ? { groups, env: jobEnv }
              : {
                  configs: singleGroup.configs,
                  env: singleGroup.env,
                  includePatterns: singleGroup.includePatterns,
                }),
            requiresDist: false,
            runner: "ubuntu-24.04",
            shardName: grouped ? "compact-small-1" : singleGroup.shard_name,
          },
        ],
      });
      expect(manifest.status, manifest.output).toBe(0);
      const [row] = JSON.parse(
        expectDefined(manifest.outputs.checks_node_core_nondist_matrix, "packed Node matrix"),
      ).include;
      expect(row).toMatchObject({
        check_name: "checks-node-compact-small-1",
        groups_gzip_base64: expect.any(String),
        requires_go: false,
      });
      expect(row).not.toHaveProperty("groups");
      expect(row).not.toHaveProperty("includePatterns");
      expect(row.env).toEqual(grouped ? jobEnv : singleGroup.env);
      const runStep = readCiWorkflow().jobs["checks-node-core-test-nondist-shard"].steps.find(
        (step: WorkflowStep) => step.name === "Run Node test shard",
      );
      const context = {
        eventName: "pull_request" as const,
        matrix: row,
        repository: "openclaw/openclaw",
        runAttempt: 1,
      };
      const packedEnv = evaluateWorkflowExpression(
        runStep.env.OPENCLAW_NODE_TEST_GROUPS_GZIP_BASE64,
        context,
      );
      const legacyEnv = evaluateWorkflowExpression(
        runStep.env.OPENCLAW_NODE_TEST_GROUPS_JSON,
        context,
      );
      expect(legacyEnv).toBe("");
      expect(evaluateWorkflowExpression(runStep.env.OPENCLAW_NODE_TEST_ENV_JSON, context)).toBe(
        JSON.stringify(grouped ? jobEnv : singleGroup.env),
      );
      // Raw fallback uses null for absent overrides; packed groups omit them.
      const normalizeDefaults = (plans: ReturnType<typeof resolveShardPlans>) =>
        plans.map((entry) =>
          entry.kind === "group"
            ? {
                ...entry,
                plan: {
                  ...entry.plan,
                  env: entry.plan.env ?? null,
                  includePatterns: entry.plan.includePatterns ?? null,
                },
              }
            : entry,
        );
      expect(
        normalizeDefaults(
          resolveShardPlans({ OPENCLAW_NODE_TEST_GROUPS_GZIP_BASE64: String(packedEnv) }),
        ),
      ).toEqual(
        normalizeDefaults(
          resolveShardPlans(
            grouped
              ? {
                  OPENCLAW_NODE_TEST_GROUPS_JSON: JSON.stringify(projectedGroups),
                }
              : {
                  OPENCLAW_NODE_TEST_CONFIGS_JSON: JSON.stringify(singleGroup.configs),
                  OPENCLAW_NODE_TEST_ENV_JSON: JSON.stringify(singleGroup.env),
                  OPENCLAW_NODE_TEST_INCLUDE_PATTERNS_JSON: JSON.stringify(
                    singleGroup.includePatterns,
                  ),
                  OPENCLAW_VITEST_SHARD_NAME: singleGroup.shard_name,
                },
          ),
        ),
      );
    },
  );

  it.each([undefined, "changed-manual-inventory"])(
    "packs flat manual Node rows without losing timing identity %s",
    (timingKey) => {
      const configs = ["test/vitest/vitest.unit-fast.config.ts"];
      const env = { OPENCLAW_VITEST_MAX_WORKERS: "2" };
      const includePatterns = Array.from(
        { length: 6_000 },
        (_, index) =>
          `src/infra/manual-inventory/owner-${index}/workflow-contract-process-boundaries.test.ts`,
      );
      const manifest = runCiManifestFixture({
        bundledPlanner: true,
        eventName: "workflow_dispatch",
        historicalCompatibility: false,
        releaseGate: true,
        scopeEnv: { OPENCLAW_CI_WORKFLOW_REVISION: "a".repeat(40) },
        nodeTestShards: [
          {
            checkName: "checks-node-manual-inventory",
            configs,
            env,
            includePatterns,
            requiresDist: false,
            runner: "ubuntu-24.04",
            shardName: "manual-inventory",
            timing_key: timingKey,
            timeoutMinutes: 20,
          },
        ],
      });
      expect(manifest.status, manifest.output).toBe(0);
      expect(manifest.outputChars).toBeLessThan(262_144);
      const rows = JSON.parse(
        expectDefined(manifest.outputs.checks_node_core_nondist_matrix, "manual Node matrix"),
      ).include;
      expect(rows).toHaveLength(1);
      const [row] = rows;
      expect(row).toMatchObject({
        check_name: "checks-node-manual-inventory",
        env,
        runner: "ubuntu-24.04",
        shard_name: "manual-inventory",
        timeout_minutes: 20,
      });
      for (const field of ["groups", "configs", "includePatterns"]) {
        expect(row).not.toHaveProperty(field);
      }
      expect(
        resolveShardPlans({ OPENCLAW_NODE_TEST_GROUPS_GZIP_BASE64: row.groups_gzip_base64 }),
      ).toEqual([
        {
          kind: "group",
          name: "manual-inventory",
          timingKey: timingKey ?? "manual-inventory",
          plan: {
            configs,
            env,
            includePatterns,
            shard_name: "manual-inventory",
            ...(timingKey ? { timing_key: timingKey } : {}),
          },
        },
      ]);
    },
  );

  it.each([
    ...(["github", "hybrid", "blacksmith"] as const).map((runnerProfile) => ({
      label: `${runnerProfile} compact PR`,
      runnerProfile,
      eventName: "pull_request" as const,
      releaseGate: false,
    })),
    {
      label: "full manual",
      runnerProfile: "github" as const,
      eventName: "workflow_dispatch" as const,
      releaseGate: false,
    },
    {
      label: "exact-head PR fallback",
      runnerProfile: "github" as const,
      eventName: "workflow_dispatch" as const,
      releaseGate: true,
    },
  ])(
    "keeps the complete $label manifest output below the safety budget",
    ({ label, runnerProfile, eventName, releaseGate }) => {
      const manifest = runCiManifestFixture({
        bundledPlanner: true,
        historicalCompatibility: false,
        changedPaths: ["src/auto-reply/full-plan.ts"],
        eventName,
        releaseGate,
        scopeEnv: { OPENCLAW_CI_WORKFLOW_REVISION: "a".repeat(40) },
        nodeTestShards: createNodeTestShardBundles({
          compactMode: eventName === "pull_request" ? "pull-request" : undefined,
          includeProofTests: eventName !== "pull_request" && !releaseGate,
          includeReleaseOnlyPluginShards: false,
          runnerBackend: runnerProfile,
        }),
        runnerProfile,
      });
      expect(manifest.status, manifest.output).toBe(0);
      expect(manifest.outputChars, label).toBeLessThan(262_144);
    },
  );

  it("uses projected legacy groups for historical targets without the codec", () => {
    const groups = [
      {
        configs: ["test/vitest/vitest.infra.config.ts"],
        env: { OPENCLAW_CI_TEST_GROUP: "legacy" },
        includePatterns: ["src/legacy.test.ts"],
        requiresDist: false,
        runner: "ubuntu-24.04",
        shard_name: "core-legacy",
        timing_key: "core-legacy#include-1-abcd",
      },
    ];
    const ungrouped = runCiManifestFixture({
      bundledPlanner: true,
      historicalCompatibility: false,
      nodeTestGroupsCodec: false,
      nodeTestShards: [
        {
          checkName: "bundled-node-plan",
          configs: ["test/vitest/vitest.infra.config.ts"],
          env: { OPENCLAW_VITEST_MAX_WORKERS: "2" },
          includePatterns: ["src/legacy.test.ts"],
          requiresDist: false,
          runner: "ubuntu-24.04",
          shardName: "bundled-node-plan",
        },
      ],
    });
    expect(ungrouped.status, ungrouped.output).toBe(0);
    expect(ungrouped.outputs.frozen_target).toBe("true");
    expect(ungrouped.outputs.compatibility_target).toBe("false");
    const rows = JSON.parse(
      expectDefined(ungrouped.outputs.checks_node_core_nondist_matrix, "manual target matrix"),
    ).include;
    expect(rows).toEqual([expect.objectContaining({ check_name: "bundled-node-plan" })]);
    expect(rows[0]).not.toHaveProperty("groups_gzip_base64");
    expect(rows[0].includePatterns).toEqual(["src/legacy.test.ts"]);
    expect(rows[0].env).toEqual({ OPENCLAW_VITEST_MAX_WORKERS: "2" });

    const grouped = runCiManifestFixture({
      bundledPlanner: true,
      historicalCompatibility: true,
      nodeTestGroupsCodec: false,
      nodeTestShards: [
        {
          checkName: "checks-node-compact-small-1",
          groups,
          requiresDist: false,
          runner: "ubuntu-24.04",
          shardName: "compact-small-1",
        },
      ],
    });
    expect(grouped.status, grouped.output).toBe(0);
    const [row] = JSON.parse(
      expectDefined(grouped.outputs.checks_node_core_nondist_matrix, "legacy Node matrix"),
    ).include;
    expect(row).not.toHaveProperty("groups_gzip_base64");
    expect(Object.keys(row.groups[0]).toSorted()).toEqual([
      "configs",
      "env",
      "includePatterns",
      "shard_name",
      "timing_key",
    ]);
    const runStep = readCiWorkflow().jobs["checks-node-core-test-nondist-shard"].steps.find(
      (step: WorkflowStep) => step.name === "Run Node test shard",
    );
    const context = {
      eventName: "workflow_dispatch" as const,
      matrix: row,
      repository: "openclaw/openclaw",
      runAttempt: 1,
    };
    const packedEnv = evaluateWorkflowExpression(
      runStep.env.OPENCLAW_NODE_TEST_GROUPS_GZIP_BASE64,
      context,
    );
    const legacyEnv = evaluateWorkflowExpression(
      runStep.env.OPENCLAW_NODE_TEST_GROUPS_JSON,
      context,
    );
    expect(packedEnv).toBe("");
    expect(
      resolveShardPlans({ OPENCLAW_NODE_TEST_GROUPS_JSON: String(legacyEnv) }).map((plan) =>
        plan.kind === "group" ? plan.plan : plan,
      ),
    ).toEqual(row.groups);
  });

  it("provisions ripgrep for real filesystem contract selections", () => {
    const contract = "src/agents/filesystem-tools-output-contract.test.ts";
    const nativeTools = "src/agents/sessions/tools/index.test.ts";
    const bytePaths = "src/agents/sessions/tools/grep.byte-path.test.ts";
    const unrelated = "src/agents/run-wait.test.ts";
    const selections = [
      { targets: [contract] },
      { includePatterns: [contract] },
      { includePatterns: ["src/agents/filesystem-*.test.ts"] },
      { targets: [nativeTools] },
      { targets: [bytePaths] },
      { includePatterns: [bytePaths] },
      { groups: [{ shard_name: "agentic-agents-support", targets: [bytePaths] }] },
      { groups: [{ shard_name: "agentic-agents-support", includePatterns: [bytePaths] }] },
      { includePatterns: [unrelated] },
      { shardName: "agentic-agents-core-runtime" },
      { shardName: "agentic-agents-support" },
      { shardName: "agentic-agents-core-runtime", includePatterns: [unrelated] },
      { groups: [{ shard_name: "agentic-agents-core-runtime", includePatterns: [contract] }] },
      { groups: [{ shard_name: "agentic-agents-support", includePatterns: [nativeTools] }] },
      { groups: [{ shard_name: "agentic-agents-core-runtime", includePatterns: [unrelated] }] },
      { groups: [{ shard_name: "agentic-agents-core-runtime" }] },
    ];
    const result = runCiManifestFixture({
      bundledPlanner: true,
      nodeTestShards: selections.map((selection, index) =>
        Object.assign(
          {
            checkName: `grep-${index}`,
            configs: ["test/vitest/vitest.agents-core.config.ts"],
            requiresDist: false,
            runner: "ubuntu-24.04",
            shardName: "compact-small-1",
          },
          selection,
        ),
      ),
    });
    expect(result.status, result.output).toBe(0);
    const matrix = JSON.parse(
      expectDefined(result.outputs.checks_node_core_nondist_matrix, "non-dist Node matrix"),
    ) as { include: { requires_ripgrep?: boolean }[] };
    expect(matrix.include.map((row) => Boolean(row.requires_ripgrep))).toEqual([
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      false,
      true,
      true,
      false,
      true,
      true,
      false,
      true,
    ]);
  });

  it("fails a release-deferred CI gate by naming the release run", () => {
    const deferred = runCiGateFixture(renderCiGateEnvironment({}, { preflight: "skipped" }), {
      PREFLIGHT_RESULT: "skipped",
      RELEASE_PRIORITY_RUN: "77",
    });
    expect(deferred.status).toBe(1);
    expect(deferred.stdout).toContain("::error title=Deferred for release 77::");
    expect(deferred.stdout).toContain("pnpm frv prioritize --restore");
    // Without an active release, a skipped preflight is an ordinary gate failure.
    const plain = runCiGateFixture(renderCiGateEnvironment({}, { preflight: "skipped" }), {
      PREFLIGHT_RESULT: "skipped",
      RELEASE_PRIORITY_RUN: "",
    });
    expect(plain.status).toBe(1);
    expect(plain.stdout).not.toContain("Deferred for release");
  });

  it("emits one final CI gate after every selected lane", () => {
    const workflow = readCiWorkflow();
    const gate = workflow.jobs["ci-gate"];
    const requiredJobs = ["preflight", "security-fast"];
    const selectedJobs = [
      "build-artifacts",
      "control-ui-performance",
      "native-i18n",
      "checks-ui",
      "checks-ui-e2e",
      "checks-ui-e2e-real-gateway",
      "control-ui-i18n",
      "checks-baseline-ratchets",
      "checks-fast-core",
      "qa-smoke-ci-profile",
      "checks-fast-plugin-contracts-shard",
      "checks-fast-channel-contracts-shard",
      "checks-node-compat",
      "checks-node-core-test-nondist-shard",
      "check-shard",
      "check-lint-hosted-core-shard",
      "check-lint-hosted-extension-shard",
      "check-test-types-hosted-core-shard",
      "check-additional-shard",
      "check-docs",
      "skills-python",
      "checks-windows",
      "macos-node",
      "macos-swift",
      "ios-build",
      "ios-screenshot-shard",
      "ios-screenshot-evidence",
      "android",
      "docker-seed-e2e",
    ];

    expect(workflow.on.pull_request).not.toHaveProperty("paths-ignore");
    expect(gate.name).toBe("openclaw/ci-gate");
    expect(gate.needs).toEqual([...requiredJobs, ...selectedJobs]);
    // Every workload is gated; the release-only receipt sealer runs after this gate.
    expect(gate.needs.toSorted()).toEqual(
      Object.keys(workflow.jobs)
        .filter((job) => job !== "ci-gate" && job !== "seal_release_child_evidence")
        .toSorted(),
    );
    expect(gate.permissions).toEqual({ contents: "read" });

    const verifyStep = gate.steps.find(
      (step: WorkflowStep) => step.name === "Verify selected CI lanes",
    );
    expect(Object.keys(verifyStep.env)).toEqual([
      "PREFLIGHT_RESULT",
      "RELEASE_PRIORITY_RUN",
      "JOB_RESULTS",
    ]);
    const resultRows: string[] = verifyStep.env.JOB_RESULTS.trim().split("\n");
    expect(resultRows.slice(0, requiredJobs.length)).toEqual(
      requiredJobs.map((job) => `${job}=\${{ needs.${job}.result }}|true`),
    );
    for (const job of selectedJobs) {
      expect(verifyStep.env.JOB_RESULTS).toContain(`${job}=\${{ needs.${job}.result }}|`);
    }
    expect(resultRows).toHaveLength(gate.needs.length);
  });

  it("does not admit the final gate for cancelled workflows or draft pull requests", () => {
    const gate = readCiWorkflow().jobs["ci-gate"];
    for (const eventName of ["pull_request", "push", "workflow_dispatch"] as const) {
      for (const cancelled of [true, false]) {
        for (const draft of [true, false]) {
          expect(
            evaluateWorkflowExpression(gate.if, {
              ciOnPush: "true",
              cancelled,
              draft,
              eventName,
              repository: "openclaw/openclaw",
              runAttempt: 1,
            }),
            JSON.stringify({ cancelled, draft, eventName }),
          ).toBe(!cancelled && (eventName !== "pull_request" || !draft));
        }
      }
    }
  });

  it("ci-gate selection projections match their owning job predicates", () => {
    const workflow = readCiWorkflow();
    const step = workflow.jobs["ci-gate"].steps.find(
      (candidate: WorkflowStep) => candidate.name === "Verify selected CI lanes",
    );
    const rows: string[] = step.env.JOB_RESULTS.trim().split("\n").slice(2);
    for (const row of rows) {
      const match = expectDefined(
        row.match(/^([\w-]+)=\$\{\{ needs\.([\w-]+)\.result \}\}\|\$\{\{ (.+) \}\}$/u),
        row,
      );
      const job = expectDefined(match[1], row);
      const selection = expectDefined(match[3], row);
      expect(match[2], row).toBe(job);
      // Gate inputs duplicate eligibility, never dependency status or cancellation.
      // Bind that projection to its owner so a routing change cannot leave stale selection.
      const eligible = workflow.jobs[job].if
        .replace(/^\$\{\{\s*|\s*\}\}$/gu, "")
        .replace(/!cancelled\(\)\s*&&\s*always\(\)\s*&&\s*/gu, "")
        .replace(
          /!cancelled\(\) && needs\.preflight\.result == 'success' && \(needs\.checks-baseline-ratchets\.result == 'success' \|\| \(needs\.preflight\.outputs\.run_baseline_ratchets == 'false' && needs\.checks-baseline-ratchets\.result == 'skipped'\)\) && /u,
          "",
        )
        .replace(/\s+/gu, " ")
        .trim();
      const projected = /^needs\.preflight\.outputs\.\w+$/u.test(selection)
        ? `${selection} == 'true'`
        : selection;
      expect(projected, job).toBe(eligible);
    }
  });

  it.skipIf(process.platform === "win32").each<{
    label: string;
    context: Partial<Parameters<typeof evaluateWorkflowExpression>[1]>;
    expected: Record<string, boolean>;
  }>([
    {
      label: "same-repo Blacksmith PR",
      context: { eventName: "pull_request" },
      expected: {
        "checks-node-compat": false,
        "ios-build": true,
        "ios-screenshot-shard": false,
      },
    },
    {
      label: "canonical Blacksmith push",
      context: { eventName: "push" },
      expected: {
        "checks-node-compat": false,
        "ios-build": true,
        "ios-screenshot-shard": false,
      },
    },
    {
      label: "GitHub push",
      context: { eventName: "push", runnerProfile: "github" },
      expected: {
        "check-lint-hosted-core-shard": true,
        "check-lint-hosted-extension-shard": false,
        "check-test-types-hosted-core-shard": true,
      },
    },
    {
      label: "hybrid PR",
      context: { eventName: "pull_request", runnerProfile: "hybrid" },
      expected: {
        "check-lint-hosted-core-shard": true,
        "check-lint-hosted-extension-shard": true,
      },
    },
    {
      label: "hybrid release gate keeps its existing lint owner",
      context: { releaseGate: true, runnerProfile: "hybrid" },
      expected: { "check-lint-hosted-extension-shard": false },
    },
    {
      label: "hybrid qualification keeps automatic lint stripes",
      context: {
        releaseGate: true,
        runnerProfile: "hybrid",
        preflightOutputs: { ci_qualification: "true" },
      },
      expected: { "check-lint-hosted-extension-shard": true },
    },
    {
      label: "targeted core test PR",
      context: {
        eventName: "pull_request",
        runnerProfile: "hybrid",
        preflightOutputs: { changed_core_test_paths_json: '["src/commands/doctor.test.ts"]' },
      },
      expected: {
        "check-shard": true,
        "check-additional-shard": true,
        "check-lint-hosted-core-shard": true,
        "check-lint-hosted-extension-shard": true,
        "check-test-types-hosted-core-shard": false,
      },
    },
    {
      label: "Blacksmith has no hosted stripes",
      context: { frozenTarget: true },
      expected: {
        "check-lint-hosted-core-shard": false,
        "check-lint-hosted-extension-shard": false,
        "check-test-types-hosted-core-shard": false,
      },
    },
    {
      label: "frozen target without hosted capability",
      context: { frozenTarget: true, hostedRunnerProfileContract: false, runnerProfile: "github" },
      expected: {
        "check-lint-hosted-core-shard": false,
        "check-lint-hosted-extension-shard": false,
        "check-test-types-hosted-core-shard": false,
      },
    },
    {
      label: "frozen target with hosted capability",
      context: { frozenTarget: true, runnerProfile: "hybrid" },
      expected: {
        "check-lint-hosted-core-shard": true,
        "check-lint-hosted-extension-shard": false,
        "check-test-types-hosted-core-shard": true,
      },
    },
    {
      label: "current target needs no capability fallback",
      context: { hostedRunnerProfileContract: false, runnerProfile: "github" },
      expected: { "check-lint-hosted-core-shard": true },
    },
    {
      label: "hosted checks out of scope",
      context: { runnerProfile: "hybrid", preflightOutputs: { run_check: "false" } },
      expected: {
        "check-shard": false,
        "check-lint-hosted-core-shard": false,
        "check-lint-hosted-extension-shard": false,
        "check-test-types-hosted-core-shard": false,
      },
    },
    {
      label: "compatibility target",
      context: { preflightOutputs: { compatibility_target: "true" } },
      expected: {
        "checks-ui": true,
        "checks-ui-e2e": false,
        "checks-ui-e2e-real-gateway": false,
        "ios-screenshot-shard": false,
      },
    },
    {
      label: "current target",
      context: {},
      expected: {
        "checks-ui-e2e": true,
        "checks-ui-e2e-real-gateway": true,
        "ios-screenshot-shard": true,
        "checks-node-compat": true,
      },
    },
    {
      label: "RunsOn qualification retains PR compatibility scope",
      context: {
        releaseGate: true,
        runnerProfile: "hybrid",
        preflightOutputs: { node_runner_backend: "runson" },
      },
      expected: {
        "checks-node-compat": false,
        "check-lint-hosted-extension-shard": true,
      },
    },
    {
      label: "manual Node 22 without artifacts",
      context: { preflightOutputs: { run_build_artifacts: "false" } },
      expected: { "checks-node-compat": false },
    },
    {
      label: "UI performance without runtime artifact changes",
      context: {
        preflightOutputs: { run_control_ui_performance: "true", run_build_artifacts: "false" },
      },
      expected: { "control-ui-performance": true },
    },
    {
      label: "unrelated runtime build skips UI performance",
      context: {
        preflightOutputs: { run_control_ui_performance: "false", run_build_artifacts: "true" },
      },
      expected: { "control-ui-performance": false },
    },
    {
      label: "UI performance outside build and UI scope",
      context: {
        preflightOutputs: {
          run_control_ui_performance: "false",
          run_build_artifacts: "false",
          run_ui_tests: "false",
        },
      },
      expected: { "control-ui-performance": false },
    },
    {
      label: "ordinary manual screenshot override",
      context: { preflightOutputs: { run_ios_screenshots: "false" } },
      expected: { "ios-screenshot-shard": true },
    },
    {
      label: "release gate without screenshot scope",
      context: { releaseGate: true, preflightOutputs: { run_ios_screenshots: "false" } },
      expected: { "ios-screenshot-shard": false },
    },
    {
      label: "release gate keeps smoke without screenshots",
      context: { releaseGate: true },
      expected: { "ios-build": true, "ios-screenshot-shard": false },
    },
    {
      label: "npm-beta excludes manual screenshots",
      context: { preflightOutputs: { release_scope: "npm-beta" } },
      expected: { "ios-screenshot-shard": false },
    },
    {
      label: "npm-beta excludes PR screenshots",
      context: { eventName: "pull_request", preflightOutputs: { release_scope: "npm-beta" } },
      expected: { "ios-screenshot-shard": false },
    },
    {
      label: "npm-stable excludes manual screenshots",
      context: { preflightOutputs: { release_scope: "npm-stable" } },
      expected: { "ios-screenshot-shard": false },
    },
    {
      label: "npm-stable excludes PR screenshots",
      context: { eventName: "pull_request", preflightOutputs: { release_scope: "npm-stable" } },
      expected: { "ios-screenshot-shard": false },
    },
    {
      label: "PR screenshot scope off",
      context: { eventName: "pull_request", preflightOutputs: { run_ios_screenshots: "false" } },
      expected: { "ios-screenshot-shard": false },
    },
  ])("ci-gate preserves eligibility: $label", ({ context, expected }) => {
    const jobResults = renderCiGateEnvironment(context);
    const selections = Object.fromEntries(
      jobResults
        .trim()
        .split("\n")
        .map((row) => {
          const [job, , selected] = row.split(/[=|]/u);
          return [expectDefined(job, row), expectDefined(selected, row)];
        }),
    );
    for (const [job, selected] of Object.entries(expected)) {
      expect(selections[job], job).toBe(String(selected));
    }
    expect(selections["ios-screenshot-evidence"]).toBe(selections["ios-screenshot-shard"]);
    const results = Object.fromEntries(
      Object.entries(selections).map(([job, selected]) => [
        job,
        selected === "true" ? "success" : "skipped",
      ]),
    );
    const outcome = runCiGateFixture(renderCiGateEnvironment(context, results));
    expect(outcome.status, `${outcome.stdout}\n${outcome.stderr}`).toBe(0);
    if (expected["ios-build"]) {
      for (const terminal of ["failure", "cancelled", "skipped"]) {
        const missingSmoke = runCiGateFixture(
          renderCiGateEnvironment(context, { ...results, "ios-build": terminal }),
        );
        expect(missingSmoke.status, missingSmoke.stdout).toBe(1);
      }
    }
    if (context.preflightOutputs?.changed_core_test_paths_json) {
      for (const terminal of ["failure", "skipped"]) {
        const missingOwner = runCiGateFixture(
          renderCiGateEnvironment(context, { ...results, "check-shard": terminal }),
        );
        expect(missingOwner.status).not.toBe(0);
      }
    }
  });

  it("keeps minimum-Node qualification in full manual CI", () => {
    const workflow = readCiWorkflow();
    const compatibilityJob = workflow.jobs["checks-node-compat"];
    const fullReleaseWorkflow = readWorkflow(".github/workflows/full-release-validation.yml");
    const fullReleaseDispatch = fullReleaseWorkflow.jobs.normal_ci.steps.find(
      (step: WorkflowStep) => step.name === "Dispatch CI",
    );

    expect(compatibilityJob.name).toBe("checks-node-compat-node24");
    for (const eventName of ["push", "pull_request"] as const) {
      expect(
        evaluateWorkflowExpression("${{ " + compatibilityJob.if + " }}", {
          eventName,
          repository: "openclaw/openclaw",
          runAttempt: 1,
          preflightOutputs: { run_build_artifacts: "true" },
        }),
      ).toBe(false);
    }
    expect(fullReleaseDispatch.env.CHILD_WORKFLOW_KIND).toBe("ci");
    expect(fullReleaseDispatch.run).toContain('dispatch_child ci.yml "$dispatch_run_name"');
    expect(fullReleaseDispatch.run).toContain('-f target_ref="$TARGET_SHA"');
    expect(compatibilityJob.steps.at(-1)?.run).toContain(
      "src/config/sessions/session-accessor.test.ts",
    );
    expect(compatibilityJob.steps.at(-1)?.run).toContain(
      "src/config/sessions/store-writer.test.ts",
    );
    expect(compatibilityJob.steps.at(-1)?.run).toContain("src/config/sessions/sessions.test.ts");
  });

  it.skipIf(process.platform === "win32")("ci-gate rejects an unexpected selected skip", () => {
    const result = runCiGateFixture(renderCiGateEnvironment({}, { "checks-ui": "skipped" }));
    expect(result.stdout).toContain("checks-ui: skipped");
    expect(result.status, result.stdout).toBe(1);
  });

  it.skipIf(process.platform === "win32").each([
    [true, "success", 0],
    [true, "skipped", 1],
    [true, "failure", 1],
    [true, "cancelled", 1],
    [true, "", 1],
    [true, "unknown", 1],
    [false, "success", 0],
    [false, "skipped", 0],
    [false, "failure", 1],
    [false, "cancelled", 1],
    [false, "", 1],
    [false, "unknown", 1],
  ] as const)(
    "ci-gate checks all downstream lanes (selected=%s, result=%s)",
    (selected, result, exit) => {
      const workflow = readCiWorkflow();
      const jobs: string[] = workflow.jobs["ci-gate"].needs.slice(2);
      const jobResults = renderCiGateEnvironment(
        {
          eventName: selected ? "workflow_dispatch" : "pull_request",
          runnerProfile: "hybrid",
          preflightOutputs: Object.fromEntries(
            Object.keys(workflow.jobs.preflight.outputs)
              .filter((key) => key.startsWith("run_"))
              .map((key) => [key, String(selected)]),
          ),
        },
        Object.fromEntries(jobs.map((job) => [job, result])),
      );
      const outcome = runCiGateFixture(jobResults);
      expect(outcome.status, `${outcome.stdout}\n${outcome.stderr}`).toBe(exit);
      for (const job of jobs) {
        expect(jobResults).toContain(`${job}=${result}|${selected}\n`);
        expect(outcome.stdout).toContain(`${job}: ${result} (selected=${selected})`);
        if (exit !== 0) {
          expect(outcome.stdout).toContain(`${job} finished with ${result} (selected=${selected})`);
        }
      }
    },
  );

  it
    .skipIf(process.platform === "win32")
    .each(["failure", "cancelled", "skipped", "", "unknown", "success="])(
    "ci-gate rejects required result %s independently of downstream success",
    (result) => {
      const outcome = runCiGateFixture(
        renderCiGateEnvironment({}, { preflight: result, "security-fast": result }),
      );
      expect(outcome.status, outcome.stdout).toBe(1);
      for (const job of ["preflight", "security-fast"]) {
        expect(outcome.stdout).toContain(`${job} finished with ${result} (selected=true)`);
      }
    },
  );

  it
    .skipIf(process.platform === "win32")
    .each(["", "unknown", "TRUE", "true|false", "true|", "false="])(
    "ci-gate rejects missing or malformed selection %s even after success",
    (selection) => {
      const outcome = runCiGateFixture(
        renderCiGateEnvironment({ preflightOutputs: { run_ui_tests: selection } }),
      );
      expect(outcome.status, outcome.stdout).toBe(1);
      expect(outcome.stdout).toContain(
        `checks-ui finished with success (selected=${selection || "missing"})`,
      );
    },
  );

  it.skipIf(process.platform === "win32")(
    "ci-gate reports failed upstream and selected dependent skips",
    () => {
      const jobResults = renderCiGateEnvironment(
        {},
        {
          "ios-screenshot-shard": "failure",
          "ios-screenshot-evidence": "skipped",
        },
      );
      const outcome = runCiGateFixture(jobResults);
      expect(outcome.status, outcome.stdout).toBe(1);
      expect(outcome.stdout).toContain(
        "ios-screenshot-shard finished with failure (selected=true)",
      );
      expect(outcome.stdout).toContain(
        "ios-screenshot-evidence finished with skipped (selected=true)",
      );
    },
  );

  it("keeps workflow guards in fast CI-routing checks", () => {
    const workflow = readCiWorkflow();
    const preflightStep = workflow.jobs.preflight.steps.find(
      (step: WorkflowStep) => step.name === "Build CI manifest",
    );
    const taxonomy = parse(readFileSync("taxonomy.yaml", "utf8")) as {
      surfaces: Array<{ id: string; categories: Array<{ id: string }> }>;
    };
    const taxonomyCategoryIds = taxonomy.surfaces.flatMap((surface) =>
      surface.categories.map((category) => `${surface.id}.${category.id}`),
    );
    const fastCoreJob = workflow.jobs["checks-fast-core"];
    const runStep = fastCoreJob.steps.find(
      (step: WorkflowStep) => step.name === "Run ${{ matrix.task }} (${{ matrix.runtime }})",
    );
    const smokeProfileJob = workflow.jobs["qa-smoke-ci-profile"];
    const smokeBuildStep = smokeProfileJob.steps.find(
      (step: WorkflowStep) => step.name === "Build QA smoke runtime",
    );
    const smokeDockerCacheStep = smokeProfileJob.steps.find(
      (step: WorkflowStep) => step.name === "Set up Blacksmith Docker layer cache",
    );
    const smokeRunStep = smokeProfileJob.steps.find(
      (step: WorkflowStep) => step.name === "Run smoke profile part",
    );
    const smokeUploadStep = smokeProfileJob.steps.find(
      (step: WorkflowStep) => step.name === "Upload QA smoke profile evidence",
    );

    const ciWorkflowText = readFileSync(".github/workflows/ci.yml", "utf8");

    expect(preflightStep.run).not.toContain("qa-smoke-profile");
    expect(preflightStep.run).not.toContain("qa_category");
    expect(taxonomyCategoryIds.length).toBeGreaterThan(0);
    for (const categoryId of taxonomyCategoryIds) {
      expect(ciWorkflowText).not.toContain(`"${categoryId}"`);
    }
    expect(runStep.run).toContain("bundled-protocol)");
    expect(runStep.run).not.toContain("qa-smoke-ci)");
    expect(runStep.run).toContain("contracts-plugins-ci-routing)");
    expect(runStep.run).toContain("ci-routing)");
    expect(fastCoreJob["runs-on"]).toContain("matrix.runner");
    expect(smokeProfileJob.name).toBe("QA Smoke CI (${{ matrix.name }})");
    // Leak invariant: dist must never be packed after the private overlay
    // build. Today that holds vacuously — the smoke set has no docker-lane
    // scenario, so the step performs exactly one private build and no pack;
    // the run step fails closed if a docker-lane scenario returns.
    expect(smokeBuildStep.run).toContain("OPENCLAW_BUILD_PRIVATE_QA=1 pnpm build qaRuntime");
    expect(smokeBuildStep.run.match(/pnpm build qaRuntime/g)).toHaveLength(1);
    expect(smokeBuildStep.run).not.toContain("package-openclaw-for-docker");
    expect(smokeBuildStep.run).not.toContain("npm pack");
    expect(smokeBuildStep.env).not.toHaveProperty("OPENCLAW_BUILD_PRIVATE_QA");
    const smokePlanRunStep = smokeProfileJob.steps.find(
      (step: WorkflowStep) => step.name === "Run smoke profile part",
    );
    expect(smokePlanRunStep.run).toContain("restore the public pack step in ci.yml");
    expect(smokePlanRunStep.run).not.toContain("OPENCLAW_CURRENT_PACKAGE_TGZ");
    expect(workflow.jobs["qa-smoke-ci-artifacts"]).toBeUndefined();
    expect(workflow.jobs["qa-smoke-ci"]).toBeUndefined();
    expect(smokeProfileJob.needs).toEqual(["preflight"]);
    expect(smokeProfileJob.strategy["max-parallel"]).toBe(
      "${{ (needs.preflight.outputs.runner_profile == 'github' || needs.preflight.outputs.runner_profile == 'hybrid') && 6 || 4 }}",
    );
    expect(smokeProfileJob.strategy.matrix).toBe(
      "${{ fromJson(needs.preflight.outputs.qa_smoke_ci_matrix) }}",
    );
    for (const [label, options, partCount] of [
      ["Blacksmith push", { runnerBackend: "blacksmith" }, 4],
      ["GitHub push", { runnerBackend: "github" }, 6],
      ["hybrid push", { runnerBackend: "hybrid" }, 4],
      ["hybrid PR", { runnerBackend: "hybrid", eventName: "pull_request" }, 4],
      ["hybrid retry", { runnerBackend: "hybrid", scopeEnv: { GITHUB_RUN_ATTEMPT: "2" } }, 6],
      ["missing attempt", { runnerBackend: "hybrid", scopeEnv: { GITHUB_RUN_ATTEMPT: "" } }, 6],
      ["other repository", { runnerBackend: "hybrid", repository: "example/openclaw" }, 6],
      [
        "current hybrid dispatch",
        {
          runnerBackend: "hybrid",
          eventName: "workflow_dispatch",
          scopeEnv: { OPENCLAW_CI_CHECKOUT_REVISION: "b".repeat(40) },
        },
        6,
      ],
      [
        "frozen hybrid dispatch",
        { runnerBackend: "hybrid", eventName: "workflow_dispatch", historicalCompatibility: true },
        6,
      ],
      [
        "frozen Blacksmith dispatch",
        {
          runnerBackend: "blacksmith",
          eventName: "workflow_dispatch",
          historicalCompatibility: true,
        },
        4,
      ],
    ] as const) {
      const manifest = runCiManifestFixture({
        bundledPlanner: true,
        changedPaths: [".github/workflows/ci.yml"],
        eventName: "push",
        historicalCompatibility: false,
        ...options,
      });
      expect(manifest.status, `${label}: ${manifest.output}`).toBe(0);
      const matrix = JSON.parse(
        expectDefined(manifest.outputs.qa_smoke_ci_matrix, `${label} QA smoke matrix`),
      );
      expect(matrix.include, label).toEqual(
        Array.from({ length: partCount }, (_, index) => ({
          name: `profile ${index + 1}/${partCount}`,
          lane: `profile-${index + 1}`,
          slug: `profile-${index + 1}-of-${partCount}`,
          part_count: partCount,
        })),
      );
    }
    for (const [runnerBackend, expected] of [
      ["blacksmith", 4],
      ["github", 6],
      ["hybrid", 6],
    ] as const) {
      expect(
        evaluateWorkflowExpression(smokeProfileJob.strategy["max-parallel"], {
          eventName: "push",
          repository: "openclaw/openclaw",
          runnerBackend,
          runAttempt: 1,
        }),
      ).toBe(expected);
    }
    expect(smokeProfileJob["runs-on"]).toContain("blacksmith-16vcpu-ubuntu-2404");
    expect(smokeDockerCacheStep).toBeUndefined();
    expect(smokeRunStep.run).toContain("createQaSmokeCiPart");
    expect(smokeRunStep.run).toContain("createQaSmokeCiPart(partId, partCount)");
    expect(smokeRunStep.env.PROFILE_PART_COUNT).toBe("${{ matrix.part_count }}");
    expect(smokeRunStep.run).toContain("createQaSmokeCiMatrix");
    expect(smokeRunStep.run).toContain("readQaScenarioPack");
    expect(smokeRunStep.run).toContain("isolate each scenario");
    expect(smokeRunStep.run).toContain("scenario_ids: [scenarioId]");
    expect(smokeRunStep.run).not.toContain("scenarioIdsByKind");
    const compatibilityScenarioBlock = smokeRunStep.run.match(
      /const compatibilityScenarioIds = new Set\(\[([\s\S]*?)\]\);/u,
    )?.[1];
    expect(compatibilityScenarioBlock?.match(/^\s+"[^"]+",$/gmu)).toHaveLength(10);
    expect(compatibilityScenarioBlock).not.toContain('"dreaming-shadow-trial-report"');
    expect(compatibilityScenarioBlock).not.toContain('"control-ui-chat-flow-playwright"');
    expect(compatibilityScenarioBlock).toContain('"gateway-smoke"');
    expect(compatibilityScenarioBlock).toContain('"matrix-restart-resume"');
    expect(smokeRunStep.run).toContain(
      "console.error(`[skip] ${partId} is not declared by this checkout's smoke plan`)",
    );
    expect(smokeRunStep.run).not.toContain(
      "console.log(`[skip] ${partId} is not declared by this checkout's smoke plan`)",
    );
    expect(smokeRunStep.run).toContain("No QA smoke runs assigned");
    expect(smokeRunStep.run).toContain("node openclaw.mjs qa run");
    expect(smokeRunStep.run).not.toContain("pnpm openclaw qa run");
    expect(smokeRunStep.run).toContain(
      "timeout --signal=TERM --kill-after=15s 10m node openclaw.mjs qa run",
    );
    expect(smokeRunStep.run).toContain("--qa-profile smoke-ci");
    expect(smokeRunStep.run).toContain("--concurrency 10");
    expect(smokeRunStep.env.OPENCLAW_QA_SUITE_WORKER_START_STAGGER_MS).toBe(
      "${{ needs.preflight.outputs.runner_profile == 'blacksmith' && '0' || '1500' }}",
    );
    expect(smokeRunStep.env.OPENCLAW_QA_SUITE_WORKER_START_STAGGER_MS).toContain("'0'");
    expect(smokeRunStep.env.OPENCLAW_QA_SUITE_WORKER_START_STAGGER_MS).toContain("'1500'");
    expect(smokeRunStep.run).toContain('scenario_args+=(--scenario "$scenario_id")');
    expect(smokeRunStep.run).toContain('done <<< "$PROFILE_RUNS_TSV"');
    expect(smokeRunStep.run).not.toContain('pids+=("$!")');
    expect(smokeRunStep.run).not.toContain('wait "${pids[$index]}"');
    expect(smokeRunStep.run).not.toContain("--category");
    expect(smokeRunStep.run).not.toContain("--allow-failures");
    expect(smokeRunStep.run).toContain("qa_exit_code=0");
    expect(smokeRunStep.run).toContain('exit "$qa_exit_code"');
    expect(smokeRunStep.run).toContain("--max-old-space-size=16384");
    expect(smokeRunStep.run).not.toContain("scripts/build-all.mts qaRuntime");
    expect(smokeRunStep.run).not.toContain("OPENAI_API_KEY");
    expect(smokeUploadStep.if).toBe("always()");
    expect(smokeUploadStep.with).toMatchObject({
      path: ".artifacts/qa-e2e/smoke-ci-profile-${{ matrix.slug }}/",
      "if-no-files-found": "warn",
    });
    expect(runStep.run.match(/src\/scripts\/ci-changed-scope\*\.test\.ts/g)).toHaveLength(2);
    for (const owner of ["guards", "planning", "evidence"]) {
      expect(runStep.run.split(`test/scripts/ci-workflow-${owner}.test.ts`)).toHaveLength(3);
    }
    expect(runStep.run.match(/test\/scripts\/ci-changed-node-test-plan\.test\.ts/g)?.length).toBe(
      2,
    );
  });
});
