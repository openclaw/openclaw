// Vitest project config tests validate aggregate Vitest project wiring.
import { globSync } from "node:fs";
import path from "node:path";
import { afterEach, assert, describe, expect, it } from "vitest";
import { resolveConfig } from "vitest/node";
import { resolveExtensionTestConfig } from "../scripts/lib/extension-test-plan.mts";
import { buildVitestRunPlans } from "../scripts/test-projects.test-support.mts";
import { withEnv } from "../src/test-utils/env.js";
import { spawnNodeEvalSync } from "../src/test-utils/node-process.js";
import { createPatternFileHelper } from "./helpers/pattern-file.js";
import { normalizeConfigPath, normalizeConfigPaths } from "./helpers/vitest-config-paths.js";
import { auditFullSuiteTestFileOwnership } from "./vitest-projects-config.test-support.js";
import { createAgentsSupportVitestConfig } from "./vitest/vitest.agents-support.config.ts";
import bundledConfig from "./vitest/vitest.bundled.config.ts";
import baseConfig from "./vitest/vitest.config.ts";
import contractChannelConfigConfig from "./vitest/vitest.contracts-channel-config.config.ts";
import contractChannelRegistryConfig from "./vitest/vitest.contracts-channel-registry.config.ts";
import contractChannelSessionConfig from "./vitest/vitest.contracts-channel-session.config.ts";
import contractChannelSurfaceConfig from "./vitest/vitest.contracts-channel-surface.config.ts";
import contractPluginConfig from "./vitest/vitest.contracts-plugin.config.ts";
import { createExtensionDatabaseWorkersVitestConfig } from "./vitest/vitest.extension-database-workers.config.ts";
import { createExtensionImessageVitestConfig } from "./vitest/vitest.extension-imessage.config.ts";
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
import liveConfig from "./vitest/vitest.live.config.ts";
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
  "server-methods/agent.test.ts",
  "server-methods/agent.followup-owner.test.ts",
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
  it("pins an explicit full-suite project worker limit", () => {
    withEnv({ OPENCLAW_VITEST_MAX_WORKERS: "8" }, () => {
      const config = requireTestConfig(
        createProjectShardVitestConfig(["test/vitest/vitest.tooling.config.ts"], { maxWorkers: 1 }),
      );
      expect(config.maxWorkers).toBe(1);
      expect(config.fileParallelism).toBe(false);
      expect(process.env.OPENCLAW_VITEST_MAX_WORKERS).toBe("1");
    });
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
    for (const file of [
      "agent",
      "health.owner-routing",
      "board.runtime-boundaries",
      "chat.reset-visible-yield",
      "system-agent-setup-control-ui",
    ]) {
      const target = `src/gateway/server-methods/${file}.test.ts`;
      expect(methodsConfig.exclude).toContain(target);
      expect(gatewayFallback.exclude).toContain(target);
    }
    expect(gatewayFallback.exclude).toContain(
      "src/gateway/server.sessions.compaction-read-errors.test.ts",
    );
  });

  it.each([
    [
      "Gateway methods",
      createGatewayMethodsIsolatedVitestConfig,
      gatewayMethodsIsolatedTestFiles,
      scopedGatewayMethodsIsolatedTestFiles,
    ],
    [
      "Gateway server",
      createGatewayServerIsolatedVitestConfig,
      gatewayServerIsolatedTestFiles,
      gatewayServerIsolatedTestFiles,
    ],
    [
      "ordinary unit-fast",
      createUnitFastVitestConfig,
      ["src/plugin-sdk/text-chunking.test.ts"],
      ["src/plugin-sdk/text-chunking.test.ts"],
    ],
    [
      "isolated unit-fast",
      createUnitFastIsolatedVitestConfig,
      ["src/system-agent/assistant.configured.test.ts"],
      ["src/system-agent/assistant.configured.test.ts"],
    ],
    [
      "fake-timer unit-fast",
      createUnitFastFakeTimersVitestConfig,
      ["src/acp/translator.stop-reason.test.ts"],
      ["src/acp/translator.stop-reason.test.ts"],
    ],
  ] as const)(
    "limits %s include files to the project's owned tests",
    (_, createConfig, owned, expected) => {
      const unrelated = "src/gateway/worker-environments/workspace-sync-scripts.test.ts";
      const mixed = patternFiles.writePatternFile("mixed-include.json", [
        ...owned,
        "src/plugin-sdk/text-chunking.test.ts",
        "src/system-agent/assistant.configured.test.ts",
        "src/acp/translator.stop-reason.test.ts",
        "src/gateway/openresponses-http.test.ts",
        unrelated,
      ]);
      const excluded = patternFiles.writePatternFile("unrelated-include.json", [unrelated]);
      expect(
        requireTestConfig(createConfig({ OPENCLAW_VITEST_INCLUDE_FILE: mixed })).include,
      ).toEqual(expected);
      expect(
        requireTestConfig(createConfig({ OPENCLAW_VITEST_INCLUDE_FILE: excluded })).include,
      ).toEqual([]);
    },
  );

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

  it("runs agents-support cleanup on the host thread", () => {
    expect(requireTestConfig(createAgentsSupportVitestConfig()).pool).toBe("forks");
  });

  it.each([
    [false, true, "1", 1, false, 1, false],
    [false, true, undefined, 1, false, 3, true],
    [true, true, "4", 4, true, 4, true],
    [true, true, undefined, 4, true, 2, true],
    [true, false, undefined, 4, true, 4, true],
  ] as const)(
    "preserves worker policy: Windows=%s CI=%s override=%s",
    (isWindows, isCI, override, localWorkers, parallel, expectedWorkers, expectedParallel) => {
      expect(
        resolveSharedVitestWorkerConfig({
          env: { CI: isCI ? "true" : undefined, OPENCLAW_VITEST_MAX_WORKERS: override },
          isCI,
          isWindows,
          localScheduling: {
            fileParallelism: parallel,
            maxWorkers: localWorkers,
            throttledBySystem: false,
          },
        }),
      ).toEqual({
        pool: isWindows ? "forks" : "threads",
        fileParallelism: expectedParallel,
        maxWorkers: expectedWorkers,
      });
    },
  );

  it.each([
    { family: "channels", filter: undefined },
    {
      family: "channels",
      filter: "src/channels/plugins/contracts/session-binding.registry-backed.contract.test.ts",
    },
    {
      family: "channels",
      filter: "src/channels/plugins/contracts/session-key-artifact.contract.test.ts",
    },
    { family: "plugins", filter: undefined },
    { family: "plugins", filter: "src/plugins/contracts/host-hook-state.identity.test.ts" },
    { family: "plugins", filter: "src/plugins/contracts/host-hooks.contract.test.ts" },
  ])(
    "preserves public $family contract command coverage with include filter $filter",
    ({ family, filter }) => {
      const root =
        family === "channels" ? "src/channels/plugins/contracts" : "src/plugins/contracts";
      const includeFile = filter
        ? patternFiles.writePatternFile("command-include.json", [filter])
        : undefined;
      const result = spawnNodeEvalSync(
        `
        import assert from "node:assert/strict";
        import { globSync, readFileSync, rmSync } from "node:fs";
        import path from "node:path";
        import { parseCLI, resolveConfig } from "vitest/node";
        import { createVitestRunSpecs, writeVitestIncludeFile } from "./scripts/test-projects.test-support.mts";
        const command = JSON.parse(readFileSync("package.json", "utf8")).scripts[${JSON.stringify(`test:contracts:${family}`)}];
        const argv = command.split(/\\s+/u);
        const wrapper = argv.indexOf("scripts/test-projects.mts");
        assert.notEqual(wrapper, -1);
        const specs = createVitestRunSpecs(argv.slice(wrapper + 1));
        const includeFile = process.env.OPENCLAW_VITEST_INCLUDE_FILE;
        const matches = [];
        for (const spec of specs) {
          try {
            if (spec.includeFilePath) {
              writeVitestIncludeFile(spec.includeFilePath, spec.includePatterns);
            }
            if (spec.env.OPENCLAW_VITEST_INCLUDE_FILE === undefined) {
              delete process.env.OPENCLAW_VITEST_INCLUDE_FILE;
            } else {
              process.env.OPENCLAW_VITEST_INCLUDE_FILE = spec.env.OPENCLAW_VITEST_INCLUDE_FILE;
            }
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
                if (relative === "src/plugins/contracts/host-hook-state.identity.test.ts" || relative === "src/plugins/contracts/host-hooks.contract.test.ts") {
                  assert.equal(projectConfig.isolate, true);
                  assert.equal(projectConfig.name, "infra");
                }
              }
            }
          } finally {
            if (spec.includeFilePath) rmSync(spec.includeFilePath);
          }
        }
        const filters = includeFile ? JSON.parse(readFileSync(includeFile, "utf8")) : null;
        const expected = globSync(${JSON.stringify(`${root}/**/*.test.ts`)})
          .map(file => file.replaceAll("\\\\", "/"))
          .filter(file => !filters || filters.some(filter => path.matchesGlob(file, filter)));
        assert.deepEqual(matches.toSorted(), expected.toSorted());
        assert.equal(new Set(matches).size, matches.length);
      `,
        {
          imports: ["tsx"],
          env: {
            ...process.env,
            GITHUB_ACTIONS: "true",
            OPENCLAW_VITEST_INCLUDE_FILE: includeFile,
          },
          timeout: DEFAULT_VITEST_TEST_TIMEOUT_MS,
        },
      );
      expect(result.error, result.stderr).toBeUndefined();
      expect(result.signal, result.stderr).toBeNull();
      expect(result.status, result.stderr).toBe(0);
    },
  );

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

  it("runs live Gateway hosts in process forks for shared-state admission", () => {
    const testConfig = requireTestConfig(liveConfig);
    expect(testConfig.pool).toBe("forks");
    expect(testConfig.maxWorkers).toBe(1);
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
      expect(testConfig.include).toContain(`${pluginId}/**/*.test.ts`);
      expect(requireTestConfig(createExtensionsVitestConfig({})).exclude).toContain(
        `${pluginId}/**`,
      );
    },
  );

  it.each(["extensions/agentsapi/agentsapi-attempt.test.ts"])(
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

  it("keeps the bundled lane in broker-capable forks with the non-isolated runner", () => {
    const testConfig = requireTestConfig(bundledConfig);
    expect(testConfig.pool).toBe("forks");
    expect(testConfig.isolate).toBe(false);
    expect(normalizeConfigPath(testConfig.runner)).toBe("test/non-isolated-runner.ts");
  });
});
