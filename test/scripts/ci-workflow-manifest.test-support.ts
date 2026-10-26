import {
  appendFileSync,
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
import { uiE2eRealGatewayTestFiles } from "../vitest/vitest.ui-paths.mjs";
import {
  evaluateWorkflowExpression,
  quoteShell,
  readCiWorkflow,
  readWorkflowOutputs,
  runWorkflowShellScript,
  type WorkflowStep,
  writeExecutable,
} from "./ci-workflow.test-support.js";

export const CI_MANIFEST_FIXTURE_TARGETS = {
  ui: ["ui/src/fixture-1.test.ts", "ui/src/fixture-2.test.ts", "ui/src/fixture-3.test.ts"],
  mocked: Array.from({ length: 12 }, (_, index) => `ui/src/e2e/fixture-${index + 1}.e2e.test.ts`),
  real: uiE2eRealGatewayTestFiles.slice(0, 2),
  browser: ["extensions/browser/chrome-extension/bootstrap.chromium.test.ts"],
  windows: Array.from({ length: 5 }, (_, index) => `test/windows-part-${index + 1}.test.ts`),
};

// Shared by both generated planners so their rows have the same defaults.
const nodeRowSource = `
  const nodeRow = (name, fields = {}) => ({
    checkName: name, requiresDist: false,
    runner: "ubuntu-24.04", shardName: name, ...fields,
  });
  const runsonRow = () => nodeRow("changed-runson-cron", {
    checkName: "checks-node-changed-runson-cron",
    groups: [{
      configs: ["test/vitest/vitest.cron.config.ts"],
      includePatterns: ["src/cron/schedule.test.ts"],
      env: { OPENCLAW_VITEST_MAX_WORKERS: "2" },
      shard_name: "core-runtime-cron-parallel-core",
    }],
    env: { OPENCLAW_VITEST_MAX_WORKERS: "2" },
    runner: "runson-c8i-8xlarge",
  });
`;

export function runCiManifestFixture(options: {
  bundledPlanner: boolean;
  sourceChannelPolicy?: boolean;
  nodeTestShards?: Record<string, unknown>[];
  nodeTestGroupsCodec?: boolean;
  bunTestRuntime?: boolean;
  nativeBunInspection?: {
    report: {
      staleEntries: string[];
      changedInputs: { file: string; reason: "changed" | "unreadable" }[];
    };
    failure?: "inspect" | "summary";
  };
  bunUiTestRuntime?: boolean | "requires-ftl-flag";
  startupCorpusCoverage?: boolean;
  startupCorpusSelection?: boolean;
  releaseFastLaneSelection?: boolean;
  changedPlannerSource?: string | null;
  selectedTestTargets?: string[];
  targetSelector?: boolean;
  changedPlannerDependencies?: string[];
  dockerSeedPlannerSource?: string;
  publishedDriverUpdateCapability?: boolean;
  changedPaths?: string[] | null;
  checkFamilyScope?: boolean;
  ciLintPlan?: Awaited<ReturnType<typeof createChangedCiLintPlan>>;
  ciTypeGraphNames?: string[];
  ciTypeBoundaryFailure?: boolean;
  changedCoreTestSupport?: boolean;
  repository?: string;
  eventName?: "pull_request" | "push" | "workflow_dispatch" | "schedule";
  historicalCompatibility?: boolean;
  iosCapabilities?: boolean;
  iosBuildCapability?: boolean;
  androidCiCapabilities?: boolean;
  androidAccessNativeCapability?: boolean;
  nativeI18nCapabilities?: boolean;
  macosNodeParts?: boolean | 2;
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
  targetFiles?: string[];
  missingTargetFiles?: string[];
  uiE2eProjectsCapability?: boolean;
  uiReleaseTier?: boolean;
  uiTestGroupsSource?: string;
  uiE2eSelectorSource?: string;
  uiRealGatewayShards?: boolean;
  remoteTagRefs?: Record<string, string>;
  scopeEnv?: Record<string, string>;
}) {
  const root = mkdtempSync(path.join(tmpdir(), "openclaw-ci-manifest-"));
  try {
    const scriptsDir = path.join(root, "scripts", "lib");
    const writeFixture = (file: string, content: string | Buffer = "export {};\n") => {
      const target = path.join(root, file);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, content);
    };
    const copyFixture = (file: string, source = file) => writeFixture(file, readFileSync(source));
    const copyFixtures = (files: string[], prefix = "") =>
      files.forEach((file) => copyFixture(`${prefix}${file}`));
    const writeFixtures = (files: Iterable<string>, content?: string) => {
      for (const file of files) {
        writeFixture(file, content);
      }
    };
    const writeScript = (name: string, source: string | Buffer) =>
      writeFixture(`scripts/lib/${name}`, source);
    const appendPlanner = (source: string, name = "ci-node-test-plan.mts") =>
      appendFileSync(path.join(scriptsDir, name), source);
    const reexport = (names: string, file: string) =>
      `export { ${names} } from ${JSON.stringify(pathToFileURL(path.resolve(file)).href)};\n`;
    mkdirSync(scriptsDir, { recursive: true });
    const selectedTargetFiles = new Set(options.targetFiles ?? []);
    if (!options.nodeTestShards) {
      selectedTargetFiles.add(
        options.bundledPlanner
          ? options.runnerBackend === "runson"
            ? "test/vitest/vitest.cron.config.ts"
            : "test/vitest/bundled.config.ts"
          : "test/vitest/legacy.config.ts",
      );
    }
    const collectSelectedTargetFiles = (plan: Record<string, unknown>) => {
      const configs = plan.configs;
      if (Array.isArray(configs)) {
        for (const config of configs) {
          if (typeof config === "string") {
            selectedTargetFiles.add(config);
          }
        }
      }
      const groups = plan.groups;
      if (Array.isArray(groups)) {
        for (const group of groups) {
          if (group && typeof group === "object") {
            collectSelectedTargetFiles(group as Record<string, unknown>);
          }
        }
      }
    };
    for (const shard of options.nodeTestShards ?? []) {
      collectSelectedTargetFiles(shard);
    }
    for (const missing of options.missingTargetFiles ?? []) {
      selectedTargetFiles.delete(missing);
    }
    writeFixtures(selectedTargetFiles);
    if (options.bunTestRuntime) {
      const inspection = options.nativeBunInspection;
      writeScript(
        "ci-test-runtime.mts",
        `export { resolveCiTestRuntimePolicy } from ${JSON.stringify(pathToFileURL(path.resolve("scripts/lib/ci-test-runtime.mts")).href)};
        ${options.bunUiTestRuntime ? `import { ciTestShardRequiresBun as currentRuntime } from ${JSON.stringify(pathToFileURL(path.resolve("scripts/lib/ci-test-runtime.mts")).href)};` : ""}
        export const ciTestShardRequiresBun = (shard, policy) =>
          policy !== "node" && (shard.configs?.includes("fixture-bun.config.ts") ||
            ${options.bunUiTestRuntime === "requires-ftl-flag" ? 'shard.env?.BUN_JSC_useFTLJIT === "false" &&' : ""}
            ${options.bunUiTestRuntime ? `currentRuntime(shard, policy, ${JSON.stringify(process.cwd())})` : "false"});
        ${
          inspection
            ? `import { appendFileSync, mkdirSync, renameSync } from "node:fs";
               export function inspectNativeBunQualifications() {
                 appendFileSync(${JSON.stringify(path.join(root, "native-bun-inspections.log"))}, "called\\n");
                 ${inspection.failure === "inspect" ? 'throw new Error("fixture inspection unavailable");' : ""}
                 ${
                   inspection.failure === "summary"
                     ? `renameSync(process.env.GITHUB_STEP_SUMMARY, process.env.GITHUB_STEP_SUMMARY + ".before-native-report");
                        mkdirSync(process.env.GITHUB_STEP_SUMMARY);`
                     : ""
                 }
                 return ${JSON.stringify(inspection.report)};
               }`
            : ""
        }`,
      );
    }
    copyFixtures(options.changedPlannerDependencies ?? []);
    // The manifest packs grouped Node rows through the target's codec and the
    // shard runner unpacks them; targets that predate the codec omit it.
    if (options.nodeTestGroupsCodec ?? true) {
      copyFixture("scripts/lib/ci-node-test-groups-codec.mts");
    }
    const legacyPlanSource = `${nodeRowSource}
          export const createNodeTestShards = () => [nodeRow("legacy-node-plan", {
            configs: ["test/vitest/legacy.config.ts"],
          })];`;
    writeScript(
      "ci-node-test-plan.mts",
      options.nodeTestShards
        ? `export const createNodeTestShards = () => ${JSON.stringify(options.nodeTestShards)};
           export const createNodeTestShardBundles = createNodeTestShards;`
        : options.bundledPlanner
          ? `
          ${legacyPlanSource}
          export const createNodeTestShardBundles = (options = {}) => {
            console.log("node-test-plan-options:" + JSON.stringify(options));
            const runson = options.runnerBackend === "runson";
            const row = runson ? runsonRow() : nodeRow("bundled-node-plan", {
              configs: ["test/vitest/bundled.config.ts"], includePatterns: options.changedPaths,
            });
            return [{ ...row, env: {
                ...row.env,
                OPENCLAW_CI_TEST_COMPACT_MODE: options.compactMode ?? "full",
                OPENCLAW_CI_TEST_COMPACT_NODE_JOB_CAP: String(options.compactNodeJobCap ?? ""),
                OPENCLAW_CI_TEST_RUNNER_BACKEND: options.runnerBackend ?? "",
                OPENCLAW_CI_TEST_PROOF_TIER: String(options.includeProofTests),
              }}];
          };
        `
          : legacyPlanSource,
    );
    if (options.sourceChannelPolicy ?? true) {
      appendPlanner(
        `\nexport const SOURCE_CHANNEL_TEST_POLICY = ${JSON.stringify(SOURCE_CHANNEL_TEST_POLICY)};\n`,
      );
    }
    if (options.windowsPlanner ?? options.bundledPlanner) {
      writeScript(
        "ci-windows-test-plan.mts",
        `\nexport const createWindowsTestShards = () => Array.from({ length: 5 }, (_, index) => ({
          check_name: "checks-windows-node-test-" + (index + 1),
          targets: ["test/windows-part-" + (index + 1) + ".test.ts"],
          predicted_seconds: 400,
        }));\n`,
      );
    }
    if (options.uiReleaseTier || options.bundledPlanner) {
      const uiTargets = [
        ...new Set([
          ...CI_MANIFEST_FIXTURE_TARGETS.ui,
          ...(options.changedPaths ?? []).filter(
            (file) =>
              file.startsWith("ui/") && file.endsWith(".test.ts") && !file.endsWith(".e2e.test.ts"),
          ),
        ]),
      ];
      const e2eTargets = [
        ...CI_MANIFEST_FIXTURE_TARGETS.mocked,
        ...CI_MANIFEST_FIXTURE_TARGETS.real,
      ];
      copyFixture("test/vitest/vitest.ui-paths.mjs");
      appendPlanner(
        options.uiTestGroupsSource ??
          `\nexport const createUiTestShardGroups = (options) => ({
          ui: [{configs: ["ui/vitest.config.ts"], shard_name: "ui", includePatterns: ${JSON.stringify(uiTargets)}, env: {fixtureTier: JSON.stringify(options)}}],
          e2e: [{configs: ["test/vitest/vitest.ui-e2e.config.ts"], shard_name: "e2e", includePatterns: options.uiE2eFiles ? [...options.uiE2eFiles, ...${JSON.stringify(CI_MANIFEST_FIXTURE_TARGETS.real)}] : ${JSON.stringify(e2eTargets)}, env: {fixtureTier: JSON.stringify(options)}}],
        });\n`,
      );
      if (options.uiE2eSelectorSource) {
        appendPlanner(options.uiE2eSelectorSource);
      }
      if (options.uiRealGatewayShards !== false) {
        appendPlanner(
          `\nexport const createUiRealGatewayTestShards = (groups) => [1, 2].map((shard) => ({
            shard,
            shard_count: 2,
            run_desktop: shard === 1,
            groups: groups.map((group) => ({
              ...group,
              configs: ["test/vitest/vitest.ui-e2e-prebuilt.config.ts"],
              shard_name: "real-gateway-" + shard,
              includePatterns: group.includePatterns.filter((file) => file === ${JSON.stringify(CI_MANIFEST_FIXTURE_TARGETS.real)}[shard - 1]),
            })).filter((group) => group.includePatterns.length > 0),
          }));\n`,
        );
      }
    }
    for (const [enabled, name] of [
      [options.toolingOwnerSelection, "isToolingTestOwnerPath"],
      [options.startupCorpusCoverage, "hasCompleteStartupCorpusCoverage"],
      [
        options.startupCorpusSelection ?? options.startupCorpusCoverage,
        "resolveStartupCorpusTestFiles",
      ],
    ] as const) {
      if (enabled) {
        appendPlanner(`\n${reexport(name, "scripts/lib/ci-node-test-plan.mts")}`);
      }
    }
    if (options.startupCorpusSelection ?? options.startupCorpusCoverage) {
      writeFixtures(startupCorpusTestFiles);
    }
    if (options.changedCoreTestSupport) {
      copyFixtures([
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
      ]);
    }
    if (options.checkFamilyScope) {
      copyFixture("scripts/ci-check-plan.mts");
      writeScript(
        "ci-check-family-scope.mts",
        reexport("resolveCiCheckFamilyScope", "scripts/lib/ci-check-family-scope.mts"),
      );
      copyFixtures(
        [
          "changed-path-facts.mjs",
          "direct-run.mjs",
          "failed-trailer.mts",
          "record-shared.mjs",
          "tsgo-core-test-shards.mts",
        ],
        "scripts/lib/",
      );
      writeFixture(
        "scripts/check-changed.mts",
        `export const createChangedCiLintPlan = () => (${JSON.stringify(options.ciLintPlan ?? null)});\nexport { createChangedCheckPlan } from ${JSON.stringify(pathToFileURL(path.resolve("scripts/check-changed.mts")).href)};\n`,
      );
      if (!options.changedCoreTestSupport) {
        writeFixture(
          "scripts/changed-lanes.mts",
          reexport("detectChangedLanes", "scripts/changed-lanes.mts"),
        );
      }
      // Substitute the native compiler inventory, retaining canonical graph selection
      // and stripe placement. Native inspection has its own owner-boundary proof.
      writeFixture(
        "scripts/run-tsgo-core-test-shards.mts",
        `
        // ${options.changedCoreTestSupport ? "--changed-paths-json" : "no changed-path capability"}
        import { TSGO_CI_GRAPHS, expandTsgoExecutionGraphs, selectChangedCiTsgoGraphs } from "./lib/tsgo-core-test-shards.mts";
        const selectedNames = ${JSON.stringify(options.ciTypeGraphNames ?? ["core", "core-test-agents-root", "core-test-gateway-root", "scripts", "test-root-tooling"])};
        export async function createChangedCiTypeCheckPlan(paths) {
          const inventory = expandTsgoExecutionGraphs(TSGO_CI_GRAPHS).map((graph) => ({ ...graph,
            files: selectedNames.includes(graph.name) ? paths : [],
          }));
          const selected = selectChangedCiTsgoGraphs(paths, inventory);
          return { mode: selected ? "changed" : "full", graphs: selected ?? TSGO_CI_GRAPHS };
        }
      `,
      );
      writeFixture(
        "scripts/check-tsgo-core-boundary.mts",
        `export async function checkCoreTsgoGraphBoundary() {
          console.log("fixture: core compiler boundary checked");
          if (${options.ciTypeBoundaryFailure === true}) {
            throw new Error("fixture: core compiler graph includes a bundled extension");
          }
          return [];
        }\n`,
      );
      for (const file of options.changedPaths ?? []) {
        const target = path.join(root, file);
        if (!existsSync(target)) {
          writeFixture(file);
        }
      }
    }
    const iosCapabilities = options.iosCapabilities ?? options.bundledPlanner;
    const iosBuildCapability = options.iosBuildCapability ?? iosCapabilities;
    const nativeI18nCapabilities = options.nativeI18nCapabilities ?? options.bundledPlanner;
    const macosNodeParts = options.macosNodeParts ?? options.bundledPlanner;
    const scriptNames = [
      ...(nativeI18nCapabilities
        ? ["android:i18n:check", "apple:i18n:check", "native:i18n:check"]
        : []),
      ...(iosBuildCapability ? ["ios:build"] : []),
      ...(macosNodeParts
        ? (macosNodeParts === 2 ? [1, 2] : [1, 2, 3]).map((part) => `test:macos:ci:${part}`)
        : []),
      "check:assertion-safety",
      "check:max-lines-ratchet",
      "check:test-timeout-race-ratchet",
      "check:test-mock-exports",
    ];
    const packageScripts = options.bundledPlanner
      ? Object.fromEntries(scriptNames.map((name) => [name, "true"]))
      : {};
    writeFixture(
      "package.json",
      `${JSON.stringify({ version: options.packageVersion, scripts: packageScripts })}\n`,
    );
    if (options.bundledPlanner && options.changedPlannerSource !== null) {
      writeScript(
        "ci-changed-node-test-plan.mts",
        options.changedPlannerSource ??
          `
          ${nodeRowSource}
          export { hasQaSmokeAffectingChange } from ${JSON.stringify(pathToFileURL(path.resolve("scripts/lib/ci-qa-smoke-scope.mts")).href)};
          export { isCiDocumentationPath } from ${JSON.stringify(pathToFileURL(path.resolve("scripts/ci-changed-scope.mjs")).href)};
          export const createChangedNodeTestShards = (changedPaths, options = {}) => {
            console.log("changed-node-plan-options:" + JSON.stringify(options));
            if (options.releaseFastLane && changedPaths.includes("scripts/lib/ci-node-test-plan.mts")) {
              options.onFallback("stub owner selection");
            }
            const selectedRows = ${JSON.stringify(options.nodeTestShards ?? null)};
            if (selectedRows) return selectedRows;
            if (options.runnerBackend === "runson") return [runsonRow()];
            if (changedPaths.includes("src/focused.ts") ||
                changedPaths.includes("scripts/openclaw-release-ready.mjs") ||
                changedPaths.includes("test/scripts/sqlite-sessions-transcripts-flip-proof.built-cli.e2e.test.ts")) {
              return [nodeRow("changed-node-plan", {
                configs: [],
                targets: changedPaths.includes("src/focused.ts")
                  ? ["src/focused.test.ts"]
                  : changedPaths.includes("scripts/openclaw-release-ready.mjs")
                    ? ["test/scripts/openclaw-release-ready.test.ts"]
                    : ["test/scripts/sqlite-sessions-transcripts-flip-proof.built-cli.e2e.test.ts"],
              })];
            }
            const rows = [nodeRow("changed-owner-plan", {
              configs: ["test/vitest/owner.config.ts"],
              includePatterns: changedPaths.includes("src/audit/message-delivery-progress-store.test.ts")
                ? ["src/audit/message-delivery-progress-store.test.ts"]
                : changedPaths.length ? ["src/owner.test.ts"] : ["src/smoke.test.ts"],
            })];
            if (changedPaths.some((changedPath) => changedPath.startsWith("extensions/"))) {
              rows.push(nodeRow("changed-extension-owner-plan", {
                predictedSeconds: 120,
                ...(changedPaths.some((changedPath) => changedPath.startsWith("extensions/matrix/"))
                  ? {
                    configs: ["test/vitest/vitest.extension-matrix.config.ts"],
                    includePatterns: [
                      "extensions/matrix/src/client.test.ts",
                      "extensions/matrix/src/monitor.test.ts",
                    ],
                  }
                : {
                    configs: [],
                    targets: ["extensions/codex/src/focused.test.ts"],
                  }),
              }));
            }
            return rows;
          };
          export const hasBuildArtifactAffectingChange = (changedPaths) =>
            !changedPaths.includes("test/scripts/sqlite-sessions-transcripts-flip-proof.built-cli.e2e.test.ts");
          export const hasSqliteSessionLifecycleAffectingChange = (changedPaths) =>
            changedPaths.includes("src/sqlite-session-owner.ts") ||
            changedPaths.includes("test/scripts/sqlite-sessions-transcripts-flip-proof.built-cli.e2e.test.ts");
        `,
      );
    }
    if (
      options.bundledPlanner &&
      options.changedPlannerSource !== null &&
      options.targetSelector !== false
    ) {
      appendPlanner(
        `
        export const resolveChangedNodeTestTargets = (changedPaths) => {
          const selected = ${JSON.stringify(options.selectedTestTargets ?? null)};
          if (selected) return selected;
          const rows = ${JSON.stringify(options.nodeTestShards ?? [])};
          const declared = rows.flatMap((row) => [
            ...(row.targets ?? []), ...(row.includePatterns ?? []),
            ...(row.groups ?? []).flatMap((group) => group.includePatterns ?? []),
          ]);
          return [...new Set(["src/owner.test.ts", ...declared, ...changedPaths.filter((file) => file.endsWith(".test.ts"))])];
        };
      `,
        "ci-changed-node-test-plan.mts",
      );
    }
    if (options.releaseFastLaneSelection) {
      appendPlanner(
        `\n${reexport("resolveReleaseFastLaneScope", "scripts/ci-changed-scope.mjs")}`,
        "ci-changed-node-test-plan.mts",
      );
    }
    if (options.bundledPlanner) {
      writeScript(
        "ci-docker-seed-plan.mts",
        options.dockerSeedPlannerSource ??
          reexport(
            "resolveDockerSeedLanes, resolveChangedDockerSeedLanes",
            "scripts/lib/ci-docker-seed-plan.mts",
          ),
      );
      copyFixture("scripts/lib/ci-published-driver-update-plan.mts");
      writeFixture("test/scripts/sqlite-sessions-transcripts-flip-proof.built-cli.e2e.test.ts");
      for (const [kind, name, directory] of [
        ["channel", "Channel", "channels/plugins"],
        ["plugin", "Plugin", "plugins"],
      ]) {
        writeScript(
          `${kind}-contract-test-plan.mts`,
          `export const create${name}ContractTestShards = () => ["a", "b"].map((suffix) => ({
            checkName: "${kind}-contracts-" + suffix,
            includePatterns: ["src/${directory}/contracts/fixture-" + suffix + ".test.ts"],
            runtime: "node", task: "contracts-${kind}s",
          }));\n`,
        );
      }
    }
    if (options.qaSmokePlan ?? options.bundledPlanner) {
      writeFixture("extensions/qa-lab/src/ci-smoke-plan.ts");
    }
    if (iosCapabilities) {
      writeFixtures(
        ["install-swift-tools.sh", "install-xcodegen.sh", "lint-swift.sh", "format-swift.sh"].map(
          (name) => `scripts/${name}`,
        ),
        "#!/bin/sh\n",
      );
    }
    if (options.protocolCoverage ?? options.bundledPlanner) {
      writeFixture("scripts/check-protocol-event-coverage.mjs", "");
    }
    if (options.androidAccessNativeCapability ?? options.bundledPlanner) {
      writeFixture(
        "apps/android/app/src/androidTest/java/ai/openclaw/app/gateway/CloudflareAccessNativeTest.kt",
        "package ai.openclaw.app.gateway\n\nclass CloudflareAccessNativeTest\n",
      );
    }
    writeFixture(
      ".github/workflows/ci.yml",
      [
        [options.formatCheck, "pnpm format:check\npnpm format:check"],
        [options.androidCiCapabilities, "android-ci-contract-v2"],
        [options.openClawKitTests, "openclawkit-tests-contract-v1"],
        [options.bundledPlanner, "docker-seed-e2e-contract-v1"],
        [options.publishedDriverUpdateCapability, "published-driver-update-contract-v1"],
        [options.targetHostedRunnerProfileContract, "hosted-runner-profile-contract-v1"],
      ]
        .filter(([enabled]) => enabled ?? options.bundledPlanner)
        .map(([, marker]) => marker)
        .join("\n"),
    );
    writeFixture(
      "test/vitest/vitest.ui-e2e.config.ts",
      (options.uiE2eProjectsCapability ?? options.bundledPlanner)
        ? "// ui-e2e-projects-contract-v1\n"
        : 'export default { test: { name: "ui-e2e" } };\n',
    );
    const outputPath = path.join(root, "manifest.out");
    const summaryPath = path.join(root, "summary.md");
    const gitOwner = ".github/actions/git-owner";
    for (const name of ["test-prerequisites.mjs", "test-prerequisites.json"]) {
      copyFixture(`.ci-harness/${gitOwner}/${name}`, `${gitOwner}/${name}`);
    }
    writeFixture(
      ".ci-harness/scripts/ci-build-manifest.mjs",
      readFileSync(new URL("../../scripts/ci-build-manifest.mjs", import.meta.url)),
    );
    for (const name of ["release-context.mjs", "release-version.mjs", "ci-ios-smoke-plan.mjs"]) {
      copyFixture(`.ci-harness/scripts/lib/${name}`, `scripts/lib/${name}`);
    }
    copyFixture(
      ".ci-harness/scripts/lib/ci-node-test-plan.mts",
      path.join(scriptsDir, "ci-node-test-plan.mts"),
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
          manifestStdout: "",
          manifestStderr: "",
          nativeBunInspectionCalls: 0,
          outputs: {} as Record<string, string>,
          checkPlanOutputs: {} as Record<string, string>,
          status: correction.status,
          summary: "",
        };
      }
      correctionBaseSha = readWorkflowOutputs(correctionOutput).sha ?? "";
    }
    if (options.historicalReader) {
      writeFixture("src/audit/message-delivery-progress-store.test.ts");
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
          (options.historicalCompatibility ?? !options.releaseGate) &&
          (options.eventName ?? "workflow_dispatch") === "workflow_dispatch"
            ? "true"
            : "false",
        OPENCLAW_CI_RELEASE_FAST_LANE_LABEL: "false",
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
        OPENCLAW_CI_HEAD_REPOSITORY: options.repository ?? "openclaw/openclaw",
        OPENCLAW_CI_RUNNER_BACKEND: options.runnerBackend ?? options.runnerProfile ?? "",
        OPENCLAW_CI_RUNNER_PROFILE: options.runnerProfile ?? options.runnerBackend ?? "blacksmith",
        OPENCLAW_CI_NODE_RUNNER_BACKEND: options.nodeRunnerBackend ?? "",
        OPENCLAW_CI_TEST_RUNTIME_POLICY: "",
        OPENCLAW_CI_RUN_SKILLS_PYTHON: "true",
        OPENCLAW_CI_RUN_WINDOWS: "true",
        OPENCLAW_CI_WORKFLOW_REVISION: "b".repeat(40),
        ...options.scopeEnv,
      },
    });
    const outputs = readWorkflowOutputs(outputPath);
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
      manifestStdout: run.stdout,
      manifestStderr: run.stderr,
      nativeBunInspectionCalls: existsSync(path.join(root, "native-bun-inspections.log"))
        ? readFileSync(path.join(root, "native-bun-inspections.log"), "utf8").trim().split("\n")
            .length
        : 0,
      outputChars: readFileSync(outputPath, "utf8").length,
      outputs,
      checkPlanOutputs,
      status: checkPlanRun ? checkPlanRun.status : run.status,
      summary: readFileSync(
        existsSync(summaryPath + ".before-native-report")
          ? summaryPath + ".before-native-report"
          : summaryPath,
        "utf8",
      ),
    };
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}
