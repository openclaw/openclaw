// Vitest project config tests validate aggregate Vitest project wiring.
import { globSync } from "node:fs";
import path from "node:path";
import { afterEach, assert, describe, expect, it } from "vitest";
import { resolveConfig } from "vitest/node";
import { resolveExtensionTestConfig } from "../scripts/lib/extension-test-plan.mts";
import {
  buildFullSuiteVitestRunPlans,
  buildVitestRunPlans,
} from "../scripts/test-projects.test-support.mts";
import { withEnv } from "../src/test-utils/env.js";
import { spawnNodeEvalSync } from "../src/test-utils/node-process.js";
import { createPatternFileHelper } from "./helpers/pattern-file.js";
import { normalizeConfigPath, normalizeConfigPaths } from "./helpers/vitest-config-paths.js";
import {
  auditFullSuiteTestFileOwnership,
  listVitestConfigTestFiles,
} from "./vitest-projects-config.test-support.js";
import { createAgentsCoreVitestConfig } from "./vitest/vitest.agents-core.config.ts";
import { createAgentsEmbeddedIncompleteTurnVitestConfig } from "./vitest/vitest.agents-embedded-agent-incomplete-turn.config.ts";
import { createAgentsEmbeddedOverflowCompactionVitestConfig } from "./vitest/vitest.agents-embedded-agent-overflow-compaction.config.ts";
import { createAgentsEmbeddedRunVitestConfig } from "./vitest/vitest.agents-embedded-agent-run.config.ts";
import { createAgentsEmbeddedVitestConfig } from "./vitest/vitest.agents-embedded-agent.config.ts";
import {
  agentVitestProjectConfigs,
  agentVitestProjectOwners,
  embeddedAgentVitestProjectOwners,
} from "./vitest/vitest.agents-paths.mjs";
import { createAgentsSupportVitestConfig } from "./vitest/vitest.agents-support.config.ts";
import { createAgentsToolsVitestConfig } from "./vitest/vitest.agents-tools.config.ts";
import { createAgentsVitestConfig } from "./vitest/vitest.agents.config.ts";
import bundledConfig from "./vitest/vitest.bundled.config.ts";
import { createCommandsLightVitestConfig } from "./vitest/vitest.commands-light.config.ts";
import { createCommandsVitestConfig } from "./vitest/vitest.commands.config.ts";
import baseConfig from "./vitest/vitest.config.ts";
import contractChannelConfigConfig from "./vitest/vitest.contracts-channel-config.config.ts";
import contractChannelRegistryConfig from "./vitest/vitest.contracts-channel-registry.config.ts";
import contractChannelSessionConfig from "./vitest/vitest.contracts-channel-session.config.ts";
import contractChannelSurfaceConfig from "./vitest/vitest.contracts-channel-surface.config.ts";
import contractPluginConfig from "./vitest/vitest.contracts-plugin.config.ts";
import {
  createContractsVitestConfig,
  pluginContractPatterns,
} from "./vitest/vitest.contracts-shared.ts";
import codexConfig from "./vitest/vitest.extension-codex.config.ts";
import {
  databaseWorkerExtensionTestFiles,
  databaseWorkerExtensionTestRoots,
} from "./vitest/vitest.extension-database-workers-paths.mjs";
import { createExtensionDatabaseWorkersVitestConfig } from "./vitest/vitest.extension-database-workers.config.ts";
import { createExtensionImessageVitestConfig } from "./vitest/vitest.extension-imessage.config.ts";
import { createExtensionSlackVitestConfig } from "./vitest/vitest.extension-slack.config.ts";
import { createExtensionsVitestConfig } from "./vitest/vitest.extensions.config.ts";
import { diagnosticForksPool } from "./vitest/vitest.forks-pool.ts";
import { createGatewayMethodsIsolatedVitestConfig } from "./vitest/vitest.gateway-methods-isolated.config.ts";
import { createGatewayMethodsVitestConfig } from "./vitest/vitest.gateway-methods.config.ts";
import { createGatewayServerIsolatedVitestConfig } from "./vitest/vitest.gateway-server-isolated.config.ts";
import {
  gatewayDatabaseWorkerTestFiles,
  gatewayMethodsIsolatedTestFiles,
  gatewayServerIsolatedTestFiles,
} from "./vitest/vitest.gateway-server-paths.mjs";
import { createGatewayServerVitestConfig } from "./vitest/vitest.gateway-server.config.ts";
import {
  createGatewayProjectShardVitestConfig,
  createGatewayVitestConfig,
} from "./vitest/vitest.gateway.config.ts";
import { createInfraVitestConfig } from "./vitest/vitest.infra.config.ts";
import liveConfig from "./vitest/vitest.live.config.ts";
import { createPluginSdkLightVitestConfig } from "./vitest/vitest.plugin-sdk-light.config.ts";
import { createProjectShardVitestConfig } from "./vitest/vitest.project-shard-config.ts";
import {
  repoRoot,
  resolveSharedVitestWorkerConfig,
  sharedVitestConfig,
} from "./vitest/vitest.shared.config.ts";
import { fullSuiteVitestShards } from "./vitest/vitest.test-shards.mjs";
import { DEFAULT_VITEST_TEST_TIMEOUT_MS } from "./vitest/vitest.timeouts.ts";
import { uiIsolatedTestFiles } from "./vitest/vitest.ui-isolated-paths.mjs";
import { createUiVitestConfig } from "./vitest/vitest.ui.config.ts";
import { createUnitFastFakeTimersVitestConfig } from "./vitest/vitest.unit-fast-fake-timers.config.ts";
import { createUnitFastIsolatedVitestConfig } from "./vitest/vitest.unit-fast-isolated.config.ts";
import unitFastRootConfig from "./vitest/vitest.unit-fast-root.config.ts";
import { createUnitFastVitestConfig } from "./vitest/vitest.unit-fast.config.ts";

