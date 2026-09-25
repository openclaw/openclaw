import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expectDefined } from "@openclaw/normalization-core";
import type { createChangedCiLintPlan } from "../../scripts/check-changed.mts";
import { SOURCE_CHANNEL_TEST_POLICY } from "../../scripts/lib/ci-node-test-plan.mts";
import { startupCorpusTestFiles } from "../vitest/vitest.startup-corpus-paths.mjs";
import {
  evaluateWorkflowExpression,
  quoteShell,
  readCiWorkflow,
  readWorkflowOutputs,
  runWorkflowShellScript,
  type WorkflowStep,
  writeExecutable,
} from "./ci-workflow.test-support.js";

export function runCiManifestFixture(options: {
  bundledPlanner: boolean;
  sourceChannelPolicy?: boolean;
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
  checkFamilyScope?: boolean;
  ciLintPlan?: Awaited<ReturnType<typeof createChangedCiLintPlan>>;
  ciTypeGraphNames?: string[];
  changedCoreTestSupport?: boolean;
  repository?: string;
  eventName?: "pull_request" | "push" | "workflow_dispatch" | "schedule";
  historicalCompatibility?: boolean;
  iosCapabilities?: boolean;
  iosBuildCapability?: boolean;
  androidCiCapabilities?: boolean;
  androidAccessNativeCapability?: boolean;
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
    if (options.sourceChannelPolicy ?? true) {
      appendFileSync(
        path.join(scriptsDir, "ci-node-test-plan.mts"),
        `\nexport const SOURCE_CHANNEL_TEST_POLICY = ${JSON.stringify(SOURCE_CHANNEL_TEST_POLICY)};\n`,
      );
    }
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
    if (options.checkFamilyScope) {
      copyFileSync("scripts/ci-check-plan.mts", path.join(root, "scripts/ci-check-plan.mts"));
      for (const file of [
        "ci-check-family-scope.mts",
        "changed-path-facts.mjs",
        "direct-run.mjs",
        "failed-trailer.mts",
        "record-shared.mjs",
        "tsgo-core-test-shards.mts",
      ]) {
        copyFileSync(path.join("scripts/lib", file), path.join(scriptsDir, file));
      }
      writeFileSync(
        path.join(root, "scripts/check-changed.mts"),
        `export const createChangedCiLintPlan = () => (${JSON.stringify(options.ciLintPlan ?? null)});\n`,
      );
      if (!options.changedCoreTestSupport) {
        writeFileSync(
          path.join(root, "scripts/changed-lanes.mts"),
          "export const detectChangedLanes = (paths) => ({ paths });\n",
        );
      }
      // Substitute the native compiler inventory, retaining canonical graph selection
      // and stripe placement. Native inspection has its own owner-boundary proof.
      writeFileSync(
        path.join(root, "scripts/run-tsgo-core-test-shards.mts"),
        `
        // ${options.changedCoreTestSupport ? "--changed-paths-json" : "no changed-path capability"}
        import { TSGO_CI_GRAPHS, selectChangedCiTsgoGraphs } from "./lib/tsgo-core-test-shards.mts";
        const selectedNames = ${JSON.stringify(options.ciTypeGraphNames ?? ["core", "core-test-agents-root", "core-test-gateway-root", "scripts", "test-root"])};
        export async function createChangedCiTypeCheckPlan(paths) {
          const inventory = TSGO_CI_GRAPHS.map((graph) => ({ ...graph,
            files: selectedNames.includes(graph.name) ? paths : [],
          }));
          const selected = selectChangedCiTsgoGraphs(paths, inventory);
          return { mode: selected ? "changed" : "full", graphs: selected ?? TSGO_CI_GRAPHS };
        }
      `,
      );
      for (const file of options.changedPaths ?? []) {
        const target = path.join(root, file);
        if (!existsSync(target)) {
          mkdirSync(path.dirname(target), { recursive: true });
          writeFileSync(target, "export {};\n");
        }
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
    if (options.androidAccessNativeCapability ?? options.bundledPlanner) {
      const nativeTest = path.join(
        root,
        "apps/android/app/src/androidTest/java/ai/openclaw/app/gateway/CloudflareAccessNativeTest.kt",
      );
      mkdirSync(path.dirname(nativeTest), { recursive: true });
      writeFileSync(
        nativeTest,
        "package ai.openclaw.app.gateway\n\nclass CloudflareAccessNativeTest\n",
      );
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
          checkPlanOutputs: {} as Record<string, string>,
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
    const checkPlanOutputs: Record<string, string> = {};
    let checkPlanRun: ReturnType<typeof runWorkflowShellScript> | undefined;
    if (run.status === 0 && outputs.run_check_plan === "true") {
      const checkPlanStep = expectDefined(
        readCiWorkflow().jobs["check-plan"].steps.find((step: WorkflowStep) => step.id === "plan"),
        "dependency-equipped check planner",
      );
      const checkPlanOutputPath = path.join(root, "check-plan.out");
      writeFileSync(checkPlanOutputPath, "");
      const context: Parameters<typeof evaluateWorkflowExpression>[1] = {
        eventName: options.eventName ?? "workflow_dispatch",
        repository: options.repository ?? "openclaw/openclaw",
        runAttempt: 1,
        preflightOutputs: outputs,
      };
      const plannerEnv = Object.fromEntries(
        Object.entries(checkPlanStep.env ?? {}).map(([key, value]) => [
          key,
          String(evaluateWorkflowExpression(value, context)),
        ]),
      );
      checkPlanRun = runWorkflowShellScript(checkPlanStep.run, {
        cwd: root,
        env: { ...process.env, ...plannerEnv, GITHUB_OUTPUT: checkPlanOutputPath },
      });
      Object.assign(checkPlanOutputs, readWorkflowOutputs(checkPlanOutputPath));
    }
    return {
      output: `${run.stdout}${run.stderr}${checkPlanRun?.stdout ?? ""}${checkPlanRun?.stderr ?? ""}`,
      outputChars: readFileSync(outputPath, "utf8").length,
      outputs,
      checkPlanOutputs,
      status: checkPlanRun ? checkPlanRun.status : run.status,
      summary: readFileSync(summaryPath, "utf8"),
    };
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}
