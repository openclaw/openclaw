// Test Projects tests cover test projects script behavior.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assert, beforeAll, describe, expect, it, vi } from "vitest";
import { listExtensionTestFilesForRoots } from "../../scripts/lib/extension-test-plan.mts";
import { readTestSelectorSourceFacts } from "../../scripts/lib/test-selector-source-facts.mts";
import {
  listVitestRuntimeConsumerFiles,
  resolveVitestPretestBuildMode,
  resolveVitestRuntimeConfigScopes,
} from "../../scripts/lib/vitest-build-prerequisites.mts";
import { resolveDefaultVitestNoOutputTimeoutMs } from "../../scripts/lib/vitest-process-env.mts";
import { resolveVitestRuntimeCliSelections } from "../../scripts/lib/vitest-runtime-selection.mts";
import { resolveShardTimingKey } from "../../scripts/lib/vitest-shard-metadata.mts";
import {
  applyDefaultMultiSpecVitestCachePaths,
  applyDefaultVitestNoOutputTimeout,
  applyFullExtensionsHeapBudget,
  applyParallelVitestCachePaths,
  buildFullSuiteVitestRunPlans,
  buildVitestRunPlans,
  createVitestRunSpecs,
  findUnmatchedExplicitTestTargets,
  formatFailedShardDigest,
  formatNoChangedTestTargetLines,
  isTestFileTarget,
  orderFullSuiteSpecsForParallelRun,
  parseTestProjectsArgs,
  resolveChangedTestTargetPlanForArgs,
  resolveChangedTestTargetPlan,
  resolveChangedTargetArgs,
  resolveControlUiTestConsumers,
  resolveParallelFullSuiteConcurrency,
  shouldRetryVitestNoOutputTimeout,
  withRetryNoOutputTimeout,
  writeVitestIncludeFile,
} from "../../scripts/test-projects.test-support.mts";
import { withEnv } from "../../src/test-utils/env.js";
import { toRepoPath } from "../../src/test-utils/repo-files.js";
import { agentVitestProjectOwners } from "../vitest/vitest.agents-paths.mjs";
import { databaseWorkerCoreTestFiles } from "../vitest/vitest.database-worker-core-paths.mjs";
import { databaseWorkerExtensionTestFiles } from "../vitest/vitest.extension-database-workers-paths.mjs";
import { gatewayDatabaseWorkerTestFiles } from "../vitest/vitest.gateway-server-paths.mjs";
import {
  startupCorpusTestFiles,
  stateStartupCorpusTestFiles,
} from "../vitest/vitest.startup-corpus-paths.mjs";

const normalizeRepoPath = toRepoPath;
const CODEX_TEST_PROCESS_FILE_LIMIT = 24;
const MATRIX_TEST_PROCESS_FILE_LIMIT = 40;
const TELEGRAM_TEST_PROCESS_FILE_LIMIT = 10;

describe("Windows CI partitions", () => {
  it("keeps explicit coverage disjoint without repeating small project setup", () => {
    const { scripts } = JSON.parse(fs.readFileSync("package.json", "utf8")) as {
      scripts: Record<string, string>;
    };
    const [first, second] = [1, 2].map((part) => {
      const command = scripts[`test:windows:ci:${part}`];
      assert(command);
      const entrypoint = "scripts/test-projects.mts ";
      expect(command).toContain(entrypoint);
      const targets = command.slice(command.indexOf(entrypoint) + entrypoint.length).split(/\s+/u);
      expect(targets.every((target) => isTestFileTarget(target))).toBe(true);
      expect(findUnmatchedExplicitTestTargets(targets)).toEqual([]);
      return {
        targets,
        configs: new Set(createVitestRunSpecs(targets, { baseEnv: {} }).map((spec) => spec.config)),
      };
    });
    assert(first && second);
    const targets = [...first.targets, ...second.targets];
    expect(new Set(targets).size).toBe(targets.length);
    // Tooling owns the long compiler fixtures; the extension catch-all retains
    // separate plugin processes. The other projects share setup within one part.
    expect([...first.configs].filter((config) => second.configs.has(config))).toEqual([
      "test/vitest/vitest.tooling.config.ts",
      "test/vitest/vitest.extensions.config.ts",
    ]);
  });
});

describe("test runtime prerequisites", () => {
  it.each([
    ["lifecycle file", ["extensions/qa-lab/src/suite-process-lifecycle.test.ts"], "private-qa"],
    ["QA directory", ["extensions/qa-lab"], "private-qa"],
    ["tooling config", ["test/vitest/vitest.tooling.config.ts"], "private-qa"],
    [
      "Codex history Worker",
      ["extensions/codex/src/app-server/session-history.test.ts"],
      "runtime",
    ],
    [
      "sticker provider runtime",
      ["extensions/telegram/src/sticker-cache.selection.test.ts"],
      "runtime",
    ],
    ["Telegram polling runtime", ["extensions/telegram/src/polling-session.test.ts"], "runtime"],
    ["Telegram config", ["test/vitest/vitest.extension-telegram.config.ts"], "runtime"],
    ["ordinary Telegram test", ["extensions/telegram/src/sequential-key.test.ts"], undefined],
    ["all plugins", ["extensions"], "private-qa"],
    ["full local suite", [], "private-qa"],
    ["ACP CLI process", ["src/cli/acp-cli-exit.process.test.ts"], "runtime"],
    ["update CLI process", ["src/cli/update-dry-run-state.process.test.ts"], "runtime"],
    ["migrated update process", ["src/cli/update-cli/update-command-migrated.test.ts"], "runtime"],
    ["update rollback", ["src/cli/update-cli/update-command-rollback.test.ts"], "runtime"],
    [
      "update recovery",
      ["src/cli/update-cli/update-command-post-update-recovery.test.ts"],
      "runtime",
    ],
    ["update repair", ["src/cli/update-cli/update-command-post-update-repair.test.ts"], "runtime"],
    [
      "update service recovery",
      ["src/cli/update-cli/update-command-service.integration.test.ts"],
      "runtime",
    ],
    [
      "candidate Gateway canary",
      ["src/infra/update-candidate-canary.integration.test.ts"],
      "runtime",
    ],
    ["infra config", ["test/vitest/vitest.infra.config.ts"], "runtime"],
    ["native SDK generation", ["src/plugins/plugin-module-generation.sdk.test.ts"], "runtime"],
    ["config startup SDK", ["src/config/config-startup-corpus.test.ts"], "runtime"],
    ...stateStartupCorpusTestFiles.map((file) => [file, [file], "runtime"] as const),
    ["runtime config project", ["test/vitest/vitest.runtime-config.config.ts"], "runtime"],
    [
      "context engine sandbox SDK",
      ["src/agents/runtime-plugins.context-engine.integration.test.ts"],
      "runtime",
    ],
    ["native direct loader SDK", ["src/plugins/loader.test.ts"], "runtime"],
    ["native setup registry SDK", ["src/plugins/setup-registry.migrations.test.ts"], "runtime"],
    ["native source checkout SDK", ["src/plugins/source-checkout-runtime.test.ts"], "runtime"],
    ["native provider contract SDK", ["extensions/deepinfra/provider.contract.test.ts"], "runtime"],
    [
      "native workspace Memory and Skills workers",
      ["extensions/file-transfer/src/workspace-service.test.ts"],
      "runtime",
    ],
    ["native catalog auth SDK", ["test/openai-model-discovery-auth-order.test.ts"], "runtime"],
    ["models.list native catalog", ["test/plugins/codex-model-catalog.gateway.test.ts"], "runtime"],
    [
      "Gateway TLS source fixture",
      ["test/e2e/qa-lab/runtime/gateway-tls-pinning.test.ts"],
      undefined,
    ],
    ["native package setup SDK", ["test/plugin-npm-runtime-build.test.ts"], "runtime"],
    ["native Linux node SDK", ["src/node-host/linux-node-plugin.integration.test.ts"], "runtime"],
    ["native memory CLI SDK", ["src/entry.memory-json.test.ts"], "runtime"],
    ["ordinary entry unit", ["src/entry.run-main.test.ts"], undefined],
    [
      "native catalog worker SDK",
      ["src/agents/prepared-model-catalog-worker.integration.test.ts"],
      "runtime",
    ],
    [
      "native catalog worker capture custody",
      ["src/agents/prepared-model-catalog-worker.custody.integration.test.ts"],
      "runtime",
    ],
    [
      "native Google Meet SDK",
      ["extensions/google-meet/src/transports/chrome-startup.test.ts"],
      "runtime",
    ],
    [
      "native channel directory config SDK",
      ["src/channels/plugins/contracts/directory.registry-backed-shard-b.contract.test.ts"],
      "runtime",
    ],
    [
      "native channel directory session SDK",
      ["src/channels/plugins/contracts/directory.registry-backed-shard-d.contract.test.ts"],
      "runtime",
    ],
    [
      "native channel surfaces session SDK",
      ["src/channels/plugins/contracts/surfaces-only.registry-backed-shard-d.contract.test.ts"],
      "runtime",
    ],
    [
      "native channel shape SDK",
      ["src/channels/plugins/contracts/plugin-shape.contract.test.ts"],
      "private-qa",
    ],
    [
      "native SDK companion lifecycle",
      ["src/plugin-sdk/channel-entry-contract.lifecycle.test.ts"],
      "runtime",
    ],
    [
      "native completion transport SDK",
      ["src/agents/simple-completion-runtime.plugin-scope.test.ts"],
      "runtime",
    ],
    ["agent core config", ["test/vitest/vitest.agents-core.config.ts"], "runtime"],
    ["agent umbrella config", ["test/vitest/vitest.agents.config.ts"], "runtime"],
    ["ordinary completion unit", ["src/agents/simple-completion-runtime.test.ts"], undefined],
    [
      "direct completion fixture without SDK imports",
      ["src/plugins/runtime/runtime-llm.prepared-owner.test.ts"],
      undefined,
    ],
    ["native inspection fixture", ["src/plugins/status.runtime-inspection.test.ts"], undefined],
    ["source module generation", ["src/plugins/plugin-module-generation.test.ts"], undefined],
    ["native module interop", ["src/plugins/plugin-module-generation.interop.test.ts"], undefined],
    ["plugins config", ["test/vitest/vitest.plugins.config.ts"], "runtime"],
    ["ordinary update unit test", ["src/infra/update-candidate-canary.test.ts"], undefined],
    ["CLI directory", ["src/cli"], "runtime"],
    ["CLI config", ["test/vitest/vitest.cli.config.ts"], undefined],
    ["ordinary CLI unit test", ["src/cli/command-path-policy.test.ts"], undefined],
    ["Doctor CLI processes", ["src/commands/doctor-config-preflight.process.test.ts"], "runtime"],
    [
      "Doctor repair rollback",
      ["src/commands/doctor-config-preflight.v17-atomicity.process.test.ts"],
      "runtime",
    ],
    [
      "Doctor retired plugin config",
      ["src/commands/doctor-plugin-install-config.process.test.ts"],
      "runtime",
    ],
    ["commands directory", ["src/commands"], "runtime"],
    ["commands config", ["test/vitest/vitest.commands.config.ts"], "runtime"],
    ["ordinary Doctor unit test", ["src/commands/doctor-config-preflight.test.ts"], undefined],
    [
      "Doctor source module probe",
      ["src/commands/doctor-config-preflight.pristine.process.test.ts"],
      undefined,
    ],
    ["concurrent Gateway streams", ["src/gateway/gateway-concurrent-streams.test.ts"], "runtime"],
    ["Gateway sidecar lifecycle", ["src/gateway/server-sidecar-retention.test.ts"], "runtime"],
    [
      "Windows cron process identity",
      ["src/gateway/gateway-cron-process-identity.windows.test.ts"],
      "runtime",
    ],
    ["real Gateway config edits", ["src/gateway/server.config-patch.test.ts"], "runtime"],
    [
      "first device sign-in verification",
      ["src/gateway/setup-inference.first-signin.integration.test.ts"],
      "runtime",
    ],
    ["Gateway directory", ["src/gateway"], "runtime"],
    ["local command first request", ["src/agents/agent-command-local.test.ts"], "runtime"],
    ["ordinary Gateway unit test", ["src/gateway/net.test.ts"], undefined],
    ["ordinary Gateway server test", ["src/gateway/server-request-context.test.ts"], undefined],
    ["ordinary QA unit test", ["extensions/qa-lab/src/gateway-child.test.ts"], undefined],
    [
      "model reader",
      ["src/agents/embedded-agent-runner/model-resolution-consistency.test.ts"],
      undefined,
    ],
  ] as const)("prepares only the prerequisite selected by %s", (_name, args, expected) => {
    const plans = args.length ? buildVitestRunPlans([...args]) : buildFullSuiteVitestRunPlans([]);
    expect(
      resolveVitestPretestBuildMode(
        plans.map((plan) => ({
          configs: [plan.config],
          includePatterns: plan.includePatterns,
        })),
      ),
    ).toBe(expected);
  });

  it.each([
    "test/vitest/vitest.gateway-server.config.ts",
    "test/vitest/vitest.gateway.config.ts",
    "test/vitest/vitest.full-agentic.config.ts",
  ])("prepares direct lifecycle selection under %s", (config) => {
    for (const [file, expected] of [
      ["src/gateway/server-sidecar-retention.test.ts", "runtime"],
      ["src/gateway/server-request-context.test.ts", undefined],
    ] as const) {
      const selections = resolveVitestRuntimeCliSelections(config, ["run", file], {});
      expect(resolveVitestPretestBuildMode(selections), file).toBe(expected);
    }
  });

  const catalogFile = "test/plugins/codex-model-catalog.gateway.test.ts";
  const freshnessFile = "src/gateway/server-methods/models-list.freshness.integration.test.ts";
  const scopedFreshnessFile = "**/models-list.freshness.integration.test.ts";
  it.each([
    ["gateway-database-workers", [], "runtime"],
    ["gateway-database-workers", [freshnessFile], "runtime"],
    ["gateway-database-workers", ["models-list.freshness.integration"], "runtime"],
    ["gateway-database-workers", [freshnessFile, "--exclude", scopedFreshnessFile], undefined],
    ["gateway-database-workers", [catalogFile], "runtime"],
    ["gateway-methods", [catalogFile], undefined],
    ["gateway-methods", [freshnessFile], undefined],
    ["gateway-methods", ["--exclude", catalogFile], undefined],
    ["gateway", [catalogFile], "runtime"],
    ["gateway", [freshnessFile], "runtime"],
    ["gateway", [freshnessFile, "--exclude", scopedFreshnessFile], undefined],
    ["full-agentic", [freshnessFile, "--exclude", scopedFreshnessFile], undefined],
    ["gateway", [catalogFile, "--exclude", catalogFile], undefined],
  ] as const)("binds %s runtime prerequisites to their owner for %s", (project, args, expected) => {
    const selections = resolveVitestRuntimeCliSelections(
      `test/vitest/vitest.${project}.config.ts`,
      ["run", ...args],
      {},
    );
    expect(resolveVitestPretestBuildMode(selections)).toBe(expected);
  });

  it.each([
    "src/gateway/setup-inference.first-signin.integration.test.ts",
    "src/gateway/server-methods/models-list.freshness.integration.test.ts",
    "test/plugins/codex-model-catalog.gateway.test.ts",
    "src/gateway/server-methods/models-list.worker-recovery.integration.test.ts",
    "src/gateway/gateway-auth-recovery.test.ts",
    "src/gateway/gateway-cron-process-identity.windows.test.ts",
    "src/gateway/gateway-route-model-reuse.test.ts",
    "src/gateway/gateway-ssh-upload-signal.test.ts",
  ])("keeps Gateway worker runtime selection rooted at the repository for %s", (file) => {
    const config = "test/vitest/vitest.gateway-database-workers.config.ts";
    expect(listVitestRuntimeConsumerFiles([config])).toContain(file);
    expect(
      listVitestRuntimeConsumerFiles(["test/vitest/vitest.gateway-methods.config.ts"]),
    ).not.toContain(file);
    expect(
      resolveVitestPretestBuildMode(resolveVitestRuntimeCliSelections(config, ["run", file], {})),
    ).toBe("runtime");
    expect(
      resolveVitestPretestBuildMode(
        resolveVitestRuntimeCliSelections(config, ["run", file, "--exclude", file], {}),
      ),
    ).toBeUndefined();
  });

  it.each([
    ["bundled", ["src/plugins/loader.test.ts"], undefined],
    ["unit-fast", ["src/plugins/*.test.ts"], undefined],
    ["contracts-channel-config", ["src/channels/plugins/contracts/**"], undefined],
    ["contracts-channel-session", ["src/channels/plugins/contracts/**"], undefined],
    ["contracts-channel-registry", ["src/channels/plugins/contracts/**"], undefined],
    ["unit", ["src/node-host/**"], undefined],
    ["unit-src", ["src/node-host/**"], undefined],
    ["unit", ["src/entry.memory-json.test.ts"], "runtime"],
    ["unit-src", ["src/entry.memory-json.test.ts"], "runtime"],
    ["extensions", ["deepinfra/**"], "runtime"],
    ["extensions", ["deepinfra/**", "google-meet/**"], "runtime"],
    ["extensions", ["deepinfra/**", "google-meet/**", "file-transfer/**"], undefined],
    ["tooling", ["test/**"], undefined],
    ["plugins", ["plugin-module-generation.sdk.test.ts"], undefined],
    ["runtime-config", ["config/config-startup-corpus.test.ts"], "runtime"],
    ...stateStartupCorpusTestFiles.map(
      (file) => ["runtime-config", [file.slice("src/".length)], "runtime"] as const,
    ),
    ["runtime-config", startupCorpusTestFiles.map((file) => file.slice("src/".length)), "runtime"],
    [
      "runtime-config",
      [
        ...startupCorpusTestFiles.map((file) => file.slice("src/".length)),
        "config/sessions/session-accessor.sqlite-reclamation-memory.test.ts",
      ],
      undefined,
    ],
    ["agents-core", ["simple-completion-runtime.plugin-scope.test.ts"], "runtime"],
    ["agents", ["simple-completion-runtime.plugin-scope.test.ts"], "runtime"],
    ...(["agents-core", "agents"] as const).map(
      (project) =>
        [
          project,
          resolveVitestRuntimeConfigScopes(`test/vitest/vitest.${project}.config.ts`).map(
            ({ file, dir }) => path.posix.relative(dir, file),
          ),
          undefined,
        ] as const,
    ),
    ["gateway-core", ["gateway-*.test.ts"], undefined],
    ["gateway-server", ["server-sidecar-retention.test.ts"], "runtime"],
    ["gateway-server", ["server.config-patch.test.ts"], "runtime"],
    [
      "gateway-server",
      ["server-sidecar-retention.test.ts", "server.config-patch.test.ts"],
      undefined,
    ],
    ["gateway", ["gateway-*.test.ts"], "runtime"],
    ["gateway", ["server*.test.ts"], "runtime"],
    ["tooling", ["**/gateway-codex-delivery-cache.test.ts"], "runtime"],
    [
      "extension-telegram",
      ["**/polling-session.test.ts", "**/sticker-cache.selection.test.ts"],
      undefined,
    ],
    [
      "extension-codex-app-server-support",
      [
        "**/event-projector.verbose-hooks.test.ts",
        "**/session-history.test.ts",
        "**/settled-turn-finalizer.native.test.ts",
        "**/transcript-mirror*.test.ts",
      ],
      undefined,
    ],
  ] as const)("keeps %s selection scoped after excluding %s", (project, exclude, expected) => {
    const selections = resolveVitestRuntimeCliSelections(
      `test/vitest/vitest.${project}.config.ts`,
      ["run", ...exclude.flatMap((pattern) => ["--exclude", pattern])],
      {},
    );
    expect(resolveVitestPretestBuildMode(selections)).toBe(expected);
  });

  it.each([
    [
      "gateway-server",
      "src/gateway/server-request-context.test.ts",
      "src/gateway/server-sidecar-retention.test.ts",
    ],
    ["gateway-database-workers", "src/gateway/server-methods/cron.runs.test.ts", freshnessFile],
    ["gateway-database-workers", "src/gateway/server-methods/models.test.ts", catalogFile],
    ["gateway", "src/gateway/server-request-context.test.ts", freshnessFile],
  ])("projects invocation-owned include files under %s", (project, ordinaryFile, runtimeFile) => {
    const selections = resolveVitestRuntimeCliSelections(
      `test/vitest/vitest.${project}.config.ts`,
      ["run"],
      {},
    );
    for (const selection of selections) {
      selection.includePatterns = [ordinaryFile];
    }
    expect(resolveVitestPretestBuildMode(selections)).toBeUndefined();
    for (const selection of selections) {
      selection.includePatterns = [runtimeFile];
    }
    expect(resolveVitestPretestBuildMode(selections)).toBe("runtime");
  });

  it("combines private QA and runtime readers into one private build", () => {
    expect(
      resolveVitestPretestBuildMode([
        { includePatterns: ["test/e2e/qa-lab/runtime/**/*.test.ts"] },
        { includePatterns: ["extensions/qa-lab/**/*.test.ts"] },
      ]),
    ).toBe("private-qa");
    expect(resolveVitestPretestBuildMode([])).toBeUndefined();
    expect(resolveVitestPretestBuildMode([{ configs: ["test/vitest/vitest.config.ts"] }])).toBe(
      "private-qa",
    );
  });
});

function listOrdinaryExtensionFiles(root: string) {
  return listExtensionTestFilesForRoots([root]).filter(
    (file) => !databaseWorkerExtensionTestFiles.includes(file),
  );
}

function expectedTelegramTestProcessCount() {
  const testFileCount = listOrdinaryExtensionFiles("extensions/telegram").length;
  return Math.max(1, Math.ceil(testFileCount / TELEGRAM_TEST_PROCESS_FILE_LIMIT));
}