const defaultPool = process.platform === "win32" ? "forks" : "threads";
const patternFiles = createPatternFileHelper("openclaw-vitest-projects-config-");
const scopedGatewayMethodsIsolatedTestFiles = [
  "server-methods/chat-metadata-runtime.cache.test.ts",
  "server-methods/tasks.access.test.ts",
  "server-methods/tasks.test.ts",
  "server-methods/agent.task-runtime.test.ts",
  "server-methods/agent.test.ts",
  "server-methods/agent.visitor-access.test.ts",
  "server-methods/board.runtime-boundaries.test.ts",
  "server-methods/chat.reset-visible-yield.test.ts",
  "server-methods/environments.pairing-snapshot.test.ts",
  "server-methods/health.owner-routing.test.ts",
  "server-methods/sessions.send-yield-resume.test.ts",
  "server-methods/system-agent-nested-inference.integration.test.ts",
  "server-methods/system-agent-setup-control-ui.test.ts",
  "server-methods/transcripts.test.ts",
  "server-methods/users-preferences.test.ts",
  "server-methods/users-role.worker.test.ts",
  "server-methods/usage.test.ts",
  "server-methods/usage.sessions-usage.test.ts",
];

function requireTestConfig<T extends { test?: unknown }>(config: T): NonNullable<T["test"]> {
  if (!config.test) {
    throw new Error("expected vitest test config");
  }
  return config.test as NonNullable<T["test"]>;
}

const rootVitestProjects = requireTestConfig(baseConfig).projects as string[];

function requireClientOptimizer(testConfig: unknown) {
  const clientOptimizer = (
    testConfig as { deps?: { optimizer?: { client?: { enabled?: boolean } } } }
  ).deps?.optimizer?.client;
  if (!clientOptimizer) {
    throw new Error("expected vitest client optimizer config");
  }
  return clientOptimizer;
}

afterEach(() => {
  patternFiles.cleanup();
});

describe("projects vitest config", () => {
  it("isolates Codex file globals while inheriting the shared worker budget", () => {
    const config = requireTestConfig(codexConfig);
    expect(config.isolate).toBe(true);
    expect(config.pool).toBe(requireTestConfig(baseConfig).pool);
    expect(config.runner).toBeUndefined();
    expect(config.fileParallelism).toBe(requireTestConfig(baseConfig).fileParallelism);
    expect(config.maxWorkers).toBe(requireTestConfig(baseConfig).maxWorkers);
  });

  it("pins an explicit full-suite project worker limit", () => {
    const previous = process.env.OPENCLAW_VITEST_MAX_WORKERS;
    try {
      process.env.OPENCLAW_VITEST_MAX_WORKERS = "8";
      const testConfig = requireTestConfig(
        createProjectShardVitestConfig(["test/vitest/vitest.tooling.config.ts"], {
          maxWorkers: 1,
        }),
      );

      expect(testConfig.maxWorkers).toBe(1);
      expect(testConfig.fileParallelism).toBe(false);
      expect(process.env.OPENCLAW_VITEST_MAX_WORKERS).toBe("1");
    } finally {
      if (previous === undefined) {
        delete process.env.OPENCLAW_VITEST_MAX_WORKERS;
      } else {
        process.env.OPENCLAW_VITEST_MAX_WORKERS = previous;
      }
    }
  });

  it("resolves the complete root watch project graph", () => {
    const result = spawnNodeEvalSync(
      `
        import { resolveConfig } from "vitest/node";
        import rootConfig from "./vitest.config.ts";
        const resolved = await resolveConfig({ config: false }, rootConfig);
        console.log("ROOT_PROJECT_RESOLUTION " + resolved.test.resolvedProjects.length);
      `,
      {
        imports: ["tsx"],
        env: { ...process.env, GITHUB_ACTIONS: "true", OPENCLAW_VITEST_INCLUDE_FILE: undefined },
        timeout: DEFAULT_VITEST_TEST_TIMEOUT_MS,
      },
    );
    const output = JSON.stringify({ stdout: result.stdout, stderr: result.stderr });
    expect(result.error, output).toBeUndefined();
    expect(result.signal, output).toBeNull();
    expect(result.status, output).toBe(0);
    const report = result.stdout
      .split("\n")
      .find((line) => line.startsWith("ROOT_PROJECT_RESOLUTION "));
    expect(report, result.stdout).toBeDefined();
    expect(Number(report!.slice("ROOT_PROJECT_RESOLUTION ".length))).toBeGreaterThan(0);
  });

  it.each(["all", "worker", "mixed"] as const)(
    "preserves Gateway fallback coverage for %s selection",
    async (selection) => {
      const [workerFile] = gatewayDatabaseWorkerTestFiles;
      assert(workerFile);
      const ordinaryFile = "src/gateway/config-reload.telegram-policy.test.ts";
      const selected = selection === "worker" ? [workerFile] : [workerFile, ordinaryFile];
      const env = {
        OPENCLAW_GATEWAY_PROJECT_SHARDS: "0",
        OPENCLAW_VITEST_INCLUDE_FILE:
          selection === "all"
            ? undefined
            : patternFiles.writePatternFile("gateway-fallback-include.json", selected),
      };
      const resolved = await resolveConfig(
        { config: false },
        createGatewayProjectShardVitestConfig(env),
      );
      const projects = resolved.test.resolvedProjects.map(({ projectConfig }) => projectConfig);
      expect(projects.map((project) => project.name)).toEqual([
        "gateway",
        "gateway-database-workers",
      ]);
      expect(projects.map((project) => project.pool)).toEqual(["forks", "forks"]);
      const original = requireTestConfig(createGatewayVitestConfig(env));
      expect(original.pool).toBe(defaultPool);
      for (const project of projects) {
        expect(project.runner).toBe(original.runner);
        expect(project.setupFiles).toEqual(original.setupFiles);
      }
      const filesByProject = projects.map((project) => {
        const exclude = project.exclude.map((pattern) =>
          path.isAbsolute(pattern) ? path.relative(project.dir, pattern) : pattern,
        );
        return globSync(project.include, { cwd: project.dir, exclude }).map((file) =>
          path.relative(repoRoot, path.join(project.dir, file)).replaceAll("\\", "/"),
        );
      });
      const files = filesByProject.flat();
      expect(new Set(files).size).toBe(files.length);
      expect(filesByProject[1]?.toSorted()).toEqual(
        (selection === "all" ? gatewayDatabaseWorkerTestFiles : [workerFile]).toSorted(),
      );
      if (selection === "all") {
        expect(filesByProject[0]).toContain(ordinaryFile);
      } else {
        expect(files.toSorted()).toEqual(selected.toSorted());
      }
    },
  );

  it("keeps root and full-suite agent projects aligned with canonical owners", () => {
    const agenticShard = fullSuiteVitestShards.find((shard) => shard.name === "agentic");
    const agentConfigs = new Set(agentVitestProjectConfigs);

    expect(rootVitestProjects.filter((config) => agentConfigs.has(config))).toEqual(
      agentVitestProjectConfigs,
    );
    expect(agenticShard?.projects.filter((config) => agentConfigs.has(config))).toEqual(
      agentVitestProjectConfigs,
    );
    expect(agentConfigs.size).toBe(agentVitestProjectConfigs.length);
  });

  it("keeps Gateway tests needing native process state or module isolation in every aggregate", () => {
    const methodsIsolatedProject = "test/vitest/vitest.gateway-methods-isolated.config.ts";
    const serverIsolatedProject = "test/vitest/vitest.gateway-server-isolated.config.ts";
    const agenticShard = fullSuiteVitestShards.find((shard) => shard.name === "agentic");
    const methodsConfig = requireTestConfig(createGatewayMethodsVitestConfig({}));
    const methodsIsolatedConfig = requireTestConfig(createGatewayMethodsIsolatedVitestConfig({}));
    const serverIsolatedConfig = requireTestConfig(createGatewayServerIsolatedVitestConfig({}));
    const serverConfig = requireTestConfig(
      createGatewayServerVitestConfig({ OPENCLAW_VITEST_MAX_WORKERS: "2" }),
    );
    const gatewayFallback = requireTestConfig(createGatewayVitestConfig());

    expect(rootVitestProjects).toContain(methodsIsolatedProject);
    expect(rootVitestProjects).toContain(serverIsolatedProject);
    expect(agenticShard?.projects).toContain(methodsIsolatedProject);
    expect(agenticShard?.projects).toContain(serverIsolatedProject);
    expect(methodsIsolatedConfig.isolate).toBe(true);
    expect(methodsIsolatedConfig.pool).toBe("forks");
    expect(normalizeConfigPath(methodsIsolatedConfig.runner)).toBe("test/non-isolated-runner.ts");
    expect(methodsIsolatedConfig.include).toEqual(scopedGatewayMethodsIsolatedTestFiles);
    expect(serverConfig.pool).toBe("forks");
    expect(serverConfig.isolate).toBe(false);
    expect(serverConfig.fileParallelism).toBe(true);
    expect(
      requireTestConfig(createGatewayServerVitestConfig({ OPENCLAW_VITEST_MAX_WORKERS: "1" }))
        .fileParallelism,
    ).toBe(false);
    expect(serverIsolatedConfig.isolate).toBe(true);
    expect(serverIsolatedConfig.pool).toBe("forks");
    expect(serverIsolatedConfig.runner).toBeUndefined();
    expect(serverIsolatedConfig.include).toEqual(gatewayServerIsolatedTestFiles);
    const overrideFixture = "src/gateway/server-plugin-subagent-runtime.overrides.test.ts";
    expect(serverIsolatedConfig.include).toContain(overrideFixture);
    expect(serverConfig.exclude).toContain("server-plugin-subagent-runtime.overrides.test.ts");
    expect(gatewayFallback.exclude).toContain(overrideFixture);
    expect(methodsConfig.exclude).toContain("src/gateway/server-methods/agent.test.ts");
    expect(methodsConfig.exclude).toContain(
      "src/gateway/server-methods/agent.task-runtime.test.ts",
    );
    expect(methodsConfig.exclude).toContain(
      "src/gateway/server-methods/health.owner-routing.test.ts",
    );
    expect(methodsConfig.exclude).toContain(
      "src/gateway/server-methods/board.runtime-boundaries.test.ts",
    );
    expect(methodsConfig.exclude).toContain(
      "src/gateway/server-methods/chat.reset-visible-yield.test.ts",
    );
    expect(methodsConfig.exclude).toContain(
      "src/gateway/server-methods/system-agent-setup-control-ui.test.ts",
    );
    expect(gatewayFallback.exclude).toContain("src/gateway/server-methods/agent.test.ts");
    expect(gatewayFallback.exclude).toContain(
      "src/gateway/server-methods/agent.task-runtime.test.ts",
    );
    expect(gatewayFallback.exclude).toContain(
      "src/gateway/server-methods/health.owner-routing.test.ts",
    );
    expect(gatewayFallback.exclude).toContain(
      "src/gateway/server-methods/board.runtime-boundaries.test.ts",
    );
    expect(gatewayFallback.exclude).toContain(
      "src/gateway/server-methods/chat.reset-visible-yield.test.ts",
    );
    expect(gatewayFallback.exclude).toContain(
      "src/gateway/server-methods/system-agent-setup-control-ui.test.ts",
    );
    expect(gatewayFallback.exclude).toContain(
      "src/gateway/server.sessions.compaction-read-errors.test.ts",
    );
  });

  it("limits isolated Gateway include files to each project's owned tests", () => {
    const unrelatedTest = "src/gateway/worker-environments/workspace-sync-scripts.test.ts";
    const methodsIncludeFile = patternFiles.writePatternFile("methods-mixed-include.json", [
      ...gatewayMethodsIsolatedTestFiles,
      unrelatedTest,
    ]);
    const serverIncludeFile = patternFiles.writePatternFile("server-mixed-include.json", [
      ...gatewayServerIsolatedTestFiles,
      unrelatedTest,
    ]);
    const unrelatedIncludeFile = patternFiles.writePatternFile("unrelated-include.json", [
      unrelatedTest,
    ]);

    expect(
      requireTestConfig(
        createGatewayMethodsIsolatedVitestConfig({
          OPENCLAW_VITEST_INCLUDE_FILE: methodsIncludeFile,
        }),
      ).include,
    ).toEqual(scopedGatewayMethodsIsolatedTestFiles);
    expect(
      requireTestConfig(
        createGatewayServerIsolatedVitestConfig({
          OPENCLAW_VITEST_INCLUDE_FILE: serverIncludeFile,
        }),
      ).include,
    ).toEqual(gatewayServerIsolatedTestFiles);
    expect(
      requireTestConfig(
        createGatewayMethodsIsolatedVitestConfig({
          OPENCLAW_VITEST_INCLUDE_FILE: unrelatedIncludeFile,
        }),
      ).include,
    ).toEqual([]);
    expect(
      requireTestConfig(
        createGatewayServerIsolatedVitestConfig({
          OPENCLAW_VITEST_INCLUDE_FILE: unrelatedIncludeFile,
        }),
      ).include,
    ).toEqual([]);
  });

  it.each([
    ["ordinary", createUnitFastVitestConfig, "src/plugin-sdk/text-chunking.test.ts"],
    [
      "isolated",
      createUnitFastIsolatedVitestConfig,
      "src/system-agent/assistant.configured.test.ts",
    ],
    ["fake timers", createUnitFastFakeTimersVitestConfig, "src/acp/control-plane/manager.test.ts"],
  ])("limits %s unit-fast include files to the project's owned tests", (_, createConfig, owned) => {
    const unrelated = "src/gateway/openresponses-http.test.ts";
    const mixedIncludeFile = patternFiles.writePatternFile("mixed-unit-fast-include.json", [
      "src/plugin-sdk/text-chunking.test.ts",
      "src/system-agent/assistant.configured.test.ts",
      "src/acp/control-plane/manager.test.ts",
      unrelated,
    ]);
    const unrelatedIncludeFile = patternFiles.writePatternFile("unrelated-unit-fast-include.json", [
      unrelated,
    ]);

    expect(
      requireTestConfig(createConfig({ OPENCLAW_VITEST_INCLUDE_FILE: mixedIncludeFile })).include,
    ).toEqual([owned]);
    expect(
      requireTestConfig(createConfig({ OPENCLAW_VITEST_INCLUDE_FILE: unrelatedIncludeFile }))
        .include,
    ).toEqual([]);
  });

  it("covers each normal full-suite test file exactly once after configs cached filtered includes", async () => {
    const contractTestConfigs = [
      contractChannelSurfaceConfig,
      contractChannelConfigConfig,
      contractChannelRegistryConfig,
      contractChannelSessionConfig,
      contractPluginConfig,
    ].map(requireTestConfig);
    const previousIncludes = contractTestConfigs.map((config) => config.include);

    try {
      // A CLI path outside the contract patterns caches these defaults with empty includes.
      for (const config of contractTestConfigs) {
        config.include = [];
      }

      const { missing, duplicated } = await auditFullSuiteTestFileOwnership();

      expect(missing).toStrictEqual([]);
      expect(duplicated).toStrictEqual([]);
    } finally {
      contractTestConfigs.forEach((config, index) => {
        const previousInclude = previousIncludes[index];
        if (previousInclude === undefined) {
          delete config.include;
        } else {
          config.include = previousInclude;
        }
      });
    }
  });

  it("focuses a discovered test from each leaf through its actual execution config", async () => {
    const configs = new Set(fullSuiteVitestShards.flatMap((shard) => shard.projects));
    let includeId = 0;
    for (const config of configs) {
      const [file] = (await listVitestConfigTestFiles(config)).toSorted();
      if (!file) {
        continue;
      }
      const matches: string[] = [];
      for (const plan of buildVitestRunPlans([file])) {
        const includeFile = plan.includePatterns
          ? patternFiles.writePatternFile(`focused-${includeId++}.json`, plan.includePatterns)
          : undefined;
        matches.push(...(await listVitestConfigTestFiles(plan.config, includeFile)));
      }
      expect(matches, file).toEqual([file]);
    }
  });

  it("covers the extension aggregate exactly once with bounded process lifetimes", async () => {
    const expected = await listVitestConfigTestFiles(
      "test/vitest/vitest.full-extensions.config.ts",
    );
    const configFiles = new Map<string, string[]>();
    const processLimits = [
      ["test/vitest/vitest.extension-codex.config.ts", "extensions/codex/", 24, 12],
      ["test/vitest/vitest.extension-matrix.config.ts", "extensions/matrix/", 40, 40],
      ["test/vitest/vitest.extension-telegram.config.ts", "extensions/telegram/", 10, 1],
    ] as const;
    const extensionConfigs = new Set(
      fullSuiteVitestShards.find((shard) =>
        shard.config.endsWith("vitest.full-extensions.config.ts"),
      )?.projects,
    );
    const fullSuitePlans = withEnv({ OPENCLAW_TEST_PROJECTS_LEAF_SHARDS: "1" }, () =>
      buildFullSuiteVitestRunPlans([]).filter((plan) => extensionConfigs.has(plan.config)),
    );
    for (const plans of [buildVitestRunPlans(["extensions"]), fullSuitePlans]) {
      const matches: string[] = [];
      for (const plan of plans) {
        let files = configFiles.get(plan.config);
        if (!files) {
          files = await listVitestConfigTestFiles(plan.config);
          configFiles.set(plan.config, files);
        }
        const targets = plan.includePatterns ?? plan.timingTargets;
        for (const target of targets ?? []) {
          expect(
            files.some((file) => path.matchesGlob(file, target)),
            target,
          ).toBe(true);
        }
        const selected = files.filter(
          (file) => !targets || targets.some((pattern) => path.matchesGlob(file, pattern)),
        );
        for (const [boundedConfig, root, limit, workerLimit] of processLimits) {
          const inheritedWorkerLimit =
            plan.config === "test/vitest/vitest.extension-database-workers.config.ts" &&
            selected.some((file) => file.startsWith(root));
          if (plan.config === boundedConfig || inheritedWorkerLimit) {
            expect(
              selected.every((file) => file.startsWith(root)),
              plan.config,
            ).toBe(true);
            expect(selected.length, plan.config).toBeLessThanOrEqual(
              inheritedWorkerLimit ? workerLimit : limit,
            );
          }
        }
        matches.push(...selected);
      }
      expect(matches.toSorted()).toEqual(expected.toSorted());
      expect(new Set(matches).size).toBe(matches.length);
    }
  });

  it("keeps all embedded harnesses under their canonical embedded owner", () => {
    expect(embeddedAgentVitestProjectOwners).toEqual([
      agentVitestProjectOwners.embedded,
      agentVitestProjectOwners.embeddedIncompleteTurn,
      agentVitestProjectOwners.embeddedOverflowCompaction,
      agentVitestProjectOwners.embeddedRun,
    ]);
  });

  it("keeps root watch projects aligned with dedicated extension shard lanes", () => {
    const extensionShard = fullSuiteVitestShards.find(
      (shard) => shard.config === "test/vitest/vitest.full-extensions.config.ts",
    );

    expect(extensionShard?.projects).toEqual(
      expect.arrayContaining([
        "test/vitest/vitest.extension-browser.config.ts",
        "test/vitest/vitest.extension-qa.config.ts",
        "test/vitest/vitest.extension-media.config.ts",
        "test/vitest/vitest.extension-misc.config.ts",
      ]),
    );
    expect(rootVitestProjects).toEqual(
      expect.arrayContaining([
        "test/vitest/vitest.extension-browser.config.ts",
        "test/vitest/vitest.extension-qa.config.ts",
        "test/vitest/vitest.extension-media.config.ts",
        "test/vitest/vitest.extension-misc.config.ts",
      ]),
    );
  });

  it("keeps root watch projects aligned with dedicated tooling shard lanes", () => {
    const toolingShard = fullSuiteVitestShards.find(
      (shard) => shard.config === "test/vitest/vitest.full-core-tooling.config.ts",
    );
    const toolingProjects = [
      "test/vitest/vitest.tooling.config.ts",
      "test/vitest/vitest.tooling-docker.config.ts",
      "test/vitest/vitest.tooling-isolated.config.ts",
    ];

    expect(toolingShard?.projects).toEqual(toolingProjects);
    const rootToolingProjects = rootVitestProjects.filter((project) =>
      toolingProjects.includes(project),
    );
    expect(new Set(rootToolingProjects)).toEqual(new Set(toolingProjects));
    expect(rootToolingProjects).toHaveLength(toolingProjects.length);
  });

  it("keeps shared roots explicit and disables vite env-file loading", () => {
    expect(sharedVitestConfig.root).toBe(repoRoot);
    expect(sharedVitestConfig.test.root).toBe(repoRoot);
    expect(baseConfig.envDir).toBe(false);
    expect(sharedVitestConfig.envDir).toBe(false);
  });

  it("uses absolute force-rerun triggers for discovered vitest lane files", () => {
    expect(sharedVitestConfig.test.forceRerunTriggers.map(normalizeConfigPath)).toContain(
      normalizeConfigPath(`${process.cwd()}/test/vitest/vitest.config.ts`),
    );
  });

  it("keeps root projects on their expected pool defaults", () => {
    expect(sharedVitestConfig.test.pool).toBe(defaultPool);
    expect(requireTestConfig(createGatewayVitestConfig()).pool).toBe(defaultPool);
    expect(requireTestConfig(createAgentsVitestConfig()).pool).toBe(defaultPool);
    expect(requireTestConfig(createAgentsCoreVitestConfig()).pool).toBe(defaultPool);
    expect(requireTestConfig(createAgentsEmbeddedVitestConfig()).pool).toBe(defaultPool);
    expect(requireTestConfig(createAgentsEmbeddedIncompleteTurnVitestConfig()).pool).toBe(
      defaultPool,
    );
    expect(requireTestConfig(createAgentsEmbeddedOverflowCompactionVitestConfig()).pool).toBe(
      defaultPool,
    );
    expect(requireTestConfig(createAgentsEmbeddedRunVitestConfig()).pool).toBe(defaultPool);
    expect(requireTestConfig(createAgentsSupportVitestConfig()).pool).toBe("forks");
    expect(requireTestConfig(createAgentsToolsVitestConfig()).pool).toBe(defaultPool);
    expect(requireTestConfig(createCommandsLightVitestConfig()).pool).toBe(defaultPool);
    expect(requireTestConfig(createCommandsVitestConfig()).pool).toBe("forks");
    expect(requireTestConfig(createPluginSdkLightVitestConfig()).pool).toBe(defaultPool);
    expect(requireTestConfig(createUnitFastVitestConfig()).pool).toBe(defaultPool);
    expect(requireTestConfig(createContractsVitestConfig(pluginContractPatterns)).pool).toBe(
      defaultPool,
    );
  });

  it("keeps the embedded-agent cold-hook budget explicit", () => {
    expect(requireTestConfig(createAgentsEmbeddedVitestConfig()).hookTimeout).toBe(600_000);
  });

  it("honors explicit worker caps in CI vitest lanes", () => {
    expect(
      resolveSharedVitestWorkerConfig({
        env: { CI: "true", OPENCLAW_VITEST_MAX_WORKERS: "1" },
        isCI: true,
        isWindows: false,
        localScheduling: {
          fileParallelism: false,
          maxWorkers: 1,
          throttledBySystem: false,
        },
      }),
    ).toEqual({
      pool: "threads",
      fileParallelism: false,
      maxWorkers: 1,
    });
    expect(
      resolveSharedVitestWorkerConfig({
        env: { CI: "true" },
        isCI: true,
        isWindows: false,
        localScheduling: {
          fileParallelism: false,
          maxWorkers: 1,
          throttledBySystem: false,
        },
      }),
    ).toEqual({
      pool: "threads",
      fileParallelism: true,
      maxWorkers: 3,
    });
  });

  it.each([
    { isCI: true, override: "4", maxWorkers: 4 },
    { isCI: true, override: undefined, maxWorkers: 2 },
    { isCI: false, override: undefined, maxWorkers: 4 },
  ])(
    "selects process workers on Windows without reducing parallelism ($isCI, $override)",
    (scenario) => {
      expect(
        resolveSharedVitestWorkerConfig({
          env: { OPENCLAW_VITEST_MAX_WORKERS: scenario.override },
          isCI: scenario.isCI,
          isWindows: true,
          localScheduling: { fileParallelism: true, maxWorkers: 4, throttledBySystem: false },
        }),
      ).toEqual({ pool: "forks", fileParallelism: true, maxWorkers: scenario.maxWorkers });
    },
  );

  it("keeps contract shards on the non-isolated runner by default", () => {
    const config = createContractsVitestConfig(pluginContractPatterns);
    const testConfig = requireTestConfig(config);
    expect(testConfig.pool).toBe(defaultPool);
    expect(testConfig.isolate).toBe(false);
    expect(normalizeConfigPath(testConfig.runner)).toBe("test/non-isolated-runner.ts");
    const session = requireTestConfig(contractChannelSessionConfig);
    expect(session.pool).toBe("forks");
    expect(session.isolate).toBe(testConfig.isolate);
    expect(session.runner).toBe(testConfig.runner);
    expect(session.setupFiles).toEqual(testConfig.setupFiles);
    expect(session.maxWorkers).toBe(testConfig.maxWorkers);
  });

  it.each([
    undefined,
    "src/channels/plugins/contracts/session-binding.registry-backed.contract.test.ts",
    "src/channels/plugins/contracts/session-key-artifact.contract.test.ts",
    "src/tasks/task-registry.test.ts",
  ])("preserves public channel contract command coverage with include filter %s", (filter) => {
    const includeFile = filter
      ? patternFiles.writePatternFile("command-include.json", [filter])
      : undefined;
    const result = spawnNodeEvalSync(
      `
        import assert from "node:assert/strict";
        import { globSync, readFileSync } from "node:fs";
        import path from "node:path";
        import { parseCLI, resolveConfig } from "vitest/node";
        import { createVitestRunSpecs } from "./scripts/test-projects.test-support.mts";
        const command = JSON.parse(readFileSync("package.json", "utf8")).scripts["test:contracts:channels"];
        const argv = command.split(/\\s+/u);
        const wrapper = argv.indexOf("scripts/test-projects.mts");
        assert.notEqual(wrapper, -1);
        const specs = createVitestRunSpecs(argv.slice(wrapper + 1));
        const matches = [];
        for (const spec of specs) {
          assert.equal(spec.includeFilePath, null);
          const { options } = parseCLI(["vitest", ...spec.pnpmArgs.slice(spec.pnpmArgs.indexOf("run"))]);
          const resolved = await resolveConfig(options);
          for (const { projectConfig } of resolved.test.resolvedProjects) {
            for (const file of globSync(projectConfig.include, { cwd: projectConfig.dir, exclude: projectConfig.exclude })) {
              const relative = path.relative(process.cwd(), path.resolve(projectConfig.dir, file)).replaceAll("\\\\", "/");
              matches.push(relative);
              if (relative.endsWith("/session-binding.registry-backed.contract.test.ts")) {
                assert.equal(projectConfig.pool, "forks");
                assert.equal(projectConfig.maxWorkers, 1);
              }
            }
          }
        }
        const includeFile = process.env.OPENCLAW_VITEST_INCLUDE_FILE;
        const filters = includeFile ? JSON.parse(readFileSync(includeFile, "utf8")) : null;
        const expected = globSync("src/channels/plugins/contracts/**/*.test.ts")
          .map(file => file.replaceAll("\\\\", "/"))
          .filter(file => !filters || filters.some(filter => path.matchesGlob(file, filter)));
        assert.deepEqual(matches.toSorted(), expected.toSorted());
        assert.equal(new Set(matches).size, matches.length);
      `,
      {
        imports: ["tsx"],
        env: { ...process.env, GITHUB_ACTIONS: "true", OPENCLAW_VITEST_INCLUDE_FILE: includeFile },
        timeout: DEFAULT_VITEST_TEST_TIMEOUT_MS,
      },
    );
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.signal, result.stderr).toBeNull();
    expect(result.status, result.stderr).toBe(0);
  });

  it("gives contract project configs unique names", () => {
    expect([
      requireTestConfig(contractChannelSurfaceConfig).name,
      requireTestConfig(contractChannelConfigConfig).name,
      requireTestConfig(contractChannelRegistryConfig).name,
      requireTestConfig(contractChannelSessionConfig).name,
      requireTestConfig(contractPluginConfig).name,
    ]).toEqual([
      "contracts-channel-surface",
      "contracts-channel-config",
      "contracts-channel-registry",
      "contracts-channel-session",
      "contracts-plugin",
    ]);
  });

  it("narrows the contracts lane to targeted contract files", () => {
    const config = createContractsVitestConfig(pluginContractPatterns, {}, [
      "node",
      "vitest",
      "run",
      "src/plugins/contracts/bundled-web-search.google.contract.test.ts",
    ]);

    expect(requireTestConfig(config).include).toEqual([
      "src/plugins/contracts/bundled-web-search.google.contract.test.ts",
    ]);
  });

  it("intersects contract include-file shards with the config family", () => {
    const includeFile = patternFiles.writePatternFile("include.json", [
      "src/channels/plugins/contracts/surfaces-only.registry-backed-shard-b.contract.test.ts",
      "src/channels/plugins/contracts/surfaces-only.registry-backed-shard-d.contract.test.ts",
      "src/channels/plugins/contracts/directory.registry-backed-shard-a.contract.test.ts",
    ]);

    const config = createContractsVitestConfig(
      ["src/channels/plugins/contracts/*-shard-a.contract.test.ts"],
      {
        OPENCLAW_VITEST_INCLUDE_FILE: includeFile,
      },
    );

    expect(requireTestConfig(config).include).toEqual([
      "src/channels/plugins/contracts/directory.registry-backed-shard-a.contract.test.ts",
    ]);
  });

  it("keeps shared and isolated UI owners together in root and full runtime runs", () => {
    for (const projects of [
      rootVitestProjects,
      fullSuiteVitestShards.find((shard) => shard.name === "core-runtime")?.projects ?? [],
    ]) {
      for (const config of [
        "vitest.ui.config.ts",
        "vitest.ui-isolated.config.ts",
        "vitest.ui-timing.config.ts",
      ]) {
        expect(projects.filter((project) => project === `test/vitest/${config}`)).toHaveLength(1);
      }
    }
    const config = createUiVitestConfig();
    const testConfig = requireTestConfig(config);
    expect(testConfig.exclude).toEqual(expect.arrayContaining(uiIsolatedTestFiles));
    expect(testConfig.environment).toBe("jsdom");
    expect(testConfig.isolate).toBe(false);
    expect(normalizeConfigPath(testConfig.runner)).toBe("test/non-isolated-runner.ts");
    const setupFiles = normalizeConfigPaths(testConfig.setupFiles);
    expect(setupFiles).not.toContain("test/setup-openclaw-runtime.ts");
    expect(setupFiles).toContain("ui/src/test-helpers/lit-warnings.setup.ts");
    expect(requireClientOptimizer(testConfig).enabled).toBe(true);
  });

  it("registers the package Chromium owner in root and full runtime runs", async () => {
    const configPath = "test/vitest/vitest.ui-browser.config.ts";
    expect(rootVitestProjects).toContain(configPath);
    expect(
      fullSuiteVitestShards.find((shard) => shard.name === "core-runtime")?.projects,
    ).toContain(configPath);
    const { createUiBrowserVitestConfig } = await import("./vitest/vitest.ui-browser.config.ts");
    const browser = createUiBrowserVitestConfig();
    expect(normalizeConfigPath(browser.root)).toBe("ui");
    expect(requireTestConfig(browser).browser?.enabled).toBe(true);
    expect(requireTestConfig(browser).runner).toBeUndefined();
  });

  it("keeps root-matrix unit-fast files on the cross-file cleanup runner", () => {
    const testConfig = requireTestConfig(unitFastRootConfig);
    expect(testConfig.isolate).toBe(false);
    expect(normalizeConfigPath(testConfig.runner)).toBe("test/non-isolated-runner.ts");
    expect(rootVitestProjects).toContain("test/vitest/vitest.unit-fast-root.config.ts");
    expect(rootVitestProjects).not.toContain("test/vitest/vitest.unit-fast.config.ts");
  });

  it("keeps fake-timer unit-fast files serial with the non-isolated runner", () => {
    const config = createUnitFastFakeTimersVitestConfig();
    const testConfig = requireTestConfig(config);
    expect(testConfig.isolate).toBe(false);
    expect(normalizeConfigPath(testConfig.runner)).toBe("test/non-isolated-runner.ts");
    expect(testConfig.fileParallelism).toBe(false);
    expect(testConfig.maxWorkers).toBe(1);
    expect(testConfig.sequence).toMatchObject({ groupOrder: 1 });
  });

  it.each([
    "src/wizard/setup.inference-recovery.integration.test.ts",
    "src/plugins/loader.trust-diagnostics.test.ts",
    "src/plugins/public-artifact-environment.test.ts",
    "src/agents/embedded-agent-runner/model.test.ts",
    "src/agents/embedded-agent-runner/model.forward-compat.test.ts",
    "src/agents/embedded-agent-runner/model.generation-scope.test.ts",
    "src/agents/embedded-agent-runner/model.skip-agent-discovery-hooks.test.ts",
    "src/agents/embedded-agent-runner/run/model-setup.ownership.test.ts",
    "src/agents/embedded-agent-runner/run/model-setup.selected-model.test.ts",
    "src/agents/embedded-agent-runner/run/runtime-preparation.thinking.test.ts",
    "src/agents/tools-effective-inventory.cold-provider.test.ts",
    "src/tts/tts-summary.static-catalog.test.ts",
  ])("routes host-owned SQLite caller %s through the infra process", (file) => {
    const project = "test/vitest/vitest.infra.config.ts";
    const testConfig = requireTestConfig(createInfraVitestConfig({}));
    expect(buildVitestRunPlans([file]).map((plan) => plan.config)).toEqual([project]);
    expect(testConfig.include).toContain(file);
    expect(testConfig.pool).toBe(diagnosticForksPool);
    expect(rootVitestProjects).toContain(project);
    expect(fullSuiteVitestShards.flatMap((shard) => shard.projects ?? [])).toContain(project);
  });

  it("runs live Gateway hosts in process forks for shared-state admission", () => {
    const testConfig = requireTestConfig(liveConfig);
    expect(testConfig.pool).toBe("forks");
    expect(testConfig.maxWorkers).toBe(1);
  });

  it("keeps Slack's real cooldown store in its forked project", () => {
    const project = "test/vitest/vitest.extension-slack.config.ts";
    expect(requireTestConfig(createExtensionSlackVitestConfig({})).pool).toBe(diagnosticForksPool);
    expect(
      buildVitestRunPlans(["extensions/slack/src/monitor/presence-cooldown-store.test.ts"]).map(
        (plan) => plan.config,
      ),
    ).toEqual([project]);
    expect(resolveExtensionTestConfig("extensions/slack")).toBe(project);
    expect(rootVitestProjects).toContain(project);
  });

  it.each(["logbook", "memory-core", "team-reports", "workboard"])(
    "runs %s database owners in main-thread hosts across focused and full suites",
    (pluginId) => {
      const project = "test/vitest/vitest.extension-database-workers.config.ts";
      const testConfig = requireTestConfig(createExtensionDatabaseWorkersVitestConfig({}));
      expect(resolveExtensionTestConfig(`extensions/${pluginId}`)).toBe(project);
      expect(
        buildVitestRunPlans([`extensions/${pluginId}/src/store.test.ts`]).map(
          (plan) => plan.config,
        ),
      ).toEqual([project]);
      expect(rootVitestProjects).toContain(project);
      expect(
        fullSuiteVitestShards.find((shard) => shard.name === "extensions")?.projects,
      ).toContain(project);
      expect(testConfig.pool).toBe(diagnosticForksPool);
      expect(testConfig.isolate).toBe(true);
      expect(testConfig.include).toEqual([
        ...databaseWorkerExtensionTestRoots.map(
          (root) => `${root.replace(/^extensions\//u, "")}/**/*.test.ts`,
        ),
        ...databaseWorkerExtensionTestFiles.map((file) => file.replace(/^extensions\//u, "")),
      ]);
      expect(requireTestConfig(createExtensionsVitestConfig({})).exclude).toContain(
        `${pluginId}/**`,
      );
    },
  );

  it.each(databaseWorkerExtensionTestFiles)(
    "routes real extension database consumer %s to its fork owner",
    (file) => {
      const project = "test/vitest/vitest.extension-database-workers.config.ts";
      const config = requireTestConfig(createExtensionDatabaseWorkersVitestConfig({}));
      expect(buildVitestRunPlans([file]).map((plan) => plan.config)).toEqual([project]);
      expect(config.include).toContain(file.replace(/^extensions\//u, ""));
      expect(config.pool).toBe(diagnosticForksPool);
      expect(config.isolate).toBe(true);
    },
  );

  it.each([
    {
      file: "approval-reactions.persistence.test.ts",
      source: "approval-reactions.ts",
      siblings: ["approval-reactions.test.ts", "approval-reaction-poller.test.ts"],
    },
    {
      file: "send.sqlite.test.ts",
      source: "send.ts",
      siblings: ["outbound-tool-trace-sanitize.test.ts"],
    },
    { file: "send.test.ts", source: "send.ts", siblings: ["outbound-tool-trace-sanitize.test.ts"] },
  ])(
    "routes iMessage $file through its worker owner without moving sibling tests",
    ({ file: basename, source, siblings }) => {
      const file = `extensions/imessage/src/${basename}`;
      const project = "test/vitest/vitest.extension-database-workers.config.ts";
      const siblingProject = "test/vitest/vitest.extension-imessage.config.ts";
      for (const target of [
        file,
        "extensions/imessage",
        "extensions/imessage/src/*.test.ts",
        `extensions/imessage/src/${source}`,
      ]) {
        const plans = buildVitestRunPlans([target]);
        expect(plans.find((plan) => plan.config === project)?.includePatterns).toContain(file);
      }
      expect(buildVitestRunPlans([file]).map((plan) => plan.config)).toEqual([project]);
      for (const sibling of siblings) {
        expect(
          buildVitestRunPlans([`extensions/imessage/src/${sibling}`]).map((plan) => plan.config),
        ).toEqual([siblingProject]);
      }
      const workerConfig = requireTestConfig(createExtensionDatabaseWorkersVitestConfig({}));
      expect(workerConfig.include).toContain(`imessage/src/${basename}`);
      expect(workerConfig.pool).toBe(diagnosticForksPool);
      expect(workerConfig.isolate).toBe(true);
      expect(requireTestConfig(createExtensionImessageVitestConfig({})).exclude).toContain(
        `imessage/src/${basename}`,
      );
      expect(requireTestConfig(createExtensionsVitestConfig({})).exclude).toContain(
        `imessage/src/${basename}`,
      );
    },
  );

  it("keeps the bundled lane on the platform pool with the non-isolated runner", () => {
    const testConfig = requireTestConfig(bundledConfig);
    expect(testConfig.pool).toBe(defaultPool);
    expect(testConfig.isolate).toBe(false);
    expect(normalizeConfigPath(testConfig.runner)).toBe("test/non-isolated-runner.ts");
  });
});