function withTinyGitRepo(files: Record<string, string>, test: (cwd: string) => void): void {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-test-projects-"));
  try {
    for (const [file, source] of Object.entries(files)) {
      const absolute = path.join(cwd, file);
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(absolute, source);
    }
    const init = spawnSync("git", ["init"], { cwd, stdio: "ignore" });
    expect(init.status).toBe(0);
    const add = spawnSync("git", ["add", "."], { cwd, stdio: "ignore" });
    expect(add.status).toBe(0);
    test(cwd);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

function withTinyFileTree(files: Record<string, string>, test: (cwd: string) => void): void {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-test-projects-"));
  try {
    for (const [file, source] of Object.entries(files)) {
      const absolute = path.join(cwd, file);
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(absolute, source);
    }
    test(cwd);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

function expectChangedTargets(changedPaths: string[], targets: string[]): void {
  expect(resolveChangedTestTargetPlan(changedPaths), changedPaths.join(", ")).toEqual({
    mode: "targets",
    targets,
  });
}

function expectSingleVitestRunPlan(
  actual: ReturnType<typeof buildVitestRunPlans>,
  expected: {
    config: string;
    forwardedArgs?: string[];
    includePatterns?: string[] | null;
    watchMode?: boolean;
  },
): void {
  expect(actual).toEqual([
    {
      config: expected.config,
      forwardedArgs: expected.forwardedArgs ?? [],
      includePatterns: expected.includePatterns ?? null,
      watchMode: expected.watchMode ?? false,
    },
  ]);
}

describe("scripts/test-projects changed-target routing", () => {
  beforeAll(() => {
    buildVitestRunPlans(["src/commands/onboard-non-interactive.test-helpers.ts"]);
    findUnmatchedExplicitTestTargets(["test/vitest/vitest.shared.config.ts"], process.cwd());
  });

  it("maps changed source files into scoped lane targets", () => {
    expect(
      resolveChangedTargetArgs(["--changed", "origin/main"], process.cwd(), () => [
        "packages/normalization-core/src/string-normalization.ts",
        "src/utils/provider-utils.ts",
      ]),
    ).toEqual([
      "packages/normalization-core/src/string-normalization.test.ts",
      "src/utils/provider-utils.test.ts",
    ]);
  });

  it.each([
    "packages/mermaid-renderer/package.json",
    "packages/mermaid-renderer/vite.config.ts",
    "packages/mermaid-renderer/native/index.html",
    "packages/mermaid-renderer/src/renderer.ts",
    "packages/mermaid-renderer/src/frame.js",
    "packages/mermaid-renderer/src/native.ts",
  ])("runs both Mermaid browser boundaries when %s changes", (changedPath) => {
    expectSingleVitestRunPlan(
      buildVitestRunPlans(["--changed", "origin/main"], process.cwd(), () => [changedPath]),
      {
        config: "test/vitest/vitest.ui-browser.config.ts",
        includePatterns: [
          "ui/src/components/markdown-mermaid.runtime.browser.test.ts",
          "ui/src/components/markdown-mermaid-native.browser.test.ts",
        ],
      },
    );
  });

  it.each([
    [
      "packages/normalization-core/src/record-coerce.ts",
      "packages/normalization-core/src/record-coerce.test.ts",
    ],
    [
      "packages/normalization-core/package.json",
      "packages/normalization-core/src/package-exports.test.ts",
    ],
    ["tsconfig.json", "test/scripts/changed-lanes.test.ts"],
  ])("retains owner proof and adds both Mermaid boundaries for %s", (changedPath, ownerTest) => {
    const plan = resolveChangedTestTargetPlan([changedPath]);
    const browserTargets = [
      "ui/src/components/markdown-mermaid.runtime.browser.test.ts",
      "ui/src/components/markdown-mermaid-native.browser.test.ts",
    ];
    expect(plan.mode).toBe("targets");
    expect(plan.targets).toEqual(expect.arrayContaining([ownerTest, ...browserTargets]));
    const runPlans = buildVitestRunPlans(["--changed", "origin/main"], process.cwd(), () => [
      changedPath,
    ]);
    expect(runPlans).toContainEqual({
      config: "test/vitest/vitest.ui-browser.config.ts",
      forwardedArgs: [],
      includePatterns: browserTargets,
      watchMode: false,
    });
  });

  it("routes Apple Mermaid preparation to its build and packaging proof", () => {
    const plan = resolveChangedTestTargetPlan(["scripts/prepare-apple-mermaid.mjs"]);
    expect(plan.mode).toBe("targets");
    expect(plan.targets).toEqual([
      "test/scripts/build-and-run-mac.test.ts",
      "test/scripts/package-mac-app.test.ts",
      "test/scripts/ci-workflow-guards.test.ts",
    ]);
  });

  it("bounds extensionless prefix probes while excluding deleted cached matches", () => {
    const target = "src/selector/topic";
    const rejectedFiles = [
      "src/other/topic.test.ts",
      "src/selector/topic-other.test.ts",
      "src/selector/topic.helper.ts",
      "src/selector/topic.child/nested.test.ts",
    ];
    const files = Object.fromEntries(
      [`${target}.test.ts`, `${target}.extra.spec.mts`, ...rejectedFiles].map((file) => [file, ""]),
    );
    withTinyGitRepo(files, (tempDir) => {
      const cwd = fs.realpathSync(tempDir);
      const candidatePaths = new Set(Object.keys(files).map((file) => path.join(cwd, file)));
      const rejectedPaths = new Set(rejectedFiles.map((file) => path.join(cwd, file)));
      const candidateProbes: string[] = [];
      const originalExistsSync = fs.existsSync;
      fs.existsSync = (file) => {
        if (typeof file === "string" && candidatePaths.has(file)) {
          candidateProbes.push(file);
        }
        return originalExistsSync(file);
      };
      try {
        const parsed = [
          parseTestProjectsArgs(["--changed", "origin/main"], cwd),
          parseTestProjectsArgs(["--changed", "origin/main"], cwd),
        ];
        for (const result of parsed) {
          expect(result).toStrictEqual({
            forwardedArgs: ["--changed", "origin/main"],
            nonTargetArgs: ["--changed", "origin/main"],
            targetArgs: [],
            watchMode: false,
          });
        }
        expect(candidateProbes).toHaveLength(0);

        expectSingleVitestRunPlan(buildVitestRunPlans([target], cwd), {
          config: "test/vitest/vitest.unit.config.ts",
          forwardedArgs: [`${target}.extra.spec.mts`, `${target}.test.ts`],
        });
        expect(findUnmatchedExplicitTestTargets([target], cwd)).toEqual([]);

        fs.unlinkSync(path.join(cwd, `${target}.extra.spec.mts`));
        expectSingleVitestRunPlan(buildVitestRunPlans([target], cwd), {
          config: "test/vitest/vitest.unit.config.ts",
          forwardedArgs: [`${target}.test.ts`],
          includePatterns: [`${target}.test.ts`],
        });
        expect(findUnmatchedExplicitTestTargets([target], cwd)).toEqual([]);

        fs.unlinkSync(path.join(cwd, `${target}.test.ts`));
        expect(findUnmatchedExplicitTestTargets([target], cwd)).toEqual([
          {
            target,
            reason: "path-does-not-exist",
            includePattern: `${target}{,.*}.{test,spec}.{js,jsx,ts,tsx,mjs,cjs,mts,cts}`,
          },
        ]);
        expect(candidateProbes.filter((file) => rejectedPaths.has(file))).toHaveLength(0);
      } finally {
        fs.existsSync = originalExistsSync;
      }
    });
  });

  it.each([
    "src/system-agent/setup-inference-turn.ts",
    "src/agents/embedded-agent-runner/run/run-attempt-dispatch.ts",
  ])(
    "routes setup inference transcript ownership changes through both regressions for %s",
    (targetPath) => {
      expectChangedTargets(
        [targetPath],
        [
          "src/agents/embedded-agent-runner/run.overflow-compaction.loop.test.ts",
          "src/commands/onboard-guided.inference.e2e.test.ts",
        ],
      );
    },
  );

  it("keeps changed mode focused by default for Vitest wiring edits", () => {
    expect(
      resolveChangedTargetArgs(["--changed", "origin/main"], process.cwd(), () => [
        "test/vitest/vitest.shared.config.ts",
        "src/utils/provider-utils.ts",
      ]),
    ).toEqual(["src/utils/provider-utils.test.ts"]);
  });

  it("skips deleted direct test files in changed mode", () => {
    expect(
      resolveChangedTargetArgs(["--changed", "origin/main"], process.cwd(), () => [
        "test/deleted-changed-target.test.ts",
      ]),
    ).toStrictEqual([]);
  });

  it("records broad fallback paths skipped by focused changed mode", () => {
    expect(
      resolveChangedTestTargetPlan([
        "test/vitest/vitest.shared.config.ts",
        "src/utils/provider-utils.ts",
      ]),
    ).toEqual({
      mode: "targets",
      skippedBroadFallbackPaths: ["test/vitest/vitest.shared.config.ts"],
      targets: ["src/utils/provider-utils.test.ts"],
    });
  });

  it("keeps the broad changed run available for Vitest wiring edits", () => {
    expect(
      resolveChangedTargetArgs(
        ["--changed", "origin/main"],
        process.cwd(),
        () => ["test/vitest/vitest.shared.config.ts", "src/utils/provider-utils.ts"],
        { env: { OPENCLAW_TEST_CHANGED_BROAD: "1" } },
      ),
    ).toBeNull();
  });

  it("keeps test runner implementation edits on runner tests", () => {
    expectChangedTargets(
      [
        "scripts/check-changed.mjs",
        "scripts/check-changed.mts",
        "scripts/test-projects.test-support.mts",
        "test/scripts/changed-lanes.test.ts",
      ],
      ["test/scripts/changed-lanes.test.ts", "test/scripts/test-projects.test.ts"],
    );
  });

  it("keeps changed-lanes shim and implementation edits on changed-lanes tests", () => {
    for (const scriptPath of ["scripts/changed-lanes.mjs", "scripts/changed-lanes.mts"]) {
      expectChangedTargets([scriptPath], ["test/scripts/changed-lanes.test.ts"]);
    }
  });

  it.each(["scripts/lib/tsx-cli-shim.mjs", "scripts/tsx.mjs"])(
    "routes shared TypeScript tooling changes through wrapper tests for %s",
    (scriptPath) => {
      expectChangedTargets(
        [scriptPath],
        [
          "test/scripts/direct-run-entrypoints.test.ts",
          "test/scripts/lint-status.test.ts",
          "test/scripts/local-check-runtime.test.ts",
        ],
      );
    },
  );

  it.each(["mjs", "cjs", "js", "mts", "cts", "ts", "sh", "py", "ps1"])(
    "discovers conventional nested, dashed and basename script owners for .%s",
    (extension) => {
      withTinyFileTree(
        {
          [`scripts/nested/fixture.${extension}`]: "",
          "test/scripts/nested/fixture.test.ts": "",
          "test/scripts/nested-fixture.test.ts": "",
          "test/scripts/fixture.test.ts": "",
          "src/scripts/nested/fixture.test.ts": "",
          "src/scripts/nested-fixture.test.ts": "",
          "src/scripts/fixture.test.ts": "",
          "test/scripts/fixture.live.test.ts": "",
        },
        (cwd) => {
          expect(
            resolveChangedTestTargetPlan([`scripts/nested/fixture.${extension}`], { cwd }),
          ).toEqual({
            mode: "targets",
            targets: [
              "test/scripts/nested/fixture.test.ts",
              "test/scripts/nested-fixture.test.ts",
              "test/scripts/fixture.test.ts",
              "src/scripts/nested/fixture.test.ts",
              "src/scripts/nested-fixture.test.ts",
              "src/scripts/fixture.test.ts",
            ],
          });
          expect(
            resolveChangedTestTargetPlan([`scripts/fixture.${extension}`], { cwd }).targets,
          ).toEqual(["test/scripts/fixture.test.ts", "src/scripts/fixture.test.ts"]);
          expect(
            resolveChangedTestTargetPlan([`scripts/unowned.${extension}`], { cwd }).targets,
          ).toEqual(["test/vitest/vitest.tooling.config.ts"]);
        },
      );
    },
  );

  it.each(["extensions/codex/package.json", "extensions/codex/src/app-server/version.ts"])(
    "routes Codex version changes through cross-plugin contract tests for %s",
    (changedPath) => {
      expectChangedTargets(
        [changedPath],
        [
          "extensions/codex/src/manifest.test.ts",
          "extensions/openai/openai-provider.test.ts",
          "test/scripts/codex-client-version-contract.test.ts",
        ],
      );
    },
  );

  it("routes control UI i18n script changes through its regression test", () => {
    expectChangedTargets(
      ["scripts/control-ui-i18n.ts"],
      ["test/scripts/control-ui-i18n.test.ts", "src/scripts/control-ui-i18n.test.ts"],
    );
  });

  it("keeps shared PR worktree helper edits on the full tooling owner suite", () => {
    expectChangedTargets(["scripts/pr-lib/worktree.sh"], ["test/vitest/vitest.tooling.config.ts"]);
  });

  it.each([
    "scripts/pr",
    "scripts/pr-lib/merge.sh",
    "scripts/pr-lib/merge-outcome.sh",
    "scripts/pr-lib/merge-legacy-refusal.mjs",
    "scripts/pr-lib/merge-pre-dispatch-refusal.mjs",
  ])("routes native merge changes through the outcome owner for %s", (scriptPath) => {
    expectChangedTargets(
      [scriptPath],
      [
        "test/scripts/pr-merge.test.ts",
        "test/scripts/pr-merge-outcome.test.ts",
        ...(scriptPath !== "scripts/pr"
          ? ["test/scripts/pr-merge-pre-dispatch-refusal.test.ts"]
          : []),
        "test/scripts/pr-merge-qualified-refusal.test.ts",
        ...(scriptPath === "scripts/pr"
          ? ["test/scripts/pr-operation-lock.test.ts", "test/scripts/pr-wrappers.test.ts"]
          : []),
      ],
    );
  });

  it("routes unmatched script changes to the tooling suite instead of skipping tests", () => {
    const targets = ["scripts/check-no-raw-http2-imports.mts"];

    expectChangedTargets(targets, ["test/vitest/vitest.tooling.config.ts"]);
    expectSingleVitestRunPlan(
      buildVitestRunPlans(["--changed", "origin/main"], process.cwd(), () => targets),
      { config: "test/vitest/vitest.tooling.config.ts" },
    );
  });

  it("routes group visible reply config changes through channel delivery regressions", () => {
    expectChangedTargets(
      ["src/config/types.messages.ts", "src/config/zod-schema.core.ts"],
      [
        "src/auto-reply/reply/dispatch-acp.test.ts",
        "src/auto-reply/reply/dispatch-from-config.test.ts",
        "src/auto-reply/reply/dispatch-from-config.delivery.test.ts",
        "src/auto-reply/reply/dispatch-from-config.lifecycle.test.ts",
        "src/auto-reply/reply/followup-runner.test.ts",
        "src/auto-reply/reply/groups.test.ts",
        "extensions/discord/src/monitor/message-handler.process.test.ts",
        "extensions/slack/src/monitor.tool-result.test.ts",
      ],
    );
  });

  it("routes source reply prompt changes through prompt and channel delivery regressions", () => {
    expectChangedTargets(
      ["src/agents/system-prompt.ts"],
      [
        "src/agents/system-prompt.test.ts",
        "src/auto-reply/reply/dispatch-acp.test.ts",
        "src/auto-reply/reply/dispatch-from-config.test.ts",
        "src/auto-reply/reply/dispatch-from-config.delivery.test.ts",
        "src/auto-reply/reply/dispatch-from-config.lifecycle.test.ts",
        "src/auto-reply/reply/followup-runner.test.ts",
        "src/auto-reply/reply/groups.test.ts",
        "extensions/discord/src/monitor/message-handler.process.test.ts",
        "extensions/slack/src/monitor.tool-result.test.ts",
      ],
    );
  });

  it("routes source reply delivery mode changes through channel delivery regressions", () => {
    expectChangedTargets(
      ["src/auto-reply/reply/source-reply-delivery-mode.ts"],
      [
        "src/auto-reply/reply/dispatch-acp.test.ts",
        "src/auto-reply/reply/dispatch-from-config.test.ts",
        "src/auto-reply/reply/dispatch-from-config.delivery.test.ts",
        "src/auto-reply/reply/dispatch-from-config.lifecycle.test.ts",
        "src/auto-reply/reply/followup-runner.test.ts",
        "src/auto-reply/reply/groups.test.ts",
        "extensions/discord/src/monitor/message-handler.process.test.ts",
        "extensions/slack/src/monitor.tool-result.test.ts",
      ],
    );
  });

  it("routes channel reply pipeline SDK changes through SDK and channel delivery regressions", () => {
    expectChangedTargets(
      ["src/plugin-sdk/channel-reply-pipeline.ts"],
      [
        "src/plugins/contracts/plugin-sdk-subpaths.test.ts",
        "src/auto-reply/reply/dispatch-acp.test.ts",
        "src/auto-reply/reply/dispatch-from-config.test.ts",
        "src/auto-reply/reply/dispatch-from-config.delivery.test.ts",
        "src/auto-reply/reply/dispatch-from-config.lifecycle.test.ts",
        "src/auto-reply/reply/followup-runner.test.ts",
        "src/auto-reply/reply/groups.test.ts",
        "extensions/discord/src/monitor/message-handler.process.test.ts",
        "extensions/slack/src/monitor.tool-result.test.ts",
      ],
    );
  });

  it("routes reply runtime SDK exports through plugin SDK contract tests", () => {
    expectChangedTargets(
      ["src/plugin-sdk/reply-runtime.ts"],
      ["src/plugins/contracts/plugin-sdk-subpaths.test.ts"],
    );
  });

  it("keeps extension batch runner edits on extension script tests", () => {
    expectChangedTargets(
      ["scripts/test-extension-batch.mts"],
      [
        "test/scripts/test-extension.test.ts",
        "test/scripts/test-projects-build-admission.test.ts",
        "test/scripts/ci-node-test-plan.test.ts",
      ],
    );
  });

  it("routes the Vitest fork patch and its fixture to lifecycle proof", () => {
    expectChangedTargets(
      ["patches/vitest@5.0.0.patch"],
      [
        "test/scripts/run-vitest-profile.test.ts",
        "test/scripts/run-vitest-state-cleanup.test.ts",
        "test/scripts/vitest-fork-shutdown.test.ts",
        "test/scripts/vitest-runner-task-updates.test.ts",
      ],
    );
    expectChangedTargets(
      ["test/fixtures/vitest-fork-shutdown.mjs"],
      ["test/scripts/vitest-fork-shutdown.test.ts"],
    );
    expectSingleVitestRunPlan(buildVitestRunPlans(["test/scripts/vitest-fork-shutdown.test.ts"]), {
      config: "test/vitest/vitest.tooling-isolated.config.ts",
      includePatterns: ["test/scripts/vitest-fork-shutdown.test.ts"],
    });
  });

  it("routes recovery survivor orchestration to its assertion owner", () => {
    for (const file of [
      "scripts/e2e/upgrade-survivor-docker.sh",
      "scripts/e2e/lib/upgrade-survivor/run.sh",
      "scripts/e2e/lib/upgrade-survivor/recovery-cleanup.mjs",
      "scripts/e2e/lib/upgrade-survivor/recovery-cleanup-fixture.mjs",
    ]) {
      const plan = resolveChangedTestTargetPlan([file]);
      expect(plan.mode).toBe("targets");
      if (plan.mode !== "targets") {
        throw new Error(`Missing recovery test owner: ${file}`);
      }
      expect(plan.targets).toContain("test/scripts/upgrade-survivor-recovery-cleanup.test.ts");
      if (file.endsWith("/run.sh")) {
        expect(plan.targets).toContain("test/scripts/upgrade-survivor-watchos-direct-node.test.ts");
      }
      if (
        file === "scripts/e2e/upgrade-survivor-docker.sh" ||
        file === "scripts/e2e/lib/upgrade-survivor/run.sh"
      ) {
        expect(plan.targets).toContain("test/scripts/upgrade-survivor-mobile-pairing.test.ts");
      }
    }
    expectChangedTargets(
      ["scripts/e2e/lib/upgrade-survivor/mobile-pairing-client.mts"],
      ["test/scripts/upgrade-survivor-mobile-pairing.test.ts"],
    );
  });

  it("routes the watchOS survivor adapter to its contract test", () => {
    expectChangedTargets(
      ["scripts/e2e/lib/upgrade-survivor/watchos-direct-node.mjs"],
      ["test/scripts/upgrade-survivor-watchos-direct-node.test.ts"],
    );
  });

  it.each([
    ["scripts/run-oxlint-shards.mts", ["run-oxlint"]],
    ["scripts/run-oxlint.mts", ["run-oxlint"]],
    ["scripts/run-oxlint.mjs", ["run-oxlint"]],
    ["scripts/run-lint.mts", ["run-oxlint"]],
    ["scripts/run-stylelint.mts", ["changed-lanes"]],
    ["scripts/lib/failed-trailer.mts", ["run-oxlint", "run-tsgo", "run-vitest", "changed-lanes"]],
    ["scripts/lib/managed-child-process.mts", ["managed-child-process"]],
    ["scripts/lib/dist-artifact-ownership.mts", ["dist-artifact-ownership"]],
  ] as const)(
    "routes %s through the lint status boundary and existing owners",
    (source, owners) => {
      expectChangedTargets(
        [source],
        [...owners, "lint-status"].map((owner) => `test/scripts/${owner}.test.ts`),
      );
    },
  );

  it("keeps Crabbox config edits on package acceptance tests", () => {
    expectChangedTargets([".crabbox.yaml"], ["test/scripts/package-acceptance-workflow.test.ts"]);
  });

  it("keeps scripts tsconfig edits on oxlint config tests", () => {
    expectChangedTargets(["scripts/tsconfig.json"], ["test/scripts/oxlint-config.test.ts"]);
  });

  it("keeps the scripts typecheck project on its routing tests", () => {
    expectChangedTargets(
      ["tsconfig.scripts.json"],
      ["test/scripts/changed-lanes.test.ts", "test/scripts/test-projects.test.ts"],
    );
  });

  it("keeps docs i18n behavior fixture edits on behavior baseline tests", () => {
    for (const fixturePath of [
      "scripts/docs-i18n/testdata/behavior/fenced-singleton-retry/case.json",
      "scripts/docs-i18n/testdata/behavior/fenced-singleton-retry/source.txt",
    ]) {
      expectChangedTargets([fixturePath], ["test/scripts/docs-i18n.test.ts"]);
    }
  });

  it("keeps docs i18n Go edits on their module and workflow guards", () => {
    const cases = [
      ["scripts/docs-i18n/main.go", ["test/scripts/docs-i18n.test.ts"]],
      ["scripts/docs-i18n/main_test.go", ["test/scripts/docs-i18n.test.ts"]],
      [
        "scripts/docs-i18n/go.mod",
        ["test/scripts/docs-i18n.test.ts", "test/scripts/ci-workflow-planning.test.ts"],
      ],
    ] as const;
    for (const [modulePath, targets] of cases) {
      expect(resolveChangedTestTargetPlan([modulePath]), modulePath).toEqual({
        mode: "targets",
        targets,
      });
    }
  });

  it("keeps k8s manifest edits on manifest tests", () => {
    expectChangedTargets(
      ["scripts/k8s/manifests/configmap.yaml"],
      ["test/scripts/k8s-manifests.test.ts"],
    );
  });

  it("keeps Crabbox runner script edits on their regression tests", () => {
    for (const scriptPath of [
      "scripts/crabbox-wrapper.mjs",
      "scripts/crabbox-wrapper.mts",
      "scripts/crabbox-wrapper-providers.mts",
      "scripts/crabbox-routing-policy.mts",
      "scripts/testbox-lease-freshness.mts",
    ]) {
      expectChangedTargets(
        [scriptPath],
        scriptPath === "scripts/crabbox-routing-policy.mts"
          ? ["test/scripts/crabbox-wrapper.test.ts", "test/scripts/crabbox-routing-policy.test.ts"]
          : scriptPath === "scripts/testbox-lease-freshness.mts"
            ? [
                "test/scripts/crabbox-wrapper.test.ts",
                "test/scripts/testbox-lease-freshness.test.ts",
              ]
            : ["test/scripts/crabbox-wrapper.test.ts"],
      );
    }
  });

  it("keeps Crabbox gate trust-boundary scripts on their owner tests", () => {
    expectChangedTargets(
      ["scripts/pr-lib/crabbox-gate-contract.mjs"],
      [
        "test/scripts/pr-crabbox-gate-publisher.test.ts",
        "test/scripts/pr-crabbox-merge-bypass.test.ts",
      ],
    );
    expectChangedTargets(
      ["scripts/pr-lib/crabbox-gate-plan.mts"],
      [
        "test/scripts/pr-crabbox-gate-plan.test.ts",
        "test/scripts/pr-crabbox-gate-publisher.test.ts",
        "test/scripts/pr-prepare-gates.test.ts",
      ],
    );
    expectChangedTargets(
      ["scripts/pr-lib/crabbox-merge-bypass.sh"],
      [
        "test/scripts/pr-crabbox-merge-bypass.test.ts",
        "test/scripts/pr-merge.test.ts",
        "test/scripts/pr-merge-outcome.test.ts",
      ],
    );
  });

  it("keeps build stamp script edits on the build stamp regression test", () => {
    expectChangedTargets(["scripts/build-stamp.mts"], ["src/infra/build-stamp.test.ts"]);
  });

  it("keeps bundled plugin metadata copier edits on runtime owner tests", () => {
    expectChangedTargets(
      ["scripts/copy-bundled-plugin-metadata.mts"],
      ["src/plugins/copy-bundled-plugin-metadata.test.ts", "src/infra/run-node.test.ts"],
    );
  });

  it.each([
    ".github/actions/git-owner/owner.py",
    ".github/actions/git-owner/action.yml",
    ".github/actions/ensure-base-commit/policy.py",
    ".github/actions/ensure-base-commit/action.yml",
    "scripts/generate-ci-git-owner.mts",
    ".github/workflows/workflow-sanity.yml",
  ])("selects executable Git boundary proof for %s", (source) => {
    expect(resolveChangedTestTargetPlan([source])).toEqual({
      mode: "targets",
      targets: expect.arrayContaining(["test/scripts/ci-git-owner.test.ts"]),
    });
  });

  it("routes QA Profile Evidence through Git lifecycle owners", () => {
    expect(resolveChangedTestTargetPlan([".github/workflows/qa-profile-evidence.yml"])).toEqual({
      mode: "targets",
      targets: expect.arrayContaining([
        "test/scripts/ci-git-owner.test.ts",
        "test/scripts/ci-linux-git.test.ts",
        "test/scripts/ci-platform-checkout.test.ts",
        "src/scripts/ci-changed-scope.git-owner.test.ts",
        "test/scripts/ci-workflow-guards.test.ts",
        "test/scripts/ci-workflow-evidence.test.ts",
      ]),
    });
  });

  it.each([
    [
      ".github/workflows/linux-app-release.yml",
      ["test/scripts/release-workflow-git-lifecycle.test.ts"],
    ],
    [
      ".github/workflows/macos-release.yml",
      [
        "test/scripts/release-workflow-git-lifecycle.test.ts",
        "test/scripts/package-acceptance-workflow.test.ts",
      ],
    ],
    [
      ".github/workflows/npm-placeholder-bootstrap.yml",
      [
        "test/scripts/release-workflow-git-lifecycle.test.ts",
        "test/scripts/npm-placeholder-publication.test.ts",
      ],
    ],
  ])("routes simple release admission lifecycle and semantic proof for %s", (source, semantic) => {
    const plan = resolveChangedTestTargetPlan([source]);
    expect(plan).toEqual({
      mode: "targets",
      targets: expect.arrayContaining([
        "test/scripts/ci-git-owner.test.ts",
        "test/scripts/ci-linux-git.test.ts",
        "test/scripts/ci-platform-checkout.test.ts",
        "test/scripts/ci-workflow-guards.test.ts",
        ...semantic,
      ]),
    });
  });

  it.each([
    [
      ".github/workflows/ci.yml",
      [
        "test/scripts/ci-workflow-planning.test.ts",
        "test/scripts/ci-workflow-evidence.test.ts",
        "test/scripts/changed-lanes.test.ts",
        "test/scripts/check-workflows.test.ts",
        "test/scripts/plugin-contract-test-plan.test.ts",
        "test/scripts/plugin-prerelease-test-plan.test.ts",
        "test/scripts/verify-pr-hosted-gates.test.ts",
      ],
    ],
    [
      ".github/workflows/full-release-validation.yml",
      [
        "src/dockerfile.test.ts",
        "test/scripts/full-release-validation-state.test.ts",
        "test/scripts/full-release-validation-at-sha.test.ts",
        "test/scripts/full-release-candidate-reuse.test.ts",
        "test/scripts/find-reusable-release-validation.test.ts",
        "test/scripts/openclaw-npm-extended-stable-full-validation-workflow.test.ts",
        "test/scripts/release-no-push-workflow.test.ts",
        "test/scripts/release-ci-summary.test.ts",
        "test/scripts/package-acceptance-workflow.test.ts",
        "test/scripts/plugin-prerelease-test-plan.test.ts",
        "test/scripts/check-workflows.test.ts",
        "test/scripts/full-release-publication-admission.test.ts",
      ],
    ],
    [
      ".github/workflows/full-release-candidate.yml",
      [
        "test/scripts/full-release-candidate-reuse.test.ts",
        "test/scripts/package-acceptance-workflow.test.ts",
        "test/scripts/check-workflows.test.ts",
        "test/scripts/release-no-push-workflow.test.ts",
      ],
    ],
    [
      ".github/workflows/openclaw-npm-release.yml",
      [
        "test/openclaw-npm-postpublish-verify.test.ts",
        "test/scripts/openclaw-npm-extended-stable-workflow.test.ts",
        "test/scripts/package-acceptance-workflow.test.ts",
      ],
    ],
    [
      ".github/workflows/docker-release.yml",
      [
        "src/dockerfile.test.ts",
        "test/scripts/docker-channel-promote.test.ts",
        "test/scripts/docker-release-artifacts.test.ts",
        "test/scripts/vercel-container-registry-publish.test.ts",
        "test/scripts/full-release-publication-admission.test.ts",
        "test/scripts/release-no-push-workflow.test.ts",
      ],
    ],
    [
      ".github/workflows/openclaw-release-publish.yml",
      [
        "test/scripts/package-acceptance-workflow.test.ts",
        "test/scripts/docker-release-artifacts.test.ts",
        "test/scripts/vercel-container-registry-publish.test.ts",
        "test/scripts/full-release-publication-admission.test.ts",
        "test/scripts/release-no-push-workflow.test.ts",
        "test/scripts/validate-release-publish-approval.test.ts",
      ],
    ],
    [
      ".github/workflows/vercel-container-registry-publish.yml",
      [
        "test/scripts/docker-channel-promote.test.ts",
        "test/scripts/release-plan-producer.test.ts",
        "test/scripts/vercel-container-registry-publish.test.ts",
        "test/scripts/full-release-publication-admission.test.ts",
      ],
    ],
    [
      ".github/workflows/openclaw-release-checks.yml",
      [
        "test/scripts/package-acceptance-workflow.test.ts",
        "test/scripts/openclaw-cross-os-release-checks.test.ts",
        "test/scripts/plugin-prerelease-test-plan.test.ts",
        "test/scripts/test-install-sh-docker.test.ts",
        "test/scripts/release-no-push-workflow.test.ts",
      ],
    ],
  ])(
    "retains required semantic owners for %s alongside discovered references",
    (workflow, owners) => {
      const plan = resolveChangedTestTargetPlan([workflow]);
      expect(plan.mode).toBe("targets");
      expect(plan.targets).toEqual(
        expect.arrayContaining(["test/scripts/ci-workflow-guards.test.ts", ...owners]),
      );
      expect(new Set(plan.targets).size).toBe(plan.targets.length);
    },
  );

  it.each([
    "scripts/full-release-candidate-reuse.mjs",
    "scripts/lib/full-release-candidate-reuse.mjs",
    "scripts/lib/full-release-candidate-reuse.d.mts",
  ])("routes candidate reuse library changes through the owner test for %s", (changedPath) => {
    expectChangedTargets([changedPath], ["test/scripts/full-release-candidate-reuse.test.ts"]);
  });

  it("unions semantic workflow owners with bounded direct references", () => {
    withTinyGitRepo(
      {
        ".github/workflows/full-release-validation.yml": "name: FRV\n",
        "test/scripts/full-release-validation-state.test.ts":
          'const workflow = ".github/workflows/full-release-validation.yml";\n',
        "test/scripts/unknown-frv-contract.test.ts":
          'const workflow = ".github/workflows/full-release-validation.yml";\n',
        "test/scripts/unknown-frv-contract.live.test.ts":
          'const workflow = ".github/workflows/full-release-validation.yml";\n',
        "test/scripts/test-projects.test.ts":
          'const workflow = ".github/workflows/full-release-validation.yml";\n',
        "test/scripts/workflow-substring.test.ts":
          'const workflow = ".github/workflows/full-release-validation.yml.bak";\n',
      },
      (cwd) => {
        const targets = resolveChangedTestTargetPlan(
          [".github/workflows/full-release-validation.yml"],
          { cwd },
        ).targets;

        expect(targets).toContain("test/scripts/unknown-frv-contract.test.ts");
        expect(
          targets.filter(
            (target) => target === "test/scripts/full-release-validation-state.test.ts",
          ),
        ).toHaveLength(1);
        expect(targets).not.toContain("test/scripts/unknown-frv-contract.live.test.ts");
        expect(targets).not.toContain("test/scripts/test-projects.test.ts");
        expect(targets).not.toContain("test/scripts/workflow-substring.test.ts");
      },
    );
  });

  it.each([
    {
      changedPath: ".github/workflows/plugin-npm-release.yml",
      exactTargets: [
        "test/scripts/plugin-npm-extended-stable-workflow.test.ts",
        "test/scripts/plugin-release-git-lifecycle.test.ts",
      ],
    },
    {
      changedPath: ".github/actions/setup-node-env/action.yml",
      exactTargets: ["test/scripts/setup-node-env-bun.test.ts"],
    },
  ])("unions exact owners and references for $changedPath", ({ changedPath, exactTargets }) => {
    withTinyGitRepo(
      {
        [changedPath]: "name: fixture\n",
        "test/scripts/direct-workflow-reference.test.ts": `const target = "${changedPath}";\n`,
      },
      (cwd) => {
        const targets = resolveChangedTestTargetPlan([changedPath], { cwd }).targets;

        for (const exactTarget of exactTargets) {
          expect(targets).toContain(exactTarget);
        }
        expect(targets).toContain("test/scripts/direct-workflow-reference.test.ts");
        expect(targets).toContain("test/scripts/ci-workflow-guards.test.ts");
      },
    );
  });

  it("routes the Bun image consumer to its executable action regression", () => {
    expectChangedTargets(
      [".github/actions/setup-node-env/seed-bun-from-image.mjs"],
      ["test/scripts/setup-node-env-bun.test.ts"],
    );
  });

  it("routes ClawHub publication through lifecycle and release workflow proof", () => {
    expect(
      resolveChangedTestTargetPlan([".github/workflows/plugin-clawhub-release.yml"]).targets,
    ).toEqual(
      expect.arrayContaining([
        "test/scripts/ci-git-owner.test.ts",
        "test/scripts/ci-linux-git.test.ts",
        "test/scripts/ci-platform-checkout.test.ts",
        "test/scripts/ci-workflow-guards.test.ts",
        "test/scripts/package-acceptance-workflow.test.ts",
        "test/scripts/plugin-release-git-lifecycle.test.ts",
      ]),
    );
  });

  it.each(["scripts/write-plugin-sdk-entry-dts.ts", "scripts/lib/local-check-runtime.mts"])(
    "selects SDK publication regressions for %s",
    (source) => {
      const plan = resolveChangedTestTargetPlan([source]);
      expect(plan.targets).toContain("test/scripts/write-plugin-sdk-entry-dts.test.ts");
      if (source === "scripts/lib/local-check-runtime.mts") {
        expect(plan.targets).toContain("test/scripts/local-check-runtime.test.ts");
      }
    },
  );

  it("does not scan direct references for semantic non-YAML tooling", () => {
    withTinyGitRepo(
      {
        "scripts/pr": "#!/bin/sh\n",
        "test/scripts/direct-tooling-reference.test.ts": 'const target = "scripts/pr";\n',
      },
      (cwd) => {
        const targets = resolveChangedTestTargetPlan(["scripts/pr"], { cwd }).targets;

        expect(targets).not.toContain("test/scripts/direct-tooling-reference.test.ts");
      },
    );
  });

  it("selects OCI publication proof for read-only Docker preparation changes", () => {
    const plan = resolveChangedTestTargetPlan([".github/workflows/docker-release-prepare.yml"]);
    expect(plan.mode).toBe("targets");
    expect(plan.targets).toEqual(
      expect.arrayContaining([
        "src/dockerfile.test.ts",
        "test/scripts/docker-release-artifacts.test.ts",
        "test/scripts/release-no-push-workflow.test.ts",
        "test/scripts/ci-workflow-guards.test.ts",
      ]),
    );
  });

  it.each([
    ".github/actions/create-generated-pr-tokens/action.yml",
    ".github/actions/publish-generated-pr/action.yml",
    ".github/workflows/auto-response.yml",
    ".github/workflows/labeler.yml",
    ".github/workflows/real-behavior-proof.yml",
    ".github/workflows/stale.yml",
    ".github/workflows/clawsweeper-dispatch.yml",
  ])("retains workflow guards for generated publication and PR automation: %s", (source) => {
    expect(resolveChangedTestTargetPlan([source]).targets).toContain(
      "test/scripts/ci-workflow-guards.test.ts",
    );
  });

  it("keeps generated locale inventory edits on workflow guards", () => {
    expectChangedTargets(
      ["scripts/native-app-i18n.ts"],
      ["test/scripts/native-app-i18n.test.ts", "test/scripts/ci-workflow-guards.test.ts"],
    );
  });

  it("keeps security review workflow edits on the automatic review owners", () => {
    expectChangedTargets(
      [".github/workflows/security-review.yml"],
      [
        "test/scripts/security-review-workflow.test.ts",
        "test/scripts/security-review-event.test.ts",
        "test/scripts/security-review-script.test.ts",
        "test/scripts/ci-workflow-guards.test.ts",
      ],
    );
  });

  it("keeps automatic review entry points and rollout changes on executable owner tests", () => {
    expectChangedTargets(
      ["scripts/github/security-review-event.mjs"],
      ["test/scripts/security-review-event.test.ts"],
    );
    for (const reviewPath of [
      "scripts/github/security-review.mjs",
      "scripts/github/security-review-rollout.mjs",
    ]) {
      expectChangedTargets(
        [reviewPath],
        [
          "test/scripts/security-review-script.test.ts",
          "test/scripts/security-review-rollout.test.ts",
        ],
      );
    }
  });

  it.each([
    ".github/workflows/ci-check-testbox.yml",
    ".github/workflows/ci-check-arm-testbox.yml",
    ".github/workflows/ci-build-artifacts-testbox.yml",
    ".github/workflows/crabbox-hydrate.yml",
  ])("retains package acceptance and workflow owners for %s", (source) => {
    const targets = resolveChangedTestTargetPlan([source]).targets;
    expect(targets).toEqual(
      expect.arrayContaining([
        "test/scripts/package-acceptance-workflow.test.ts",
        "test/scripts/ci-workflow-guards.test.ts",
      ]),
    );
    if (source === ".github/workflows/ci-check-testbox.yml") {
      expect(targets).toContain("test/scripts/changed-lanes.test.ts");
    }
  });

  it.each(["ios", "macos", "shared-openclawkit"])(
    "retains Periphery scope proof for %s",
    (platform) => {
      expect(
        resolveChangedTestTargetPlan([`.github/workflows/${platform}-periphery.yml`]).targets,
      ).toEqual(
        expect.arrayContaining([
          "test/scripts/ci-workflow-guards.test.ts",
          "test/scripts/periphery-scope-workflows.test.ts",
        ]),
      );
    },
  );

  it.each([
    ["docs-sync-publish", "docs-sync-publish"],
    ["docs-agent", "docs-agent-workflow"],
  ])("routes %s edits through docs, workflow, and native Git owner proof", (workflow, test) => {
    expectChangedTargets(
      [`.github/workflows/${workflow}.yml`],
      [
        `test/scripts/${test}.test.ts`,
        "test/scripts/ci-git-owner.test.ts",
        "test/scripts/ci-linux-git.test.ts",
        "test/scripts/ci-platform-checkout.test.ts",
        "src/scripts/ci-changed-scope.git-owner.test.ts",
        "test/scripts/ci-workflow-guards.test.ts",
        ...(workflow === "docs-sync-publish"
          ? ["test/scripts/docs-mirror-freshness.test.ts"]
          : ["test/scripts/ci-workflow-planning.test.ts"]),
      ],
    );
  });

  it.each([
    ".github/workflows/mantis-discord-smoke.yml",
    ".github/workflows/mantis-discord-status-reactions.yml",
    ".github/workflows/mantis-discord-thread-attachment.yml",
    ".github/workflows/mantis-slack-desktop-smoke.yml",
    ".github/workflows/mantis-web-ui-chat-proof.yml",
    ".github/actions/mantis-validate-trusted-ref/action.yml",
  ])("retains Mantis package, Git lifecycle and trust-boundary owners for %s", (source) => {
    const targets = resolveChangedTestTargetPlan([source]).targets;
    expect(targets).toEqual(
      expect.arrayContaining([
        "test/scripts/package-acceptance-workflow.test.ts",
        "test/scripts/ci-workflow-guards.test.ts",
        "test/scripts/ci-git-owner.test.ts",
        "test/scripts/ci-linux-git.test.ts",
        "test/scripts/ci-platform-checkout.test.ts",
        "src/scripts/ci-changed-scope.git-owner.test.ts",
      ]),
    );
    if (source.includes("web-ui-chat-proof") || source.includes("validate-trusted-ref")) {
      expect(targets).toContain("test/scripts/mantis-web-ui-chat-proof-workflow.test.ts");
    }
  });

  it("keeps workflow sanity script edits on workflow guard tests", () => {
    expectChangedTargets(
      ["scripts/check-workflows.mts"],
      [
        "test/scripts/check-composite-action-input-interpolation.test.ts",
        "test/scripts/check-no-conflict-markers.test.ts",
        "test/scripts/ci-workflow-guards.test.ts",
        "test/scripts/check-workflows.test.ts",
      ],
    );
  });

  it("keeps workflow helper guard edits on their regression tests", () => {
    expectChangedTargets(
      ["scripts/check-composite-action-input-interpolation.py"],
      ["test/scripts/check-composite-action-input-interpolation.test.ts"],
    );

    expectChangedTargets(
      ["scripts/check-no-conflict-markers.mjs"],
      ["test/scripts/check-no-conflict-markers.test.ts"],
    );
  });

  it("keeps CI, dependency, and docs tooling edits on owner tests", () => {
    const changedScopeTestFamily = fs
      .readdirSync("src/scripts")
      .filter((file) => /^ci-changed-scope(?:\.[^/]+)?\.test\.ts$/u.test(file))
      .map((file) => `src/scripts/${file}`)
      .toSorted((left, right) => left.localeCompare(right));
    expectChangedTargets(
      ["scripts/ci-changed-scope.mjs"],
      [...changedScopeTestFamily, "test/scripts/control-ui-i18n.test.ts"],
    );

    expectChangedTargets(
      ["scripts/github/dependency-guard.mjs"],
      [
        "test/scripts/dependency-guard-script.test.ts",
        "test/scripts/security-review-workflow.test.ts",
      ],
    );

    expectChangedTargets(
      ["scripts/github/guard-shared.mjs"],
      [
        "test/scripts/dependency-guard-script.test.ts",
        "test/scripts/security-review-workflow.test.ts",
        "test/scripts/security-sensitive-guard-script.test.ts",
        "test/scripts/security-review-script.test.ts",
        "test/scripts/security-review-event.test.ts",
      ],
    );

    expectChangedTargets(
      ["scripts/github/run-openclaw-cross-os-release-checks.sh"],
      ["test/scripts/openclaw-cross-os-release-workflow.test.ts"],
    );

    expectChangedTargets(
      ["scripts/github/security-sensitive-guard.mjs"],
      [
        "test/scripts/security-sensitive-guard-script.test.ts",
        "test/scripts/security-review-workflow.test.ts",
      ],
    );

    expectChangedTargets(
      ["scripts/clawtributors-map.json"],
      ["test/scripts/update-clawtributors.test.ts"],
    );
  });

  it("routes shared contract ownership and declarations through every affected lane", () => {
    const targets = [
      "test/scripts/test-projects.test.ts",
      "test/vitest-projects-config.test.ts",
      "test/vitest/vitest.contracts-channel-surface.config.ts",
      "test/vitest/vitest.contracts-channel-config.config.ts",
      "test/vitest/vitest.contracts-channel-registry.config.ts",
      "test/vitest/vitest.contracts-channel-session.config.ts",
    ];
    for (const changedPath of [
      "test/vitest/vitest.contracts-paths.mjs",
      "test/vitest/vitest.contracts-paths.d.mts",
    ]) {
      expect(resolveChangedTestTargetPlan([changedPath]), changedPath).toEqual({
        mode: "targets",
        targets,
      });
    }
  });

  it("keeps QA Lab gateway smoke script edits on QA e2e tests", () => {
    expectChangedTargets(
      ["scripts/dev/gateway-smoke.ts"],
      ["test/e2e/qa-lab/runtime/gateway-smoke.e2e.test.ts"],
    );
  });

  it("routes explicit tooling implementation files to owner tests", () => {
    expect(
      findUnmatchedExplicitTestTargets([
        "scripts/build-all.mts",
        "scripts/check.mts",
        "scripts/check-dynamic-import-warts.mts",
        "scripts/run-oxlint-shards.mts",
        "scripts/test-force.ts",
        "scripts/tsdown-build.mts",
        "scripts/verify.mts",
      ]),
    ).toEqual([]);

    expect(
      buildVitestRunPlans([
        "scripts/build-all.mts",
        "scripts/check.mts",
        "scripts/check-dynamic-import-warts.mts",
        "scripts/run-oxlint-shards.mts",
        "scripts/test-force.ts",
        "scripts/tsdown-build.mts",
        "scripts/verify.mts",
      ]),
    ).toEqual([
      {
        config: "test/vitest/vitest.unit-fast.config.ts",
        forwardedArgs: [],
        includePatterns: [
          "test/scripts/check.test.ts",
          "test/scripts/test-force.test.ts",
          "test/scripts/verify.test.ts",
        ],
        watchMode: false,
      },
      {
        config: "test/vitest/vitest.tooling.config.ts",
        forwardedArgs: [],
        includePatterns: [
          "test/scripts/build-all.test.ts",
          "test/scripts/check-dynamic-import-warts.test.ts",
          "test/scripts/lint-status.test.ts",
          "test/scripts/run-oxlint.test.ts",
          "test/scripts/tsdown-build.test.ts",
        ],
        watchMode: false,
      },
    ]);
  });

  it("routes explicit source files through precise owner tests before broad globs", () => {
    expectSingleVitestRunPlan(buildVitestRunPlans(["src/gateway/server-startup-early.ts"]), {
      config: "test/vitest/vitest.gateway.config.ts",
      includePatterns: ["src/gateway/server-startup-early.test.ts"],
    });
    expectSingleVitestRunPlan(buildVitestRunPlans(["src/commands/onboarding-plugin-install.ts"]), {
      config: "test/vitest/vitest.commands.config.ts",
      includePatterns: ["src/commands/onboarding-plugin-install.test.ts"],
    });
  });

  it("routes gateway package targets through the gateway-client lane", () => {
    expectSingleVitestRunPlan(
      buildVitestRunPlans([
        "packages/gateway-client/src/timeouts.test.ts",
        "packages/gateway-protocol/src/frame-guards.test.ts",
      ]),
      {
        config: "test/vitest/vitest.gateway-client.config.ts",
        includePatterns: [
          "packages/gateway-client/src/timeouts.test.ts",
          "packages/gateway-protocol/src/frame-guards.test.ts",
        ],
      },
    );
  });

  it.each(["src/selector/one.test.ts", "./src/selector/one.test.ts"])(
    "records exact default-unit ownership for %s without removing CLI filters",
    (target) => {
      withTinyFileTree({ "src/selector/one.test.ts": "" }, (cwd) => {
        expectSingleVitestRunPlan(buildVitestRunPlans([target, "--", "-t", "case"], cwd), {
          config: "test/vitest/vitest.unit.config.ts",
          forwardedArgs: ["-t", "case", target],
          includePatterns: ["src/selector/one.test.ts"],
        });
      });
    },
  );

  it.each([
    ["src/selector/missing.test.ts"],
    ["src/selector/one.spec.ts"],
    ["src/selector/*.test.ts"],
    ["src/selector/one.test.ts", "src/selector/one.spec.ts"],
    ["src/selector/one.test.ts", "src/selector/missing.test.ts"],
    ["src/selector/one.live.test.ts"],
    ["outside/one.test.ts"],
  ])("keeps unsupported default-unit targets on the CLI route: %j", (...targets) => {
    withTinyFileTree(
      {
        "src/selector/one.test.ts": "",
        "src/selector/one.spec.ts": "",
        "src/selector/one.live.test.ts": "",
        "outside/one.test.ts": "",
      },
      (cwd) => {
        expectSingleVitestRunPlan(buildVitestRunPlans(targets, cwd), {
          config: "test/vitest/vitest.unit.config.ts",
          forwardedArgs: targets,
        });
      },
    );
  });

  it("preserves absolute and watch default-unit target semantics", () => {
    const target = "src/selector/one.test.ts";
    withTinyFileTree({ [target]: "" }, (cwd) => {
      const absolute = path.join(cwd, target);
      expectSingleVitestRunPlan(buildVitestRunPlans([absolute], cwd), {
        config: "test/vitest/vitest.unit.config.ts",
        forwardedArgs: [absolute],
      });
      expectSingleVitestRunPlan(buildVitestRunPlans(["--watch", target], cwd), {
        config: "test/vitest/vitest.unit.config.ts",
        forwardedArgs: [target],
        watchMode: true,
      });
    });
  });

  it("keeps inherited default-unit include files intersected with the CLI target", () => {
    const target = "src/selector/one.test.ts";
    withTinyFileTree({ [target]: "", "include.json": JSON.stringify([]) }, (cwd) => {
      const includeFile = path.join(cwd, "include.json");
      const [spec] = createVitestRunSpecs([target], {
        cwd,
        baseEnv: { OPENCLAW_VITEST_INCLUDE_FILE: includeFile },
      });
      expect(spec).toMatchObject({
        config: "test/vitest/vitest.unit.config.ts",
        includePatterns: null,
        includeFilePath: null,
        env: { OPENCLAW_VITEST_INCLUDE_FILE: includeFile },
      });
      expect(spec?.pnpmArgs.at(-1)).toBe(target);
      expect(fs.readFileSync(includeFile, "utf8")).toBe("[]");
    });
  });

  it.each(["test/scripts/run-node.test.ts", "extensions/matrix/src/matrix/client/storage.test.ts"])(
    "keeps owned include selection independent of missing borrowed metadata: %s",
    (target) => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-owned-include-"));
      try {
        const borrowed = path.join(tempDir, "missing.json");
        const [spec] = createVitestRunSpecs([target], {
          baseEnv: { OPENCLAW_VITEST_INCLUDE_FILE: borrowed },
        });
        expect(spec?.includePatterns).toEqual([target]);
        expect(spec?.includeFilePath).toBeTruthy();
        expect(spec?.env.OPENCLAW_VITEST_INCLUDE_FILE).toBe(spec?.includeFilePath);
        expect(spec?.env.OPENCLAW_VITEST_INCLUDE_FILE).not.toBe(borrowed);
        expect(fs.existsSync(borrowed)).toBe(false);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    },
  );

  it.each([false, true])(
    "preserves mixed target order with directory first=%s",
    (directoryFirst) => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-include-order-"));
      try {
        const owned = "test/scripts/run-node.test.ts";
        const selected = "test/helpers/temp-dir.test.ts";
        const borrowed = path.join(tempDir, "include.json");
        fs.writeFileSync(borrowed, JSON.stringify([selected]));
        const args = directoryFirst ? ["test/helpers", owned] : [owned, "test/helpers"];
        const [spec] = createVitestRunSpecs(args, {
          baseEnv: { OPENCLAW_VITEST_INCLUDE_FILE: borrowed },
        });
        expect(spec?.includePatterns).toEqual(
          directoryFirst ? [selected, owned] : [owned, selected],
        );
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    },
  );

  it("keeps an owned worker file beside a restricted directory selection", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-owned-directory-"));
    try {
      const owned = "extensions/matrix/src/matrix/client/storage.test.ts";
      const selected = "extensions/matrix/src/matrix/sdk/idb-persistence.test.ts";
      const borrowed = path.join(tempDir, "include.json");
      fs.writeFileSync(borrowed, JSON.stringify([selected]));
      const specs = createVitestRunSpecs([owned, "extensions/matrix/src/matrix/sdk"], {
        baseEnv: { OPENCLAW_VITEST_INCLUDE_FILE: borrowed },
      });
      const worker = specs.find(
        (spec) => spec.config === "test/vitest/vitest.extension-database-workers.config.ts",
      );
      expect(worker?.includePatterns?.toSorted()).toEqual([owned, selected].toSorted());
      expect(fs.readFileSync(borrowed, "utf8")).toBe(JSON.stringify([selected]));
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("routes explicit imported source files through import-graph tests", () => {
    let plans: ReturnType<typeof buildVitestRunPlans> = [];
    withTinyGitRepo(
      {
        "src/runtime.ts": "export const value = 'x';\n",
        "src/runtime.consumer.test.ts": "import { value } from './runtime.js';\nvoid value;\n",
      },
      (cwd) => {
        plans = buildVitestRunPlans(["src/runtime.ts"], cwd);
      },
    );

    expect(plans).toEqual([
      {
        config: "test/vitest/vitest.unit.config.ts",
        forwardedArgs: ["src/runtime.consumer.test.ts"],
        includePatterns: ["src/runtime.consumer.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("deduplicates explicit source tests that share import-graph owners", () => {
    let plans: ReturnType<typeof buildVitestRunPlans> = [];
    withTinyGitRepo(
      {
        "src/runtime-a.ts": "export const a = 'a';\n",
        "src/runtime-b.ts": "export const b = 'b';\n",
        "src/runtime.consumer.test.ts":
          "import { a } from './runtime-a.js';\nimport { b } from './runtime-b.js';\nvoid [a, b];\n",
      },
      (cwd) => {
        plans = buildVitestRunPlans(["src/runtime-a.ts", "src/runtime-b.ts"], cwd);
      },
    );

    expect(plans).toEqual([
      {
        config: "test/vitest/vitest.unit.config.ts",
        forwardedArgs: ["src/runtime.consumer.test.ts"],
        includePatterns: ["src/runtime.consumer.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("preserves Git membership for large changed and explicit test inventories", () => {
    withTinyGitRepo(
      {
        ".gitignore": "src/runtime.ignored.test.ts\n",
        "src/runtime.ts": "export const value = 1;\n",
        "src/runtime.consumer.test.ts": 'import "./runtime.js";\n',
      },
      (cwd) => {
        // Index-only padding reproduces a large checkout without thousands of fixture files.
        const blob = spawnSync("git", ["hash-object", "-w", "--stdin"], {
          cwd,
          encoding: "utf8",
          input: "",
        });
        expect(blob.status).toBe(0);
        const padding = Array.from(
          { length: 6_000 },
          (_, index) =>
            `100644 ${blob.stdout.trim()}\tsrc/padding/${index}-${"x".repeat(190)}.ts\n`,
        ).join("");
        const indexed = spawnSync("git", ["update-index", "--index-info"], {
          cwd,
          input: padding,
        });
        expect(indexed.status).toBe(0);
        for (const root of ["extensions", "packages", "ui/src", "ui/config", "test"]) {
          fs.mkdirSync(path.join(cwd, root), { recursive: true });
        }
        fs.writeFileSync(
          path.join(cwd, "src/runtime.untracked.test.ts"),
          'import "./runtime.js";\n',
        );
        fs.writeFileSync(path.join(cwd, "src/runtime.ignored.test.ts"), 'import "./runtime.js";\n');

        expect(resolveChangedTestTargetPlan(["src/runtime.ts"], { cwd }).targets).toEqual([
          "src/runtime.consumer.test.ts",
        ]);
        const includeFile = path.join(cwd, "include.json");
        writeVitestIncludeFile(includeFile, ["src/**/*.test.ts"], { cwd });
        expect(JSON.parse(fs.readFileSync(includeFile, "utf8")).toSorted()).toEqual([
          "src/runtime.consumer.test.ts",
          "src/runtime.untracked.test.ts",
        ]);
      },
    );
  });

  it("follows converging import frontiers without crossing test boundaries", () => {
    withTinyGitRepo(
      {
        "src/value.ts": 'export * from "./left/bridge.js";\n',
        "src/left/bridge.ts": 'export\n * from\n "../value.js";\n',
        "src/right/bridge.ts": 'export * from "../value.js";\n',
        "src/other/bridge.ts": "export const unrelated = 1;\n",
        "src/combined.consumer.test.ts":
          'import\u00a0"./left/bridge.js";\nimport(\n"./right/bridge.js"\n);\n',
        "src/right.consumer.test.ts": 'import "./right/bridge.js";\n',
        "src/other.consumer.test.ts": 'import "./other/bridge.js";\n',
        "src/after-test.consumer.test.ts": 'import "./combined.consumer.test.js";\n',
        "src/value.consumer.live.test.ts": 'import "./value.js";\n',
      },
      (cwd) => {
        expect(resolveChangedTestTargetPlan(["src/value.ts"], { cwd }).targets).toEqual([
          "src/combined.consumer.test.ts",
          "src/right.consumer.test.ts",
        ]);
      },
    );
  });

  it.each([false, true])(
    "keeps broad-name consumers complete without synchronous source opens (narrow importer: %s)",
    (includeNarrowImporter) => {
      const files: Record<string, string> = {
        "src/owner/value.ts": "export const value = 1;\n",
        "src/owner/barrel.ts": 'export\n { value } from\n "./value.js";\n',
        "src/owner/directory/index.ts": 'export * from "../barrel.js";\n',
        "src/owner/consumer.test.ts": 'import(\n "./directory"\n);\n',
        "src/owner/type.consumer.test.ts": 'import type {\n Value\n } from "./value.js";\n',
        "src/owner/deleted.test.ts": 'import "./value.js";\n',
        "src/owner/value.live.test.ts": 'import "./value.js";\n',
      };
      if (includeNarrowImporter) {
        files["src/outside.consumer.test.ts"] = 'import "./owner/value.js";\n';
      }
      // A narrow path match must not hide consumers of a widely occurring basename.
      for (let index = 0; index < 801; index += 1) {
        files[`src/padding/${index}.ts`] = "// value\n";
      }
      withTinyGitRepo(files, (cwd) => {
        fs.unlinkSync(path.join(cwd, "src/owner/deleted.test.ts"));
        fs.writeFileSync(path.join(cwd, "src/owner/untracked.test.ts"), 'import "./value.js";\n');
        const reads = vi.spyOn(fs, "readFileSync");
        try {
          const expectedTargets = [
            ...(includeNarrowImporter ? ["src/outside.consumer.test.ts"] : []),
            "src/owner/consumer.test.ts",
            "src/owner/type.consumer.test.ts",
          ];
          expect(
            resolveChangedTestTargetPlan(["src/owner/value.ts"], { cwd }).targets,
            "initial owner selection",
          ).toEqual(expectedTargets);
          expect(
            resolveChangedTestTargetPlan(["src/owner/value.ts"], { cwd }).targets,
            "cached owner selection",
          ).toEqual(expectedTargets);
          expect(
            reads.mock.calls.filter(([file]) => typeof file === "string" && file.startsWith(cwd)),
          ).toEqual([]);
        } finally {
          reads.mockRestore();
        }
      });
    },
  );

  it.each([
    { name: "Git inventory", withRepo: withTinyGitRepo },
    { name: "filesystem inventory", withRepo: withTinyFileTree },
  ])(
    "keeps tooling imports direct while preserving literal file references ($name)",
    ({ withRepo }) => {
      const files: Record<string, string> = {
        "scripts/fixture-source.mts": "export const value = 1;\n",
        "scripts/fixture-bridge.mts": 'export * from "./fixture-source.mjs";\n',
        "test/scripts/direct.consumer.test.ts": 'import "../../scripts/fixture-source.mjs";\n',
        "test/scripts/transitive.consumer.test.ts": 'import "../../scripts/fixture-bridge.mjs";\n',
        "test/scripts/literal.consumer.test.ts": 'const fixture = "scripts/fixture-source.mts";\n',
        "test/scripts/substring.consumer.test.ts":
          'const fixture = "scripts/fixture-source.mts.bak";\n',
      };
      for (let index = 0; index < 801; index += 1) {
        files[`src/padding/${index}.ts`] = "// scripts/fixture-source\n";
      }
      withRepo(files, (cwd) => {
        expect(
          resolveChangedTestTargetPlan(["scripts/fixture-source.mts"], { cwd }).targets,
        ).toEqual([
          "test/scripts/direct.consumer.test.ts",
          "test/scripts/literal.consumer.test.ts",
        ]);
      });
    },
  );

  it.each([
    { name: "Git inventory", withRepo: withTinyGitRepo },
    { name: "filesystem inventory", withRepo: withTinyFileTree },
  ])("routes test helper and file-URL fixture consumers completely ($name)", ({ withRepo }) => {
    const fixture = "test/scripts/fixtures/worker.mjs";
    const helper = "test/scripts/runtime.test-support.ts";
    const direct = "test/scripts/direct.consumer.test.ts";
    const indirect = "test/scripts/indirect.consumer.test.ts";
    const opaque = "test/scripts/opaque/index.mjs";
    const explicitHelper = "test/scripts/source/input.test-support.ts";
    const explicitConsumer = "test/scripts/outer/consumer.test.ts";
    withRepo(
      {
        [fixture]: "export {};\n",
        [helper]:
          'export const worker = new URL("./fixtures/worker.mjs?generation=1#child", import.meta.url);\n',
        "test/scripts/bridge.test-support.ts": 'export * from "./runtime.test-support.js";\n',
        [direct]: 'import "./runtime.test-support.js";\n',
        [indirect]: 'import "./bridge.test-support.js";\n',
        "test/scripts/after-test.consumer.test.ts": 'import "./direct.consumer.test.js";\n',
        "test/scripts/unrelated.consumer.test.ts": "export {};\n",
        "test/scripts/live.consumer.live.test.ts": 'import "./runtime.test-support.js";\n',
        [opaque]: "export {};\n",
        "test/scripts/literal.opaque.consumer.test.ts": `const fixture = "${opaque}";\n`,
        "test/scripts/relative.opaque.consumer.test.ts": 'import "./opaque/index.mjs";\n',
        [explicitHelper]: "export const value = 1;\n",
        "test/scripts/bridge/index.ts": 'export * from "../source/input.test-support.js";\n',
        [explicitConsumer]: 'import "../bridge/index.js";\n',
      },
      (cwd) => {
        const options = { cwd, broad: true, forceFullImportGraph: true };
        for (const changed of [fixture, helper]) {
          expect(resolveChangedTestTargetPlan([changed], options)).toEqual({
            mode: "targets",
            targets: [direct, indirect],
          });
        }
        // A literal reference alone cannot prove an opaque helper's complete frontier.
        expect(resolveChangedTestTargetPlan([opaque, direct], options)).toEqual({
          mode: "targets",
          targets: [opaque, direct],
        });
        expect(buildVitestRunPlans([explicitHelper], cwd)).toEqual([
          {
            config: "test/vitest/vitest.tooling.config.ts",
            forwardedArgs: [],
            includePatterns: [explicitConsumer],
            watchMode: false,
          },
        ]);
      },
    );
  });

  it.each([false, true])(
    "retains an unowned changed tooling test alongside its consumers (mixed input: %s)",
    (mixedInput) => {
      const changedTest = "test/e2e/qa-lab/runtime/changed-tooling.test.ts";
      const reader = "test/scripts/tooling-reader.test.ts";
      const otherTest = "src/independent.test.ts";
      withTinyGitRepo(
        {
          [changedTest]: "export const value = 1;\n",
          [reader]:
            'import "../e2e/qa-lab/runtime/changed-tooling.test.js";\n' +
            `const fixture = "${changedTest}";\n`,
          [otherTest]: "export const independent = true;\n",
        },
        (cwd) => {
          const inputs = mixedInput ? [changedTest, otherTest, changedTest] : [changedTest];
          expect(resolveChangedTestTargetPlan(inputs, { cwd })).toEqual({
            mode: "targets",
            targets: [changedTest, reader, ...(mixedInput ? [otherTest] : [])],
          });
        },
      );
    },
  );

  it.each([
    {
      changedPath: "scripts/unowned-source.mts",
      expectedTargets: ["test/scripts/tooling-reader.test.ts"],
    },
    {
      changedPath: "test/scripts/owned.test.ts",
      expectedTargets: ["test/scripts/owned.test.ts"],
    },
    {
      changedPath: "test/e2e/qa-lab/runtime/changed-tooling.live.test.ts",
      expectedTargets: ["test/scripts/tooling-reader.test.ts"],
    },
  ])(
    "preserves non-test, explicit-owner, and live selection for $changedPath",
    ({ changedPath, expectedTargets }) => {
      withTinyGitRepo(
        {
          [changedPath]: "export const value = 1;\n",
          "test/scripts/tooling-reader.test.ts": `const fixture = "${changedPath}";\n`,
        },
        (cwd) => {
          expect(resolveChangedTestTargetPlan([changedPath], { cwd })).toEqual({
            mode: "targets",
            targets: expectedTargets,
          });
        },
      );
    },
  );

  it("routes many explicit source files through one import-graph-backed owner set", () => {
    let plans: ReturnType<typeof buildVitestRunPlans> = [];
    const files: Record<string, string> = {};
    const imports: string[] = [];
    const refs: string[] = [];
    for (let index = 0; index < 13; index += 1) {
      files[`src/runtime-${index}.ts`] = `export const value${index} = ${index};\n`;
      imports.push(`import { value${index} } from './runtime-${index}.js';`);
      refs.push(`value${index}`);
    }
    files["src/runtime.consumer.test.ts"] = `${imports.join("\n")}\nvoid [${refs.join(", ")}];\n`;

    withTinyFileTree(files, (cwd) => {
      plans = buildVitestRunPlans(
        Array.from({ length: 13 }, (_, index) => `src/runtime-${index}.ts`),
        cwd,
      );
    });

    expect(plans).toEqual([
      {
        config: "test/vitest/vitest.unit.config.ts",
        forwardedArgs: ["src/runtime.consumer.test.ts"],
        includePatterns: ["src/runtime.consumer.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("does not route live tests through the normal changed-test lane", () => {
    expectChangedTargets(["src/gateway/gateway-codex-harness.live.test.ts"], []);
  });

  it("routes changed extension vitest configs to their own shard", () => {
    expectSingleVitestRunPlan(
      buildVitestRunPlans(["--changed", "origin/main"], process.cwd(), () => [
        "test/vitest/vitest.extension-discord.config.ts",
      ]),
      { config: "test/vitest/vitest.extension-discord.config.ts" },
    );
  });

  it("routes the shell helper test to the isolated tooling shard", () => {
    expectSingleVitestRunPlan(
      buildVitestRunPlans(["--changed", "origin/main"], process.cwd(), () => [
        "test/scripts/openclaw-e2e-instance.test.ts",
      ]),
      {
        config: "test/vitest/vitest.tooling-isolated.config.ts",
        includePatterns: ["test/scripts/openclaw-e2e-instance.test.ts"],
      },
    );
  });

  it.each([
    "test/plugins/bundled-provider-auth-literal-parity.test.ts",
    "test/plugins/bundled-provider-auth-literal-parity.2.test.ts",
    "test/plugins/bundled-provider-auth-literal-parity.3.test.ts",
  ])("routes bundled provider auth parity test %s to the isolated tooling shard", (testFile) => {
    expectSingleVitestRunPlan(buildVitestRunPlans([testFile]), {
      config: "test/vitest/vitest.tooling-isolated.config.ts",
      includePatterns: [testFile],
    });
  });

  it.each([
    "test/scripts/check-extension-package-tsc-boundary.test.ts",
    "test/scripts/check-plugin-sdk-wildcard-reexports.test.ts",
    "test/scripts/control-ui-i18n.test.ts",
  ])("routes process-group test %s to the isolated tooling shard", (testFile) => {
    expectSingleVitestRunPlan(buildVitestRunPlans([testFile]), {
      config: "test/vitest/vitest.tooling-isolated.config.ts",
      includePatterns: [testFile],
    });
  });

  it.each([
    "src/gateway/health/collector.queue-health.test.ts",
    "src/gateway/server-methods/server-methods.test.ts",
  ])("routes health SQLite consumer %s exactly once to its broker owner", (testFile) => {
    expectSingleVitestRunPlan(buildVitestRunPlans([testFile]), {
      config: "test/vitest/vitest.gateway-database-workers.config.ts",
      includePatterns: [testFile],
    });
    expect(gatewayDatabaseWorkerTestFiles.filter((file) => file === testFile)).toEqual([testFile]);
  });

  it.each(gatewayDatabaseWorkerTestFiles)(
    "routes Gateway database consumer %s to its fork owner",
    (testFile) => {
      expectSingleVitestRunPlan(buildVitestRunPlans([testFile]), {
        config: "test/vitest/vitest.gateway-database-workers.config.ts",
        includePatterns: [testFile],
      });
    },
  );

  it.each(
    ["src/gateway", "src/gateway/**/*.test.ts"].flatMap((target) =>
      ["alone", "worker-first", "aggregate-first"].map((order) => ({ target, order })),
    ),
  )(
    "keeps Gateway database consumers in the aggregate for $target ($order)",
    ({ target, order }) => {
      const [workerFile] = gatewayDatabaseWorkerTestFiles;
      assert(workerFile);
      const targets =
        order === "alone"
          ? [target]
          : order === "worker-first"
            ? [workerFile, target]
            : [target, workerFile];
      const forwardedArgs = ["--reporter=dot", "--coverage"];
      expect(buildVitestRunPlans([...targets, ...forwardedArgs])).toEqual([
        {
          config: "test/vitest/vitest.gateway.config.ts",
          forwardedArgs,
          includePatterns: targets.map((file) =>
            file === "src/gateway" ? "src/gateway/**/*.test.ts" : file,
          ),
          watchMode: false,
        },
        {
          config: "test/vitest/vitest.infra.config.ts",
          forwardedArgs,
          includePatterns: ["src/gateway/server-methods/memory-search.test.ts"],
          watchMode: false,
        },
      ]);
    },
  );

  it.each(
    [
      "test/vitest/vitest.gateway.config.ts",
      "src/gateway/config-reload.telegram-policy.test.ts",
    ].flatMap((target) => [true, false].map((workerFirst) => ({ target, workerFirst }))),
  )(
    "coalesces Gateway worker config with $target (worker first: $workerFirst)",
    ({ target, workerFirst }) => {
      const workerConfig = "test/vitest/vitest.gateway-database-workers.config.ts";
      const targets = workerFirst ? [workerConfig, target] : [target, workerConfig];
      expectSingleVitestRunPlan(buildVitestRunPlans(targets), {
        config: "test/vitest/vitest.gateway.config.ts",
        includePatterns: target.endsWith(".config.ts")
          ? null
          : workerFirst
            ? [...gatewayDatabaseWorkerTestFiles, target]
            : [target, ...gatewayDatabaseWorkerTestFiles],
      });
    },
  );

  it.each([
    "src/agents/command/session-store.test.ts",
    "src/state/openclaw-state-db.test.ts",
    "src/worker/worker.runtime.test.ts",
  ])("routes native shared-state consumer %s exactly once to its broker owner", (testFile) => {
    expectSingleVitestRunPlan(buildVitestRunPlans([testFile]), {
      config: "test/vitest/vitest.infra.config.ts",
      includePatterns: [testFile],
    });
    expect(databaseWorkerCoreTestFiles.filter((file) => file === testFile)).toEqual([testFile]);
  });

  it.each(databaseWorkerCoreTestFiles)(
    "routes host-owned database consumer %s to the infra fork shard",
    (testFile) => {
      expectSingleVitestRunPlan(buildVitestRunPlans([testFile]), {
        config: "test/vitest/vitest.infra.config.ts",
        includePatterns: [testFile],
      });
    },
  );

  it.each([
    "src/logging/diagnostic-session-context.test.ts",
    "src/logging/diagnostic-stuck-session-recovery.runtime.test.ts",
    "src/state/openclaw-state-db.test.ts",
  ])("routes cron save-only fixture %s to the existing fork owner", (testFile) => {
    expectSingleVitestRunPlan(buildVitestRunPlans([testFile]), {
      config: "test/vitest/vitest.infra.config.ts",
      includePatterns: [testFile],
    });
  });

  it.each([
    ["src/plugin-sdk/memory-host-events.ts", "src/plugin-sdk/memory-host-events.test.ts"],
    ["src/plugin-sdk/persistent-dedupe.ts", "src/plugin-sdk/memory-host-events.test.ts"],
    [
      "src/wizard/setup.inference-recovery.integration.test.ts",
      "src/wizard/setup.inference-recovery.integration.test.ts",
    ],
  ])("preserves database consumer coverage for source target %s", (sourceFile, testFile) => {
    expectSingleVitestRunPlan(buildVitestRunPlans([sourceFile]), {
      config: "test/vitest/vitest.infra.config.ts",
      includePatterns: [testFile],
    });
  });

  it.each([
    ["src/agents/**/*.test.ts", "test/vitest/vitest.agents.config.ts"],
    ["test/plugins", "test/vitest/vitest.tooling.config.ts"],
    ["test/scripts", "test/vitest/vitest.tooling.config.ts"],
    ["src/plugin-state", "test/vitest/vitest.unit.config.ts"],
  ])("preserves watch selection across database ownership for %s", (target, owner) => {
    expect(buildVitestRunPlans(["--watch", target])).toEqual([
      {
        config: "test/vitest/vitest.database-worker-watch.config.ts",
        databaseWorkerWatchOwner: owner,
        databaseWorkerWatchTests: databaseWorkerCoreTestFiles.filter((file) =>
          file.startsWith(`${target.split("/**")[0]}/`),
        ),
        forwardedArgs: [],
        includePatterns: [target.endsWith(".test.ts") ? target : `${target}/**/*.test.ts`],
        watchMode: true,
      },
    ]);
  });

  it.each([
    ["src/agents/**/*.test.ts", "src/agents/**/memory-*.test.ts", "src/agents/**/memory-*.test.ts"],
    [
      "extensions/matrix",
      "extensions/matrix/**/storage.test.ts",
      "extensions/matrix/**/storage.test.ts",
    ],
    [
      "extensions/matrix/**/storage.test.ts",
      "extensions/matrix/**/*.test.ts",
      "extensions/matrix/**/storage.test.ts",
    ],
    [
      "extensions/matrix/**/storage.test.ts",
      "extensions/matrix/**/storage.test.ts",
      "extensions/matrix/**/storage.test.ts",
    ],
  ])("retains watch intersection for %s and %s", (directory, pattern, expected) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-worker-watch-scope-"));
    try {
      const includeFile = path.join(tempDir, "include.json");
      fs.writeFileSync(includeFile, JSON.stringify([pattern]));
      const specs = createVitestRunSpecs(["--watch", directory], {
        baseEnv: { OPENCLAW_VITEST_INCLUDE_FILE: includeFile },
      });
      expect(specs).toHaveLength(1);
      expect(specs[0]?.includePatterns).toContain(expected);
      expect(
        specs[0]?.includePatterns?.every(
          (value) => value === expected || path.matchesGlob(value, expected),
        ),
      ).toBe(true);
      expect(specs[0]?.watchMode).toBe(true);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it.each([
    ["src/agents/**/*.test.ts", "test/plugins"],
    ["src/plugin-sdk/memory-host-events.test.ts", "src/plugin-sdk/provider-auth.test.ts"],
    ["src/plugin-sdk/outbound-media.bulk.test.ts", "src/plugin-sdk/provider-auth.test.ts"],
  ])("retains the mixed watch rejection for %s and %s", (...targets) => {
    expect(() => buildVitestRunPlans(["--watch", ...targets])).toThrow(
      "watch mode with mixed test suites is not supported",
    );
  });

  it.each([
    [
      "test/vitest/vitest.plugins.config.ts",
      "src/plugins/doctor-contract-registry.load-paths.test.ts",
    ],
    ["test/vitest/vitest.plugin-sdk.config.ts", "src/plugin-sdk/provider-auth.test.ts"],
    [
      "test/vitest/vitest.unit-fast.config.ts",
      "src/agents/embedded-agent-runner/run/model-setup.selected-model.test.ts",
    ],
    [
      "test/vitest/vitest.unit-fast-isolated.config.ts",
      "src/state/openclaw-agent-execution-cleanup.test.ts",
    ],
  ])("preserves whole-owner watch coverage for %s with %s", (config, file) => {
    const [plan] = buildVitestRunPlans(["--watch", config, file]);
    expect(plan).toMatchObject({
      config: "test/vitest/vitest.database-worker-watch.config.ts",
      databaseWorkerWatchOwner: config,
      includePatterns: null,
      watchMode: true,
    });
    expect(plan?.databaseWorkerWatchTests).toContain(file);
    if (config.endsWith("vitest.plugin-sdk.config.ts")) {
      expect(plan?.databaseWorkerWatchTests).toContain("src/plugin-sdk/memory-host-core.test.ts");
      expect(plan?.databaseWorkerWatchTests).not.toContain(
        "src/plugin-sdk/memory-host-events.test.ts",
      );
      expect(plan?.databaseWorkerWatchTests).not.toContain(
        "src/plugin-sdk/outbound-media.bulk.test.ts",
      );
    }
    const [spec] = createVitestRunSpecs(["--watch", config, file], { baseEnv: {} });
    expect(spec?.includeFilePath).toBeNull();
    expect(spec?.env.OPENCLAW_VITEST_DATABASE_WORKER_WATCH_OWNER).toBe(config);
    expect(JSON.parse(spec?.env.OPENCLAW_VITEST_DATABASE_WORKER_WATCH_TESTS ?? "null")).toEqual(
      plan?.databaseWorkerWatchTests,
    );
  });

  it.each(["src/plugin-state", "src/plugin-sdk", "src/agents", "src/commands", "test/plugins"])(
    "retains database worker ownership for directory and glob target %s",
    (directory) => {
      const expected = databaseWorkerCoreTestFiles.filter((file) =>
        file.startsWith(`${directory}/`),
      );
      for (const target of [directory, `${directory}/**/*.test.ts`]) {
        const plans = buildVitestRunPlans([target]);
        const infra = plans.find((plan) => plan.config === "test/vitest/vitest.infra.config.ts");
        expect(infra?.includePatterns).toEqual(expected);
      }
    },
  );

  it.each(agentVitestProjectOwners.coreIsolated.include)(
    "routes isolated agent test %s to the isolated agents-core shard",
    (testFile) => {
      expectSingleVitestRunPlan(buildVitestRunPlans([testFile]), {
        config: "test/vitest/vitest.agents-core-isolated.config.ts",
        includePatterns: [testFile],
      });
    },
  );

  it.each(agentVitestProjectOwners.spawnProductionBoundary.include)(
    "routes production-boundary agent test %s to its dedicated shard",
    (testFile) => {
      expectSingleVitestRunPlan(buildVitestRunPlans([testFile]), {
        config: "test/vitest/vitest.agents-spawn-production-boundary.config.ts",
        includePatterns: [testFile],
      });
    },
  );

  it.each([
    ["src/agents/agent-scope.test.ts", "test/vitest/vitest.agents-core.config.ts"],
    [
      "src/agents/agent-command.compaction-rotation.test.ts",
      "test/vitest/vitest.agents-core.config.ts",
    ],
    [
      "src/agents/agent-command.embedded-maintenance.test.ts",
      "test/vitest/vitest.agents-core.config.ts",
    ],
    [
      "src/agents/embedded-agent-runner/run.before-agent-reply-cron.test.ts",
      "test/vitest/vitest.agents-embedded-agent.config.ts",
    ],
    [
      "src/agents/embedded-agent-runner/run.inherited-auth-owner.test.ts",
      "test/vitest/vitest.agents-embedded-agent.config.ts",
    ],
    [
      "src/agents/embedded-agent-runner/run.session-permissions.test.ts",
      "test/vitest/vitest.agents-embedded-agent.config.ts",
    ],
    [
      "src/agents/embedded-agent-runner/run.overflow-compaction.test.ts",
      "test/vitest/vitest.agents-embedded-agent-overflow-compaction.config.ts",
    ],
    [
      "src/agents/embedded-agent-runner/run/attempt.abort-race.test.ts",
      "test/vitest/vitest.agents-embedded-agent-run.config.ts",
    ],
    ["src/agents/runtime-plan/tools.test.ts", "test/vitest/vitest.agents-support.config.ts"],
    ["src/agents/tools/cron-tool.pacing.test.ts", "test/vitest/vitest.agents-tools.config.ts"],
  ])("routes focused agent test %s to its owning shard", (testFile, config) => {
    expect(buildVitestRunPlans([testFile])).toEqual([
      {
        config,
        forwardedArgs: [],
        includePatterns: [testFile],
        watchMode: false,
      },
    ]);
  });

  it("keeps split command compaction and model-switch tests in the runtime owner shard", () => {
    const targets = [
      "src/agents/agent-command.compaction-rotation.test.ts",
      "src/agents/agent-command.embedded-maintenance.test.ts",
      "src/agents/agent-command.live-model-switch.test.ts",
    ];
    expectSingleVitestRunPlan(buildVitestRunPlans(targets), {
      config: "test/vitest/vitest.agents-core.config.ts",
      includePatterns: targets,
    });
  });

  it("routes every split incomplete-turn test to its dedicated serial shard", () => {
    const root = "src/agents/embedded-agent-runner";
    const discovered = fs
      .readdirSync(root)
      .filter((name) => name.startsWith("run.incomplete-turn.") && name.endsWith(".test.ts"))
      .map((name) => `${root}/${name}`)
      .toSorted();
    const owned = agentVitestProjectOwners.embeddedIncompleteTurn.include.toSorted();

    expect(owned).toEqual(discovered);
    for (const testFile of discovered) {
      expect(buildVitestRunPlans([testFile])).toEqual([
        {
          config: "test/vitest/vitest.agents-embedded-agent-incomplete-turn.config.ts",
          forwardedArgs: [],
          includePatterns: [testFile],
          watchMode: false,
        },
      ]);
    }
  });

  it.each([
    {
      directory: "src/agents/embedded-agent-runner/run",
      config: "test/vitest/vitest.agents-embedded-agent-run.config.ts",
      workerFiles: databaseWorkerCoreTestFiles.filter((file) =>
        file.startsWith("src/agents/embedded-agent-runner/run/"),
      ),
    },
    {
      directory: "src/agents/runtime-plan",
      config: "test/vitest/vitest.agents-support.config.ts",
      workerFiles: [],
    },
  ])(
    "routes focused agent directory $directory across its owners",
    ({ directory, config, workerFiles }) => {
      expect(buildVitestRunPlans([directory])).toEqual([
        ...(workerFiles.length > 0
          ? [
              {
                config: "test/vitest/vitest.infra.config.ts",
                forwardedArgs: [],
                includePatterns: workerFiles,
                watchMode: false,
              },
            ]
          : []),
        {
          config,
          forwardedArgs: [directory],
          includePatterns: null,
          watchMode: false,
        },
      ]);
    },
  );

  it("splits the focused agent tools directory across its worker and tools owners", () => {
    expect(buildVitestRunPlans(["src/agents/tools"])).toEqual([
      {
        config: "test/vitest/vitest.infra.config.ts",
        forwardedArgs: [],
        includePatterns: databaseWorkerCoreTestFiles.filter((file) =>
          file.startsWith("src/agents/tools/"),
        ),
        watchMode: false,
      },
      {
        config: "test/vitest/vitest.agents-tools.config.ts",
        forwardedArgs: ["src/agents/tools"],
        includePatterns: null,
        watchMode: false,
      },
    ]);
  });

  it("keeps shuffle options on both embedded-run owners", () => {
    const directory = "src/agents/embedded-agent-runner/run";

    expect(
      buildVitestRunPlans([directory, "--", "--sequence.shuffle", "--sequence.seed", "3"]),
    ).toEqual([
      {
        config: "test/vitest/vitest.infra.config.ts",
        forwardedArgs: ["--sequence.shuffle", "--sequence.seed", "3"],
        includePatterns: databaseWorkerCoreTestFiles.filter((file) =>
          file.startsWith(`${directory}/`),
        ),
        watchMode: false,
      },
      {
        config: "test/vitest/vitest.agents-embedded-agent-run.config.ts",
        forwardedArgs: ["--sequence.shuffle", "--sequence.seed", "3", directory],
        includePatterns: null,
        watchMode: false,
      },
    ]);
  });

  it("splits the embedded-agent parent directory across every isolated harness", () => {
    const root = "src/agents/embedded-agent-runner";
    const plans = buildVitestRunPlans([root]);

    expect(plans).toEqual(
      expect.arrayContaining([
        {
          config: "test/vitest/vitest.agents-embedded-agent.config.ts",
          forwardedArgs: [],
          includePatterns: [`${root}/*.test.ts`],
          watchMode: false,
        },
        {
          config: "test/vitest/vitest.agents-embedded-agent-incomplete-turn.config.ts",
          forwardedArgs: [],
          includePatterns: agentVitestProjectOwners.embeddedIncompleteTurn.include,
          watchMode: false,
        },
        {
          config: "test/vitest/vitest.agents-embedded-agent-overflow-compaction.config.ts",
          forwardedArgs: [],
          includePatterns: [`${root}/run.overflow-compaction.test.ts`],
          watchMode: false,
        },
        {
          config: "test/vitest/vitest.agents-embedded-agent-run.config.ts",
          forwardedArgs: [],
          includePatterns: [`${root}/run/**/*.test.ts`],
          watchMode: false,
        },
      ]),
    );
    expect(plans.map((plan) => plan.config)).not.toContain("test/vitest/vitest.agents.config.ts");
  });

  it("keeps the broad agent test glob complete across agent and database owners", () => {
    const target = "src/agents/**/*.test.ts";

    expect(buildVitestRunPlans([target])).toEqual([
      {
        config: "test/vitest/vitest.infra.config.ts",
        forwardedArgs: [],
        includePatterns: databaseWorkerCoreTestFiles.filter((file) =>
          file.startsWith("src/agents/"),
        ),
        watchMode: false,
      },
      {
        config: "test/vitest/vitest.agents.config.ts",
        forwardedArgs: [],
        includePatterns: [target],
        watchMode: false,
      },
    ]);
  });

  it.each([
    [
      "src/agents/embedded-agent-runner/run/*.test.ts",
      "test/vitest/vitest.agents-embedded-agent-run.config.ts",
    ],
    ["src/agents/runtime-plan/**/*.test.ts", "test/vitest/vitest.agents-support.config.ts"],
    ["src/agents/tools/**/*.test.ts", "test/vitest/vitest.agents-tools.config.ts"],
  ])("routes focused agent glob %s to its owning shard", (target, config) => {
    const plans = buildVitestRunPlans([target]);

    expect(plans).toEqual(
      expect.arrayContaining([
        {
          config,
          forwardedArgs: [],
          includePatterns: [target],
          watchMode: false,
        },
      ]),
    );
    expect(plans.map((plan) => plan.config)).not.toContain("test/vitest/vitest.agents.config.ts");
  });

  it("keeps mixed embedded-agent and cron-tool targets in their owning shards", () => {
    const embeddedTest = "src/agents/embedded-agent-runner/run.before-agent-reply-cron.test.ts";
    const cronToolTest = "src/agents/tools/cron-tool.pacing.test.ts";

    expect(buildVitestRunPlans([embeddedTest, cronToolTest])).toEqual([
      {
        config: "test/vitest/vitest.agents-embedded-agent.config.ts",
        forwardedArgs: [],
        includePatterns: [embeddedTest],
        watchMode: false,
      },
      {
        config: "test/vitest/vitest.agents-tools.config.ts",
        forwardedArgs: [],
        includePatterns: [cronToolTest],
        watchMode: false,
      },
    ]);
  });

  it("routes Docker E2E script targets to their owner tooling tests", () => {
    const targets = [
      "scripts/e2e/kitchen-sink-plugin-docker.sh",
      "scripts/e2e/kitchen-sink-rpc-docker.sh",
      "scripts/e2e/kitchen-sink-rpc-walk.mts",
      "scripts/e2e/onboard-docker.sh",
      "scripts/e2e/lib/plugin-lifecycle-matrix/measure.mjs",
      "scripts/e2e/plugin-lifecycle-matrix-docker.sh",
      "scripts/e2e/release-media-memory-docker.sh",
    ];

    expect(findUnmatchedExplicitTestTargets(targets)).toEqual([]);
    expect(buildVitestRunPlans(targets, process.cwd())).toEqual([
      {
        config: "test/vitest/vitest.tooling-docker.config.ts",
        forwardedArgs: [],
        includePatterns: ["test/scripts/docker-build-helper.test.ts"],
        watchMode: false,
      },
      {
        config: "test/vitest/vitest.tooling.config.ts",
        forwardedArgs: [],
        includePatterns: [
          "test/scripts/plugin-prerelease-test-plan.test.ts",
          "test/scripts/kitchen-sink-rpc-walk.test.ts",
          "test/scripts/openclaw-test-state.test.ts",
          "test/scripts/plugin-lifecycle-measure.test.ts",
          "test/scripts/docker-e2e-plan.test.ts",
          "test/scripts/release-media-memory-scenario.test.ts",
        ],
        watchMode: false,
      },
    ]);
  });

  it("routes changed Parallels process helpers to their owner tooling tests", () => {
    expectSingleVitestRunPlan(
      buildVitestRunPlans(["--changed", "origin/main"], process.cwd(), () => [
        "scripts/e2e/parallels/filesystem.ts",
        "scripts/e2e/parallels/guest-transports.ts",
        "scripts/e2e/parallels/host-command.ts",
        "scripts/e2e/parallels/host-server.ts",
        "scripts/e2e/parallels/linux-smoke.ts",
        "scripts/e2e/parallels/phase-runner.ts",
        "scripts/e2e/parallels/macos-smoke.ts",
        "scripts/e2e/parallels-macos-smoke.sh",
        "scripts/e2e/parallels-linux-smoke.sh",
        "scripts/e2e/parallels-npm-update-smoke.sh",
        "scripts/e2e/parallels/npm-update-smoke.ts",
        "scripts/e2e/parallels/npm-update-scripts.ts",
        "scripts/e2e/parallels/smoke-common.ts",
        "scripts/e2e/parallels/update-job-timeout.ts",
        "scripts/e2e/parallels/windows-smoke.ts",
        "scripts/e2e/parallels-windows-smoke.sh",
      ]),
      {
        config: "test/vitest/vitest.tooling.config.ts",
        includePatterns: [
          "test/scripts/parallels-smoke-model.test.ts",
          "test/scripts/parallels-npm-update-smoke.test.ts",
          "test/scripts/parallels-update-job-timeout.test.ts",
        ],
      },
    );
  });

  it("routes mac restart helpers through restart-mac owner tests", () => {
    expectChangedTargets(
      ["scripts/lib/restart-mac-gateway.sh"],
      ["test/scripts/build-and-run-mac.test.ts", "test/scripts/restart-mac.test.ts"],
    );
  });

  it("routes the shared MCP scenario through its Docker and client owners", () => {
    expectChangedTargets(
      ["scripts/e2e/lib/mcp-code-mode/scenario.sh"],
      [
        "test/scripts/docker-build-helper.test.ts",
        "test/scripts/docker-e2e-plan.test.ts",
        "test/scripts/plugin-prerelease-test-plan.test.ts",
        "test/scripts/mcp-code-mode-gateway-client.test.ts",
        "test/scripts/session-log-mentions.test.ts",
      ],
    );
  });

  it("routes MCP and cron Docker E2E script targets instead of skipping changed tests", () => {
    const targets = [
      "scripts/e2e/mcp-channels-docker.sh",
      "test/e2e/qa-lab/runtime/mcp-channels-docker-client.ts",
      "test/e2e/qa-lab/runtime/mcp-channels.fixture.ts",
      "test/e2e/qa-lab/runtime/mcp-client-temp-state.fixture.ts",
      "scripts/e2e/mcp-code-mode-gateway-docker.sh",
      "scripts/e2e/mcp-code-mode-gateway-live-docker.sh",
      "scripts/e2e/agent-bundle-mcp-tools-docker.sh",
      "test/e2e/qa-lab/runtime/agent-bundle-mcp-tools-docker-client.ts",
      "scripts/mcp-code-mode-gateway-e2e.ts",
      "scripts/e2e/cron-cli-docker.sh",
      "scripts/e2e/cron-mcp-cleanup-docker.sh",
      "scripts/e2e/cron-mcp-cleanup-docker-client.ts",
    ];

    expect(findUnmatchedExplicitTestTargets(targets)).toEqual([]);
    expectChangedTargets(targets, [
      "test/scripts/docker-build-helper.test.ts",
      "test/scripts/docker-e2e-observability.test.ts",
      "test/scripts/docker-e2e-plan.test.ts",
      "test/scripts/plugin-prerelease-test-plan.test.ts",
      "test/e2e/qa-lab/runtime/mcp-gateway-transport.e2e.test.ts",
      "test/scripts/cron-mcp-cleanup-docker-client.test.ts",
      "test/scripts/mcp-code-mode-gateway-client.test.ts",
      "test/scripts/session-log-mentions.test.ts",
      "src/agents/agent-bundle-mcp-runtime.test.ts",
      "src/agents/agent-bundle-mcp-tools.materialize.test.ts",
      "src/gateway/server.cron.test.ts",
      "src/gateway/server-methods/agent.test.ts",
      "src/cron/isolated-agent/run.fast-mode.test.ts",
      "src/cron/active-jobs-manual-run.test.ts",
    ]);
  });

  it("routes OpenAI image auth Docker E2E script targets instead of skipping changed tests", () => {
    const targets = [
      "scripts/e2e/openai-image-auth-docker.sh",
      "test/e2e/qa-lab/runtime/openai-image-auth-docker-client.ts",
    ];

    expect(findUnmatchedExplicitTestTargets(targets)).toEqual([]);
    expectChangedTargets(targets, [
      "test/scripts/docker-build-helper.test.ts",
      "test/scripts/docker-e2e-plan.test.ts",
      "test/scripts/openai-image-auth-docker-client.test.ts",
      "extensions/openai/image-generation-provider.test.ts",
      "src/image-generation/openai-compatible-image-provider.test.ts",
    ]);
  });

  it("routes package-backed Docker shell targets instead of skipping changed tests", () => {
    const targets = [
      "scripts/e2e/codex-media-path-docker.sh",
      "scripts/e2e/codex-npm-plugin-live-docker.sh",
      "scripts/e2e/codex-on-demand-docker.sh",
      "scripts/e2e/live-plugin-tool-docker.sh",
      "scripts/e2e/plugin-binding-command-escape-docker.sh",
      "scripts/e2e/qr-import-docker.sh",
    ];

    expect(findUnmatchedExplicitTestTargets(targets)).toEqual([]);
    expectChangedTargets(targets, [
      "test/scripts/docker-build-helper.test.ts",
      "test/scripts/docker-e2e-plan.test.ts",
      "test/scripts/codex-media-path-client.test.ts",
      "test/scripts/package-acceptance-workflow.test.ts",
      "test/scripts/live-plugin-tool-assertions.test.ts",
      "test/scripts/plugin-binding-command-escape-docker.test.ts",
    ]);
  });

  it("routes OpenClaw Docker E2E script targets instead of skipping changed tests", () => {
    const targets = [
      "scripts/e2e/system-agent-first-run-docker.sh",
      "test/e2e/qa-lab/runtime/system-agent-first-run-docker-client.ts",
      "scripts/e2e/system-agent-first-run-spec.json",
      "scripts/e2e/system-agent-rescue-docker.sh",
      "scripts/e2e/system-agent-rescue-docker-client.ts",
    ];

    expect(findUnmatchedExplicitTestTargets(targets)).toEqual([]);
    expectChangedTargets(targets, [
      "test/scripts/docker-build-helper.test.ts",
      "test/scripts/docker-e2e-plan.test.ts",
      "src/cli/program/register.onboard.test.ts",
      "src/cli/run-main.test.ts",
      "src/cli/run-main.exit.test.ts",
      "src/commands/system-agent-with-inference.test.ts",
      "src/system-agent/assistant.configured.test.ts",
      "src/system-agent/assistant.test.ts",
      "src/system-agent/system-agent.test.ts",
      "src/system-agent/operations.test.ts",
      "src/system-agent/overview.test.ts",
      "src/system-agent/audit.test.ts",
      "src/system-agent/rescue-policy.test.ts",
      "src/system-agent/rescue-message.test.ts",
    ]);
  });

  it.each([
    ["chunks the broad shell helper tooling shard after isolated targets", "test/scripts"],
    ["chunks broad shell helper globs after isolated targets", "test/scripts/*.test.ts"],
  ])("%s", (_title, target) => {
    const plans = buildVitestRunPlans([target, "--reporter=dot"], process.cwd());
    const pattern = target === "test/scripts" ? "test/scripts/**/*.test.ts" : target;
    const expected = fs.globSync(pattern).map(normalizeRepoPath).toSorted();
    const selected = plans.flatMap(
      (plan) =>
        plan.includePatterns ?? plan.forwardedArgs.filter((arg) => arg.endsWith(".test.ts")),
    );
    expect(selected.toSorted()).toEqual(expected);
    expect(new Set(selected).size).toBe(selected.length);

    const requiredOwners: Record<string, string> = {
      "test/scripts/ci-git-prerequisites.test.ts":
        "test/vitest/vitest.unit-fast-isolated.config.ts",
      "test/scripts/pr-ci-sweeper.reopen-timer.test.ts":
        "test/vitest/vitest.unit-fast-fake-timers.config.ts",
      "test/scripts/docker-build-helper.test.ts": "test/vitest/vitest.tooling-docker.config.ts",
      "test/scripts/openclaw-e2e-instance.test.ts": "test/vitest/vitest.tooling-isolated.config.ts",
    };
    for (const plan of plans) {
      const files =
        plan.includePatterns ?? plan.forwardedArgs.filter((arg) => arg.endsWith(".test.ts"));
      expect(plan.watchMode).toBe(false);
      expect(plan.forwardedArgs).toContain("--reporter=dot");
      if (plan.config === "test/vitest/vitest.tooling.config.ts") {
        expect(files.length).toBeLessThanOrEqual(60);
      }
      for (const file of files) {
        const owner = file.endsWith(".e2e.test.ts")
          ? "test/vitest/vitest.e2e.config.ts"
          : requiredOwners[file];
        if (owner) {
          expect(plan.config, file).toBe(owner);
        }
      }
    }
  });

  it("routes the src scripts test root to the tooling shard", () => {
    expect(findUnmatchedExplicitTestTargets(["src/scripts"], process.cwd())).toEqual([]);
    expectSingleVitestRunPlan(buildVitestRunPlans(["src/scripts"], process.cwd()), {
      config: "test/vitest/vitest.tooling.config.ts",
      includePatterns: ["src/scripts/**/*.test.ts"],
    });
  });

  it("routes exact source directory roots to their owning shards", () => {
    const cases = [
      ["src/acp", "test/vitest/vitest.acp.config.ts"],
      ["src/agents", "test/vitest/vitest.agents.config.ts"],
      ["src/auto-reply", "test/vitest/vitest.auto-reply.config.ts"],
      ["src/channels", "test/vitest/vitest.channels.config.ts"],
      ["src/config", "test/vitest/vitest.runtime-config.config.ts"],
      ["src/cron", "test/vitest/vitest.cron.config.ts"],
      ["src/daemon", "test/vitest/vitest.daemon.config.ts"],
      ["src/gateway", "test/vitest/vitest.gateway.config.ts"],
      ["src/hooks", "test/vitest/vitest.hooks.config.ts"],
      ["src/infra", "test/vitest/vitest.infra.config.ts"],
      ["src/logging", "test/vitest/vitest.logging.config.ts"],
      ["src/media", "test/vitest/vitest.media.config.ts"],
      ["src/media-understanding", "test/vitest/vitest.media-understanding.config.ts"],
      ["src/plugin-sdk", "test/vitest/vitest.plugin-sdk.config.ts"],
      ["src/plugins", "test/vitest/vitest.plugins.config.ts"],
      ["src/process", "test/vitest/vitest.process.config.ts"],
      ["src/secrets", "test/vitest/vitest.secrets.config.ts"],
      ["src/shared", "test/vitest/vitest.shared-core.config.ts"],
      ["src/tasks", "test/vitest/vitest.tasks.config.ts"],
      ["src/tui", "test/vitest/vitest.tui.config.ts"],
      ["src/utils", "test/vitest/vitest.utils.config.ts"],
      ["src/wizard", "test/vitest/vitest.wizard.config.ts"],
      ["ui/src", "test/vitest/vitest.ui.config.ts"],
    ] as const;

    const plansByConfig = new Map(
      buildVitestRunPlans(
        cases.map(([target]) => target),
        process.cwd(),
      ).map((plan) => [plan.config, plan]),
    );
    for (const [target, config] of cases) {
      const plan = plansByConfig.get(config);
      expect(plan).toMatchObject({
        config,
        forwardedArgs: [],
        watchMode: false,
      });
      expect(plan?.includePatterns?.filter((pattern) => pattern.endsWith("/**/*.test.ts"))).toEqual(
        [`${target}/**/*.test.ts`],
      );
    }

    expect(buildVitestRunPlans(["src/plugin-sdk"], process.cwd())).toEqual([
      expect.objectContaining({
        config: "test/vitest/vitest.unit-fast.config.ts",
        includePatterns: expect.arrayContaining(["src/plugin-sdk/access-groups.test.ts"]),
      }),
      expect.objectContaining({
        config: "test/vitest/vitest.infra.config.ts",
        includePatterns: databaseWorkerCoreTestFiles.filter((file) =>
          file.startsWith("src/plugin-sdk/"),
        ),
      }),
      expect.objectContaining({
        config: "test/vitest/vitest.plugin-sdk-light.config.ts",
        includePatterns: expect.arrayContaining(["src/plugin-sdk/acp-runtime.test.ts"]),
      }),
      {
        config: "test/vitest/vitest.plugin-sdk.config.ts",
        forwardedArgs: [],
        includePatterns: ["src/plugin-sdk/**/*.test.ts"],
        watchMode: false,
      },
    ]);
    expect(buildVitestRunPlans(["src/shared"], process.cwd()).map((plan) => plan.config)).toEqual([
      "test/vitest/vitest.unit-fast.config.ts",
      "test/vitest/vitest.shared-core.config.ts",
    ]);
    expect(buildVitestRunPlans(["src/utils"], process.cwd()).map((plan) => plan.config)).toEqual([
      "test/vitest/vitest.unit-fast.config.ts",
      "test/vitest/vitest.utils.config.ts",
    ]);
    expect(findUnmatchedExplicitTestTargets(["src/commands"])).toEqual([]);
    expect(buildVitestRunPlans(["src/commands"], process.cwd())).toEqual([
      {
        config: "test/vitest/vitest.infra.config.ts",
        forwardedArgs: [],
        includePatterns: databaseWorkerCoreTestFiles.filter((file) =>
          file.startsWith("src/commands/"),
        ),
        watchMode: false,
      },
      {
        config: "test/vitest/vitest.commands-light.config.ts",
        forwardedArgs: [],
        includePatterns: null,
        watchMode: false,
      },
      {
        config: "test/vitest/vitest.commands.config.ts",
        forwardedArgs: [],
        includePatterns: null,
        watchMode: false,
      },
    ]);
  });

  it.each([
    "src/cli/help-exit.process.test.ts",
    "src/cli/update-dry-run-state.process.test.ts",
    "src/cli/update-cli/update-command-migrated.test.ts",
    "src/cli/update-cli/update-command-rollback.test.ts",
    "src/cli/update-cli/update-command-post-update-recovery.test.ts",
    "src/cli/update-cli/update-command-post-update-repair.test.ts",
    "src/cli/update-cli/update-command-service.integration.test.ts",
    "src/cli/one-shot-exit.test.ts",
    "src/cli/program/subcli-descriptors.test.ts",
    "src/cli/state-dir-gateway-check.process.test.ts",
    "src/cli/state-dir-gateway-check.server.test.ts",
    "src/state/openclaw-database-verify.process.test.ts",
  ])("routes source-child process test %s through its isolated project", (file) => {
    expectSingleVitestRunPlan(buildVitestRunPlans([file]), {
      config: "test/vitest/vitest.cli-process.config.ts",
      includePatterns: [file],
    });
  });

  it("adds the CLI process project for broad CLI targets", () => {
    const plans = buildVitestRunPlans(["src/cli"]);

    expect(plans.map((plan) => plan.config)).toEqual(
      expect.arrayContaining([
        "test/vitest/vitest.unit-fast.config.ts",
        "test/vitest/vitest.cli-process.config.ts",
        "test/vitest/vitest.cli.config.ts",
      ]),
    );
    const processPlan = plans.find(
      (plan) => plan.config === "test/vitest/vitest.cli-process.config.ts",
    );
    expect(processPlan?.includePatterns).toContain("src/cli/help-exit.process.test.ts");
    expect(processPlan?.includePatterns).toContain("src/cli/update-dry-run-state.process.test.ts");
  });

  it.each(["src/state", "src/state/", "src/state/**/*.test.ts"])(
    "adds the verifier process project for broad state target %s",
    (target) => {
      const plans = buildVitestRunPlans([target]);
      expect(plans.map((plan) => plan.config)).toContain("test/vitest/vitest.unit.config.ts");
      expect(
        plans.filter((plan) => plan.config === "test/vitest/vitest.cli-process.config.ts"),
      ).toEqual([
        {
          config: "test/vitest/vitest.cli-process.config.ts",
          forwardedArgs: [],
          includePatterns: ["src/state/openclaw-database-verify.process.test.ts"],
          watchMode: false,
        },
      ]);
    },
  );

  it("deduplicates the verifier process selected by a state directory and exact leaf", () => {
    const plans = buildVitestRunPlans([
      "src/state",
      "src/state/openclaw-database-verify.process.test.ts",
    ]);
    expect(
      plans.filter((plan) => plan.config === "test/vitest/vitest.cli-process.config.ts"),
    ).toEqual([
      {
        config: "test/vitest/vitest.cli-process.config.ts",
        forwardedArgs: [],
        includePatterns: ["src/state/openclaw-database-verify.process.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("does not fan out the verifier for an unrelated exact state test", () => {
    expect(
      buildVitestRunPlans(["src/state/openclaw-database.test.ts"]).map((plan) => plan.config),
    ).not.toContain("test/vitest/vitest.cli-process.config.ts");
  });

  it("rejects broad CLI watch targets that cross shared and process projects", () => {
    expect(() => buildVitestRunPlans(["--watch", "src/cli"])).toThrow(
      "watch mode with mixed test suites is not supported",
    );
  });

  it("preserves post-separator Vitest args without parsing them as targets", () => {
    for (const [arg, watchMode] of [
      ["--reporter=verbose", false],
      ["--watch", true],
    ] as const) {
      expect(buildVitestRunPlans(["test/scripts/run-vitest.test.ts", "--", arg])).toEqual([
        {
          config: "test/vitest/vitest.tooling.config.ts",
          forwardedArgs: [arg],
          includePatterns: ["test/scripts/run-vitest.test.ts"],
          watchMode,
        },
      ]);
    }
  });

  it("keeps pnpm-style leading separators out of target routing", () => {
    expectSingleVitestRunPlan(buildVitestRunPlans(["--", "test/scripts/run-vitest.test.ts"]), {
      config: "test/vitest/vitest.tooling.config.ts",
      includePatterns: ["test/scripts/run-vitest.test.ts"],
    });
  });

  it.each(["--help", "-h"])(
    "prints wrapper help for %s without starting a broad local suite",
    (helpFlag) => {
      withTinyFileTree({}, (tempDir) => {
        const result = spawnSync(
          process.execPath,
          ["--import", "tsx", "scripts/test-projects.mts", helpFlag],
          {
            encoding: "utf8",
            // Own the child's tsx cache so unrelated host transforms cannot delay help.
            env: { ...process.env, TMPDIR: tempDir, TMP: tempDir, TEMP: tempDir },
            timeout: 5_000,
          },
        );

        expect(result.status).toBe(0);
        expect(result.stdout).toContain("Usage: node --import tsx scripts/test-projects.mts");
        expect(result.stderr).not.toContain("[test] starting");
      });
    },
  );

  it("routes explicit test-support helper files to affected tests", () => {
    expect(
      findUnmatchedExplicitTestTargets(["src/commands/onboard-non-interactive.test-helpers.ts"]),
    ).toEqual([]);

    expectSingleVitestRunPlan(
      buildVitestRunPlans(["src/commands/onboard-non-interactive.test-helpers.ts"]),
      {
        config: "test/vitest/vitest.commands.config.ts",
        includePatterns: [
          "src/commands/onboard-non-interactive.gateway-auth-token.test.ts",
          "src/commands/onboard-non-interactive.gateway-health-auth.test.ts",
          "src/commands/onboard-non-interactive.gateway.test.ts",
        ],
      },
    );
  });

  it("rejects explicit test-support helper files with no importing tests", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-test-targets-"));
    try {
      fs.mkdirSync(path.join(tempDir, "src", "lonely"), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, "src", "lonely", "runtime.test-helpers.ts"),
        "export {};\n",
      );

      expect(
        findUnmatchedExplicitTestTargets(["src/lonely/runtime.test-helpers.ts"], tempDir),
      ).toEqual([
        {
          target: "src/lonely/runtime.test-helpers.ts",
          reason: "target-matched-no-test-files",
        },
      ]);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("routes contract roots to separate contract shards", () => {
    const plans = buildVitestRunPlans([
      "src/channels/plugins/contracts/channel-catalog.contract.test.ts",
      "src/plugins/contracts/loader.contract.test.ts",
    ]);

    expect(plans).toEqual([
      {
        config: "test/vitest/vitest.contracts-channel-surface.config.ts",
        forwardedArgs: [],
        includePatterns: ["src/channels/plugins/contracts/channel-catalog.contract.test.ts"],
        watchMode: false,
      },
      {
        config: "test/vitest/vitest.contracts-plugin.config.ts",
        forwardedArgs: [],
        includePatterns: ["src/plugins/contracts/loader.contract.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("fans contract directory targets out to the owning contract lanes", () => {
    // Regression: the generic channels project excludes contracts/**, so the
    // directory target used to run zero tests and exit green.
    const plans = buildVitestRunPlans(["src/channels/plugins/contracts"]);

    expect(plans.map((plan) => plan.config)).toEqual([
      "test/vitest/vitest.contracts-channel-surface.config.ts",
      "test/vitest/vitest.contracts-channel-config.config.ts",
      "test/vitest/vitest.contracts-channel-registry.config.ts",
      "test/vitest/vitest.contracts-channel-session.config.ts",
    ]);
    expect(plans.every((plan) => plan.includePatterns === null)).toBe(true);
  });

  it("routes the plugin contracts directory to the plugin contracts lane", () => {
    const plans = buildVitestRunPlans(["src/plugins/contracts"]);

    expect(plans).toEqual([
      {
        config: "test/vitest/vitest.contracts-plugin.config.ts",
        forwardedArgs: [],
        includePatterns: null,
        watchMode: false,
      },
    ]);
  });

  it.each([
    {
      title: "routes explicit plugin-sdk light tests to the lighter plugin-sdk lane",
      target: "src/plugin-sdk/temp-path.test.ts",
      config: "test/vitest/vitest.plugin-sdk-light.config.ts",
      includePattern: "src/plugin-sdk/temp-path.test.ts",
    },
    {
      title: "routes explicit commands light tests to the lighter commands lane",
      target: "src/commands/status-json-runtime.test.ts",
      config: "test/vitest/vitest.commands-light.config.ts",
      includePattern: "src/commands/status-json-runtime.test.ts",
    },
    {
      title: "routes fake-timer unit-fast tests to the serial fake-timer lane",
      target: "src/acp/control-plane/manager.test.ts",
      config: "test/vitest/vitest.unit-fast-fake-timers.config.ts",
      includePattern: "src/acp/control-plane/manager.test.ts",
    },
  ])("$title", ({ target, config, includePattern }) => {
    const plans = buildVitestRunPlans([target], process.cwd());

    expect(plans).toEqual([
      {
        config,
        forwardedArgs: [],
        includePatterns: [includePattern],
        watchMode: false,
      },
    ]);
  });

  it.each([
    {
      title: "routes browser extension changes to the browser extension lane",
      changedPath: "extensions/browser/src/browser/cdp.helpers.ts",
      config: "test/vitest/vitest.extension-browser.config.ts",
      testPath: "extensions/browser/src/browser/cdp.helpers.test.ts",
    },
    {
      title: "keeps public plugin SDK changes focused by default",
      changedPath: "src/plugin-sdk/provider-entry.ts",
      config: "test/vitest/vitest.plugin-sdk-light.config.ts",
      testPath: "src/plugin-sdk/provider-entry.test.ts",
    },
    {
      title: "routes LM Studio changes to the provider extension lane",
      changedPath: "extensions/lmstudio/src/runtime.ts",
      config: "test/vitest/vitest.extension-providers.config.ts",
      testPath: "extensions/lmstudio/src/runtime.test.ts",
    },
    {
      title: "routes QA extension changes to the QA extension lane",
      changedPath: "extensions/qa-lab/src/scenario-catalog.test.ts",
      config: "test/vitest/vitest.extension-qa.config.ts",
      testPath: "extensions/qa-lab/src/scenario-catalog.test.ts",
    },
    {
      title: "routes changed source files to sibling tests when present",
      changedPath: "src/agents/test-helpers/live-model-turn-probes.ts",
      config: "test/vitest/vitest.unit-fast.config.ts",
      testPath: "src/agents/live-model-turn-probes.test.ts",
    },
    {
      title: "routes plugin-sdk source files with sibling tests narrowly by default",
      changedPath: "src/plugin-sdk/facade-runtime.ts",
      config: "test/vitest/vitest.bundled.config.ts",
      testPath: "src/plugin-sdk/facade-runtime.test.ts",
    },
    {
      title: "routes command source files with sibling tests narrowly on the command lane",
      changedPath: "src/commands/channels.add.ts",
      config: "test/vitest/vitest.commands.config.ts",
      testPath: "src/commands/channels.add.test.ts",
    },
  ])("$title", ({ changedPath, config, testPath }) => {
    const plans = buildVitestRunPlans(["--changed", "origin/main"], process.cwd(), () => [
      changedPath,
    ]);

    expect(plans).toEqual([
      {
        config,
        forwardedArgs: [],
        includePatterns: [testPath],
        watchMode: false,
      },
    ]);
  });

  it("keeps shared test helpers cheap by default when no precise target exists", () => {
    let args: string[] | null = null;
    withTinyGitRepo(
      {
        "test/helpers/unmapped-helper.ts": "export const unmapped = true;\n",
      },
      (cwd) => {
        args = resolveChangedTargetArgs(["--changed", "origin/main"], cwd, () => [
          "test/helpers/unmapped-helper.ts",
        ]);
      },
    );

    expect(args).toStrictEqual([]);
  });

  it("routes imported shared test helpers through affected tests", () => {
    let targets: string[] = [];
    withTinyGitRepo(
      {
        "test/helpers/temp-dir.ts": "export const tempDir = 'x';\n",
        "test/helpers/temp-dir.test.ts":
          "import { tempDir } from './temp-dir.js';\nvoid tempDir;\n",
        "test/scripts/bench-cli-startup.test.ts":
          "import { tempDir } from '../helpers/temp-dir.js';\nvoid tempDir;\n",
        "src/foo.test.ts":
          "import { tempDir } from '../test/helpers/temp-dir.js';\nvoid tempDir;\n",
      },
      (cwd) => {
        targets = resolveChangedTestTargetPlan(["test/helpers/temp-dir.ts"], { cwd }).targets;
      },
    );

    expect(targets).toEqual([
      "test/helpers/temp-dir.test.ts",
      "src/foo.test.ts",
      "test/scripts/bench-cli-startup.test.ts",
    ]);
  });

  it("keeps the broad changed run available for shared test helpers", () => {
    let args: string[] | null = [];
    withTinyGitRepo(
      {
        "test/helpers/unmapped-helper.ts": "export const unmapped = true;\n",
      },
      (cwd) => {
        args = resolveChangedTargetArgs(
          ["--changed", "origin/main"],
          cwd,
          () => ["test/helpers/unmapped-helper.ts"],
          { env: { OPENCLAW_TEST_CHANGED_BROAD: "1" } },
        );
      },
    );

    expect(args).toBeNull();
  });

  it("routes channel contract helper edits through the tests that import them", () => {
    const plan = resolveChangedTestTargetPlan([
      "src/channels/plugins/contracts/test-helpers/manifest.ts",
    ]);

    expect(plan.mode).toBe("targets");
    expect(plan.targets).toContain("src/channels/plugins/contracts/registry.contract.test.ts");
    expect(plan.targets).not.toContain("extensions/discord/src/directory-contract.test.ts");
  });

  it("routes channel SDK helper edits through the tests that import them", () => {
    expectChangedTargets(
      ["src/plugin-sdk/test-helpers/directory-ids.ts"],
      [
        "extensions/discord/src/directory-contract.test.ts",
        "extensions/slack/src/directory-contract.test.ts",
        "extensions/telegram/src/directory-contract.test.ts",
      ],
    );
  });

  it("routes channel contract helper edits through contract shards", () => {
    const plan = resolveChangedTestTargetPlan([
      "src/channels/plugins/contracts/test-helpers/registry-backed-contract-shards.ts",
    ]);

    expect(plan.mode).toBe("targets");
    expect(plan.targets).toContain(
      "src/channels/plugins/contracts/plugin.registry-backed-shard-a.contract.test.ts",
    );
    expect(plan.targets).toContain(
      "src/channels/plugins/contracts/threading.registry-backed-shard-h.contract.test.ts",
    );
    expect(plan.targets).not.toContain("extensions/discord/src/channel-actions.contract.test.ts");
  });

  it.each([
    ["extensions/imessage/message-tool-api.ts", "extensions/imessage/src/message-tool-api.test.ts"],
    ["extensions/imessage/src/actions.ts", "extensions/imessage/src/actions.test.ts"],
    ["extensions/imessage/src/channel.ts", "extensions/imessage/src/test-plugin.test.ts"],
    ["extensions/slack/message-tool-api.ts", "extensions/slack/message-tool-api.ts"],
    [
      "extensions/slack/src/channel-actions.ts",
      "extensions/slack/src/channel-actions-setup-status.contract.test.ts",
    ],
    ["extensions/slack/src/channel.ts", "extensions/slack/src/channel.test.ts"],
    ["extensions/mattermost/gateway-auth-api.ts", "extensions/mattermost/gateway-auth-api.ts"],
    ["extensions/mattermost/src/channel.ts", "extensions/mattermost/src/channel.test.ts"],
    ["extensions/feishu/session-key-api.ts", "extensions/feishu/session-key-api.ts"],
    ["extensions/feishu/src/channel.ts", "extensions/feishu/src/channel.test.ts"],
    ["extensions/telegram/session-key-api.ts", "extensions/telegram/session-key-api.ts"],
    ["extensions/telegram/src/channel.ts", "test/telegram-question-gateway.test.ts"],
    ["extensions/discord/session-key-api.ts", "extensions/discord/session-key-api.ts"],
    ["extensions/discord/thread-binding-api.ts", "extensions/discord/thread-binding-api.ts"],
    ["extensions/discord/src/channel.ts", "extensions/discord/src/channel.test.ts"],
    ["extensions/matrix/thread-binding-api.ts", "extensions/matrix/thread-binding-api.ts"],
    ["extensions/matrix/src/channel.ts", "extensions/matrix/src/channel.threading.test.ts"],
  ] as const)(
    "routes %s through its owner and the plugin-shape parity contract",
    (changedPath, ownerTarget) => {
      const plan = resolveChangedTestTargetPlan([changedPath]);

      expect(plan.mode).toBe("targets");
      expect(plan.targets).toContain(ownerTarget);
      expect(plan.targets).toContain(
        "src/channels/plugins/contracts/plugin-shape.contract.test.ts",
      );
    },
  );

  it("routes precise plugin contract helpers without broad-running every shard", () => {
    expect(
      resolveChangedTargetArgs(["--changed", "origin/main"], process.cwd(), () => [
        "src/plugins/contracts/tts-contract-suites.ts",
      ]),
    ).toEqual([
      "src/plugins/contracts/core-extension-facade-boundary.test.ts",
      "src/plugins/contracts/tts.contract.test.ts",
    ]);
  });

  it("routes Slack enterprise install changes through both owning tests", () => {
    expectChangedTargets(
      ["extensions/slack/src/monitor/enterprise-install.ts"],
      [
        "extensions/slack/src/monitor/enterprise-install.test.ts",
        "extensions/slack/src/monitor/provider.auth-test-token.test.ts",
      ],
    );
  });

  it("routes worker launcher changes through every split owner suite", () => {
    expectChangedTargets(
      ["src/gateway/worker-environments/worker-turn-launcher.ts"],
      [
        "src/gateway/worker-environments/worker-turn-launcher.test.ts",
        "src/gateway/worker-environments/worker-turn-launcher-claim-admission.test.ts",
        "src/gateway/worker-environments/worker-turn-launcher-failure-recovery.test.ts",
        "src/gateway/worker-environments/worker-turn-launcher-reclaimed-placement.test.ts",
        "src/gateway/worker-environments/worker-turn-launcher-remote-handoff.test.ts",
        "src/gateway/worker-environments/worker-turn-launcher-terminal-results.test.ts",
      ],
    );
  });

  it("keeps unknown root surfaces cheap by default", () => {
    expect(
      resolveChangedTargetArgs(["--changed", "origin/main"], process.cwd(), () => [
        "unknown/file.txt",
      ]),
    ).toStrictEqual([]);
  });

  it("fails safe for raw Git paths that explicit-path normalization would rewrite", () => {
    for (const changedPath of [
      " scripts/changed-lanes.mts",
      String.raw`scripts\changed-lanes.mts`,
    ]) {
      expect(
        resolveChangedTestTargetPlanForArgs(
          ["--changed", "origin/main"],
          process.cwd(),
          () => [changedPath],
          { broad: true },
        ),
        changedPath,
      ).toEqual({ mode: "broad", targets: [] });
    }
  });

  it("keeps unknown root surface skip reasons available to changed-mode callers", () => {
    expect(
      resolveChangedTestTargetPlanForArgs(["--changed", "origin/main"], process.cwd(), () => [
        "unknown/file.txt",
      ]),
    ).toEqual({
      mode: "targets",
      skippedBroadFallbackPaths: ["unknown/file.txt"],
      targets: [],
    });
  });

  it("explains changed paths that need explicit broad fallback before skipping", () => {
    expect(formatNoChangedTestTargetLines(["unknown-root-surface.txt"])).toEqual([
      "[test] no precise changed test targets; skipping Vitest.",
      "[test] 1 changed path require broad Vitest fallback:",
      "[test]   unknown-root-surface.txt",
      "[test] run `OPENCLAW_TEST_CHANGED_BROAD=1 pnpm test:changed` for broad coverage.",
    ]);
  });

  it("keeps the broad changed run available for unknown root surfaces", () => {
    expect(
      resolveChangedTargetArgs(
        ["--changed", "origin/main"],
        process.cwd(),
        () => ["unknown/file.txt"],
        { env: { OPENCLAW_TEST_CHANGED_BROAD: "1" } },
      ),
    ).toBeNull();
  });

  it("skips app-only changes because app tests are separate from Vitest lanes", () => {
    expect(
      buildVitestRunPlans(["--changed", "origin/main"], process.cwd(), () => [
        "apps/macos/OpenClaw/AppDelegate.swift",
      ]),
    ).toStrictEqual([]);
  });

  it.each([
    {
      file: "src/cli/native-hook-relay-cli.locator-worker.test.ts",
      config: "test/vitest/vitest.infra.config.ts",
    },
    {
      file: "src/gateway/server-methods/native-hook-relay.test.ts",
      config: "test/vitest/vitest.gateway-database-workers.config.ts",
    },
    {
      file: "extensions/codex/src/app-server/run-attempt-one-shot-cleanup.test.ts",
      config: "test/vitest/vitest.extension-database-workers.config.ts",
    },
    {
      file: "extensions/codex/src/app-server/run-attempt.context-engine.test.ts",
      config: "test/vitest/vitest.extension-database-workers.config.ts",
    },
  ])("routes native hook relay fixture $file to its host broker", ({ file, config }) => {
    expectSingleVitestRunPlan(buildVitestRunPlans([file]), { config, includePatterns: [file] });
  });

  it("routes explicit active-memory and Codex index tests to the database worker", () => {
    expect(
      buildVitestRunPlans([
        "extensions/active-memory/index.test.ts",
        "extensions/codex/index.test.ts",
      ]),
    ).toEqual([
      {
        config: "test/vitest/vitest.extension-database-workers.config.ts",
        forwardedArgs: [],
        includePatterns: ["extensions/active-memory/index.test.ts"],
        watchMode: false,
      },
      {
        config: "test/vitest/vitest.extension-database-workers.config.ts",
        forwardedArgs: [],
        includePatterns: ["extensions/codex/index.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("keeps the top-level extensions watch target on its aggregate owner", () => {
    expectSingleVitestRunPlan(buildVitestRunPlans(["--watch", "extensions"]), {
      config: "test/vitest/vitest.full-extensions.config.ts",
      watchMode: true,
    });
  });

  it("bounds an explicit Telegram config target across process lifetimes", () => {
    const config = "test/vitest/vitest.extension-telegram.config.ts";
    const plans = buildVitestRunPlans([config], process.cwd());

    expect(plans).toHaveLength(expectedTelegramTestProcessCount());
    expect(plans.every((plan) => plan.config === config)).toBe(true);
    expect(
      plans.every(
        (plan) => (plan.includePatterns?.length ?? 0) <= TELEGRAM_TEST_PROCESS_FILE_LIMIT,
      ),
    ).toBe(true);
    expect(plans.flatMap((plan) => plan.includePatterns ?? [])).toEqual(
      listOrdinaryExtensionFiles("extensions/telegram"),
    );
  });

  it.each([
    {
      channel: "Telegram",
      config: "test/vitest/vitest.extension-telegram.config.ts",
    },
    { channel: "Matrix", config: "test/vitest/vitest.extension-matrix.config.ts" },
  ])("preserves an externally scoped $channel config target", ({ config }) => {
    expect(
      buildVitestRunPlans([config], process.cwd(), () => [], {
        env: { OPENCLAW_VITEST_INCLUDE_FILE: "ci-shard.json" },
      }),
    ).toEqual([
      {
        config,
        forwardedArgs: [],
        includePatterns: null,
        watchMode: false,
      },
    ]);
  });

  it.each([
    {
      channel: "Telegram",
      config: "test/vitest/vitest.extension-telegram.config.ts",
      directory: "extensions/telegram",
    },
    {
      channel: "Matrix",
      config: "test/vitest/vitest.extension-matrix.config.ts",
      directory: "extensions/matrix",
    },
  ])("preserves an externally scoped $channel directory run spec", ({ config, directory }) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-external-test-scope-"));
    try {
      const includeFile = path.join(tempDir, "ci-shard.json");
      fs.writeFileSync(includeFile, JSON.stringify([`${directory}/src/example.test.ts`]));
      const [spec] = createVitestRunSpecs([directory], {
        baseEnv: { OPENCLAW_VITEST_INCLUDE_FILE: includeFile },
      });

      expect(spec).toMatchObject({
        config,
        env: { OPENCLAW_VITEST_INCLUDE_FILE: includeFile },
        includeFilePath: null,
        includePatterns: null,
      });
    } finally {
      fs.rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it.each([
    {
      directory: "extensions/matrix/src/matrix/client",
      selected: ["extensions/matrix/src/matrix/client/storage.test.ts"],
      inherited: [
        "extensions/matrix/src/matrix/client/storage.test.ts",
        "extensions/matrix/src/matrix/thread-bindings.test.ts",
      ],
    },
    {
      directory: "extensions/matrix/src/matrix/sdk",
      selected: [
        "extensions/matrix/src/matrix/sdk/idb-persistence.test.ts",
        "extensions/matrix/src/matrix/sdk/recovery-key-store.test.ts",
      ],
      inherited: ["extensions/matrix/**/*.test.ts"],
    },
  ])(
    "intersects $directory and inherited worker selections before emitting include files",
    ({ directory, selected, inherited }) => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-worker-selection-"));
      try {
        const includeFile = path.join(tempDir, "include.json");
        fs.writeFileSync(includeFile, JSON.stringify(inherited));
        const specs = createVitestRunSpecs([directory], {
          baseEnv: { OPENCLAW_VITEST_INCLUDE_FILE: includeFile },
        });
        const worker = specs.find(
          (spec) => spec.config === "test/vitest/vitest.extension-database-workers.config.ts",
        );
        expect(worker?.includePatterns).toEqual(selected);
        expect(specs.flatMap((spec) => spec.includePatterns ?? [])).not.toContain(
          "extensions/matrix/src/matrix/thread-bindings.test.ts",
        );
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    },
  );

  it.each([
    ["matrix", MATRIX_TEST_PROCESS_FILE_LIMIT],
    ["codex", CODEX_TEST_PROCESS_FILE_LIMIT],
    ["telegram", TELEGRAM_TEST_PROCESS_FILE_LIMIT],
  ] as const)("bounds an explicit %s directory across both database owners", (name, limit) => {
    const root = `extensions/${name}`;
    const plans = buildVitestRunPlans([root]);
    const selected = plans.flatMap((plan) => plan.includePatterns ?? []);
    expect(plans.length).toBeGreaterThan(1);
    expect(plans.every((plan) => (plan.includePatterns?.length ?? 0) <= limit)).toBe(true);
    expect(selected.toSorted()).toEqual(listExtensionTestFilesForRoots([root]).toSorted());
    expect(new Set(selected).size).toBe(selected.length);
    for (const plan of plans) {
      if (
        name === "telegram" &&
        plan.config === "test/vitest/vitest.extension-database-workers.config.ts"
      ) {
        expect(plan.includePatterns).toHaveLength(1);
      }
      for (const file of plan.includePatterns ?? []) {
        expect(plan.config).toBe(
          databaseWorkerExtensionTestFiles.includes(file)
            ? "test/vitest/vitest.extension-database-workers.config.ts"
            : `test/vitest/vitest.extension-${name}.config.ts`,
        );
      }
    }
  });

  it("keeps an explicit Codex file target in one process", () => {
    const testFile = listExtensionTestFilesForRoots(["extensions/codex"])[0];
    if (!testFile) {
      throw new Error("expected a Codex test fixture");
    }

    expect(buildVitestRunPlans([testFile], process.cwd())).toEqual([
      {
        config: "test/vitest/vitest.extension-codex.config.ts",
        forwardedArgs: [],
        includePatterns: [testFile],
        watchMode: false,
      },
    ]);
  });

  it("keeps grouped Matrix targets covered when bounding the directory", () => {
    const testFile = listExtensionTestFilesForRoots(["extensions/matrix"])[0];
    if (!testFile) {
      throw new Error("expected a Matrix test fixture");
    }

    const plans = buildVitestRunPlans(["extensions/matrix", testFile], process.cwd());

    expect(plans.length).toBeGreaterThan(1);
    expect(
      plans.every((plan) => (plan.includePatterns?.length ?? 0) <= MATRIX_TEST_PROCESS_FILE_LIMIT),
    ).toBe(true);
    expect(plans.flatMap((plan) => plan.includePatterns ?? []).toSorted()).toEqual(
      listExtensionTestFilesForRoots(["extensions/matrix"]).toSorted(),
    );
  });

  it("keeps a grouped Matrix config target unsplit beside its worker tests", () => {
    const plans = buildVitestRunPlans([
      "extensions/matrix",
      "test/vitest/vitest.extension-matrix.config.ts",
    ]);
    expect(plans).toEqual([
      {
        config: "test/vitest/vitest.extension-database-workers.config.ts",
        forwardedArgs: [],
        includePatterns: databaseWorkerExtensionTestFiles.filter((file) =>
          file.startsWith("extensions/matrix/"),
        ),
        watchMode: false,
      },
      {
        config: "test/vitest/vitest.extension-matrix.config.ts",
        forwardedArgs: [],
        includePatterns: null,
        watchMode: false,
      },
    ]);
  });

  it("keeps explicit Matrix files and watch runs unchunked", () => {
    const testFile = listExtensionTestFilesForRoots(["extensions/matrix"])[0];
    expect(testFile).toBeDefined();
    expect(buildVitestRunPlans([testFile!])).toHaveLength(1);
    const plans = buildVitestRunPlans(["--watch", "extensions/matrix"]);
    expect(plans).toEqual([
      {
        config: "test/vitest/vitest.database-worker-watch.config.ts",
        databaseWorkerWatchOwner: "test/vitest/vitest.extension-matrix.config.ts",
        databaseWorkerWatchTests: databaseWorkerExtensionTestFiles.filter((file) =>
          file.startsWith("extensions/matrix/"),
        ),
        forwardedArgs: [],
        includePatterns: expect.arrayContaining(["extensions/matrix/**/*.test.ts"]),
        watchMode: true,
      },
    ]);
  });

  it("narrows default-lane changed source files to affected tests", () => {
    const plans = buildVitestRunPlans(["--changed", "origin/main"], process.cwd(), () => [
      "packages/sdk/src/index.ts",
    ]);

    expect(plans).toEqual([
      {
        config: "test/vitest/vitest.unit.config.ts",
        forwardedArgs: ["packages/sdk/src/index.test.ts"],
        includePatterns: ["packages/sdk/src/index.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("can combine sibling and import-graph targets for CI", () => {
    withTinyGitRepo(
      {
        "src/consumer.test.ts": 'import "./value.js";\n',
        "src/value.test.ts": 'import "./value.js";\n',
        "src/value.ts": "export const value = 1;\n",
      },
      (cwd) => {
        expect(
          resolveChangedTestTargetPlan(["src/value.ts"], {
            combineSiblingWithImportGraph: true,
            cwd,
            forceFullImportGraph: true,
          }),
        ).toEqual({
          mode: "targets",
          targets: ["src/value.test.ts", "src/consumer.test.ts"],
        });
      },
    );
  });

  describe("Kova schema selection", () => {
    const wrapper = "src/config/zod-schema.agent-defaults.ts";
    const base = "src/config/zod-schema.agent-defaults-base.ts";
    const sibling = "src/config/zod-schema.agent-defaults.test.ts";
    const baseConsumer = "src/config/base-consumer.test.ts";
    const wrapperConsumer = "src/config/wrapper-consumer.test.ts";
    const unrelated = "src/config/unrelated.ts";
    const unrelatedTest = "src/config/unrelated.test.ts";
    const kova = "test/scripts/openclaw-performance-workflow.test.ts";
    const workflow = ".github/workflows/openclaw-performance.yml";
    const workflowOwners = [
      kova,
      "test/scripts/openclaw-performance-git-lifecycle.test.ts",
      "test/scripts/ci-git-owner.test.ts",
      "test/scripts/ci-linux-git.test.ts",
      "test/scripts/ci-platform-checkout.test.ts",
      "test/scripts/ci-workflow-guards.test.ts",
    ];
    const files = {
      [base]: "export const defaults = {};\n",
      [wrapper]: 'export { defaults } from "./zod-schema.agent-defaults-base.js";\n',
      [sibling]: 'import "./zod-schema.agent-defaults.js";\n',
      [baseConsumer]: 'import "./zod-schema.agent-defaults-base.js";\n',
      [wrapperConsumer]: 'import "./zod-schema.agent-defaults.js";\n',
      [unrelated]: "export const unrelated = true;\n",
      [unrelatedTest]: 'import "./unrelated.js";\n',
      [workflow]: "name: performance\n",
      ...Object.fromEntries(workflowOwners.map((file) => [file, "export {};\n"])),
    };

    describe("watch compatibility", () => {
      describe.each(["changed", "explicit"])("%s", (mode) => {
        it.each([
          { name: "wrapper", paths: [wrapper], targets: [sibling] },
          { name: "base", paths: [base], targets: [baseConsumer, sibling, wrapperConsumer] },
          {
            name: "both schemas",
            paths: [wrapper, base],
            targets: [baseConsumer, sibling, wrapperConsumer],
          },
        ])("keeps $name watch coverage in its existing suite", ({ paths, targets }) => {
          withTinyGitRepo(files, (cwd) => {
            const args = [
              "--watch",
              ...(mode === "explicit" ? paths : ["--changed", "origin/main"]),
            ];
            const plans = buildVitestRunPlans(args, cwd, () => paths);
            expectSingleVitestRunPlan(plans, {
              config: "test/vitest/vitest.runtime-config.config.ts",
              includePatterns: expect.arrayContaining(targets),
              watchMode: true,
            });
            expect(plans[0]?.includePatterns).toHaveLength(targets.length);
            expect(findUnmatchedExplicitTestTargets(args, cwd)).toEqual([]);
          });
        });

        it.each([
          { flags: ["--watch=false"] },
          { flags: ["--watch", "false"] },
          { flags: ["--watch", "--no-watch"] },
        ])("retains Kova for non-watch flags $flags", ({ flags }) => {
          withTinyGitRepo(files, (cwd) => {
            const paths = [wrapper, base];
            const args = [
              ...flags,
              ...(mode === "explicit" ? paths : ["--changed", "origin/main"]),
            ];
            const plans = buildVitestRunPlans(args, cwd, () => paths);
            expect(plans.every((plan) => !plan.watchMode)).toBe(true);
            expect(plans.flatMap((plan) => plan.includePatterns ?? []).toSorted()).toEqual(
              [baseConsumer, sibling, wrapperConsumer, kova].toSorted(),
            );
          });
        });
      });

      it.each([wrapper, base])("still rejects explicitly mixed watch suites for %s", (schema) => {
        withTinyGitRepo(files, (cwd) => {
          expect(() => buildVitestRunPlans(["--watch", schema, kova], cwd)).toThrow(
            "watch mode with mixed test suites is not supported",
          );
        });
      });

      it.each([wrapper, base])(
        "does not admit unmatched watch source %s through Kova",
        (schema) => {
          withTinyGitRepo(
            { [schema]: "export const defaults = {};\n", [kova]: "export {};\n" },
            (cwd) => {
              expect(findUnmatchedExplicitTestTargets([schema], cwd)).toEqual([]);
              expect(findUnmatchedExplicitTestTargets(["--watch", schema], cwd)).toEqual([
                expect.objectContaining({
                  target: schema,
                  reason: "target-matched-no-test-files",
                }),
              ]);
            },
          );
        },
      );
    });

    it("keeps skipped import-graph paths visible with mixed broad changes", () => {
      withTinyGitRepo(files, (cwd) => {
        const paths = [base, "unknown/file.txt"];
        expect(resolveChangedTestTargetPlan(paths, { cwd })).toEqual({
          mode: "targets",
          targets: [kova],
          skippedBroadFallbackPaths: paths,
        });
        expect(resolveChangedTestTargetPlan(paths, { cwd, broad: true })).toEqual({
          mode: "broad",
          targets: [],
        });
      });
    });

    describe.each(["changed", "explicit", "ci"])("%s", (mode) => {
      it.each([
        { name: "wrapper only", paths: [wrapper] },
        { name: "base only", paths: [base] },
        { name: "both schemas", paths: [wrapper, base, wrapper] },
        { name: "mixed workflow", paths: [workflow, wrapper, base] },
        { name: "already selected owner", paths: [base, kova, kova] },
        { name: "unrelated source", paths: [unrelated] },
      ])("$name retains normal coverage and adds only the required owner", ({ paths }) => {
        withTinyGitRepo(files, (cwd) => {
          const options =
            mode === "ci"
              ? { combineSiblingWithImportGraph: true, forceFullImportGraph: true }
              : {};
          const args = mode === "explicit" ? paths : ["--changed", "origin/main"];
          const plans = buildVitestRunPlans(args, cwd, () => paths, options);
          const selected = plans.flatMap((plan) => plan.includePatterns ?? []);
          const hasBase = paths.includes(base);
          const hasWrapper = paths.includes(wrapper);
          const hasWorkflow =
            paths.includes(workflow) || (mode !== "explicit" && paths.includes(kova));
          const normalTargets = hasBase
            ? [baseConsumer, wrapperConsumer, sibling]
            : hasWrapper
              ? mode === "ci"
                ? [sibling, wrapperConsumer]
                : [sibling]
              : [unrelatedTest];

          // Assert the pre-existing coverage before the missing data dependency.
          expect(selected).toEqual(expect.arrayContaining(normalTargets));
          if (!hasBase && hasWrapper && mode !== "ci") {
            expect(selected).not.toContain(wrapperConsumer);
          }
          if (mode !== "explicit") {
            const targets = resolveChangedTargetArgs(args, cwd, () => paths, options);
            expect(targets).toEqual(expect.arrayContaining(normalTargets));
            expect(targets?.length).toBe(new Set(targets).size);
          }
          if (hasBase || hasWrapper) {
            expect(selected).toContain(kova);
            expect(selected.filter((file) => file === kova)).toHaveLength(1);
            expect(plans).toContainEqual({
              config: "test/vitest/vitest.tooling.config.ts",
              forwardedArgs: [],
              includePatterns: expect.arrayContaining([kova]),
              watchMode: false,
            });
            expect(selected).not.toContain(unrelatedTest);
          } else {
            expect(selected).toEqual([unrelatedTest]);
          }
          if (hasWorkflow) {
            expect(selected).toEqual(expect.arrayContaining(workflowOwners));
          } else {
            expect(selected.toSorted()).toEqual(
              [...normalTargets, ...(hasBase || hasWrapper ? [kova] : [])].toSorted(),
            );
          }
          expect(selected.length).toBe(new Set(selected).size);
        });
      });
    });
  });

  it.each(["changed", "explicit"])(
    "routes %s ui support files to the ui lane without dead include globs",
    (mode) => {
      const targets = ["ui/src/styles/base.css", "ui/src/test-helpers/lit-warnings.setup.ts"];
      const plans = buildVitestRunPlans(
        mode === "changed" ? ["--changed", "origin/main"] : targets,
        process.cwd(),
        () => targets,
      );

      expect(plans[0]).toEqual({
        config: "test/vitest/vitest.ui.config.ts",
        forwardedArgs: [],
        includePatterns: null,
        watchMode: false,
      });
      expect(plans[1]?.config).toBe("test/vitest/vitest.ui-browser.config.ts");
      expect(plans[1]?.includePatterns).toContain(
        "ui/src/components/markdown-mermaid.runtime.browser.test.ts",
      );
    },
  );

  it.each(["relative", "trailing slash", "absolute", "dot segments"])(
    "keeps an existing nested ui directory and explicit e2es scoped (%s)",
    (spelling) => {
      const directory = "ui/src/pages/new-session";
      const isolated = `${directory}/draft-persistence.test.ts`;
      const unitFiles = [
        `${directory}/view.test.ts`,
        `${directory}/nested/child.test.ts`,
        isolated,
      ];
      const e2es = [
        "ui/src/e2e/new-session-page.workspace-validation.e2e.test.ts",
        "ui/src/e2e/new-session-page.projects-places.e2e.test.ts",
        "ui/src/e2e/new-session-page.device-dispatch.e2e.test.ts",
      ];
      withTinyFileTree(
        Object.fromEntries(
          [
            ...unitFiles,
            ...e2es,
            "ui/src/pages/other/view.test.ts",
            "ui/src/pages/workboard/view.test.ts",
            "ui/src/components/other.browser.test.ts",
            "ui/src/e2e/other.e2e.test.ts",
          ].map((file) => [file, ""]),
        ),
        (cwd) => {
          const target =
            spelling === "absolute"
              ? path.join(cwd, directory)
              : spelling === "trailing slash"
                ? `./${directory}/`
                : spelling === "dot segments"
                  ? "ui/src/pages/./new-session/../new-session"
                  : directory;
          const plans = buildVitestRunPlans([target, ...e2es], cwd);
          expect(plans).toEqual([
            {
              config: "test/vitest/vitest.ui.config.ts",
              forwardedArgs: [],
              includePatterns: [`${directory}/**/*.test.ts`],
              watchMode: false,
            },
            {
              config: "test/vitest/vitest.ui-isolated.config.ts",
              forwardedArgs: [],
              includePatterns: [isolated],
              watchMode: false,
            },
            {
              config: "test/vitest/vitest.ui-e2e.config.ts",
              forwardedArgs: [],
              includePatterns: e2es,
              watchMode: false,
            },
          ]);
          const includeFile = path.join(cwd, "include.json");
          const filesByPlan = plans.map((plan) => {
            writeVitestIncludeFile(includeFile, plan.includePatterns!, { cwd });
            return JSON.parse(fs.readFileSync(includeFile, "utf8"));
          });
          // Shared UI intersects these files with its ownership exclusions.
          expect(filesByPlan).toEqual([unitFiles.toSorted(), [isolated], e2es]);
        },
      );
    },
  );

  it("keeps mixed Control UI root and source changes in the UI lane", () => {
    const plans = buildVitestRunPlans(["--changed", "origin/main"], process.cwd(), () => [
      "ui/index.html",
      "ui/src/components/markdown.test.ts",
      "ui/src/pages/agents/memory/dreaming.test.ts",
    ]);

    expect(plans.map((plan) => plan.config)).toEqual([
      "test/vitest/vitest.ui.config.ts",
      "test/vitest/vitest.ui-isolated.config.ts",
      "test/vitest/vitest.ui-browser.config.ts",
      "test/vitest/vitest.ui-timing.config.ts",
    ]);
  });

  it.each([
    {
      changedPath: "ui/config/control-ui-chunking.ts",
      tests: ["ui/src/app/control-ui-chunking.test.ts"],
    },
    {
      changedPath: "ui/config/control-ui-locales.ts",
      tests: ["ui/src/app/vite-config.node.test.ts"],
    },
    {
      changedPath: "ui/config/control-ui-boot-modules.json",
      tests: ["ui/src/app/control-ui-chunking.test.ts", "ui/src/app/vite-config.node.test.ts"],
    },
  ])("routes changed ui build helper $changedPath to its owner tests", ({ changedPath, tests }) => {
    const plans = buildVitestRunPlans(["--changed", "origin/main"], process.cwd(), () => [
      changedPath,
    ]);

    expect(plans).toEqual([
      {
        config: "test/vitest/vitest.ui.config.ts",
        forwardedArgs: [],
        includePatterns: tests,
        watchMode: false,
      },
    ]);
  });

  it("routes isolated ui test targets to the isolated project", () => {
    expectSingleVitestRunPlan(buildVitestRunPlans(["ui/src/pages/chat/chat-pane.test.ts"]), {
      config: "test/vitest/vitest.ui-isolated.config.ts",
      includePatterns: ["ui/src/pages/chat/chat-pane.test.ts"],
    });
  });

  it("adds isolated and Chromium projects before timing budgets for broad ui targets", () => {
    const plans = buildVitestRunPlans(["ui/src"]);

    expect(plans.map((plan) => plan.config)).toEqual([
      "test/vitest/vitest.ui.config.ts",
      "test/vitest/vitest.ui-isolated.config.ts",
      "test/vitest/vitest.ui-browser.config.ts",
      "test/vitest/vitest.ui-timing.config.ts",
    ]);
    expect(plans[1]?.includePatterns).toContain("ui/src/pages/chat/chat-pane.test.ts");
    expect(plans[2]?.includePatterns).toContain(
      "ui/src/components/markdown-mermaid.runtime.browser.test.ts",
    );
    expect(plans[3]?.includePatterns).toEqual(["ui/src/components/markdown.progress.node.test.ts"]);
  });

  it.each([
    [
      "ui/src/components/markdown-mermaid.runtime.browser.test.ts",
      "test/vitest/vitest.ui-browser.config.ts",
    ],
    ["ui/src/components/form-controls.browser.test.ts", "test/vitest/vitest.ui.config.ts"],
  ])("routes the browser test %s to its execution owner", (file, config) => {
    expectSingleVitestRunPlan(buildVitestRunPlans([file]), { config, includePatterns: [file] });
  });

  it.each([
    ["ui/src/**/*.browser.test.ts"],
    [
      "ui/src/components/*.browser.test.ts",
      "ui/src/pages/chat",
      "ui/src/styles/cursor-policy.browser.test.ts",
    ],
  ])("retains both browser owners for mixed selectors %j", (...targets) => {
    const plans = buildVitestRunPlans(targets);
    const native = plans.find((plan) => plan.config === "test/vitest/vitest.ui-browser.config.ts");
    const node = plans.find((plan) => plan.config === "test/vitest/vitest.ui.config.ts");
    expect(native?.includePatterns).toContain(
      "ui/src/components/markdown-mermaid.runtime.browser.test.ts",
    );
    expect(
      node?.includePatterns === null ||
        node?.includePatterns?.includes("ui/src/components/form-controls.browser.test.ts"),
    ).toBe(true);
    expect(node?.includePatterns ?? []).not.toContain(
      "ui/src/components/markdown-mermaid.runtime.browser.test.ts",
    );
    expect(native?.includePatterns).not.toContain(
      "ui/src/components/form-controls.browser.test.ts",
    );
    if (targets.length === 1) {
      // Browser screenshots live in directories named after their test files.
      const matchingFiles = fs.globSync(targets[0]!).filter((file) => fs.statSync(file).isFile());
      expect(plans.flatMap((plan) => plan.includePatterns ?? []).toSorted()).toEqual(
        matchingFiles.toSorted(),
      );
    }
  });

  it("rejects broad ui watch targets that cross shared and isolated projects", () => {
    expect(() => buildVitestRunPlans(["--watch", "ui/src"])).toThrow(
      "watch mode with mixed test suites is not supported",
    );
  });

  it("rejects UI glob watch before freezing the current matching files", () => {
    expect(() =>
      buildVitestRunPlans(["--watch", "ui/src/components/markdown-*.browser.test.ts"]),
    ).toThrow("use a literal test path, directory, or dedicated UI suite");
  });

  it("keeps explicit non-renderer ui test targets scoped", () => {
    expect(
      buildVitestRunPlans([
        "ui/src/i18n/test/translate.test.ts",
        "test/scripts/control-ui-i18n.test.ts",
      ]),
    ).toEqual([
      {
        config: "test/vitest/vitest.tooling-isolated.config.ts",
        forwardedArgs: [],
        includePatterns: ["test/scripts/control-ui-i18n.test.ts"],
        watchMode: false,
      },
      {
        config: "test/vitest/vitest.ui.config.ts",
        forwardedArgs: [],
        includePatterns: ["ui/src/i18n/test/translate.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes control ui e2e tests to the ui e2e lane", () => {
    expectSingleVitestRunPlan(buildVitestRunPlans(["ui/src/e2e/chat-flow.e2e.test.ts"]), {
      config: "test/vitest/vitest.ui-e2e.config.ts",
      includePatterns: ["ui/src/e2e/chat-flow.e2e.test.ts"],
    });

    expectSingleVitestRunPlan(buildVitestRunPlans(["ui/src/test-helpers/control-ui-e2e.ts"]), {
      config: "test/vitest/vitest.ui-e2e.config.ts",
    });

    expectSingleVitestRunPlan(buildVitestRunPlans(["ui/src/e2e"]), {
      config: "test/vitest/vitest.ui-e2e.config.ts",
      includePatterns: ["ui/src/e2e/**/*.test.ts"],
    });

    expect(createVitestRunSpecs(["ui/src/e2e"], { baseEnv: {} })[0]?.pnpmArgs).toContain(
      "--configLoader",
    );
  });

  it("routes auto-reply route source files to route regression tests", () => {
    expectChangedTargets(
      [
        "src/auto-reply/reply/dispatch-from-config.ts",
        "src/auto-reply/reply/effective-reply-route.ts",
        "src/auto-reply/reply/effective-reply-route.test.ts",
      ],
      [
        "src/auto-reply/reply/dispatch-acp.test.ts",
        "src/auto-reply/reply/dispatch-from-config.test.ts",
        "src/auto-reply/reply/dispatch-from-config.delivery.test.ts",
        "src/auto-reply/reply/dispatch-from-config.lifecycle.test.ts",
        "src/auto-reply/reply/followup-runner.test.ts",
        "src/auto-reply/reply/groups.test.ts",
        "extensions/discord/src/monitor/message-handler.process.test.ts",
        "extensions/slack/src/monitor.tool-result.test.ts",
        "src/auto-reply/reply/effective-reply-route.test.ts",
      ],
    );
  });

  it("routes effective reply changes through every dispatch entrypoint", () => {
    expectChangedTargets(
      ["src/auto-reply/reply/effective-reply-route.ts"],
      [
        "src/auto-reply/reply/effective-reply-route.test.ts",
        "src/auto-reply/reply/dispatch-acp.test.ts",
        "src/auto-reply/reply/dispatch-from-config.test.ts",
        "src/auto-reply/reply/dispatch-from-config.delivery.test.ts",
        "src/auto-reply/reply/dispatch-from-config.lifecycle.test.ts",
        "src/auto-reply/reply/followup-runner.test.ts",
        "src/auto-reply/reply/groups.test.ts",
        "extensions/discord/src/monitor/message-handler.process.test.ts",
        "extensions/slack/src/monitor.tool-result.test.ts",
      ],
    );
  });

  it("routes ACP command source files to ACP command regression tests", () => {
    expectChangedTargets(
      [
        "src/auto-reply/reply/commands-acp.ts",
        "src/auto-reply/reply/commands-acp.test.ts",
        "src/auto-reply/reply/dispatch-acp-command-bypass.ts",
        "src/auto-reply/reply/dispatch-acp-command-bypass.test.ts",
      ],
      [
        "src/auto-reply/reply/commands-acp.test.ts",
        "src/auto-reply/reply/dispatch-acp-command-bypass.test.ts",
      ],
    );
  });

  it("routes Google Meet CLI edits to the lightweight CLI tests", () => {
    expectChangedTargets(
      ["extensions/google-meet/src/cli.ts"],
      [
        "extensions/google-meet/src/cli-artifacts.test.ts",
        "extensions/google-meet/src/cli-runtime.test.ts",
        "extensions/google-meet/src/cli.test.ts",
      ],
    );
  });

  it("routes Google Meet OAuth edits to the lightweight OAuth tests", () => {
    expectChangedTargets(
      ["extensions/google-meet/src/oauth.ts"],
      ["extensions/google-meet/src/oauth.test.ts"],
    );
  });

  it("routes Google Meet entry edits to the plugin entry tests", () => {
    expectChangedTargets(
      ["extensions/google-meet/index.ts"],
      ["extensions/google-meet/index.test.ts"],
    );
  });

  it("routes memory doctor and embedding default edits to focused tests", () => {
    expectChangedTargets(
      [
        "src/commands/doctor-memory-search.ts",
        "packages/memory-host-sdk/src/host/embedding-defaults.ts",
      ],
      [
        "src/commands/doctor-memory-search.test.ts",
        "extensions/memory-core/src/memory/embeddings.test.ts",
      ],
    );
  });

  it("routes provider auth choice edits to focused auth-choice tests", () => {
    expectChangedTargets(
      ["src/plugins/provider-auth-choice.ts"],
      [
        "src/commands/auth-choice.apply.plugin-provider.test.ts",
        "src/commands/auth-choice.test.ts",
      ],
    );
  });

  it("routes provider env var edits to focused secret tests", () => {
    expectChangedTargets(
      ["src/secrets/provider-env-vars.ts"],
      ["src/secrets/provider-env-vars.dynamic.test.ts", "src/secrets/provider-env-vars.test.ts"],
    );
  });

  it("routes changed utils and shared files to their light scoped lanes", () => {
    const plans = buildVitestRunPlans(["--changed", "origin/main"], process.cwd(), () => [
      "packages/normalization-core/src/string-normalization.ts",
      "src/utils/provider-utils.ts",
    ]);

    expect(plans).toEqual([
      {
        config: "test/vitest/vitest.unit.config.ts",
        forwardedArgs: ["packages/normalization-core/src/string-normalization.test.ts"],
        includePatterns: ["packages/normalization-core/src/string-normalization.test.ts"],
        watchMode: false,
      },
      {
        config: "test/vitest/vitest.utils.config.ts",
        forwardedArgs: [],
        includePatterns: ["src/utils/provider-utils.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("keeps scoped include files distinct across invocations and borrowed metadata", () => {
    const borrowed = path.join(os.tmpdir(), "borrowed-vitest-include.json");
    const files = Array.from({ length: 2 }, () => {
      const [spec] = createVitestRunSpecs(["src/plugin-sdk/temp-path.test.ts"], {
        baseEnv: { OPENCLAW_VITEST_INCLUDE_FILE: borrowed },
      });
      assert(spec?.includeFilePath);
      expect(path.dirname(spec.includeFilePath)).toBe(os.tmpdir());
      expect(spec.includeFilePath).not.toBe(borrowed);
      return spec.includeFilePath;
    });
    expect(files[0]).not.toBe(files[1]);
  });

  it("expands routed glob targets to literal include-file paths", () => {
    withTinyGitRepo(
      {
        "src/gateway/core.test.ts": "",
        "src/gateway/server-methods/ping.test.ts": "",
        "src/gateway/server-startup.test.ts": "",
      },
      (cwd) => {
        const includeFile = path.join(cwd, "include.json");
        writeVitestIncludeFile(
          includeFile,
          [
            "src/gateway/**/*.test.ts",
            "src/gateway/server-*.test.ts",
            "src/gateway/@(core|server-startup).test.ts",
          ],
          { cwd },
        );

        expect(JSON.parse(fs.readFileSync(includeFile, "utf8"))).toEqual([
          "src/gateway/core.test.ts",
          "src/gateway/server-methods/ping.test.ts",
          "src/gateway/server-startup.test.ts",
        ]);
      },
    );
  });

  it("retains routed glob targets in watch-mode include files", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-test-projects-watch-"));
    try {
      const includeFile = path.join(tempDir, "include.json");
      writeVitestIncludeFile(includeFile, ["src/gateway/**/*.test.ts"], {
        expandGlobs: false,
      });

      expect(JSON.parse(fs.readFileSync(includeFile, "utf8"))).toEqual([
        "src/gateway/**/*.test.ts",
      ]);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("preflights targeted UI E2E specs with Playwright browser assets", () => {
    const [spec] = createVitestRunSpecs(["ui/src/pages/tasks/tasks.e2e.test.ts"], {
      baseEnv: {},
    });

    expect(spec?.config).toBe("test/vitest/vitest.ui-e2e.config.ts");
    expect(spec?.preflightPnpmArgs).toEqual([
      "exec",
      "node",
      "--import",
      "tsx",
      "scripts/ensure-playwright-chromium.mts",
    ]);
  });

  it("routes unit-fast light tests to the cache-friendly unit-fast lane", () => {
    const plans = buildVitestRunPlans(
      ["src/commands/status-overview-values.test.ts"],
      process.cwd(),
    );

    expect(plans).toEqual([
      {
        config: "test/vitest/vitest.unit-fast.config.ts",
        forwardedArgs: [],
        includePatterns: ["src/commands/status-overview-values.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes forced stateful unit-fast tests to the isolated lane", () => {
    const file = "src/system-agent/assistant.configured.test.ts";
    const plans = buildVitestRunPlans([file], process.cwd());
    expect(plans).toEqual([
      {
        config: "test/vitest/vitest.unit-fast-isolated.config.ts",
        forwardedArgs: [],
        includePatterns: [file],
        watchMode: false,
      },
    ]);
  });

  it("routes changed commands source allowlist files to sibling light tests", () => {
    const plans = buildVitestRunPlans(["--changed", "origin/main"], process.cwd(), () => [
      "src/commands/status-overview-values.ts",
      "src/commands/gateway-status/helpers.ts",
    ]);

    expect(plans).toEqual([
      {
        config: "test/vitest/vitest.unit-fast.config.ts",
        forwardedArgs: [],
        includePatterns: [
          "src/commands/status-overview-values.test.ts",
          "src/commands/gateway-status/helpers.test.ts",
        ],
        watchMode: false,
      },
    ]);
  });

  it("keeps changed mode to precise targets by default", () => {
    expect(resolveChangedTestTargetPlan(["package.json", "src/commands/channels.add.ts"])).toEqual({
      mode: "targets",
      skippedBroadFallbackPaths: ["package.json"],
      targets: ["src/commands/channels.add.test.ts"],
    });
  });

  it("skips import-graph scans once a diff already needs broad fallback", () => {
    const readFileSync = vi.spyOn(fs, "readFileSync");
    const before = readFileSync.mock.calls.length;
    const plan = resolveChangedTestTargetPlan([
      ".crabbox.yaml",
      "scripts/check.mts",
      "src/gateway/server.impl.ts",
    ]);
    const repoSourceReads = readFileSync.mock.calls
      .slice(before)
      .filter(([file]) => typeof file === "string" && normalizeRepoPath(file).includes("/src/"));
    readFileSync.mockRestore();

    expect(plan).toEqual({
      mode: "targets",
      skippedBroadFallbackPaths: ["src/gateway/server.impl.ts"],
      targets: ["test/scripts/package-acceptance-workflow.test.ts", "test/scripts/check.test.ts"],
    });
    expect(repoSourceReads).toEqual([]);
  });

  it("keeps broad changed fallback available through explicit env", () => {
    expect(
      resolveChangedTestTargetPlan(["package.json", "src/commands/channels.add.ts"], {
        env: { OPENCLAW_TEST_CHANGED_BROAD: "1" },
      }),
    ).toEqual({
      mode: "broad",
      targets: [],
    });
  });

  it("routes prompt snapshot generator helper edits to the owner test", () => {
    for (const target of [
      "scripts/generate-prompt-snapshots.ts",
      "scripts/prompt-snapshot-files.ts",
      "scripts/sync-codex-model-prompt-fixture.ts",
      "test/helpers/agents/happy-path-prompt-snapshots.ts",
      "test/fixtures/agents/prompt-snapshots/codex-model-catalog/gpt-5.5.pragmatic.source.json",
      "test/fixtures/agents/prompt-snapshots/codex-runtime-happy-path/telegram-direct-codex-message-tool.md",
      "test/fixtures/agents/prompt-snapshots/codex-runtime-happy-path/discord-group-codex-message-tool.md.diff",
    ]) {
      expectChangedTargets([target], ["test/scripts/prompt-snapshots.test.ts"]);
    }
  });

  it("routes runtime sidecar baseline edits to baseline owner tests", () => {
    for (const target of [
      "scripts/generate-runtime-sidecar-paths-baseline.ts",
      "src/plugins/runtime-sidecar-paths-baseline.ts",
    ]) {
      expectChangedTargets([target], ["src/plugins/bundled-plugin-metadata.test.ts"]);
    }

    for (const target of [
      "scripts/lib/bundled-runtime-sidecar-paths.json",
      "src/plugins/runtime-sidecar-paths.ts",
    ]) {
      expectChangedTargets(
        [target],
        [
          "src/plugins/bundled-plugin-metadata.test.ts",
          "src/infra/update-global.test.ts",
          "src/infra/update-runner.test.ts",
          "test/openclaw-npm-postpublish-verify.test.ts",
        ],
      );
    }
  });

  it("routes appcast edits to appcast owner tests", () => {
    expectChangedTargets(
      ["appcast.xml"],
      ["test/appcast.test.ts", "test/scripts/make-appcast.test.ts"],
    );
  });

  it("routes package fixture assets to their owner test", () => {
    const owner = "packages/ai/src/provider-transport-parity.test.ts";
    const fixturePaths = [
      "packages/ai/test/fixtures/provider-transport-parity/anthropic-success.snap.txt",
      "packages/ai/test/fixtures/provider-transport-parity/anthropic-error.snap.txt",
    ];
    for (const fixturePath of fixturePaths) {
      expectChangedTargets([fixturePath], [owner]);
    }
    expectChangedTargets(fixturePaths, [owner]);
    expectSingleVitestRunPlan(
      buildVitestRunPlans(["--changed", "origin/main"], process.cwd(), () => fixturePaths),
      {
        config: "test/vitest/vitest.unit.config.ts",
        forwardedArgs: [owner],
        includePatterns: [owner],
      },
    );
  });

  it.each([
    ["src/gateway/gateway.test.ts", "e2e"],
    ["src/gateway/server.startup-matrix-migration.integration.test.ts", "e2e"],
    ["src/gateway/sessions-history-http.test.ts", "gateway"],
  ])("routes gateway integration fixture %s to the %s lane", (target, lane) => {
    const plans = buildVitestRunPlans([target], process.cwd());

    expect(plans).toEqual([
      {
        config: `test/vitest/vitest.${lane}.config.ts`,
        forwardedArgs: lane === "e2e" ? [target] : [],
        includePatterns: lane === "e2e" ? null : [target],
        watchMode: false,
      },
    ]);
  });

  it.each([
    "src/tui/tui-auth-child-pty.e2e.test.ts",
    "src/tui/tui-pty-harness.e2e.test.ts",
    "src/tui/tui-session-identity-pty.e2e.test.ts",
    "src/tui/tui-reset-transition-pty.e2e.test.ts",
    "src/tui/tui-pty-local.e2e.test.ts",
  ])("routes TUI PTY integration target %s to the PTY lane", (target) => {
    const plans = buildVitestRunPlans([target], process.cwd());

    expect(plans).toEqual([
      {
        config: "test/vitest/vitest.tui-pty.config.ts",
        forwardedArgs: [],
        includePatterns: [target],
        watchMode: false,
      },
    ]);
  });
});

describe("test selector native source facts", () => {
  it("keeps whole-area UI consumers and source readers across graph cache scopes", () => {
    const pluginModule = "extensions/example/browser/view.ts";
    const pluginConsumer = "test/plugin-browser-consumer.test.ts";
    // This import belongs to the virtual repository, not this test's module graph.
    const pluginImport = path.posix
      .relative(path.posix.dirname(pluginConsumer), pluginModule)
      .replace(/\.ts$/u, ".js");
    withTinyGitRepo(
      {
        "src/owner/value.ts": "export const value = 1;\n",
        "ui/src/presenter.ts": 'export { value } from "../../src/owner/value.js";\n',
        "ui/src/catalog.json": '{"label":"Changed dynamically loaded data"}\n',
        "ui/src/catalog-extra.json": '{"label":"Another dynamically loaded catalog"}\n',
        "ui/src/presenter.test.ts": 'import { value } from "./presenter.js"; void value;\n',
        [pluginModule]: "export const view = 1;\n",
        "src/consumer.test.ts": 'import { value } from "../ui/src/presenter.js"; void value;\n',
        "scripts/ui-consumer.mjs": 'export { value } from "../ui/src/presenter.js";\n',
        "test/scripts/ui-consumer.test.ts":
          'import { value } from "../../scripts/ui-consumer.mjs"; void value;\n',
        [pluginConsumer]: `import { view } from ${JSON.stringify(pluginImport)}; void view;\n`,
        "test/scripts/ui-catalog-reader.test.ts":
          'import { readFileSync } from "node:fs"; readFileSync("ui/src/catalog.json", "utf8");\n',
        "test/scripts/ui-extra-reader.test.ts":
          'import { readFileSync } from "node:fs"; readFileSync("ui/src/catalog-extra.json", "utf8");\n',
        "test/scripts/ui-shared-reader.test.ts":
          'import { readFileSync } from "node:fs"; ["ui/src/catalog.json", "ui/src/catalog-extra.json"].map((file) => readFileSync(file, "utf8"));\n',
        "test/ui-consumer.live.test.ts": 'import "../ui/src/presenter.js";\n',
        "src/unrelated.test.ts": "export {};\n",
      },
      (cwd) => {
        const sourcePlan = () =>
          resolveChangedTestTargetPlan(["src/owner/value.ts"], {
            cwd,
            forceFullImportGraph: true,
          });
        const expectedSourcePlan = {
          mode: "targets",
          targets: ["src/consumer.test.ts", "ui/src/presenter.test.ts"],
        };
        expect(sourcePlan()).toEqual(expectedSourcePlan);
        const graphConsumers = [
          "src/consumer.test.ts",
          "test/plugin-browser-consumer.test.ts",
          "test/scripts/ui-consumer.test.ts",
        ];
        expect(resolveControlUiTestConsumers(["ui/src/catalog.json"], cwd)).toEqual([
          ...graphConsumers,
          "test/scripts/ui-catalog-reader.test.ts",
          "test/scripts/ui-shared-reader.test.ts",
        ]);
        expect(
          resolveControlUiTestConsumers(
            ["ui/src/catalog.json", "ui/src/catalog-extra.json", "ui/src/catalog.json"],
            cwd,
          ),
        ).toEqual([
          ...graphConsumers,
          "test/scripts/ui-catalog-reader.test.ts",
          "test/scripts/ui-shared-reader.test.ts",
          "test/scripts/ui-extra-reader.test.ts",
        ]);
        expect(
          resolveControlUiTestConsumers(["ui/src/catalog-extra.json", "ui/src/catalog.json"], cwd),
        ).toEqual([
          ...graphConsumers,
          "test/scripts/ui-extra-reader.test.ts",
          "test/scripts/ui-shared-reader.test.ts",
          "test/scripts/ui-catalog-reader.test.ts",
        ]);
        expect(sourcePlan()).toEqual(expectedSourcePlan);
      },
    );
  });

  it("reads complete files without installed packages, inherited hooks, or reparsing cached imports", () => {
    withTinyFileTree(
      {
        "large.mts": `${"// padding\n".repeat(220_000)}export type {\n Value\n } from "./barrel.js";\nimport(\n "./dynamic.mjs"\n);\nconst fixture = "scripts/tool.mts";\nnew URL(\n "./native-fixture.mjs?generation=1#child", import.meta.url,\n);\nnew URL("./other-base.mjs", "file:///elsewhere/");`,
      },
      (cwd) => {
        const files = [
          { file: "large.mts", parseImports: true },
          { file: "deleted.ts", parseImports: true },
        ];
        const expectedFacts = {
          imports: ["./barrel.js", "./dynamic.mjs", "./native-fixture.mjs"],
          matches: ["scripts/tool.mts", "scripts/tool"],
          references: ["scripts/tool.mts"],
        };
        const scanner = path.join(fs.realpathSync(cwd), "test-selector-source-facts.mts");
        fs.copyFileSync(path.resolve("scripts/lib/test-selector-source-facts.mts"), scanner);
        const native = spawnSync(process.execPath, [scanner], {
          cwd,
          input: JSON.stringify({ files, terms: ["scripts/tool.mts", "scripts/tool"] }),
          encoding: "utf8",
        });
        expect(native.error).toBeUndefined();
        expect(native.status, native.stderr).toBe(0);
        expect(JSON.parse(native.stdout)).toEqual([expectedFacts, null]);
        vi.stubEnv(
          "NODE_OPTIONS",
          "--import=data:text/javascript,throw%20Error('inherited-loader')",
        );
        try {
          expect(
            readTestSelectorSourceFacts(
              cwd,
              files,
              ["scripts/tool.mts", "scripts/tool"],
              16 * 1024 * 1024,
            ),
          ).toEqual([{ file: "large.mts", ...expectedFacts }]);
          expect(
            readTestSelectorSourceFacts(
              cwd,
              [{ file: "large.mts", parseImports: false }],
              ["scripts/tool.mts"],
              16 * 1024 * 1024,
            ),
          ).toEqual([
            {
              file: "large.mts",
              imports: [],
              matches: ["scripts/tool.mts"],
              references: ["scripts/tool.mts"],
            },
          ]);
        } finally {
          vi.unstubAllEnvs();
        }
      },
    );
  });

  it("fails loudly on child launch, output overflow, and invalid native requests", () => {
    withTinyFileTree({ "value.ts": 'import "./dependency.js";' }, (cwd) => {
      const files = [{ file: "value.ts", parseImports: true }];
      expect(() => readTestSelectorSourceFacts(path.join(cwd, "missing"), files, [], 1024)).toThrow(
        "Test selector source scan failed",
      );
      expect(() => readTestSelectorSourceFacts(cwd, files, [], 1)).toThrow(
        "Test selector source scan failed",
      );
      const result = spawnSync(
        process.execPath,
        [path.resolve("scripts/lib/test-selector-source-facts.mts")],
        {
          cwd,
          input: '{"files":false}',
          encoding: "utf8",
        },
      );
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("[test-selector-source-facts] FAILED (exit 1)");
    });
  });
});

describe("scripts/test-projects full-suite sharding", () => {
  it.each([
    { label: "null", includePatterns: null },
    { label: "empty", includePatterns: [] },
  ])("retains whole-config costs for $label selection", ({ includePatterns }) => {
    const whole = { config: "test/vitest/vitest.gateway.config.ts", includePatterns };
    const selected = {
      config: "test/vitest/vitest.tooling.config.ts",
      includePatterns: ["test/scripts/run-with-env.test.ts"],
    };

    expect(orderFullSuiteSpecsForParallelRun([selected, whole])).toEqual([whole, selected]);
  });

  it("prioritizes expensive selected files over whole-config defaults", () => {
    const tooling = {
      config: "test/vitest/vitest.tooling.config.ts",
      includePatterns: ["test/scripts/vitest-worker-artifacts.test.ts"],
    };
    const runtime = {
      config: "test/vitest/vitest.runtime-config.config.ts",
      includePatterns: ["src/config/sessions/session-accessor.sqlite-archive.worker.test.ts"],
    };

    expect(orderFullSuiteSpecsForParallelRun([runtime, tooling])).toEqual([tooling, runtime]);
  });

  it("prices expanded chunk files without enabling include-file filtering", () => {
    const chunk = {
      config: "test/vitest/vitest.tooling.config.ts",
      includePatterns: null,
      timingTargets: ["test/scripts/vitest-worker-artifacts.test.ts"],
    };
    const whole = { config: "test/vitest/vitest.runtime-config.config.ts", includePatterns: null };

    expect(orderFullSuiteSpecsForParallelRun([whole, chunk])).toEqual([chunk, whole]);
  });

  it("uses observed selection timings without substituting a whole-config sample", () => {
    const fastTooling = {
      config: "test/vitest/vitest.tooling.config.ts",
      includePatterns: ["test/scripts/run-with-env.test.ts"],
    };
    const slowTooling = {
      config: fastTooling.config,
      includePatterns: ["test/scripts/vitest-worker-artifacts.test.ts"],
    };
    const runtime = {
      config: "test/vitest/vitest.runtime-config.config.ts",
      includePatterns: ["src/config/sessions/session-accessor.sqlite-archive.worker.test.ts"],
    };
    const timings = new Map([
      [fastTooling.config, 1_000_000],
      [resolveShardTimingKey(fastTooling), 500],
      [resolveShardTimingKey(slowTooling), 153_000],
      [resolveShardTimingKey(runtime), 35_000],
    ]);

    expect(orderFullSuiteSpecsForParallelRun([fastTooling, slowTooling, runtime], timings)).toEqual(
      [slowTooling, fastTooling, runtime],
    );
  });

  it("interleaves expensive and cheap configs using observed costs", () => {
    const specs = ["a", "b", "c", "d", "e"].map((config) => ({ config }));
    const timings = new Map([
      ["a", 30],
      ["b", 50],
      ["c", 10],
      ["d", 40],
      ["e", 20],
    ]);

    expect(orderFullSuiteSpecsForParallelRun(specs, timings).map((spec) => spec.config)).toEqual([
      "b",
      "c",
      "d",
      "e",
      "a",
    ]);
  });

  it.each(["1", "true", "yes", "on"])(
    "keeps CI=%s full-suite runs serial even on roomy hosts",
    (ciValue) => {
      expect(
        resolveParallelFullSuiteConcurrency(
          61,
          {
            CI: ciValue,
            OPENCLAW_VITEST_MAX_WORKERS: "3",
          },
          {
            cpuCount: 14,
            loadAverage1m: 0,
            totalMemoryBytes: 48 * 1024 ** 3,
          },
        ),
      ).toBe(1);
    },
  );

  it("keeps CI=1 full-suite runs on aggregate shard configs", () => {
    vi.stubEnv("CI", "1");
    vi.stubEnv("GITHUB_ACTIONS", "");
    vi.stubEnv("OPENCLAW_TESTBOX_REMOTE_RUN", "");
    vi.stubEnv("OPENCLAW_TEST_PROJECTS_LEAF_SHARDS", "");
    vi.stubEnv("OPENCLAW_TEST_PROJECTS_PARALLEL", "");
    try {
      const configs = buildFullSuiteVitestRunPlans([], process.cwd()).map((plan) => plan.config);

      expect(configs).toContain("test/vitest/vitest.full-agentic.config.ts");
      expect(configs).toContain("test/vitest/vitest.full-extensions.config.ts");
      expect(configs).not.toContain("test/vitest/vitest.gateway-server.config.ts");
      expect(configs).not.toContain("test/vitest/vitest.extension-telegram.config.ts");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("gives only the aggregate extension shard an 8 GiB heap floor", () => {
    const specs = applyFullExtensionsHeapBudget([
      {
        config: "test/vitest/vitest.full-extensions.config.ts",
        env: { NODE_OPTIONS: "--trace-warnings --max-old-space-size=4096" },
      },
      {
        config: "test/vitest/vitest.full-core-runtime.config.ts",
        env: { NODE_OPTIONS: "--max-old-space-size=4096" },
      },
    ]);

    expect(specs[0]?.env.NODE_OPTIONS).toBe("--trace-warnings --max-old-space-size=8192");
    expect(specs[1]?.env.NODE_OPTIONS).toBe("--max-old-space-size=4096");
  });

  it("preserves a larger aggregate extension heap override", () => {
    const specs = applyFullExtensionsHeapBudget([
      {
        config: "test/vitest/vitest.full-extensions.config.ts",
        env: { NODE_OPTIONS: "--max_old_space_size 12288 --trace-warnings" },
      },
    ]);

    expect(specs[0]?.env.NODE_OPTIONS).toBe("--max_old_space_size 12288 --trace-warnings");
  });

  it("preserves inherited Node options when the spec has no override", () => {
    const specs = applyFullExtensionsHeapBudget(
      [{ config: "test/vitest/vitest.full-extensions.config.ts", env: {} }],
      {
        env: {
          NODE_OPTIONS: "--require ./test-hook.cjs --max-old-space-size=12288",
        },
      },
    );

    expect(specs[0]?.env.NODE_OPTIONS).toBe("--require ./test-hook.cjs --max-old-space-size=12288");
  });

  it("raises the effective last aggregate extension heap override", () => {
    const specs = applyFullExtensionsHeapBudget([
      {
        config: "test/vitest/vitest.full-extensions.config.ts",
        env: { NODE_OPTIONS: "--max-old-space-size=12288 --max_old_space_size=4096" },
      },
    ]);

    expect(specs[0]?.env.NODE_OPTIONS).toBe("--max-old-space-size=12288 --max_old_space_size=8192");
  });

  it("splits the Testbox agentic and extension shards into bounded processes", () => {
    vi.stubEnv("CI", "1");
    vi.stubEnv("GITHUB_ACTIONS", "");
    vi.stubEnv("OPENCLAW_TESTBOX_REMOTE_RUN", "1");
    vi.stubEnv("OPENCLAW_TEST_PROJECTS_LEAF_SHARDS", "");
    vi.stubEnv("OPENCLAW_TEST_PROJECTS_PARALLEL", "");
    try {
      const plans = buildFullSuiteVitestRunPlans([], process.cwd());
      const configs = plans.map((plan) => plan.config);

      expect(configs).not.toContain("test/vitest/vitest.full-agentic.config.ts");
      expect(configs).not.toContain("test/vitest/vitest.full-extensions.config.ts");
      expect(configs).toContain("test/vitest/vitest.agents-core.config.ts");
      expect(configs).toContain("test/vitest/vitest.extension-telegram.config.ts");

      const targetedPlans = (config: string) =>
        plans.filter((plan) => plan.config === config && plan.forwardedArgs.length > 0);
      expect(targetedPlans("test/vitest/vitest.agents-core.config.ts")).toHaveLength(6);
      expect(targetedPlans("test/vitest/vitest.gateway-server.config.ts")).toHaveLength(4);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("rejects malformed parallel full-suite overrides", () => {
    expect(() =>
      resolveParallelFullSuiteConcurrency(
        61,
        {
          OPENCLAW_TEST_PROJECTS_PARALLEL: "3x",
        },
        {
          cpuCount: 14,
          loadAverage1m: 0,
          totalMemoryBytes: 48 * 1024 ** 3,
        },
      ),
    ).toThrow("OPENCLAW_TEST_PROJECTS_PARALLEL must be a positive integer; got: 3x");

    expect(() =>
      resolveParallelFullSuiteConcurrency(
        61,
        {
          OPENCLAW_TEST_PROJECTS_PARALLEL: "0",
        },
        {
          cpuCount: 14,
          loadAverage1m: 0,
          totalMemoryBytes: 48 * 1024 ** 3,
        },
      ),
    ).toThrow("OPENCLAW_TEST_PROJECTS_PARALLEL must be a positive integer; got: 0");
  });

  it("rejects malformed conservative worker budget values", () => {
    expect(() =>
      resolveParallelFullSuiteConcurrency(
        61,
        {
          OPENCLAW_VITEST_MAX_WORKERS: "1e0",
        },
        {
          cpuCount: 14,
          loadAverage1m: 0,
          totalMemoryBytes: 48 * 1024 ** 3,
        },
      ),
    ).toThrow("OPENCLAW_VITEST_MAX_WORKERS must be a positive integer; got: 1e0");

    expect(() =>
      resolveParallelFullSuiteConcurrency(
        61,
        {
          OPENCLAW_TEST_WORKERS: "1 worker",
        },
        {
          cpuCount: 14,
          loadAverage1m: 0,
          totalMemoryBytes: 48 * 1024 ** 3,
        },
      ),
    ).toThrow("OPENCLAW_TEST_WORKERS must be a positive integer; got: 1 worker");
  });

  it("keeps serial untargeted local runs on leaf project configs", () => {
    withEnv(
      {
        OPENCLAW_TEST_PROJECTS_LEAF_SHARDS: "1",
        OPENCLAW_TEST_SKIP_FULL_EXTENSIONS_SHARD: "1",
      },
      () => {
        withEnv(
          {
            OPENCLAW_TEST_PROJECTS_LEAF_SHARDS: undefined,
            OPENCLAW_TEST_SKIP_FULL_EXTENSIONS_SHARD: undefined,
            OPENCLAW_TEST_PROJECTS_PARALLEL: undefined,
            CI: undefined,
            GITHUB_ACTIONS: undefined,
            OPENCLAW_TEST_PROJECTS_SERIAL: "1",
          },
          () => {
            const configs = buildFullSuiteVitestRunPlans([], process.cwd()).map(
              (plan) => plan.config,
            );

            expect(configs).toContain("test/vitest/vitest.gateway-server.config.ts");
            expect(configs).toContain("test/vitest/vitest.auto-reply-reply.config.ts");
            expect(configs).toContain("test/vitest/vitest.extension-telegram.config.ts");
            expect(configs).not.toContain("test/vitest/vitest.full-agentic.config.ts");
            expect(configs).not.toContain("test/vitest/vitest.full-extensions.config.ts");
          },
        );

        expect(process.env.OPENCLAW_TEST_PROJECTS_LEAF_SHARDS).toBe("1");
        expect(process.env.OPENCLAW_TEST_SKIP_FULL_EXTENSIONS_SHARD).toBe("1");
      },
    );
  });

  it("expands untargeted local runs to leaf project configs by default", () => {
    withEnv(
      {
        OPENCLAW_TEST_PROJECTS_LEAF_SHARDS: undefined,
        OPENCLAW_TEST_PROJECTS_PARALLEL: undefined,
        OPENCLAW_TEST_PROJECTS_SERIAL: undefined,
        CI: undefined,
        GITHUB_ACTIONS: undefined,
        OPENCLAW_VITEST_MAX_WORKERS: undefined,
        OPENCLAW_TEST_WORKERS: undefined,
      },
      () => {
        const plans = buildFullSuiteVitestRunPlans([], process.cwd());
        const configs = plans.map((plan) => plan.config);

        expect(configs).toContain("test/vitest/vitest.gateway-server.config.ts");
        expect(configs).toContain("test/vitest/vitest.extension-telegram.config.ts");
        expect(configs).not.toContain("test/vitest/vitest.full-agentic.config.ts");
        expect(configs).not.toContain("test/vitest/vitest.full-core-unit-fast.config.ts");

        const targetedPlans = (config: string) =>
          plans.filter((plan) => plan.config === config && plan.forwardedArgs.length > 0);
        const unitFastPlans = targetedPlans("test/vitest/vitest.unit-fast.config.ts");
        expect(unitFastPlans.length).toBeGreaterThan(1);
        expect(unitFastPlans.every((plan) => plan.forwardedArgs.length <= 70)).toBe(true);
        const unitSrcPlans = targetedPlans("test/vitest/vitest.unit-src.config.ts");
        expect(unitSrcPlans.length).toBeGreaterThan(1);
        expect(unitSrcPlans.every((plan) => plan.forwardedArgs.length <= 150)).toBe(true);
        const toolingPlans = targetedPlans("test/vitest/vitest.tooling.config.ts");
        expect(toolingPlans.length).toBeGreaterThan(1);
        expect(toolingPlans.every((plan) => plan.forwardedArgs.length <= 2)).toBe(true);
        const toolingTargets = toolingPlans.flatMap((plan) => plan.forwardedArgs);
        expect(toolingTargets.filter((file) => file.startsWith("test/fixtures/"))).toEqual([]);
        expect(plans.flatMap((plan) => plan.forwardedArgs)).toEqual(
          expect.arrayContaining([
            "test/scripts/oxlint-boundary-guards.test.ts",
            "test/scripts/ts-topology.test.ts",
          ]),
        );
        for (const plan of plans.filter((entry) => entry.forwardedArgs.length > 0)) {
          expect(plan.timingTargets).toEqual(plan.forwardedArgs);
          expect(plan.includePatterns).toBeNull();
        }
      },
    );
  });

  it("can skip the aggregate extension shard when CI runs dedicated extension shards", () => {
    withEnv(
      {
        OPENCLAW_TEST_PROJECTS_PARALLEL: undefined,
        OPENCLAW_TEST_PROJECTS_SERIAL: "1",
        CI: "true",
        OPENCLAW_TEST_SKIP_FULL_EXTENSIONS_SHARD: "1",
      },
      () => {
        const configs = buildFullSuiteVitestRunPlans([], process.cwd()).map((plan) => plan.config);

        expect(configs).not.toContain("test/vitest/vitest.full-extensions.config.ts");
        expect(configs).toContain("test/vitest/vitest.full-auto-reply.config.ts");
      },
    );
  });

  it("runs explicit leaf project config targets as whole configs", () => {
    const args = [
      "test/vitest/vitest.agents-core.config.ts",
      "test/vitest/vitest.agents-embedded-agent.config.ts",
      "test/vitest/vitest.agents-embedded-agent-incomplete-turn.config.ts",
      "test/vitest/vitest.agents-embedded-agent-overflow-compaction.config.ts",
      "test/vitest/vitest.agents-embedded-agent-run.config.ts",
      "test/vitest/vitest.agents-support.config.ts",
      "test/vitest/vitest.agents-tools.config.ts",
    ];

    expect(findUnmatchedExplicitTestTargets(args, process.cwd())).toEqual([]);
    expect(buildVitestRunPlans(args, process.cwd())).toEqual(
      args.map((config) => ({
        config,
        forwardedArgs: [],
        includePatterns: null,
        watchMode: false,
      })),
    );
  });

  it("keeps shared Vitest config helpers out of whole-config targets", () => {
    const args = ["test/vitest/vitest.shared.config.ts"];

    expect(findUnmatchedExplicitTestTargets(args, process.cwd())).toEqual([]);
    expectSingleVitestRunPlan(buildVitestRunPlans(args, process.cwd()), {
      config: "test/vitest/vitest.tooling.config.ts",
      includePatterns: ["test/vitest/**/*.test.ts"],
    });

    withTinyFileTree({ "test/vitest/vitest.helper.config.ts": "export default {};\n" }, (cwd) => {
      const helperArgs = ["test/vitest/vitest.helper.config.ts"];
      expect(findUnmatchedExplicitTestTargets(helperArgs, cwd)).toEqual([
        {
          target: "test/vitest/vitest.helper.config.ts",
          reason: "target-matched-no-test-files",
          includePattern: "test/vitest/**/*.test.ts",
        },
      ]);
      expectSingleVitestRunPlan(buildVitestRunPlans(helperArgs, cwd), {
        config: "test/vitest/vitest.tooling.config.ts",
        includePatterns: ["test/vitest/**/*.test.ts"],
      });
    });
  });

  it("rejects typoed explicit leaf project config targets", () => {
    expect(
      findUnmatchedExplicitTestTargets(["test/vitest/vitest.agents-croe.config.ts"], process.cwd()),
    ).toEqual([
      {
        target: "test/vitest/vitest.agents-croe.config.ts",
        reason: "path-does-not-exist",
      },
    ]);
  });

  it("rejects unmatched extensionless test prefixes with the attempted pattern", () => {
    const target = "extensions/telegram/src/no-such-prefix";
    const [unmatched] = findUnmatchedExplicitTestTargets([target]);
    expect(unmatched).toEqual({
      target,
      reason: "path-does-not-exist",
      includePattern: `${target}{,.*}.{test,spec}.{js,jsx,ts,tsx,mjs,cjs,mts,cts}`,
    });
  });

  it("rejects watch mode with multiple explicit leaf project config targets", () => {
    expect(() =>
      buildVitestRunPlans(
        [
          "--watch",
          "test/vitest/vitest.agents-core.config.ts",
          "test/vitest/vitest.agents-tools.config.ts",
        ],
        process.cwd(),
      ),
    ).toThrow(
      "watch mode with mixed test suites is not supported; target one suite at a time or use a dedicated suite command",
    );
  });

  it("skips extension project configs when leaf sharding and the aggregate extension shard is disabled", () => {
    withEnv(
      {
        OPENCLAW_TEST_PROJECTS_LEAF_SHARDS: "1",
        OPENCLAW_TEST_SKIP_FULL_EXTENSIONS_SHARD: "1",
      },
      () => {
        const configs = buildFullSuiteVitestRunPlans([], process.cwd()).map((plan) => plan.config);

        expect(configs).not.toContain("test/vitest/vitest.extensions.config.ts");
        expect(configs).not.toContain("test/vitest/vitest.extension-providers.config.ts");
        expect(configs).toContain("test/vitest/vitest.auto-reply-reply.config.ts");
      },
    );
  });

  it("expands full-suite shards before running them in parallel", () => {
    withEnv(
      {
        OPENCLAW_TEST_PROJECTS_LEAF_SHARDS: undefined,
        OPENCLAW_TEST_PROJECTS_PARALLEL: "6",
      },
      () => {
        const configs = buildFullSuiteVitestRunPlans([], process.cwd()).map((plan) => plan.config);

        expect(configs).toContain("test/vitest/vitest.extension-telegram.config.ts");
        expect(configs).not.toContain("test/vitest/vitest.full-extensions.config.ts");
      },
    );
  });

  it("rejects malformed full-suite expansion parallel overrides", () => {
    withEnv(
      {
        OPENCLAW_TEST_PROJECTS_LEAF_SHARDS: undefined,
        OPENCLAW_TEST_PROJECTS_PARALLEL: "6x",
      },
      () => {
        expect(() => buildFullSuiteVitestRunPlans([], process.cwd())).toThrow(
          "OPENCLAW_TEST_PROJECTS_PARALLEL must be a positive integer; got: 6x",
        );
      },
    );
  });

  it("keeps untargeted watch mode on the native root config", () => {
    expect(buildFullSuiteVitestRunPlans(["--watch"], process.cwd())).toEqual([
      {
        config: "vitest.config.ts",
        forwardedArgs: [],
        includePatterns: null,
        watchMode: true,
      },
    ]);
  });
});

describe("scripts/test-projects parallel cache paths", () => {
  it("splits an explicit global cache root per parallel shard", () => {
    const specs = applyParallelVitestCachePaths(
      [
        {
          config: "test/vitest/vitest.gateway.config.ts",
          env: { OPENCLAW_VITEST_FS_MODULE_CACHE_PATH: "/tmp/cache" },
          pnpmArgs: [],
        },
        {
          config: "test/vitest/vitest.extension-telegram.config.ts",
          env: { OPENCLAW_VITEST_FS_MODULE_CACHE_PATH: "/tmp/cache" },
          pnpmArgs: [],
        },
      ],
      { cwd: "/repo", env: { OPENCLAW_VITEST_FS_MODULE_CACHE_PATH: "/tmp/cache" } },
    );

    expect(specs.map((spec) => spec.env.OPENCLAW_VITEST_FS_MODULE_CACHE_PATH)).toEqual([
      path.join("/tmp/cache", "0-test-vitest-vitest.gateway.config.ts"),
      path.join("/tmp/cache", "1-test-vitest-vitest.extension-telegram.config.ts"),
    ]);
  });

  it("keeps an already isolated cache path", () => {
    const [spec] = applyParallelVitestCachePaths(
      [
        {
          config: "test/vitest/vitest.gateway.config.ts",
          env: { OPENCLAW_VITEST_FS_MODULE_CACHE_PATH: "/tmp/cache/gateway" },
          pnpmArgs: [],
        },
      ],
      { cwd: "/repo", env: { OPENCLAW_VITEST_FS_MODULE_CACHE_PATH: "/tmp/cache" } },
    );

    expect(spec?.env.OPENCLAW_VITEST_FS_MODULE_CACHE_PATH).toBe("/tmp/cache/gateway");
  });
});

describe("scripts/test-projects failed shard digest", () => {
  it("prints failed configs with focused rerun commands", () => {
    expect(
      formatFailedShardDigest([
        {
          code: 1,
          config: "test/vitest/vitest.extension-codex.config.ts",
          includePatterns: null,
          noOutputTimedOut: false,
          signal: null,
        },
      ]),
    ).toEqual([
      "[test] failed shard digest (1):",
      "[test] - test/vitest/vitest.extension-codex.config.ts (exit 1)",
      "[test]   rerun: node scripts/run-vitest.mjs run --config test/vitest/vitest.extension-codex.config.ts --reporter=verbose",
    ]);
  });

  it("prints target-based reruns when a shard used include patterns", () => {
    expect(
      formatFailedShardDigest([
        {
          code: 143,
          config: "test/vitest/vitest.unit.config.ts",
          includePatterns: ["src/foo bar.test.ts"],
          noOutputTimedOut: true,
          signal: "SIGTERM",
        },
      ]),
    ).toEqual([
      "[test] failed shard digest (1):",
      "[test] - test/vitest/vitest.unit.config.ts (exit 143, signal SIGTERM, no-output timeout) includes='src/foo bar.test.ts'",
      "[test]   rerun: pnpm test 'src/foo bar.test.ts' -- --reporter=verbose",
    ]);
  });
});

describe("scripts/test-projects Vitest stall watchdog", () => {
  it("arms non-watch jobs without shortening the direct runner's slow-config watchdog", () => {
    const configs = [
      "test/vitest/vitest.extension-feishu.config.ts",
      "test/vitest/vitest.gateway-server.config.ts",
    ];
    const specs = applyDefaultVitestNoOutputTimeout(
      configs.map((config) => ({ config, env: {}, watchMode: false })),
      { env: {} },
    );

    for (const [index, spec] of specs.entries()) {
      const timeout = Number(spec.env.OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS);
      const heartbeat = Number(spec.env.OPENCLAW_VITEST_NO_OUTPUT_HEARTBEAT_MS);
      expect(timeout).toBeGreaterThan(0);
      expect(heartbeat).toBeGreaterThan(0);
      expect(heartbeat).toBeLessThan(timeout);
      expect(timeout).toBeGreaterThanOrEqual(
        resolveDefaultVitestNoOutputTimeoutMs(["run", "--config", configs[index]!]),
      );
    }
    expect(Number(specs[1]?.env.OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS)).toBeGreaterThan(
      Number(specs[0]?.env.OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS),
    );
  });

  it("keeps explicit watchdog settings and watch mode untouched", () => {
    const specs = applyDefaultVitestNoOutputTimeout(
      [
        {
          config: "test/vitest/vitest.extension-feishu.config.ts",
          env: { PATH: "/usr/bin" },
          includeFilePath: null,
          includePatterns: null,
          pnpmArgs: [],
          watchMode: true,
        },
        {
          config: "test/vitest/vitest.extension-memory.config.ts",
          env: {
            OPENCLAW_VITEST_NO_OUTPUT_HEARTBEAT_MS: "25000",
            OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS: "0",
            PATH: "/usr/bin",
          },
          includeFilePath: null,
          includePatterns: null,
          pnpmArgs: [],
          watchMode: false,
        },
      ],
      { env: { PATH: "/usr/bin" } },
    );

    expect(specs[0]?.env.OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS).toBeUndefined();
    expect(specs[0]?.env.OPENCLAW_VITEST_NO_OUTPUT_HEARTBEAT_MS).toBeUndefined();
    expect(specs[1]?.env.OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS).toBe("0");
    expect(specs[1]?.env.OPENCLAW_VITEST_NO_OUTPUT_HEARTBEAT_MS).toBe("25000");
  });

  it("allows changed checks to disable automatic silent-run retries", () => {
    expect(shouldRetryVitestNoOutputTimeout({})).toBe(true);
    expect(shouldRetryVitestNoOutputTimeout({ CI: "true" })).toBe(false);
    expect(shouldRetryVitestNoOutputTimeout({ CI: "1" })).toBe(false);
  });

  it("raises short shard no-output timeouts for the retry attempt", () => {
    const spec = { env: { OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS: "60000" } };
    expect(withRetryNoOutputTimeout(spec).env.OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS).toBe("300000");
    const generous = { env: { OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS: "600000" } };
    expect(withRetryNoOutputTimeout(generous)).toBe(generous);
    const disabled = { env: { OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS: "0" } };
    expect(withRetryNoOutputTimeout(disabled)).toBe(disabled);
    const unset = { env: {} };
    expect(withRetryNoOutputTimeout(unset)).toBe(unset);
    expect(shouldRetryVitestNoOutputTimeout({ GITHUB_ACTIONS: "true" })).toBe(false);
    expect(shouldRetryVitestNoOutputTimeout({ OPENCLAW_VITEST_NO_OUTPUT_RETRY: "1" })).toBe(true);
    expect(shouldRetryVitestNoOutputTimeout({ OPENCLAW_VITEST_NO_OUTPUT_RETRY: "0" })).toBe(false);
    expect(shouldRetryVitestNoOutputTimeout({ OPENCLAW_VITEST_NO_OUTPUT_RETRY: "false" })).toBe(
      false,
    );
  });
});

describe("scripts/test-projects Vitest cache isolation", () => {
  it("keeps same-config process lifetimes on one restored cache", () => {
    const specs = [
      {
        config: "test/vitest/vitest.extension-telegram.config.ts",
        env: { OPENCLAW_VITEST_FS_MODULE_CACHE_PATH: "/tmp/cache" },
        includeFilePath: null,
        includePatterns: ["extensions/telegram/src/a.test.ts"],
        pnpmArgs: [],
        watchMode: false,
      },
      {
        config: "test/vitest/vitest.extension-telegram.config.ts",
        env: { OPENCLAW_VITEST_FS_MODULE_CACHE_PATH: "/tmp/cache" },
        includeFilePath: null,
        includePatterns: ["extensions/telegram/src/b.test.ts"],
        pnpmArgs: [],
        watchMode: false,
      },
    ];

    const configured = applyDefaultMultiSpecVitestCachePaths(specs, {
      cwd: "/repo",
      env: { OPENCLAW_VITEST_FS_MODULE_CACHE_PATH: "/tmp/cache" },
    });

    expect(configured.map((spec) => spec.env.OPENCLAW_VITEST_FS_MODULE_CACHE_PATH)).toEqual([
      "/tmp/cache",
      "/tmp/cache",
    ]);
  });

  it("assigns isolated fs-module caches to multi-spec non-watch runs", () => {
    const specs = applyDefaultMultiSpecVitestCachePaths(
      [
        {
          config: "test/vitest/vitest.unit-fast.config.ts",
          env: {},
          includeFilePath: null,
          includePatterns: null,
          pnpmArgs: [],
          watchMode: false,
        },
        {
          config: "test/vitest/vitest.extension-memory.config.ts",
          env: {},
          includeFilePath: null,
          includePatterns: null,
          pnpmArgs: [],
          watchMode: false,
        },
      ],
      { cwd: "/repo", env: {} },
    );

    expect(specs.map((spec) => spec.env.OPENCLAW_VITEST_FS_MODULE_CACHE_PATH)).toEqual([
      path.join("/repo", ".cache", "vitest", "0-test-vitest-vitest.unit-fast.config.ts"),
      path.join("/repo", ".cache", "vitest", "1-test-vitest-vitest.extension-memory.config.ts"),
    ]);
  });

  it("keeps single-spec and watch runs on the default cache", () => {
    const single = [
      {
        config: "test/vitest/vitest.unit-fast.config.ts",
        env: {},
        includeFilePath: null,
        includePatterns: null,
        pnpmArgs: [],
        watchMode: false,
      },
    ];
    expect(applyDefaultMultiSpecVitestCachePaths(single, { cwd: "/repo", env: {} })).toBe(single);

    const watch = [
      {
        config: "vitest.config.ts",
        env: {},
        includeFilePath: null,
        includePatterns: null,
        pnpmArgs: [],
        watchMode: true,
      },
      {
        config: "test/vitest/vitest.unit-fast.config.ts",
        env: {},
        includeFilePath: null,
        includePatterns: null,
        pnpmArgs: [],
        watchMode: false,
      },
    ];
    expect(applyDefaultMultiSpecVitestCachePaths(watch, { cwd: "/repo", env: {} })).toBe(watch);
  });
});

it.each([
  "test/scripts/plugin-release-git-lifecycle.test.ts",
  "test/scripts/release-workflow-git-lifecycle.test.ts",
  ".github/workflows/plugin-clawhub-release.yml",
  ".github/workflows/plugin-npm-release.yml",
  ".github/actions/publish-generated-pr/action.yml",
  ".github/actions/publish-generated-pr/policy.py",
  ".github/workflows/maturity-scorecard.yml",
  "test/scripts/generated-publisher.test-support.ts",
  "test/scripts/ci-checkout.test-support.ts",
  "test/scripts/ci-git-owner.test.ts",
  "test/scripts/ci-linux-git.test.ts",
  "test/scripts/ci-platform-checkout.test.ts",
])("routes shared Git ownership through all native tooling lanes: %s", (changedPath) => {
  const plan = resolveChangedTestTargetPlan([changedPath]);
  expect(plan.mode).toBe("targets");
  expect(plan.targets).toEqual(
    expect.arrayContaining([
      "test/scripts/ci-git-owner.test.ts",
      "test/scripts/ci-linux-git.test.ts",
      "test/scripts/ci-platform-checkout.test.ts",
      "test/scripts/ci-workflow-guards.test.ts",
    ]),
  );
});

// Workflow policy and shared fixture changes must select both semantic and process proof.
it.each([
  ".github/workflows/openclaw-performance.yml",
  "test/scripts/openclaw-performance-workflow.test.ts",
  "test/scripts/openclaw-performance-workflow.test-support.ts",
  "test/scripts/openclaw-performance-git-lifecycle.test.ts",
  "test/scripts/ci-git-owner.test-support.ts",
  "test/scripts/fixtures/ci-platform-checkout.mjs",
  "test/scripts/ci-windows-process-census.test-support.ts",
  "test/scripts/fixtures/ci-windows-process-census.mjs",
  "test/scripts/fixtures/ci-windows-process-census.py",
])("routes Performance lifecycle ownership: %s", (changedPath) => {
  const plan = resolveChangedTestTargetPlan([changedPath]);
  expect(plan.mode).toBe("targets");
  expect(plan.targets).toEqual(
    expect.arrayContaining([
      "test/scripts/ci-git-owner.test.ts",
      "test/scripts/ci-linux-git.test.ts",
      "test/scripts/ci-platform-checkout.test.ts",
      "test/scripts/openclaw-performance-workflow.test.ts",
      "test/scripts/openclaw-performance-git-lifecycle.test.ts",
      "test/scripts/ci-workflow-guards.test.ts",
    ]),
  );
});

it("routes release admission lifecycle ownership through serial native proof", () => {
  expect(
    resolveChangedTestTargetPlan(["test/scripts/release-workflow-git-lifecycle.test.ts"]).targets,
  ).toEqual(
    expect.arrayContaining([
      "test/scripts/ci-git-owner.test.ts",
      "test/scripts/ci-linux-git.test.ts",
      "test/scripts/ci-platform-checkout.test.ts",
      "test/scripts/release-workflow-git-lifecycle.test.ts",
      "test/scripts/ci-workflow-guards.test.ts",
    ]),
  );
});

it("routes plugin publication lifecycle ownership through serial native proof", () => {
  expect(
    resolveChangedTestTargetPlan(["test/scripts/plugin-release-git-lifecycle.test.ts"]).targets,
  ).toEqual(
    expect.arrayContaining([
      "test/scripts/ci-git-owner.test.ts",
      "test/scripts/ci-linux-git.test.ts",
      "test/scripts/ci-platform-checkout.test.ts",
      "test/scripts/plugin-release-git-lifecycle.test.ts",
      "test/scripts/ci-workflow-guards.test.ts",
    ]),
  );
});
